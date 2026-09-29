// Pure Perplexity wire protocol: consts, types, SSE parsing, request/query building,
// content extraction. Extracted verbatim from perplexity-web.ts. No host state/fetch/auth.
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

// ─── Content extraction ─────────────────────────────────────────────────────

export interface ContentChunk {
  delta?: string;
  answer?: string;
  backendUuid?: string;
  thinking?: string;
  error?: string;
  /** Structured error code for quota / rate-limit surfaces (e.g. quota_exhausted). */
  errorCode?: string;
  /**
   * Suggested cooldown when quota is classified before the HTTP stream is committed.
   * Once SSE 200 starts, a late error cannot retroactively add status or Retry-After metadata.
   */
  resetSeconds?: number;
  done?: boolean;
}

/** Default cooldown when Perplexity reports advanced-model weekly quota exhaustion
 * without an explicit reset clock (weekly window is account-side). Long enough that
 * rotation skips the account instead of hammering it every few seconds. */
export const PPLX_ADVANCED_QUOTA_DEFAULT_RESET_SECONDS = 6 * 60 * 60;

// The schematized API delivers the answer text in blocks whose `intended_usage`
// is either the aggregate `ask_text` or per-segment `ask_text_<n>_markdown`
// (older builds used names merely containing "markdown"). All converge on the
// same answer, so we lock onto a single primary usage to avoid double-counting.
export function isAnswerTextUsage(usage: string): boolean {
  return (
    usage === "ask_text" || /^ask_text_\d+_markdown$/.test(usage) || usage.includes("markdown")
  );
}

// Reconstructed state for one answer-text block, built up from diff patches
// (streaming) or a materialized markdown_block (final COMPLETED frame).
export interface MarkdownAccumulator {
  chunks: string[];
}

// Apply a markdown_block diff_block patch set. Perplexity sends an initial
// `{op:"replace", path:"", value:{chunks:[...]}}` then incremental
// `{op:"add", path:"/chunks/<n>", value:"..."}` frames. We only need the
// chunks array; joining it yields the cumulative answer text.
export function applyMarkdownDiff(acc: MarkdownAccumulator, patches: PplxDiffPatch[]): void {
  for (const patch of patches) {
    const path = patch.path ?? "";
    if (path === "") {
      const value = (patch.value ?? {}) as { chunks?: unknown; answer?: unknown };
      if (Array.isArray(value.chunks)) {
        acc.chunks = value.chunks.map((c) => String(c));
      } else if (typeof value.answer === "string" && value.answer.length > 0) {
        // Some COMPLETED/replace frames only materialize `answer` (no chunks).
        acc.chunks = [value.answer];
      } else {
        acc.chunks = [];
      }
      continue;
    }
    const chunkMatch = /^\/chunks\/(\d+)$/.exec(path);
    if (chunkMatch && typeof patch.value === "string") {
      const idx = Number.parseInt(chunkMatch[1], 10);
      acc.chunks[idx] = patch.value;
    }
  }
}

/** Answer-text items carry this `variant`; "thinking" and friends are not answer text. */
const WORKFLOW_ANSWER_VARIANT = "answer";

/**
 * mdState key for one workflow answer item. Keyed per step+item so the
 * `/chunks/<k>` indices of two concurrent items can never overwrite each other.
 */
function workflowUsageKey(stepIdx: number, itemIdx: number): string {
  return `workflow_root:${stepIdx}:${itemIdx}`;
}

function isAnswerItem(item: PplxWorkflowItem | undefined): boolean {
  if (!item) return false;
  const payloadVariant = item.payload?.text_payload?.variant;
  return (payloadVariant ?? item.variant) === WORKFLOW_ANSWER_VARIANT;
}

/**
 * Seed an accumulator from a materialized answer item. Chunks win over `text`:
 * the terminal frame can carry a `text` that lags the chunk track (same
 * precedence markdown_block already uses for `chunks` over `answer`).
 */
function seedFromAnswerItem(acc: MarkdownAccumulator, item: PplxWorkflowItem): void {
  const tp = item.payload?.text_payload;
  if (!tp) return;
  if (Array.isArray(tp.chunks) && tp.chunks.length > 0) {
    acc.chunks = tp.chunks.map((c) => String(c));
  } else if (typeof tp.text === "string" && tp.text.length > 0) {
    acc.chunks = [tp.text];
  }
}

function ensureAcc(mdState: Map<string, MarkdownAccumulator>, key: string): MarkdownAccumulator {
  let acc = mdState.get(key);
  if (!acc) {
    acc = { chunks: [] };
    mdState.set(key, acc);
  }
  return acc;
}

/**
 * Apply a `field: "workflow_block"` diff patch set.
 *
 * Live shapes (Aug 2026 capture, pplx-auto / mode=copilot):
 *   {op:"add",     path:"/steps/1",                                        value:{items:[…]}}
 *   {op:"add",     path:"/steps/0/items/1",                                value:{…}}
 *   {op:"add",     path:"/steps/1/items/0/payload/text_payload/chunks/2",  value:"…"}
 *   {op:"replace", path:"/steps/1/items/0/payload/text_payload/text",      value:"…"}
 *
 * Only answer-variant items are accumulated; step/status patches are ignored.
 */
export function applyWorkflowDiff(
  mdState: Map<string, MarkdownAccumulator>,
  patches: PplxDiffPatch[]
): void {
  for (const patch of patches) {
    const path = patch.path ?? "";

    // Whole step materialized — pick up every answer item it carries.
    const stepMatch = /^\/steps\/(\d+)$/.exec(path);
    if (stepMatch) {
      const stepIdx = Number.parseInt(stepMatch[1], 10);
      const step = (patch.value ?? {}) as PplxWorkflowStep;
      (step.items ?? []).forEach((item, itemIdx) => {
        if (!isAnswerItem(item)) return;
        seedFromAnswerItem(ensureAcc(mdState, workflowUsageKey(stepIdx, itemIdx)), item);
      });
      continue;
    }

    // Single item appended to an existing step.
    const itemMatch = /^\/steps\/(\d+)\/items\/(\d+)$/.exec(path);
    if (itemMatch) {
      const item = (patch.value ?? {}) as PplxWorkflowItem;
      if (!isAnswerItem(item)) continue;
      const key = workflowUsageKey(
        Number.parseInt(itemMatch[1], 10),
        Number.parseInt(itemMatch[2], 10)
      );
      seedFromAnswerItem(ensureAcc(mdState, key), item);
      continue;
    }

    // Incremental chunk append — the streaming hot path.
    const chunkMatch = /^\/steps\/(\d+)\/items\/(\d+)\/payload\/text_payload\/chunks\/(\d+)$/.exec(
      path
    );
    if (chunkMatch && typeof patch.value === "string") {
      const key = workflowUsageKey(
        Number.parseInt(chunkMatch[1], 10),
        Number.parseInt(chunkMatch[2], 10)
      );
      // Only extend a track already seeded by an answer item: a chunk patch
      // carries no variant, so an unseeded key could be a "thinking" track.
      const acc = mdState.get(key);
      if (!acc) continue;
      acc.chunks[Number.parseInt(chunkMatch[3], 10)] = patch.value;
      continue;
    }

    // Terminal `text` materialization — only used when no chunks arrived.
    const textMatch = /^\/steps\/(\d+)\/items\/(\d+)\/payload\/text_payload\/text$/.exec(path);
    if (textMatch && typeof patch.value === "string" && patch.value.length > 0) {
      const key = workflowUsageKey(
        Number.parseInt(textMatch[1], 10),
        Number.parseInt(textMatch[2], 10)
      );
      const acc = mdState.get(key);
      if (!acc || acc.chunks.join("").length > 0) continue;
      acc.chunks = [patch.value];
    }
  }
}

/** Accumulate every answer item of a materialized workflow_block. */
export function applyWorkflowBlock(
  mdState: Map<string, MarkdownAccumulator>,
  workflow: PplxWorkflowBlock
): void {
  (workflow.steps ?? []).forEach((step, stepIdx) => {
    (step.items ?? []).forEach((item, itemIdx) => {
      if (!isAnswerItem(item)) return;
      seedFromAnswerItem(ensureAcc(mdState, workflowUsageKey(stepIdx, itemIdx)), item);
    });
  });
}

/**
 * Extract the assistant answer from the COMPLETED frame's `text` step-blob.
 *
 * Live shape (Jul 2026 browser capture):
 *   text: '[{"step_type":"FINAL","content":{"answer":"{\\"answer\\":\\"Hi…\\",\\"chunks\\":[…]}"}}]'
 *
 * The nested `content.answer` is often a *double-encoded* JSON string. Used as a
 * safety net when diff_block / markdown_block frames were missed (truncated TLS
 * stream, FINAL-only delivery, etc.) so we don't return empty content.
 */
export function extractAnswerFromFinalText(text: string | undefined | null): string | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Plain non-JSON text (legacy non-schematized path).
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const steps = Array.isArray(parsed) ? parsed : [parsed];
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as Record<string, unknown>;
      const stepType = String(s.step_type || s.stepType || "");
      if (stepType && stepType !== "FINAL") continue;

      const content = s.content as Record<string, unknown> | string | undefined;
      let rawAnswer: unknown =
        typeof content === "string"
          ? content
          : content && typeof content === "object"
            ? (content as Record<string, unknown>).answer
            : undefined;
      if (rawAnswer == null && typeof s.answer === "string") rawAnswer = s.answer;
      if (rawAnswer == null) continue;

      if (typeof rawAnswer === "string") {
        const inner = rawAnswer.trim();
        if (!inner) continue;
        // Double-encoded JSON blob: {"answer":"…","chunks":[…],"structured_answer":[…]}
        if (inner.startsWith("{") || inner.startsWith("[")) {
          try {
            const obj = JSON.parse(inner) as Record<string, unknown>;
            if (typeof obj.answer === "string" && obj.answer.trim()) return obj.answer;
            if (Array.isArray(obj.chunks) && obj.chunks.length > 0) {
              return obj.chunks.map((c) => String(c)).join("");
            }
            if (Array.isArray(obj.structured_answer)) {
              const joined = (obj.structured_answer as Array<Record<string, unknown>>)
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("");
              if (joined.trim()) return joined;
            }
          } catch {
            // Fall through — treat as plain markdown.
          }
        }
        return inner;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Pick the longest reconstructed answer across dual ask_text / ask_text_N_markdown tracks. */
export function longestMarkdownAnswer(
  mdState: Map<string, MarkdownAccumulator>,
  preferredUsage: string | null
): { usage: string | null; answer: string } {
  let bestUsage: string | null = preferredUsage;
  let bestAnswer = preferredUsage ? (mdState.get(preferredUsage)?.chunks ?? []).join("") : "";

  for (const [usage, acc] of mdState) {
    const joined = (acc.chunks ?? []).join("");
    if (joined.length > bestAnswer.length) {
      bestAnswer = joined;
      bestUsage = usage;
    }
  }
  return { usage: bestUsage, answer: bestAnswer };
}

/** Extract goal descriptions from a materialized or diff-patched plan block. */
function extractPlanGoalDescriptions(block: PplxBlock): string[] {
  const out: string[] = [];
  if (block.plan_block?.goals) {
    for (const goal of block.plan_block.goals) {
      const desc = goal.description ?? "";
      if (desc) out.push(desc);
    }
  }
  // Live multi-step streams send plan as RFC-6902 diff patches, not plan_block.
  const patches = block.diff_block?.patches;
  if (Array.isArray(patches)) {
    for (const patch of patches) {
      const value = patch.value as { goals?: Array<{ description?: string }> } | undefined;
      if (value && Array.isArray(value.goals)) {
        for (const goal of value.goals) {
          const desc = goal.description ?? "";
          if (desc) out.push(desc);
        }
      }
    }
  }
  return out;
}

export interface PplxQuotaError {
  message: string;
  errorCode: string;
  resetSeconds: number;
}

function formatUpsellError(upsell: PplxUpsellInformation | undefined): PplxQuotaError | null {
  if (!upsell) return null;
  const name = String(upsell.name || "");
  // advanced_models_quota_low = weekly advanced-model (Opus/Sonnet/GPT/…) budget
  // exhausted. Browser still often downgrades to turbo; when no answer text is
  // produced we must surface this instead of a silent "empty content" 502.
  if (
    name === "advanced_models_quota_low" ||
    name.includes("quota") ||
    String(upsell.upsell_type || "")
      .toUpperCase()
      .includes("UPGRADE")
  ) {
    const title = (upsell.title || "").trim();
    const desc = (upsell.description || "").trim();
    const detail = [title, desc].filter(Boolean).join(" — ");
    const base = detail
      ? `Perplexity advanced model quota exhausted: ${detail}`
      : "Perplexity advanced model quota exhausted for this account this week. Use pplx-auto/pplx-sonar, wait for the weekly reset, or upgrade (Perplexity Max).";
    const resetSeconds = PPLX_ADVANCED_QUOTA_DEFAULT_RESET_SECONDS;
    // Append human "reset after …" so VibeProxy's existing message parsers
    // (and accountFallback.formatRetryAfter consumers) pick up the cooldown.
    const h = Math.floor(resetSeconds / 3600);
    const m = Math.floor((resetSeconds % 3600) / 60);
    const s = resetSeconds % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return {
      message: `${base} (reset after ${parts.join(" ")})`,
      errorCode: "quota_exhausted",
      resetSeconds,
    };
  }
  return null;
}

// ─── Stream side-channel state (sources, thread continuation) ──────────────

/**
 * Mutable side-channel filled while extractContent runs. Callers read it at any
 * point (the streaming citation renderer needs sources mid-stream) and after the
 * generator finishes (thread continuation, sources for the final response).
 */
export interface PplxStreamState {
  sources: PplxSource[];
  backendUuid: string | null;
  readWriteToken: string | null;
  /** Deep Research asked for clarification instead of answering. */
  clarifyingQuestions: string[];
}

export function createStreamState(): PplxStreamState {
  return { sources: [], backendUuid: null, readWriteToken: null, clarifyingQuestions: [] };
}

export const PPLX_LOGGED_OUT_ERROR_CODE = "session_logged_out";

// Seen live: `logged_out_thread_sign_in` (upsell_type LOGIN) and, after a few
// anonymous questions, `fraud_authwall_upsell`. Both mean the cookie is not a session.
function isSignInUpsell(upsell: PplxUpsellInformation | undefined): boolean {
  if (!upsell) return false;
  const name = String(upsell.name || "");
  return (
    /^logged_out|authwall/i.test(name) ||
    String(upsell.upsell_type || "").toUpperCase() === "LOGIN" ||
    /LOGIN/i.test(String((upsell as { cta?: unknown }).cta || ""))
  );
}

function toSources(results: PplxWebResult[] | undefined): PplxSource[] {
  const out: PplxSource[] = [];
  for (const r of results ?? []) {
    if (!r || typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
    const source: PplxSource = { title: String(r.name || r.url), url: r.url };
    if (typeof r.snippet === "string" && r.snippet) source.snippet = r.snippet;
    if (typeof r.timestamp === "string" && r.timestamp) source.date = r.timestamp.slice(0, 10);
    out.push(source);
  }
  return out;
}

function mergeSources(into: PplxSource[], add: PplxSource[]): void {
  const seen = new Set(into.map((s) => s.url));
  for (const s of add) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    into.push(s);
  }
}

const CLARIFY_RE = /clarif/i;

/** Collect question strings from an arbitrary clarification payload. */
function collectQuestions(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || value == null) return;
  if (typeof value === "string") {
    const q = value.trim();
    if (q.includes("?") && !out.includes(q)) out.push(q);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectQuestions(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectQuestions(v, out, depth + 1);
    }
  }
}

/**
 * Deep Research clarification on the legacy `text` step-blob path:
 * `[{"step_type":"RESEARCH_CLARIFYING_QUESTIONS","content":{"questions":[…]}}]`.
 */
export function extractClarifyingQuestionsFromText(text: string | undefined | null): string[] {
  if (!text || !text.trim().startsWith("[")) return [];
  try {
    const steps = JSON.parse(text) as Array<Record<string, unknown>>;
    const out: string[] = [];
    for (const step of Array.isArray(steps) ? steps : []) {
      if (CLARIFY_RE.test(String(step?.step_type || ""))) collectQuestions(step.content, out);
    }
    return out;
  } catch {
    return [];
  }
}

interface WorkflowProgress {
  queries: string[];
  sources: PplxSource[];
  questions: string[];
}

function readWorkflowItem(item: PplxWorkflowItem | undefined, progress: WorkflowProgress): void {
  if (!item || typeof item !== "object") return;
  const payload = item.payload ?? {};
  for (const q of payload.queries_payload?.queries ?? []) {
    if (typeof q === "string" && q.trim()) progress.queries.push(q.trim());
  }
  progress.sources.push(...toSources(payload.sources_payload?.sources));
  if (CLARIFY_RE.test(String(item.type || "")) || CLARIFY_RE.test(String(item.variant || ""))) {
    collectQuestions(payload, progress.questions);
  }
}

function readWorkflowStep(step: PplxWorkflowStep | undefined, progress: WorkflowProgress): void {
  if (!step || typeof step !== "object") return;
  const clarifyStep = CLARIFY_RE.test(String(step.tool_name || ""));
  for (const item of step.items ?? []) {
    readWorkflowItem(item, progress);
    if (clarifyStep) collectQuestions(item?.payload, progress.questions);
  }
}

/** Search queries, sources and clarifications carried by a workflow block or its diff. */
function workflowProgress(block: PplxBlock): WorkflowProgress {
  const progress: WorkflowProgress = { queries: [], sources: [], questions: [] };
  for (const step of block.workflow_block?.steps ?? []) readWorkflowStep(step, progress);
  if (block.diff_block?.field === "workflow_block") {
    for (const patch of block.diff_block.patches ?? []) {
      const path = patch.path ?? "";
      if (/^\/steps\/\d+$/.test(path)) {
        readWorkflowStep(patch.value as PplxWorkflowStep, progress);
      } else if (/^\/steps\/\d+\/items\/\d+$/.test(path)) {
        readWorkflowItem(patch.value as PplxWorkflowItem, progress);
      }
    }
  }
  return progress;
}

export async function* extractContent(
  eventStream: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null,
  state: PplxStreamState = createStreamState()
): AsyncGenerator<ContentChunk> {
  // Sources in citation order: web_result_block is what [n] indexes into; the
  // Sources tab and per-step workflow sources are fallbacks for frames without it.
  let webResultSources: PplxSource[] = [];
  let tabSources: PplxSource[] = [];
  const workflowSources: PplxSource[] = [];
  const refreshSources = () => {
    state.sources = webResultSources.length
      ? webResultSources
      : tabSources.length
        ? tabSources
        : workflowSources;
  };
  let fullAnswer = "";
  let backendUuid: string | null = null;
  let seenLen = 0;
  const seenThinking = new Set<string>();
  // Per-usage reconstructed answer-text blocks + the locked primary usage.
  const mdState = new Map<string, MarkdownAccumulator>();
  let primaryUsage: string | null = null;
  let lastEventText: string | undefined;
  let lastUpsell: PplxUpsellInformation | undefined;

  for await (const event of readPplxSseEvents(eventStream, signal)) {
    if (event.error_code || event.error_message) {
      yield {
        error: event.error_message || `Perplexity error: ${event.error_code}`,
        errorCode: event.error_code,
        done: true,
      };
      return;
    }

    if (event.backend_uuid) backendUuid = state.backendUuid = event.backend_uuid;
    if (event.read_write_token) state.readWriteToken = event.read_write_token;
    if (event.text) lastEventText = event.text;
    if (event.upsell_information) lastUpsell = event.upsell_information;

    // An expired/invalid cookie is served as an anonymous visitor: HTTP 200 with a
    // "sign in" upsell and a canned "sign up and retry" answer in the first frame.
    // Surface it as an auth failure instead of passing that text off as the answer.
    if (isSignInUpsell(event.upsell_information)) {
      yield {
        error:
          "Perplexity session is logged out — the session cookie is expired or invalid. Re-paste your __Secure-next-auth.session-token.",
        errorCode: PPLX_LOGGED_OUT_ERROR_CODE,
        done: true,
      };
      return;
    }

    const blocks = event.blocks ?? [];
    for (const block of blocks) {
      const usage = block.intended_usage ?? "";

      if (block.web_result_block?.web_results) {
        webResultSources = toSources(block.web_result_block.web_results);
      }
      if (block.sources_mode_block?.web_results) {
        tabSources = toSources(block.sources_mode_block.web_results);
      }

      // Thinking + sources: workflow search steps (queries, visited sources) and
      // Deep Research clarifications. Research runs for minutes before any answer
      // text, so this progress is also what keeps the stream alive and "ready".
      if (block.workflow_block || block.diff_block?.field === "workflow_block") {
        const progress = workflowProgress(block);
        mergeSources(workflowSources, progress.sources);
        for (const q of progress.questions) {
          if (!state.clarifyingQuestions.includes(q)) state.clarifyingQuestions.push(q);
        }
        for (const qr of progress.queries) {
          if (seenThinking.has(qr)) continue;
          seenThinking.add(qr);
          yield { thinking: `Searching: ${qr}`, backendUuid: backendUuid ?? undefined };
        }
        for (const src of progress.sources.slice(0, 3)) {
          if (seenThinking.has(src.url)) continue;
          seenThinking.add(src.url);
          yield { thinking: `Reading: ${src.url}`, backendUuid: backendUuid ?? undefined };
        }
      }

      // Thinking: search steps
      if (usage === "pro_search_steps" && block.plan_block?.steps) {
        for (const step of block.plan_block.steps) {
          if (step.step_type === "SEARCH_WEB") {
            for (const q of step.search_web_content?.queries ?? []) {
              const qr = q.query ?? "";
              if (qr && !seenThinking.has(qr)) {
                seenThinking.add(qr);
                yield { thinking: `Searching: ${qr}`, backendUuid: backendUuid ?? undefined };
              }
            }
          } else if (step.step_type === "READ_RESULTS") {
            for (const u of (step.read_results_content?.urls ?? []).slice(0, 3)) {
              if (u && !seenThinking.has(u)) {
                seenThinking.add(u);
                yield { thinking: `Reading: ${u}`, backendUuid: backendUuid ?? undefined };
              }
            }
          }
        }
      }

      // Thinking: plan goals (materialized plan_block OR live multi-step diff_block)
      if (usage === "plan") {
        for (const desc of extractPlanGoalDescriptions(block)) {
          if (desc && !seenThinking.has(desc)) {
            seenThinking.add(desc);
            yield { thinking: desc, backendUuid: backendUuid ?? undefined };
          }
        }
      }

      // Content: workflow_block answer items. Perplexity migrated the answer text
      // here from markdown_block, so this must run BEFORE the isAnswerTextUsage
      // gate — the carrying usage is "workflow_root", which that gate rejects.
      if (block.workflow_block) {
        applyWorkflowBlock(mdState, block.workflow_block);
        continue;
      }
      if (block.diff_block?.field === "workflow_block") {
        applyWorkflowDiff(mdState, block.diff_block.patches ?? []);
        continue;
      }

      // Content: answer-text blocks (schematized diff frames OR materialized
      // markdown_block on the final COMPLETED frame).
      if (!isAnswerTextUsage(usage)) continue;
      // Only apply markdown patches when the diff targets markdown_block (or field
      // is absent on older frames). Ignore answer_tabs/plan/etc. diffs that share
      // the same event but different field names.
      if (
        block.diff_block &&
        block.diff_block.field &&
        block.diff_block.field !== "markdown_block"
      ) {
        continue;
      }
      let acc = mdState.get(usage);
      if (!acc) {
        acc = { chunks: [] };
        mdState.set(usage, acc);
      }

      if (block.diff_block && Array.isArray(block.diff_block.patches)) {
        applyMarkdownDiff(acc, block.diff_block.patches);
      } else if (block.markdown_block) {
        const mb = block.markdown_block;
        if (Array.isArray(mb.chunks) && mb.chunks.length > 0) {
          acc.chunks = mb.chunks.map((c) => String(c));
        } else if (typeof mb.answer === "string" && mb.answer.length > 0) {
          acc.chunks = [mb.answer];
        }
      }

      // Prefer the aggregate `ask_text` block; otherwise lock the first seen.
      if (usage === "ask_text") {
        primaryUsage = "ask_text";
      } else if (!primaryUsage) {
        primaryUsage = usage;
      }
    }

    refreshSources();

    // Emit at most one content delta per event from the longest reconstructed
    // answer track (ask_text and ask_text_0_markdown often stream in parallel).
    const { answer: currentAnswer } = longestMarkdownAnswer(mdState, primaryUsage);
    if (currentAnswer.length > seenLen) {
      const delta = currentAnswer.slice(seenLen);
      fullAnswer = currentAnswer;
      seenLen = currentAnswer.length;
      yield { delta, answer: fullAnswer, backendUuid: backendUuid ?? undefined };
    }

    // Legacy fallback: a plain non-JSON `text` field with no structured blocks.
    // The schematized API's `text` field is a JSON step-blob (not user-facing),
    // so only use it when there are no answer-text blocks at all.
    if (!primaryUsage && mdState.size === 0 && blocks.length === 0 && event.text) {
      const t = event.text.trim();
      const looksLikeJson = t.startsWith("{") || t.startsWith("[");
      if (!looksLikeJson && t.length > seenLen) {
        const delta = t.slice(seenLen);
        fullAnswer = t;
        seenLen = t.length;
        yield { delta, answer: fullAnswer, backendUuid: backendUuid ?? undefined };
      }
    }

    // Only stop on the terminal COMPLETED frame. A `final:true` flag can appear
    // on a still-PENDING frame BEFORE the COMPLETED frame that materializes the
    // full markdown_block — breaking on `final` there drops the answer.
    if (event.status === "COMPLETED") {
      // Safety net: if diff/markdown tracks stayed empty, pull the answer from
      // the COMPLETED frame's double-encoded FINAL step blob.
      if (!fullAnswer.trim()) {
        const fromText = extractAnswerFromFinalText(event.text || lastEventText);
        if (fromText && fromText.trim()) {
          const delta = fromText.slice(seenLen);
          fullAnswer = fromText;
          seenLen = fromText.length;
          if (delta) {
            yield { delta, answer: fullAnswer, backendUuid: backendUuid ?? undefined };
          }
        }
      }
      break;
    }
  }

  // Cancellation is not a successful terminal event. In particular, do not synthesize the final
  // `done` chunk: streaming callers use that signal to emit stop/[DONE] and persist the session.
  if (signal?.aborted) return;

  for (const q of extractClarifyingQuestionsFromText(lastEventText)) {
    if (!state.clarifyingQuestions.includes(q)) state.clarifyingQuestions.push(q);
  }

  // End-of-stream without a COMPLETED frame still try the last text blob.
  if (!fullAnswer.trim() && lastEventText) {
    const fromText = extractAnswerFromFinalText(lastEventText);
    if (fromText && fromText.trim()) {
      fullAnswer = fromText;
    }
  }

  // No answer materialized through any recovery path — if the stream surfaced
  // an advanced-model quota upsell, report it clearly instead of a silent
  // empty-content response so callers can cooldown/rotate the account.
  if (!fullAnswer.trim()) {
    const upsellErr = formatUpsellError(lastUpsell);
    if (upsellErr) {
      yield {
        error: upsellErr.message,
        errorCode: upsellErr.errorCode,
        resetSeconds: upsellErr.resetSeconds,
        done: true,
        backendUuid: backendUuid ?? undefined,
      };
      return;
    }
  }

  yield { delta: "", answer: fullAnswer, backendUuid: backendUuid ?? undefined, done: true };
}

// ─── OpenAI SSE format ──────────────────────────────────────────────────────

export function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
