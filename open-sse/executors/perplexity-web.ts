/**
 * PerplexityWebExecutor — Perplexity Web Session Provider
 *
 * Routes requests through Perplexity's internal SSE API using a Pro/Max
 * subscription session cookie or JWT, translating between OpenAI chat
 * completions format and Perplexity's internal protocol.
 *
 * Beyond plain chat it exposes what the web UI has and the OpenAI shape lacks:
 * - web sources as `citations` / `search_results` (Perplexity API shape) and
 *   `message.annotations` url_citation entries (OpenAI shape);
 * - Deep Research (`pplx-deep-research`) with autonomous answers to its
 *   clarifying questions;
 * - thread continuity: a follow-up turn is appended to the same Perplexity
 *   thread (last_backend_uuid + read_write_token) instead of replaying history.
 *
 * Per-request options live under the optional `perplexity` body object — see
 * parsePerplexityOptions().
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import {
  tlsFetchPerplexity,
  isCloudflareChallenge,
  TlsClientUnavailableError,
  type TlsFetchResult,
} from "../services/perplexityTlsClient.ts";
import { prepareToolMessages } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import {
  PERPLEXITY_DEEP_RESEARCH_BUDGET_MS,
  resolveModelRequestBudgetMs,
} from "../config/modelRequestBudgets.ts";
import {
  fetchPerplexityRateLimits,
  invalidatePerplexityRateLimits,
} from "../services/perplexityQuotaFetcher.ts";
import {
  PPLX_SSE_ENDPOINT,
  PPLX_STREAM_EOF_SYMBOL,
  PPLX_USER_AGENT,
  PPLX_LOGGED_OUT_ERROR_CODE,
  MODEL_MAP,
  THINKING_MAP,
  RESEARCH_MODE,
  CITATION_MODES,
  StreamingCitationRenderer,
  cleanResponse,
  createStreamState,
  parseOpenAIMessages,
  buildPplxRequestBody,
  buildQuery,
  extractContent,
  renderCitations,
  sseChunk,
  type CitationMode,
  type ContentChunk,
  type PplxRequestOptions,
  type PplxSource,
  type PplxStreamState,
} from "./perplexity-web/protocol.ts";

// ─── Request options ────────────────────────────────────────────────────────

export interface PerplexityOptions {
  citationMode: CitationMode;
  language?: string;
  coordinates?: { latitude: number; longitude: number };
  /** Deep Research clarifications: "auto" answers them itself, "manual" returns them. */
  researchInteraction: "auto" | "manual";
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Validate the optional `perplexity` extension object:
 * `{ citation_mode?, language?, coordinates?: {latitude, longitude}, research_interaction? }`.
 */
export function parsePerplexityOptions(
  raw: unknown
): { ok: true; options: PerplexityOptions } | { ok: false; error: string } {
  const options: PerplexityOptions = { citationMode: "clean", researchInteraction: "auto" };
  if (raw === undefined || raw === null) return { ok: true, options };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "perplexity must be an object" };
  }
  const o = raw as Record<string, unknown>;

  if (o.citation_mode !== undefined) {
    if (!CITATION_MODES.includes(o.citation_mode as CitationMode)) {
      return {
        ok: false,
        error: `perplexity.citation_mode must be one of ${CITATION_MODES.join(", ")}`,
      };
    }
    options.citationMode = o.citation_mode as CitationMode;
  }
  if (o.language !== undefined) {
    if (typeof o.language !== "string" || !LANGUAGE_RE.test(o.language) || o.language.length > 35) {
      return { ok: false, error: "perplexity.language must be a BCP-47 tag such as ru-RU" };
    }
    options.language = o.language;
  }
  if (o.coordinates !== undefined) {
    const c = o.coordinates as Record<string, unknown> | null;
    const lat = c?.latitude;
    const lng = c?.longitude;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return {
        ok: false,
        error: "perplexity.coordinates must be {latitude, longitude} in degrees",
      };
    }
    options.coordinates = { latitude: lat, longitude: lng };
  }
  if (o.research_interaction !== undefined) {
    if (o.research_interaction !== "auto" && o.research_interaction !== "manual") {
      return { ok: false, error: "perplexity.research_interaction must be auto or manual" };
    }
    options.researchInteraction = o.research_interaction;
  }
  return { ok: true, options };
}

// ─── Session continuity ─────────────────────────────────────────────────────

// Deep Research threads are worked on for hours; keep entries long enough to cover that.
const SESSION_MAX_AGE_MS = 6 * 3600_000;
const SESSION_MAX_ENTRIES = 500;

interface SessionEntry {
  backendUuid: string;
  readWriteToken: string | null;
  ts: number;
}

const sessionCache = new Map<string, SessionEntry>();

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// The client echoes our answer back in the next turn. Normalize away what differs
// between citation modes and whitespace so the echoed transcript still matches.
function normalizeTurn(content: string): string {
  return content
    .replace(/ ?\[\d+\]\([^)\s]*\)/g, "")
    .replace(/ ?\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Scoped per credential: a thread belongs to the Perplexity account that created it.
function sessionKey(scope: string, history: Array<{ role: string; content: string }>): string {
  const parts = history.map((h) => `${h.role}:${normalizeTurn(h.content)}`).join("\n");
  return `${scope}:${fnv1a(parts)}:${parts.length}`;
}

function sessionLookup(
  scope: string,
  history: Array<{ role: string; content: string }>
): SessionEntry | null {
  if (history.length === 0) return null;
  const key = sessionKey(scope, history);
  const entry = sessionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SESSION_MAX_AGE_MS) {
    sessionCache.delete(key);
    return null;
  }
  return entry;
}

function sessionStore(
  scope: string,
  history: Array<{ role: string; content: string }>,
  currentMsg: string,
  responseText: string,
  state: PplxStreamState
): void {
  if (!state.backendUuid) return;
  const full = [
    ...history,
    { role: "user", content: currentMsg },
    { role: "assistant", content: responseText },
  ];
  sessionCache.set(sessionKey(scope, full), {
    backendUuid: state.backendUuid,
    readWriteToken: state.readWriteToken,
    ts: Date.now(),
  });
  if (sessionCache.size > SESSION_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of sessionCache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) sessionCache.delete(oldestKey);
  }
}

export function __resetPerplexitySessionsForTesting(): void {
  sessionCache.clear();
}

// ─── Deep Research ──────────────────────────────────────────────────────────

// The TLS client's timeout bounds the whole streamed answer, not just the first byte.
// Its 30s default cut Pro follow-ups mid-answer; research runs for minutes.
const ANSWER_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_PPLX_TLS_TIMEOUT_MS || "", 10) || 300_000;
const RESEARCH_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_PPLX_RESEARCH_TIMEOUT_MS || "", 10) || 900_000;
const RESEARCH_TIMEOUT_SAFETY_MS = 1_000;

export function buildResearchContinuation(questions: string[]): string {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return (
    "Continue the Deep Research task without asking the user for input. " +
    "Answer the clarification questions below by choosing the most reasonable options " +
    "from the original context. If ambiguity remains, state the assumption briefly and " +
    `proceed with the research.\n\nClarification questions:\n${list}`
  );
}

function formatQuestions(questions: string[]): string {
  return questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
}

// ─── Response shaping ───────────────────────────────────────────────────────

function sourceFields(sources: PplxSource[]): Record<string, unknown> {
  if (sources.length === 0) return {};
  return {
    citations: sources.map((s) => s.url),
    search_results: sources.map((s) => ({
      title: s.title,
      url: s.url,
      ...(s.snippet ? { snippet: s.snippet } : {}),
      ...(s.date ? { date: s.date } : {}),
    })),
  };
}

function annotations(sources: PplxSource[]): Array<Record<string, unknown>> {
  return sources.map((s) => ({
    type: "url_citation",
    url_citation: { url: s.url, title: s.title },
  }));
}

/** Render the final answer; falls back to clarifying questions when research stopped there. */
function finalAnswerText(fullAnswer: string, state: PplxStreamState, mode: CitationMode): string {
  const rendered = cleanResponse(renderCitations(fullAnswer, mode, state.sources), true, true);
  if (rendered || state.clarifyingQuestions.length === 0) return rendered;
  return formatQuestions(state.clarifyingQuestions);
}

interface TurnContext {
  model: string;
  cid: string;
  created: number;
  scope: string;
  history: Array<{ role: string; content: string }>;
  currentMsg: string;
  citationMode: CitationMode;
  state: PplxStreamState;
}

function buildStreamingResponse(
  chunks: AsyncIterable<ContentChunk>,
  ctx: TurnContext
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { model, cid, created, state } = ctx;
  const frame = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    encoder.encode(
      sseChunk({
        id: cid,
        object: "chat.completion.chunk",
        created,
        model,
        system_fingerprint: null,
        choices: [{ index: 0, finish_reason: null, logprobs: null, ...choice }],
        ...extra,
      })
    );

  return new ReadableStream(
    {
      async start(controller) {
        const renderer = new StreamingCitationRenderer(ctx.citationMode, () => state.sources);
        try {
          controller.enqueue(frame({ delta: { role: "assistant" } }));

          let fullAnswer = "";
          let completed = false;

          for await (const chunk of chunks) {
            if (chunk.error) {
              controller.enqueue(frame({ delta: { content: `[Error: ${chunk.error}]` } }));
              break;
            }
            if (chunk.thinking) {
              controller.enqueue(frame({ delta: { reasoning_content: chunk.thinking + "\n" } }));
              continue;
            }
            if (chunk.done) {
              fullAnswer = chunk.answer || fullAnswer;
              completed = true;
              break;
            }
            const out = renderer.push(chunk.delta || "");
            if (out) controller.enqueue(frame({ delta: { content: out } }));
            if (chunk.answer) fullAnswer = chunk.answer;
          }

          const tail = renderer.finish();
          if (tail) controller.enqueue(frame({ delta: { content: tail } }));
          if (completed && !fullAnswer.trim() && state.clarifyingQuestions.length > 0) {
            controller.enqueue(
              frame({ delta: { content: formatQuestions(state.clarifyingQuestions) } })
            );
          }

          // Sources ride on their own chunk right before the stop chunk, in both the
          // OpenAI (delta.annotations) and the Perplexity API (citations) shapes.
          if (state.sources.length > 0) {
            controller.enqueue(
              frame(
                { delta: { annotations: annotations(state.sources) } },
                sourceFields(state.sources)
              )
            );
          }
          controller.enqueue(frame({ delta: {}, finish_reason: "stop" }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));

          if (completed) {
            sessionStore(
              ctx.scope,
              ctx.history,
              ctx.currentMsg,
              finalAnswerText(fullAnswer, state, ctx.citationMode),
              state
            );
          }
        } catch (err) {
          controller.enqueue(
            frame({
              delta: {
                content: `[Stream error: ${err instanceof Error ? err.message : String(err)}]`,
              },
              finish_reason: "stop",
            })
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    },
    { highWaterMark: 16384 }
  );
}

async function buildNonStreamingResponse(
  chunks: AsyncIterable<ContentChunk>,
  ctx: TurnContext
): Promise<Response> {
  const { model, cid, created, state } = ctx;
  let fullAnswer = "";
  const thinkingParts: string[] = [];

  try {
    for await (const chunk of chunks) {
      if (chunk.error) {
        const status = chunk.errorCode === PPLX_LOGGED_OUT_ERROR_CODE ? 401 : 502;
        return new Response(
          JSON.stringify({
            error: {
              message: chunk.error,
              type: "upstream_error",
              code: chunk.errorCode || "PPLX_ERROR",
            },
          }),
          { status, headers: { "Content-Type": "application/json" } }
        );
      }
      if (chunk.thinking) {
        thinkingParts.push(chunk.thinking);
        continue;
      }
      if (chunk.done) {
        fullAnswer = chunk.answer || fullAnswer;
        break;
      }
      if (chunk.answer) fullAnswer = chunk.answer;
    }
  } catch (err) {
    // A transport failure mid-answer (TLS timeout, reset) must become an HTTP error,
    // not a rejected execute().
    return new Response(
      JSON.stringify({
        error: {
          message: `Perplexity stream failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`,
          type: "upstream_error",
          code: "PPLX_STREAM_ERROR",
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const content = finalAnswerText(fullAnswer, state, ctx.citationMode);
  sessionStore(ctx.scope, ctx.history, ctx.currentMsg, content, state);

  const msg: Record<string, unknown> = { role: "assistant", content };
  if (thinkingParts.length > 0) msg.reasoning_content = thinkingParts.join("\n");
  if (state.sources.length > 0) msg.annotations = annotations(state.sources);

  const promptTokens = Math.ceil(ctx.currentMsg.length / 4);
  const completionTokens = Math.ceil(content.length / 4);

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      ...sourceFields(state.sources),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ─── Executor ───────────────────────────────────────────────────────────────

function jsonError(status: number, message: string, type: string, code?: string): Response {
  return new Response(JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class PerplexityWebExecutor extends BaseExecutor {
  constructor() {
    super("perplexity-web", { id: "perplexity-web", baseUrl: PPLX_SSE_ENDPOINT });
  }

  override getTimeoutMs(model?: string) {
    return resolveModelRequestBudgetMs(this.provider, model, super.getTimeoutMs());
  }

  async execute({ model, body, stream, credentials, signal, log }: ExecuteInput) {
    const bodyObj = (body || {}) as Record<string, unknown>;
    const rawMessages = bodyObj.messages as Array<Record<string, unknown>> | undefined;
    if (!rawMessages || !Array.isArray(rawMessages) || rawMessages.length === 0) {
      return {
        response: jsonError(400, "Missing or empty messages array", "invalid_request"),
        url: PPLX_SSE_ENDPOINT,
        headers: {},
        transformedBody: body,
      };
    }

    const parsedOptions = parsePerplexityOptions(bodyObj.perplexity);
    if ("error" in parsedOptions) {
      return {
        response: jsonError(400, parsedOptions.error, "invalid_request"),
        url: PPLX_SSE_ENDPOINT,
        headers: {},
        transformedBody: body,
      };
    }
    const pplxOptions = (parsedOptions as { options: PerplexityOptions }).options;

    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      bodyObj,
      rawMessages as Array<{ role: string; content: unknown }>
    );

    // Resolve thinking mode
    const thinking =
      bodyObj.thinking === true ||
      (bodyObj.reasoning_effort != null && bodyObj.reasoning_effort !== "none");

    let pplxMode: string;
    let modelPref: string;
    if (thinking && THINKING_MAP[model]) {
      pplxMode = "copilot";
      modelPref = THINKING_MAP[model];
      log?.info?.("PPLX-WEB", `Thinking mode → ${model} using ${modelPref}`);
    } else if (MODEL_MAP[model]) {
      [pplxMode, modelPref] = MODEL_MAP[model];
    } else {
      pplxMode = "copilot";
      modelPref = model;
      log?.info?.("PPLX-WEB", `Unmapped model ${model}, using as raw preference`);
    }
    const isResearch = pplxMode === RESEARCH_MODE;
    // All TLS turns in one Deep Research execution share the outer model budget.
    // Without a shared deadline, an automatic clarification continuation could
    // start near the outer timeout and leave the opaque native request running
    // for another full RESEARCH_TIMEOUT_MS after chatCore had already aborted.
    const researchDeadlineAt = isResearch
      ? Date.now() + PERPLEXITY_DEEP_RESEARCH_BUDGET_MS - RESEARCH_TIMEOUT_SAFETY_MS
      : null;

    // Parse messages and check session continuity
    const scope = fnv1a(String(credentials.accessToken || credentials.apiKey || ""));
    const parsed = parseOpenAIMessages(effectiveMessages);
    const followUp = sessionLookup(scope, parsed.history);
    if (followUp) {
      log?.info?.("PPLX-WEB", `Session continue: ${followUp.backendUuid.slice(0, 12)}...`);
    }

    // Deep Research has a small monthly allowance (Pro ≈20). When the account has
    // none left, fail fast with a quota error: no upstream call, and perplexity-web
    // uses per-model lockouts, so only this model is parked — Pro search keeps
    // routing to the account. Unknown counters (fetch failed) fail open.
    const connectionId = credentials.connectionId || `cookie:${scope}`;
    if (isResearch) {
      const limits = await fetchPerplexityRateLimits(connectionId, {
        apiKey: credentials.apiKey,
        accessToken: credentials.accessToken,
      });
      if (limits?.research === 0) {
        log?.warn?.("PPLX-WEB", "Deep Research quota exhausted for this account");
        return {
          response: jsonError(
            429,
            "Perplexity Deep Research quota exhausted for this account (monthly allowance). Use pplx-auto or another account.",
            "rate_limit_error",
            "quota_exhausted"
          ),
          url: PPLX_SSE_ENDPOINT,
          headers: {},
          transformedBody: body,
        };
      }
    }

    const query = buildQuery(parsed, followUp?.backendUuid ?? null);
    if (!query.trim()) {
      return {
        response: jsonError(400, "Empty query after processing", "invalid_request"),
        url: PPLX_SSE_ENDPOINT,
        headers: {},
        transformedBody: body,
      };
    }

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Origin: "https://www.perplexity.ai",
      Referer: "https://www.perplexity.ai/",
      "User-Agent": PPLX_USER_AGENT,
      // Current app request headers (replaced the stale X-App-ApiVersion/X-App-ApiClient pair,
      // which the new endpoint no longer expects and which contributed to HTTP 400).
      "x-perplexity-request-endpoint": PPLX_SSE_ENDPOINT,
      "x-perplexity-request-reason": "ask-query-state-provider",
      "x-perplexity-request-try-number": "1",
    };
    if (credentials.accessToken) {
      baseHeaders["Authorization"] = `Bearer ${credentials.accessToken}`;
    } else if (credentials.apiKey) {
      baseHeaders["Cookie"] = `__Secure-next-auth.session-token=${credentials.apiKey}`;
    }

    const requestOptions = (readWriteToken: string | null): PplxRequestOptions => ({
      language: pplxOptions.language,
      coordinates: pplxOptions.coordinates,
      readWriteToken,
    });

    const send = async (pplxBody: Record<string, unknown>, requestId: string) => {
      const timeoutMs = isResearch
        ? Math.min(RESEARCH_TIMEOUT_MS, Math.max(0, (researchDeadlineAt ?? 0) - Date.now()))
        : ANSWER_TIMEOUT_MS;
      if (timeoutMs <= 0) {
        const timeoutError = new Error(
          "Perplexity Deep Research execution budget exhausted before the next upstream request"
        );
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      return tlsFetchPerplexity(PPLX_SSE_ENDPOINT, {
        method: "POST",
        headers: { ...baseHeaders, "x-request-id": requestId },
        body: JSON.stringify(pplxBody),
        signal: signal ?? null,
        stream: true,
        streamEofSymbol: PPLX_STREAM_EOF_SYMBOL,
        timeoutMs,
      });
    };

    // Build Perplexity request
    const requestId = crypto.randomUUID();
    const pplxBody = buildPplxRequestBody(
      query,
      parsed.currentMsg,
      pplxMode,
      modelPref,
      followUp?.backendUuid ?? null,
      requestId,
      requestOptions(followUp?.readWriteToken ?? null)
    );
    const headers = { ...baseHeaders, "x-request-id": requestId };

    log?.info?.(
      "PPLX-WEB",
      `Query to ${model} (pref=${modelPref}, mode=${pplxMode}), len=${query.length}`
    );

    // Fetch from Perplexity through the Firefox-fingerprinted TLS client.
    // Perplexity sits behind Cloudflare Enterprise which pins JA3/JA4 to a real
    // browser handshake; Node's fetch() is challenged with a 403 page from
    // VPS/datacenter IPs even with a valid cookie (issue #2459).
    let response: TlsFetchResult;
    try {
      response = await send(pplxBody, requestId);
    } catch (err) {
      const isTlsUnavail = err instanceof TlsClientUnavailableError;
      log?.error?.("PPLX-WEB", `Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      const message = isTlsUnavail
        ? `Perplexity TLS client unavailable: ${sanitizeErrorMessage((err as Error).message)}`
        : `Perplexity connection failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
      return {
        response: jsonError(502, message, "upstream_error"),
        url: PPLX_SSE_ENDPOINT,
        headers,
        transformedBody: pplxBody,
      };
    }

    if (response.status !== 200 || (!response.body && !response.text)) {
      const status = response.status;
      let errMsg = `Perplexity returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        if (isCloudflareChallenge(response.text)) {
          errMsg =
            "Cloudflare blocked the request — Perplexity's edge rejected this server's TLS fingerprint " +
            "(common on VPS/datacenter IPs). Ensure tls-client-node is installed with its native binary, " +
            "or route perplexity-web through a residential proxy.";
          log?.error?.("PPLX-WEB", "Cloudflare challenge detected — TLS bypass failed");
        } else {
          errMsg =
            "Perplexity auth failed — session cookie may be expired. Re-paste your __Secure-next-auth.session-token.";
        }
      } else if (status === 429) {
        errMsg = "Perplexity rate limited. Wait a moment and retry.";
      }
      log?.warn?.("PPLX-WEB", errMsg);
      return {
        response: jsonError(status, errMsg, "upstream_error", `HTTP_${status}`),
        url: PPLX_SSE_ENDPOINT,
        headers,
        transformedBody: pplxBody,
      };
    }

    if (!response.body) {
      return {
        response: jsonError(502, "Perplexity returned empty response body", "upstream_error"),
        url: PPLX_SSE_ENDPOINT,
        headers,
        transformedBody: pplxBody,
      };
    }

    const state = createStreamState();
    const firstBody = response.body;
    // A research run consumes the allowance; make the next check re-read it.
    if (isResearch) invalidatePerplexityRateLimits(connectionId);

    // One logical turn. A Deep Research answer that stops at clarifying questions is
    // continued in the same thread (research_interaction=auto), so the caller gets
    // the finished research instead of a questionnaire.
    async function* turnChunks(): AsyncGenerator<ContentChunk> {
      let pending: ContentChunk | null = null;
      for await (const chunk of extractContent(firstBody, signal, state)) {
        if (chunk.done && !chunk.error) {
          pending = chunk;
          break;
        }
        yield chunk;
        if (chunk.error) return;
      }
      if (!pending) return;

      const needsContinuation =
        isResearch &&
        pplxOptions.researchInteraction === "auto" &&
        state.clarifyingQuestions.length > 0 &&
        !(pending.answer || "").trim() &&
        state.backendUuid;
      if (!needsContinuation) {
        yield pending;
        return;
      }

      const questions = [...state.clarifyingQuestions];
      log?.info?.("PPLX-WEB", `Deep Research asked ${questions.length} question(s); continuing`);
      yield {
        thinking: `Clarifying questions answered automatically:\n${formatQuestions(questions)}`,
      };
      const continuation = buildResearchContinuation(questions);
      const contId = crypto.randomUUID();
      const contBody = buildPplxRequestBody(
        continuation,
        continuation,
        pplxMode,
        modelPref,
        state.backendUuid,
        contId,
        requestOptions(state.readWriteToken)
      );
      const contResponse = await send(contBody, contId);
      if (contResponse.status !== 200 || !contResponse.body) {
        yield {
          error: `Deep Research continuation failed: HTTP ${contResponse.status}`,
          done: true,
        };
        return;
      }
      state.clarifyingQuestions = [];
      yield* extractContent(contResponse.body, signal, state);
    }

    // Peek the first chunk so a logged-out session becomes a real 401 (lets the
    // account be marked/rotated) instead of a 200 stream carrying an error line.
    const iterator = turnChunks();
    let first: IteratorResult<ContentChunk>;
    try {
      first = await iterator.next();
    } catch (err) {
      const message = `Perplexity stream failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
      log?.error?.("PPLX-WEB", message);
      return {
        response: jsonError(502, message, "upstream_error", "PPLX_STREAM_ERROR"),
        url: PPLX_SSE_ENDPOINT,
        headers,
        transformedBody: pplxBody,
      };
    }
    if (!first.done && first.value.errorCode === PPLX_LOGGED_OUT_ERROR_CODE) {
      log?.warn?.("PPLX-WEB", "Session cookie is logged out");
      return {
        response: jsonError(
          401,
          first.value.error || "Perplexity session is logged out",
          "upstream_error",
          PPLX_LOGGED_OUT_ERROR_CODE
        ),
        url: PPLX_SSE_ENDPOINT,
        headers,
        transformedBody: pplxBody,
      };
    }
    const chunks: AsyncIterable<ContentChunk> = {
      async *[Symbol.asyncIterator]() {
        if (!first.done) yield first.value;
        yield* { [Symbol.asyncIterator]: () => iterator };
      },
    };

    // Build OpenAI-compatible response
    const ctx: TurnContext = {
      model,
      cid: `chatcmpl-pplx-${crypto.randomUUID().slice(0, 12)}`,
      created: Math.floor(Date.now() / 1000),
      scope,
      history: parsed.history,
      currentMsg: parsed.currentMsg,
      citationMode: pplxOptions.citationMode,
      state,
    };

    // Tool mode buffers the full completion (no live token streaming) and
    // converts <tool> text into real tool_calls — even when the caller asked
    // for a streaming response — mirroring chatgpt-web's toolMode (#5240,
    // #5927). Without this, streaming requests (the default for agentic
    // coding clients) never emitted a tool_calls SSE delta.
    let finalResponse: Response;
    if (hasTools) {
      const bufferedJson = await buildNonStreamingResponse(chunks, ctx);
      finalResponse = await buildToolModeResponse(bufferedJson, requestedTools, stream, {
        cid: ctx.cid,
        created: ctx.created,
        model,
        idSeed: "pplx",
      });
    } else if (stream) {
      finalResponse = new Response(buildStreamingResponse(chunks, ctx), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    } else {
      finalResponse = await buildNonStreamingResponse(chunks, ctx);
    }

    return {
      response: finalResponse,
      url: PPLX_SSE_ENDPOINT,
      headers,
      transformedBody: pplxBody,
    };
  }
}
