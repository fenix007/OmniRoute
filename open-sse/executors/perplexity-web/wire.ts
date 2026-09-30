// Pure Perplexity wire protocol: consts, types, SSE parsing, request/query building,
// and citation rendering. No host state/fetch/auth.
import { randomUUID } from "crypto";

export const PPLX_SSE_ENDPOINT = "https://www.perplexity.ai/rest/sse/perplexity_ask";
// Perplexity's current request schema version (sent in params.version). Perplexity rejects
// stale versions with HTTP 400 — keep this in lockstep with the website's payload.
export const PPLX_API_VERSION = "2.18";
// Block use-cases the current web client advertises. The schematized API (use_schematized_api)
// validates the request shape, so this must be present (mirrors the browser request body).
export const PPLX_SUPPORTED_BLOCK_USE_CASES = [
  "answer_modes",
  "media_items",
  "knowledge_cards",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "sports_widgets",
  "news_widgets",
  "shopping_widgets",
  "jobs_widgets",
  "search_result_widgets",
  "inline_images",
  "inline_assets",
  "placeholder_cards",
  "diff_blocks",
  "inline_knowledge_cards",
  "entity_group_v2",
  "refinement_filters",
  "canvas_mode",
  "maps_preview",
  "answer_tabs",
  "price_comparison_widgets",
  "preserve_latex",
  "generic_onboarding_widgets",
  "in_context_suggestions",
  "pending_followups",
  "inline_claims",
  "unified_assets",
  "workflow_steps",
  "workflow_widgets",
  "navigation_results",
  "background_agents",
];
// Perplexity's live SSE terminator (not OpenAI's `data: [DONE]`). Using the wrong
// EOF symbol can truncate or hang the Firefox-TLS stream tailer before answer
// chunks land — which surfaces as "Provider returned empty content".
export const PPLX_STREAM_EOF_SYMBOL = "event: end_of_stream";
// Firefox 148 — must match the `firefox_148` TLS profile used by perplexityTlsClient.
// A mismatched UA vs TLS fingerprint is itself a Cloudflare bot signal (issue #2459).
export const PPLX_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0";

// mode / model_preference pairs — every entry posts mode:"copilot", like the live
// www.perplexity.ai client does when a model is picked from the catalog.
//
// mode:"search" must NOT be used here. The backend now downgrades it to CONCISE and
// drops model_preference entirely, answering with status:"FAILED" and the text
// "Error in processing query." Verified against a paid `subscription_tier: "max"`
// account: mode:"search" + claude50sonnet → {"mode":"CONCISE","status":"FAILED"},
// while mode:"copilot" + the same preference → {"mode":"COPILOT",
// "display_model":"claude50sonnet"} and a normal stream. Same for every other
// catalog model, so "search" breaks the whole catalog, not just one entry.
export const MODEL_MAP: Record<string, [string, string]> = {
  // pplx-auto/pplx-sonar were already on "copilot" (with "search", pplx-sonar maps to
  // "experimental" — that model no longer streams answer-text blocks for many
  // sessions → empty content, issue #6955).
  "pplx-auto": ["copilot", "pplx_pro"],
  "pplx-sonar": ["copilot", "turbo"],
  "pplx-gpt-5.6-terra": ["copilot", "gpt56_terra"],
  "pplx-gpt-5.6-sol": ["copilot", "gpt56_sol"],
  "pplx-gemini": ["copilot", "gemini37flash"],
  "pplx-sonnet": ["copilot", "claude50sonnet"],
  // Perplexity's catalog moved Opus to 5.0; claude48opus is still accepted but
  // answers from the older model.
  "pplx-opus": ["copilot", "claude50opus"],
  "pplx-glm": ["copilot", "glm_5_2"],
  // The current Kimi K3 catalog entry only exposes its reasoning model.
  "pplx-kimi": ["copilot", "kimik3thinking"],
  "pplx-grok-4.6": ["copilot", "grok46low"],
  "pplx-nemotron": ["copilot", "nv_nemotron_3_ultra"],
  // Legacy fork ids kept so existing callers keep resolving after the catalog refresh.
  "pplx-gpt-5.4": ["copilot", "gpt54"],
  "pplx-gpt": ["copilot", "gpt55"],
  // Deep Research is its own backend mode (not a model preference under copilot).
  "pplx-deep-research": ["research", "pplx_alpha"],
};

export const RESEARCH_MODE = "research";

export const THINKING_MAP: Record<string, string> = {
  "pplx-gpt-5.6-terra": "gpt56_terra_thinking",
  "pplx-gpt-5.6-sol": "gpt56_sol_thinking",
  "pplx-gemini": "gemini37flashthinking",
  "pplx-sonnet": "claude50sonnetthinking",
  "pplx-opus": "claude50opusthinking",
  "pplx-kimi": "kimik3thinking",
  "pplx-grok-4.6": "grok46medium",
  "pplx-gpt-5.4": "gpt54_thinking",
  "pplx-gpt": "gpt55_thinking",
};

// Eats the space before the marker so "text [1] more" cleans to "text more".
// Never squash runs of spaces here: the non-streaming path (tool mode always)
// would flatten code indentation (#13968).
export const CITATION_RE = / ?\[\d+\]/g;
export const GROK_TAG_RE = /<grok:[^>]*>.*?<\/grok:[^>]*>/gs;
export const GROK_SELF_RE = /<grok:[^>]*\/>/g;
export const XML_DECL_RE = /<[?]xml[^?]*[?]>/g;
export const RESPONSE_TAG_RE = /<\/?response\b[^>]*>/gi;
export const MULTI_NL = /\n{3,}/g;

// A citation marker and a subscript are spelled the same way, so citation
// cleanup has to skip anything that is code: fenced blocks, <tool> payloads and
// inline spans. Order matters — closed regions first, then the unterminated
// tails (a stream cut off mid-answer), and the inline span last so the third
// backtick of a fence is never taken for an empty `` span.
export const CODE_SPAN_RE =
  /(```[\s\S]*?```|<tool>[\s\S]*?<\/tool>|```[\s\S]*$|<tool>[\s\S]*$|`[^`\n]+`)/g;

// ─── Helpers ────────────────────────────────────────────────────────────────

// cleanResponse() runs over the whole answer before tool mode parses <tool>
// text into tool_calls, so an unguarded CITATION_RE turned `arr[0]` into `arr`
// in rendered code blocks and in tool-call arguments alike (#14121).
export function stripCitations(text: string): string {
  // String.split with a capturing group interleaves the delimiters at odd
  // indices; those are the protected regions and pass through untouched.
  return text
    .split(CODE_SPAN_RE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(CITATION_RE, "")))
    .join("");
}

// ─── Sources and citation rendering ─────────────────────────────────────────

/**
 * How `[n]` markers in the answer are rendered. `clean` (default) keeps the historical
 * behaviour of stripping them; `numbered` keeps them so they index into `citations`
 * (the Perplexity API contract); `markdown` turns them into `[n](url)` links.
 */
export type CitationMode = "clean" | "numbered" | "markdown";

export const CITATION_MODES: readonly CitationMode[] = ["clean", "numbered", "markdown"];

export interface PplxSource {
  title: string;
  url: string;
  snippet?: string;
  date?: string;
}

const MARKER_RE = /\[(\d+)\]/g;

/** Apply `fn` to the prose parts of `text`, leaving code spans and <tool> payloads intact. */
function mapProse(text: string, fn: (prose: string) => string): string {
  return text
    .split(CODE_SPAN_RE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

export function renderCitations(text: string, mode: CitationMode, sources: PplxSource[]): string {
  if (mode === "numbered") return text;
  if (mode === "clean") return stripCitations(text);
  return mapProse(text, (prose) =>
    prose.replace(MARKER_RE, (marker, num: string) => {
      const source = sources[Number.parseInt(num, 10) - 1];
      return source ? `[${num}](${source.url})` : marker;
    })
  );
}

// A trailing fragment that may still become a citation marker once the next chunk
// arrives (" ", " [", "[1", " [12"). Streaming holds it back so markers are rendered
// whole instead of leaking half-stripped.
const PENDING_MARKER_RE = / ?\[\d*$| $/;

/**
 * Incremental citation renderer for streaming. Renders the cumulative answer and
 * emits only the new suffix, so a marker split across chunks is handled like the
 * non-streaming path. `sources` can grow while streaming; `finish()` flushes the tail.
 */
export class StreamingCitationRenderer {
  private raw = "";
  private emitted = 0;

  constructor(
    private readonly mode: CitationMode,
    private readonly sources: () => PplxSource[]
  ) {}

  push(delta: string): string {
    this.raw += delta;
    const pending = PENDING_MARKER_RE.exec(this.raw);
    const stable = pending ? this.raw.slice(0, pending.index) : this.raw;
    return this.emit(stable);
  }

  finish(): string {
    return this.emit(this.raw);
  }

  private emit(text: string): string {
    const rendered = cleanResponse(renderCitations(text, this.mode, this.sources()), false, true);
    if (rendered.length <= this.emitted) return "";
    const out = rendered.slice(this.emitted);
    this.emitted = rendered.length;
    return out;
  }
}

/**
 * Remove Perplexity markup from answer text. Citation markers are stripped unless
 * `keepCitations` is set (the caller already rendered them via renderCitations).
 */
export function cleanResponse(text: string, strip = true, keepCitations = false): string {
  let t = text;
  t = t.replace(XML_DECL_RE, "");
  if (!keepCitations) t = stripCitations(t);
  t = t.replace(GROK_TAG_RE, "");
  t = t.replace(GROK_SELF_RE, "");
  t = t.replace(RESPONSE_TAG_RE, "");
  if (strip) {
    t = t.replace(MULTI_NL, "\n\n");
    t = t.trim();
  }
  return t;
}

// ─── SSE types ──────────────────────────────────────────────────────────────

export interface PplxDiffPatch {
  op?: string;
  path?: string;
  value?: unknown;
}

export interface PplxBlock {
  intended_usage?: string;
  markdown_block?: {
    answer?: string;
    chunks?: string[];
    progress?: string;
    chunk_starting_offset?: number;
  };
  // Schematized API (use_schematized_api) streams block updates as RFC-6902
  // JSON-patch diffs against a target field (e.g. markdown_block) instead of
  // sending the whole block each frame. `field` names the block being patched.
  diff_block?: {
    field?: string;
    patches?: PplxDiffPatch[];
  };
  web_result_block?: {
    web_results?: PplxWebResult[];
  };
  // "Sources" answer tab; carries the same web_results list as web_result_block.
  sources_mode_block?: {
    web_results?: PplxWebResult[];
  };
  plan_block?: {
    steps?: Array<{
      step_type?: string;
      search_web_content?: { queries?: Array<{ query?: string }> };
      read_results_content?: { urls?: string[] };
    }>;
    goals?: Array<{ description?: string }>;
  };
  // Workflow API (`intended_usage: "workflow_root"`). Perplexity moved the answer
  // text here from markdown_block: it now arrives as one WORKFLOW_ITEM_TEXT item
  // whose `text_payload.variant` is "answer", nested under a workflow step. Other
  // variants ("thinking") and item types (queries, sources) are not answer text.
  workflow_block?: PplxWorkflowBlock;
}

export interface PplxWorkflowTextPayload {
  text?: string;
  chunks?: string[];
  variant?: string;
  is_streaming?: boolean;
}

export interface PplxWebResult {
  url?: string;
  name?: string;
  snippet?: string;
  timestamp?: string;
}

export interface PplxWorkflowItem {
  type?: string;
  variant?: string;
  payload?: {
    text_payload?: PplxWorkflowTextPayload;
    // WORKFLOW_ITEM_QUERIES / WORKFLOW_ITEM_SOURCES of a search step (Sep 2026 capture).
    queries_payload?: { queries?: string[] };
    sources_payload?: { sources?: PplxWebResult[] };
    [key: string]: unknown;
  };
}

export interface PplxWorkflowStep {
  status?: string;
  title?: string;
  tool_name?: string;
  items?: PplxWorkflowItem[];
}

export interface PplxWorkflowBlock {
  status?: string;
  steps?: PplxWorkflowStep[];
}

export interface PplxUpsellInformation {
  name?: string;
  upsell_type?: string;
  title?: string;
  description?: string;
  cta?: string;
}

export interface PplxStreamEvent {
  status?: string;
  final?: boolean;
  text?: string;
  blocks?: PplxBlock[];
  backend_uuid?: string;
  // Thread write capability returned with every answer; follow-ups send it back
  // together with last_backend_uuid to append to the same thread.
  read_write_token?: string;
  web_results?: PplxWebResult[];
  error_code?: string;
  error_message?: string;
  display_model?: string;
  upsell_information?: PplxUpsellInformation;
}

// ─── SSE parsing ────────────────────────────────────────────────────────────

export async function* readPplxSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): AsyncGenerator<PplxStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let readerFinished = false;
  let readerCancelRequested = false;

  const cancelReader = (reason: unknown) => {
    if (readerFinished || readerCancelRequested) return;
    readerCancelRequested = true;
    // Cancellation is a client-facing latency boundary. Request upstream cleanup once, but never
    // await a hostile underlying source whose cancel hook does not settle.
    void reader.cancel(reason).catch(() => undefined);
  };
  const handleAbort = () => cancelReader(signal?.reason ?? "perplexity_stream_aborted");
  if (signal?.aborted) handleAbort();
  else signal?.addEventListener("abort", handleAbort, { once: true });

  function flush(): PplxStreamEvent | null | "done" {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n");
    dataLines = [];
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return "done";
    try {
      return JSON.parse(trimmed) as PplxStreamEvent;
    } catch {
      return null;
    }
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) {
        readerFinished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const parsed = flush();
          if (parsed === "done") return;
          if (parsed) yield parsed;
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        if (line === "event: end_of_stream") {
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) {
      dataLines.push(buffer.trim().slice(5).trimStart());
    }
    const tail = flush();
    if (tail && tail !== "done") yield tail;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    cancelReader(signal?.reason ?? "perplexity_stream_reader_closed");
    try {
      reader.releaseLock();
    } catch {
      // A hostile source may keep its cancel promise pending; the lock can be released later by GC.
    }
  }
}

// ─── OpenAI → Perplexity translation ────────────────────────────────────────

export interface ParsedMessages {
  systemMsg: string;
  history: Array<{ role: string; content: string }>;
  currentMsg: string;
}

export function parseOpenAIMessages(messages: Array<Record<string, unknown>>): ParsedMessages {
  let systemMsg = "";
  const history: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";

    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "text")
        .map((c) => String(c.text || ""))
        .join(" ");
    }
    if (!content.trim()) continue;

    if (role === "system") {
      systemMsg += content + "\n";
    } else if (role === "user" || role === "assistant") {
      history.push({ role, content });
    }
  }

  let currentMsg = "";
  if (history.length > 0 && history[history.length - 1].role === "user") {
    currentMsg = history.pop()!.content;
  }

  return { systemMsg, history, currentMsg };
}

export interface PplxRequestOptions {
  /** BCP-47 answer/search locale, e.g. "ru-RU". Defaults to en-US. */
  language?: string;
  /** Enables Perplexity local search around this point (places, "near me"). */
  coordinates?: { latitude: number; longitude: number };
  /** Thread write token from the previous answer; sent with last_backend_uuid. */
  readWriteToken?: string | null;
}

export function buildPplxRequestBody(
  query: string,
  dslQuery: string,
  mode: string,
  modelPref: string,
  followUpUuid: string | null,
  requestId: string,
  options: PplxRequestOptions = {}
): Record<string, unknown> {
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  // Mirrors the current www.perplexity.ai/rest/sse/perplexity_ask request body. Perplexity's
  // schematized API validates this shape; an outdated version or missing required fields → HTTP 400.
  const params: Record<string, unknown> = {
    attachments: [],
    language: options.language || "en-US",
    timezone: tz,
    search_focus: "internet",
    sources: ["web"],
    frontend_uuid: requestId,
    mode,
    model_preference: modelPref,
    is_related_query: false,
    is_sponsored: false,
    frontend_context_uuid: crypto.randomUUID(),
    prompt_source: "user",
    query_source: followUpUuid ? "followup" : "home",
    is_incognito: true,
    local_search_enabled: Boolean(options.coordinates),
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: PPLX_SUPPORTED_BLOCK_USE_CASES,
    client_coordinates: options.coordinates
      ? {
          location_lat: options.coordinates.latitude,
          location_lng: options.coordinates.longitude,
          name: "",
        }
      : null,
    mentions: [],
    dsl_query: dslQuery && dslQuery.trim() ? dslQuery : query,
    skip_search_enabled: true,
    is_nav_suggestions_disabled: false,
    source: "default",
    always_search_override: false,
    override_no_search: false,
    client_search_results_cache_key: requestId,
    should_ask_for_mcp_tool_confirmation: true,
    supports_tool_approval_modal: true,
    browser_agent_allow_once_from_toggle: false,
    force_enable_browser_agent: false,
    supported_features: ["browser_agent_permission_banner_v1.1"],
    extended_context: false,
    version: PPLX_API_VERSION,
    rum_session_id: crypto.randomUUID(),
  };

  // Only present on follow-ups (matches the browser, which omits it for a fresh query).
  if (followUpUuid) {
    params.last_backend_uuid = followUpUuid;
    if (options.readWriteToken) params.read_write_token = options.readWriteToken;
  }

  return {
    query_str: query,
    params,
  };
}

const SEARCH_HINT = "You have built-in web search. Answer questions directly using search results.";

/**
 * Whether to append {@link SEARCH_HINT} to the caller's system message.
 *
 * It used to be unconditional. Perplexity's answer engine is search-first anyway, and
 * for coding clients the sentence leaks into replies as meta-commentary ("I need to
 * search before responding per my instructions"), so it is now opt-in via
 * `OMNIROUTE_PPLX_SEARCH_HINT`. Read per call rather than at module load so the flag
 * can be flipped without restarting the server (and so tests can toggle it).
 */
function searchHintEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.OMNIROUTE_PPLX_SEARCH_HINT ?? "");
}

export function buildQuery(parsed: ParsedMessages, followUpUuid: string | null): string {
  if (followUpUuid) {
    const sys = parsed.systemMsg.trim();
    const hint = searchHintEnabled() ? `\n\n${SEARCH_HINT}` : "";
    const contract = sys ? `${sys}${hint}` : "";
    return contract ? `${contract}\n\n${parsed.currentMsg}` : parsed.currentMsg;
  }

  const obj: Record<string, unknown> = {};
  if (parsed.systemMsg.trim()) {
    obj.instructions = searchHintEnabled()
      ? [parsed.systemMsg.trim(), SEARCH_HINT]
      : [parsed.systemMsg.trim()];
  }
  if (parsed.history.length > 0) {
    obj.history = parsed.history;
  }
  if (parsed.currentMsg) {
    obj.query = parsed.currentMsg;
  } else if (parsed.history.length === 0) {
    obj.query = "";
  }
  const json = JSON.stringify(obj);
  return json.length > 96000 ? json.slice(-96000) : json;
}
