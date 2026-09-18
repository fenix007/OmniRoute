# fenix007/OmniRoute — stable fork

Frozen distribution: upstream `v3.8.48` plus a small owned patch set. Upstream
releases after 3.8.48 are unstable for our deployment (ai-router), so prod runs
this fork instead of `diegosouzapw/omniroute`.

## Branches and tags

- `stable` — the branch prod images are built from: `v3.8.48` + patch set.
- `main` — tracks upstream for PR work; never deployed.
- Release tags: `3.8.48-fork.N` (deliberately **not** `v*`, so inherited
  upstream workflows — docker-publish, electron-release — never fire).

## Patch set on top of v3.8.48

| Commit                                                                   | Upstream PR     | What                                                                                                                                                 |
| ------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix(executors): disable parallel tools for Codex Responses Lite          | #7171 (merged)  | cherry-pick                                                                                                                                          |
| feat(providers): add xAI OAuth PKCE provider                             | #7399 (merged)  | cherry-pick                                                                                                                                          |
| fix(api): enforce image generation API key auth                          | #8306 (merged)  | cherry-pick                                                                                                                                          |
| fix(affinity): evict the sticky session pin on a combo per-model timeout | #10016 (merged) | cherry-pick, adapted (3.8.48 lacks the 3.8.50 dispatch seam context)                                                                                 |
| fix(api): retry Codex image generation by account                        | #8307 (open)    | port of the functional subset; the model-access matcher also unwraps raw JSON error strings (3.8.48 codex handler has no sanitizeImageProviderError) |
| fix(codex): strip sampling params from native Responses passthrough      | #12585 (open)   | adapted: delete `temperature` and `top_p` at the existing 3.8.48 passthrough boundary without importing the newer shared param-rule refactor         |
| fix(chat): reject non-object message entries with HTTP 400               | #12644 (open)   | adapted at the existing 3.8.48 early guard so malformed chat payloads cannot reach translators and surface as HTTP 500                               |
| ci(fork): fork-image-fenix007.yml                                        | —               | fork-only                                                                                                                                            |

Owned OpenCode Go protocol/catalog alignment (fork.16):

| Change                                                              | Upstream issue | What                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix(opencode): route every live Go model through its documented API | #12196         | fork-only: sync all 34 live model ids; route GPT/Grok/Muse through Responses and MiniMax/Qwen through Messages; keep DeepSeek on Chat; add provider-scoped family fallbacks for models discovered before the next sync |

Production on the pre-fix `sha-35359a0` image returned HTTP 500 for
`gpt-5.6-luna` and rejected `grok-4.6` as unsupported for `oa-compat`. The
executor defaulted every model missing from the static registry to
`/chat/completions`, while the upstream requires `/responses` for both models.
The shared fallback lives in `getModelTargetFormat`, so chatCore translates the
request body to the same format that `OpencodeExecutor` uses to choose the URL.

The `v3.8.50` registry was not copied wholesale: it puts DeepSeek V4 Pro and
Flash on Responses, but the current official OpenCode Go endpoint table assigns
both to Chat Completions. Baseline production tests also reached both through
the Chat endpoint and stopped only at the workspace's explicit China-hosting
opt-in gate.

Sources: `open-sse/config/providers/registry/opencode/go/index.ts`,
`open-sse/config/providerModels.ts`. Tests:
`tests/unit/opencode-go-catalog-alignment.test.ts`,
`tests/unit/opencode-executor.test.ts`, `tests/unit/chatcore-target-format.test.ts`.

OpenCode Go quota API backport (fork.17):

| Change                                              | Upstream PR | What                                                                                                                                                                        |
| --------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feat(quota): use the official OpenCode Go usage API | #12124      | adapted: query `/zen/go/v1/usage` with the connection API key, parse rolling/weekly/monthly windows, bind the cache to the key, and remove obsolete Z.AI/dashboard scraping |

The frozen 3.8.48 dispatcher sent OpenCode Go keys to a Z.AI quota endpoint. A valid
chat/models key therefore rendered an `Unknown` quota card asking for a workspace ID
and auth cookie. OpenCode now exposes an API-key-authenticated usage endpoint, so the
provider limits page no longer needs browser credentials. The fetcher remains
fail-open and keeps the existing 60-second successful-response cache.

Sources: `open-sse/services/opencodeQuotaFetcher.ts`,
`open-sse/services/usage.ts`, `open-sse/services/opencodeOllamaUsage.ts`. Tests:
`tests/unit/opencode-quota-fetcher.test.ts`,
`tests/unit/opencode-go-usage.test.ts`, and the provider modal UI suites.

Tier-1 upstream fixes ported from release/v3.8.50 (fork.2):

| Commit                                                                        | Upstream PR | What                                                                                         |
| ----------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| fix(codex): surface capacity errors embedded in 200-OK SSE streams            | #6710       | cherry-pick (trivial conflicts)                                                              |
| fix(codex): non-stream chat 502 "Response body is already used"               | #7526       | cherry-pick clean                                                                            |
| fix(codex): check content-type before touching response.body in peek          | #7570       | cherry-pick clean                                                                            |
| fix(sse): preserve parallel_tool_calls for GPT-5.6 under Codex Responses Lite | #7957       | cherry-pick clean                                                                            |
| fix(sse): bound Codex SSE peek read with per-read timeout                     | #8043       | cherry-pick clean                                                                            |
| fix(images): refresh OAuth and rotate accounts on 401                         | #9231       | adapted: merged with our #8307 port (fallback wrapper first, codex model-access retry after) |
| fix(settings,auth): debugMode false + no rotation on model-unsupported 400    | #10525      | cherry-pick + carried the settings.ts debugMode default flip the squash relied on            |

Tier-2 combo resilience + Tier-3 quota/limiter fixes ported from release/v3.8.50 (fork.3):

| Commit                                                                         | Upstream PR  | What                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix(combo): recover provider circuit breaker from HALF_OPEN on success         | #9207        | adapted: kept this base's `getProviderConnections` import and file-size baseline                                                                                                 |
| fix(rate-limit): patch Bottleneck doExpire capacity leak                       | #9328        | cherry-pick (baseline only)                                                                                                                                                      |
| fix(combo): network errors must not trip provider circuit breaker              | #9342        | adapted: the breaker guard lives inline in chat.ts here (upstream extracted chatPredicates.ts later)                                                                             |
| fix(rate-limit): separate queue wait from execution timeout                    | #9164        | partial: classifier + combo leg only; the connection-cooldown leg rides on a later 3.8.50 predicate refactor                                                                     |
| fix(combo): clear LKGP pin when its target fails                               | #10034       | adapted: took `clearLKGP` only, plus a matching `invalidateCachedLKGP` in readCache (that helper landed in the #10137 commit)                                                    |
| fix(combo): isolate session stickiness by combo                                | #10137       | adapted: namespaced BOTH call sites (this base still has the main path in combo.ts, not targetResolution.ts)                                                                     |
| fix(combo): make failoverBeforeRetry actually skip the same-model retry        | #10217       | cherry-pick clean                                                                                                                                                                |
| fix(account-fallback): classify 'insufficient credits' as credits-exhausted    | #10116       | cherry-pick clean                                                                                                                                                                |
| fix(sse): clear quota_exhausted cooldown when the real window recovers         | #10534       | cherry-pick clean                                                                                                                                                                |
| fix(resilience): retry Codex pre-output transport failures on the same account | #9708/#10792 | adapted: replaced the 3.8.50 `connectionFilterStatus` map with a transport-cooled id set, dropped the managed-lease call and the lease/occupancy locals this base has no use for |

Owned fixes for upstream error-status masking (fork.4):

A provider failure was reaching clients as HTTP 200 with the error buried in the body,
so every client whose retry logic keys on 429/5xx treated a transient overload as a
terminal success. Two independent layers caused it, and both are fixed here.

| Change                                                                    | Upstream PR | What                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix(sse): widen the keepalive commit window so failures keep their status | —           | fork-only: `resolveKeepaliveThreshold` default 2000 → 4000 ms (`OMNIROUTE_KEEPALIVE_THRESHOLD_MS`, capped at 4500 to stay under reqwest's ~5s idle read). Handler failures inside the window keep a real status. |
| fix(sse): carry the upstream status in the in-band error frame            | —           | fork-only: `annotateErrorFrameStatus` adds `error.status` when the stream already committed to 200 — the only signal a client has left to tell a retryable 5xx/429 from a terminal 4xx.                          |
| fix(sse): emit Anthropic-shaped error frames on /v1/messages              | —           | fork-only: `buildErrorFrameData` + `errorFrameFormat: "anthropic"`. Claude clients branch on `error.type` and ignore an OpenAI-shaped frame, so a failure previously read as a stream that simply ended.         |
| feat(compat): global stream default for machine clients                   | —           | fork-only: `OMNIROUTE_STREAM_DEFAULT_MODE=json` applies the existing per-key `streamDefaultMode` fallback deployment-wide, so wildcard-Accept clients that omit `stream` take the status-preserving JSON path.   |

Sources: `open-sse/utils/keepaliveThreshold.ts`, `open-sse/utils/earlyStreamKeepalive.ts`,
`open-sse/utils/aiSdkCompat.ts`, `src/app/api/v1/messages/route.ts`. Tests:
`tests/unit/keepalive-threshold.test.ts`, `tests/unit/earlyStreamKeepalive.test.ts`,
`tests/unit/resolve-stream-flag.test.ts`.

Gaps in that patch set, found while verifying fork.5 on production (fork.6):

| Change                                                              | Upstream PR | What                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fix(sse): emit Responses-shaped error frames on /v1/responses       | —           | fork-only: `errorFrameFormat: "responses"` + `errorFrameEventName`. fork.4 fixed the payload shape but not the event name, and Responses API clients (Codex CLI) terminate a stream on `response.failed` and ignore `event: error` whatever it carries — the fork.4 frame was inert. |
| fix(compat): let the deployment-wide stream default reach real keys | —           | fork-only: `normalizeStreamDefaultMode` no longer treats a stored `legacy` as an explicit opt-out. Every key row is created with `stream_default_mode = "legacy"`, so `OMNIROUTE_STREAM_DEFAULT_MODE=json` was dead code on any real database — verified inert on production.        |

The stream-default change is a deliberate semantics trade: with the env var set, a key
cannot pin itself back to SSE through its stored mode. Per-request opt-in (`stream: true`
or `Accept: text/event-stream`) still outranks the deployment default, which is how a
caller that needs SSE asks for it.

Sources: `open-sse/utils/earlyStreamKeepalive.ts`, `open-sse/utils/aiSdkCompat.ts`,
`src/app/api/v1/responses/route.ts`. Tests: `tests/unit/earlyStreamKeepalive.test.ts`,
`tests/unit/resolve-stream-flag.test.ts`.

Owned fix for false client-disconnect accounting (fork.7):

| Change                                                          | Upstream PR | What                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fix(sse): detect the terminal marker in oversized client chunks | —           | fork-only: `noteClientChunk` matched against a 4096-char trailing window, so any terminal SSE event whose own payload exceeded it lost the marker. `clientTerminalSeen` stayed false and a fully delivered stream was finalized as 499 `request_signal_aborted` with 0 tokens. |

Production evidence (24h to 2026-08-21T13:49Z): 171 of 176 non-2xx call-logs were 499.
Matching call-logs 1:1 against nginx over a 2h window on `/v1/responses` (211 vs 212
entries), 68 of 72 of those 499s have exactly one same-path nginx line within ±1s and it
is HTTP 200 with a full body; nginx saw a single genuine client abort. Reproduced twice
on prod (combo and direct model, 44–51 chunks, 360–418 KB, read through
`response.completed`, then hard close → logged 499 / 38.9s / 0 tokens); small
single-chunk streams logged 200. The window threshold is exact: a completed-event
payload of 4000 B was detected, 4100 B was not.

Beyond the misreported success rate, the same defect zeroed `tokens.in`/`tokens.out` on
the largest ~5% of requests, which is what ai-router's `lib/omniroute-call-log-sync.ts`
aggregates into quota and `/limits`.

Sources: `open-sse/utils/streamHandler.ts`. Tests: `tests/unit/stream-handler.test.ts`,
`tests/unit/stream-handler-terminal-marker.test.ts`.

Owned fix for `response_format` dropped on the Kiro route (fork.8):

| Change                                                | Upstream PR | What                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fix(kiro): carry response_format into the Kiro prompt | —           | fork-only: `buildKiroPayload` never read `body.response_format`. Kiro has no Structured Output parameter, so the field was dropped with no trace and the model answered with invented property names — every strict-schema caller failed closed. |

`openai-to-claude.ts` and `DefaultExecutor.applyJsonSchemaFallback()` already
describe the schema in the prompt when the upstream cannot enforce it. Kiro had
neither: `KiroExecutor extends BaseExecutor`, not `DefaultExecutor`, so the
fallback was unreachable, and `register(FORMATS.OPENAI, FORMATS.KIRO, …)` is the
single request path into the provider. The contract is now appended to the final
user message as a `<system-reminder>` (Kiro has no `system` role) — at the tail,
where output-format instructions hold best.

Measured on `kr/claude-haiku-4.5` and `kr/claude-sonnet-4.5` against a 19-field
strict schema before the fix: both answered with their own field names
(`match_score`, `concerns`, `interview_topics`), while a 2-field schema passed
only because those two names appeared verbatim in the prompt.

This is best-effort JSON, not constrained decoding, and it cannot become one on
this route: Kiro's only schema-carrying channel is a tool schema, and
`kiroSanitizer` must strip `additionalProperties`, `$ref`/`$defs` and `anyOf`
(Kiro 400s `Improperly formed request` otherwise) — exactly the keywords a
strict schema is built from. `tool_choice` is not forwarded either, so a tool
call cannot be forced. Callers that need enforcement must route to a provider
with native Structured Output.

Sources: `open-sse/translator/request/openai-to-kiro/responseFormat.ts`,
`open-sse/translator/request/openai-to-kiro.ts`,
`open-sse/translator/request/openai-to-kiro/messageHelpers.ts` (gained
`wrapSystemReminder`, moved out of the frozen translator file).
Tests: `tests/unit/kiro-response-format.test.ts`.

Gap in that fix, found verifying fork.8 on production (fork.9):

| Change                                                                   | Upstream PR | What                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix(kiro): strip the JSON code fence when response_format asked for JSON | —           | fork-only: Claude on Kiro honours the prompt-level schema but wraps the object in a ```json fence anyway, so `JSON.parse(message.content)` still failed for a conforming client. |

fork.8 was probed live against a strict schema whose property names never appear
in the prompt. Both `kr/claude-haiku-4.5` and `kr/claude-sonnet-4.5` returned
exactly `residual_gap_score` / `evidence_kind` / `rationale` — the contract
works — and both fenced the object, on every attempt, despite the instruction
forbidding it. Kiro has no `response_format` to enforce, so the fence is
unwrappable only on our side.

`KiroExecutor.execute` now pipes its SSE through `stripJsonFenceFromSse` when the
request carries `response_format: json_schema | json_object`. The stripper
rewrites `delta.content` only — tool-call and reasoning deltas pass through — and
holds back a trailing run of whitespace/backticks so a closing fence can be told
from real content, releasing it as its own chunk just before the finishing chunk.
A normal chat answer keeps its code blocks: without a JSON `response_format` the
wrapper is never installed.

Sources: `open-sse/executors/kiro/jsonFence.ts`, `open-sse/executors/kiro.ts`.
Tests: `tests/unit/kiro-json-fence.test.ts`.

Gap in that fix, found verifying fork.9 on production (fork.10):

| Change                                                        | Upstream PR | What                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fix(kiro): detect the JSON contract on the translated payload | —           | fork-only: fork.9 asked `body.response_format`, but chatCore hands the executor the already-built Kiro payload — the condition was never true and the stripper never installed. Verified inert on production. |

`KiroExecutor.execute` receives `body` **after** the registry translated it
through `buildKiroPayload`, which is why the executor already reads its
`thinkingExpected` hint out of `transformedBody.conversationState`. fork.9's
`wantsJsonOnlyContent(body)` looked for `response_format` on that payload, found
nothing, and left every response fenced — the live probe on fork.9 returned the
same fenced JSON as fork.8.

The translator now leaves `KIRO_JSON_CONTRACT_MARKER`
(`<response_format>json</response_format>`) at the head of the contract it
appends, and `kiroPayloadWantsJsonOnly` looks for it in the built prompt — the
same channel `<thinking_mode>enabled</thinking_mode>` already travels on. The
tests now drive that decision with real `buildKiroPayload` output instead of a
synthetic OpenAI body, which is the gap that let fork.9 ship green.

Sources: `open-sse/executors/kiro/jsonFence.ts`, `open-sse/executors/kiro.ts`,
`open-sse/translator/request/openai-to-kiro/responseFormat.ts`.
Tests: `tests/unit/kiro-json-fence.test.ts`.

Selected release/v3.8.50 and open-PR fixes adapted for our traffic (fork.11):

| Change                                                              | Upstream PR | What                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fix(combo): derive Responses stickiness from `input`                | #7277       | adapted in both standard and round-robin dispatch while retaining the fork.3 `combo.name` namespace                                                                                                                |
| fix(resilience): treat client aborts as local lifecycle failures    | #7908/#8011 | adapted across raw-string/DOM abort status mapping, connection cooldown and provider breakers; fork.3 network/queue exclusions and HALF_OPEN recovery remain intact                                                |
| fix(oauth): keep same-email Codex accounts distinct                 | #7825       | shared matcher across every OAuth completion path; workspace identity wins, otherwise a non-empty `chatgptUserId` must match, while an explicit `connectionId` remains authoritative                               |
| fix(codex): use the catalog's real maximum context window           | #11179      | prefer `max_context_window` and advertise GPT-5.6 Codex as 872K input/context plus 128K output                                                                                                                     |
| fix(sse): fail completed streams that emitted no model content      | #8732       | safety adaptation: a bounded frame gate suppresses the successful terminal and emits the protocol-native error first for OpenAI, Responses and Claude; split and 512-KiB completed events preserve fork.7 behavior |
| fix(sse): do not fabricate plaintext for encrypted reasoning        | #8807       | removes placeholder summary mutation while preserving `encrypted_content` in output-item and completed snapshots                                                                                                   |
| fix(kiro): preserve prose interleaved through parallel tool results | #8931       | defers assistant prose until the result batch is complete, without changing the fork.8–10 JSON contract/marker path                                                                                                |

Sources: `open-sse/services/combo/sessionStickiness.ts`,
`src/shared/utils/circuitBreaker.ts`, `src/lib/oauth/connectionPersistence.ts`,
`src/app/api/providers/[id]/models/discovery/codex.ts`,
`open-sse/utils/streamTerminalGuard.ts`, `open-sse/utils/stream.ts`, and
`open-sse/translator/request/openai-to-kiro/toolResultGrouping.ts`.

The #8732 upstream implementation was not copied literally: it appended an error
after `finish_reason: stop`, `[DONE]`, `response.completed`, or `message_stop`.
Clients are allowed to stop at those markers, so fork.11 withholds only the
terminal frame and guarantees that an empty stream's error is the first terminal
event. Complete keepalives and lifecycle frames continue streaming immediately;
the unfinished-frame buffer is capped at 1 MiB and fails open above the cap.

Quality gates (fork.11): new Kiro and SSE logic was extracted into leaf modules,
so the frozen translator and the 800-line production-file cap remain green without
changing the file-size baseline. The nightly mutation test list also records six
fork tests that had drifted out of `stryker.conf.json`, plus the new abort suite.

Quality gates (fork.8): `check:file-size` froze `openai-to-kiro.ts` at 912 lines,
so the helper lives in a sibling module (`openai-to-kiro/responseFormat.ts`,
alongside `messageHelpers.ts` / `adaptiveThinking.ts`) and the translator ends at
907 — no baseline was touched. Extracting it also dropped `complexity` to 2059
against a 2060 baseline. `check:test-file-size` was red from fork.7
(`stream-handler.test.ts` at 873 > cap 800); its six terminal-marker tests moved
to `stream-handler-terminal-marker.test.ts`, leaving 665 + 237 with the same 27
tests passing.

Quality gates (fork.5):

`check:complexity-ratchets` was red on `stable` from fork.3 onward. Measured per tag:
the cyclomatic baseline (2056) was already 2 behind on pristine `v3.8.48`, and the
ported patches added +1 in fork.2 and +1 in fork.3; the cognitive baseline (890) matched
the base and grew +3 / +2 across the same two tags. fork.3 rebaselined `check:file-size`
for these ports but not the two complexity ratchets, so both were rebaselined to the
measured 2060 / 895 with the per-tag evidence recorded in
`config/quality/complexity-baseline.json` and `config/quality/quality-baseline.json`.
The fork.4 patch set itself added zero violations.

Evaluated and deliberately NOT ported:

| Upstream PR                                                              | Why not                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #10744 (fail over streaming responses terminated with empty completions) | needs the `openAi` SSE-lifecycle tracker from the #7285 rework; validateQuality.ts has diverged by ~357/73 lines, so porting it would drag a large slice of 3.8.50 |

## Upstream review — 2026-09-08

Reviewed against `origin/stable` at `214e687391ce6b3ebb105f93f0027b2f790e9612`.
Queried all 694 upstream PRs updated since 2026-09-01 and all 278 open PRs with
`gh`; shortlisted production-scope changes for diff, test, discussion and exact
head review. These counts describe discovery, not 694 full code reviews.

Adapted [#12863](https://github.com/diegosouzapw/OmniRoute/pull/12863)
(OPEN at the reviewed upstream head):
subtract cached prompt tokens from Gemini-to-Claude `input_tokens`, clamped to
zero. Gemini's `promptTokenCount` includes the cached prefix; Anthropic's
`input_tokens` excludes `cache_read_input_tokens`. Previously a 100-token prompt
with 90 cached tokens was reported as 100 + 90 and counted as 190 by
`getLoggedInputTokens`. The translated usage now reports 10 + 90 = 100.

- Reviewed PR head: `5002c412819bb439ba08df2ed84717459e1c852d`.
- Functional upstream commit: `d59b0d8dbb543d5bd65c3e8402107d36b92369b2`.
- Adaptation after Claude Code CLI / Opus 5 review: keep cache-inclusive
  `prompt_tokens` and `completion_tokens` in the translator's internal state;
  subtract cache only when building the outgoing Anthropic `message_delta`.
  A literal one-line port made full-cache/zero-output usage fall back to an
  estimate and made stream metadata and response-body totals omit cached input.
  Keeping normalized internal usage also preserves the full input for pricing.
  Reject non-finite, negative and nonnumeric cache counters. No shared stream,
  pricing or metadata implementation changes are required.
- Risk: limited to Gemini-to-Anthropic usage accounting. OpenAI prompt totals,
  output/thinking tokens, terminal events and wrapped stream handling retain
  their existing contracts. No equivalent correction existed at the reviewed
  stable head.
- Sources: `open-sse/translator/response/gemini-to-claude.ts` and
  `src/lib/usage/tokenAccounting.ts`.
- Regression coverage: cached/uncached/full-cache prompts, invalid cache counters,
  cache counts above prompt counts and retained usage across wrapped chunks.
  Seven new `createSSEStream` tests exercise fragmented Gemini/Antigravity input,
  emitted Anthropic usage, single terminal events, completion callback totals,
  SSE metadata and pricing, including full-cache prompts with zero or missing
  output counts. Five of these tests failed against the literal one-line port
  and pass with this adaptation. All 83 tests across seven related suites pass.
  `npm run typecheck:core`, scoped ESLint with the existing suppressions,
  Prettier and `git diff --check` pass.

The initial port was held because `check:file-size` found three production and
six test violations already present at the reviewed stable head. The user then
authorized resolving this debt. The size baseline and limits are unchanged:

- Extract response-header helpers from `chatHelpers.ts`, WebSocket header filtering
  from `codex.ts`, and error-status mappings from `streamHandler.ts` into leaf
  modules. Existing exports and all six moved function bodies are preserved.
- Extract response/capability/log fixtures from the chat-pipeline, chatcore
  translation, combo-routing and translator-helper test suites.
- Split translator replay and pure WebDAV scenarios into separately discovered
  unit suites. All 290 original test cases remain. Their bodies are unchanged
  except for the pre-existing combo fallback fixture failure described below.
- The old combo fallback test returned a Claude response to the second OpenAI
  request and expected only two HTTP calls. Update its mock to fail OpenAI by URL
  and assert the current bounded same-account retry from #9708: two OpenAI calls
  with the same credential, followed by Claude. Production retry policy is unchanged.
- Replace eleven moved explicit `any` annotations with typed/unknown fixture
  fields and reduce the corresponding ESLint suppression count from 261 to 250.

The size gate now passes. The combined final run passes all 477 tests across
21 related files. Scoped ESLint, core typecheck, formatting, the explicit-any
budget, docs-sync and tracked-artifact checks pass. The circular-dependency scan
remains advisory; the extracted production modules have no imports and add no cycles.

Other reviewed candidates (statuses and heads as observed on 2026-09-08):

| PR                                                             | Status / head         | Decision for v3.8.48                                                                                                                                                                                                            |
| -------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#12585](https://github.com/diegosouzapw/OmniRoute/pull/12585) | OPEN `3df5ac987679`   | Already adapted: Codex passthrough deletes both sampling parameters before returning. Do not import the later shared-rule refactor.                                                                                             |
| [#12644](https://github.com/diegosouzapw/OmniRoute/pull/12644) | OPEN `faa87c818e23`   | Already adapted: malformed message entries are rejected before dispatch; recorded above.                                                                                                                                        |
| [#12827](https://github.com/diegosouzapw/OmniRoute/pull/12827) | OPEN `cc46f41ecf5c`   | Equivalent client version 0.153.4 already present in `open-sse/config/codexClient.ts` and identity tests through `290a8e722`.                                                                                                   |
| [#12899](https://github.com/diegosouzapw/OmniRoute/pull/12899) | MERGED `cb924f14838b` | Rejected as written: the combo-name allowlist returns true before checking `disableNonPublicModels`. The new tests do not combine those settings; do not weaken key policy.                                                     |
| [#12935](https://github.com/diegosouzapw/OmniRoute/pull/12935) | OPEN `bb3d539829b2`   | Not ported: accepts an empty sentinel with nonstandard Claude `stop_reason: length` for an Ollama/Qwen probe outside production scope; preserve empty-output failure handling.                                                  |
| [#12997](https://github.com/diegosouzapw/OmniRoute/pull/12997) | OPEN `1bfbf8636364`   | Not applicable literally: the affected `imageCombo.ts` success-unwrapping path is absent on this base. Do not introduce later image-combo infrastructure.                                                                       |
| [#12982](https://github.com/diegosouzapw/OmniRoute/pull/12982) | OPEN `a747a81555b4`   | Deferred: depends on the later image-combo path in its tests, which also assert the bare-array response rejected by #12997. Needs direct-handler/Codex-path tests on this base before an independent empty-payload adaptation.  |
| [#12785](https://github.com/diegosouzapw/OmniRoute/pull/12785) | OPEN `af7f3351362b`   | Deferred: missing stop-sequence forwarding is relevant, but the literal nullish fallback can emit `[undefined]` for `stop_sequences: null`. Its three input cases do not establish null/empty/precedence behavior on this base. |
| [#11809](https://github.com/diegosouzapw/OmniRoute/pull/11809) | MERGED `cc4e038bc7e3` | Deferred: changes Kiro account-state policy for a missing-profile 403; upstream classifier tests alone do not verify old-base profile discovery, cooldown and account recovery together.                                        |
| [#12391](https://github.com/diegosouzapw/OmniRoute/pull/12391) | OPEN `895b007c809d`   | Deferred: cleanup runs only on abort; successful attempts that clear their timeout still leave listeners. The test aborts every attempt and does not cover that remaining lifecycle case.                                       |
| [#12737](https://github.com/diegosouzapw/OmniRoute/pull/12737) | OPEN `8dade0d1c7c7`   | Deferred: useful premature-WebSocket-close failure, but it relies on the newer Codex public-error allowlist. Adapt and test the old error boundary before porting; do not copy the file-size rebaseline.                        |
| [#12818](https://github.com/diegosouzapw/OmniRoute/pull/12818) | OPEN `911a18c05afa`   | Deferred: `dispatchPrelude.ts` is absent; old inline pinned dispatch has a different fallback set including 524. Needs old-path credential and pin-cleanup regression coverage.                                                 |
| [#12964](https://github.com/diegosouzapw/OmniRoute/pull/12964) | OPEN `0b7be09f44fe`   | Deferred: `credentialPatterns.ts` is absent; changing a regex in the newer sanitizer does not port its security boundary to this base. A separate old-boundary redaction adaptation is required.                                |

Publication policy for this maintenance: `fork-image-fenix007.yml` publishes on
pushes to `stable`, while the inherited CI/quality workflows target other branches
or manual dispatch. Maintenance commits use `[skip ci]` to suppress push-triggered
image publication after local validation, as documented by
[GitHub Actions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).
No workflow configuration, release tag or deployment is part of this change.

## Upstream review — 2026-09-09

Reviewed from current `origin/stable` at
`e5ed4b10b4f7f88a8dfa8f71650a4ecbee8732e9` after fetching origin and upstream.
`gh` discovery returned 632 PRs updated since 2026-09-02 and 302 open PRs.
These are discovery counts, not full code-review counts. Production candidates
were compared with the previous review, exact PR heads, diffs, available tests,
bodies and discussion/review records. No discussion or submitted review existed
on #13059 at inspection time; its checks did not establish full upstream CI success.

Adapted [#13059](https://github.com/diegosouzapw/OmniRoute/pull/13059)
(OPEN; reviewed head and functional commit
`a596e5543b5ee43bbe49544d0cc7d0466ecf1e0b`): preserve user-defined property names
when traversing Gemini tool and response schemas.

- Applicability: this base lacks the newer `injectObjectType` / `ensureArrayItems`
  phases implicated by the upstream reproduction. However, its existing
  `convertConstToEnum` and `normalizeAdditionalProperties` visitors already treat
  property maps as schema nodes. A required argument named `const` becomes an
  invalid `enum` / `type` entry in the property map; an argument named
  `additionalProperties` disappears, potentially replaced with a required
  placeholder `reason`. No equivalent fix existed in the reviewed stable code.
- Minimal adaptation: apply the PR's schema-map-aware traversal to the existing
  sanitizer phases only. Keep their constraint transformations, numeric enum
  handling, required-field cleanup, local references and empty-object placeholders.
  Do not introduce newer sanitizer phases or change the unsupported-keyword set.
- Risk is confined to request schema normalization shared by Gemini and the
  existing Cloud Code path, including OpenAI JSON response schemas. Authentication,
  account rotation, quota policy and stream/error handling are unchanged.
- New regression suite: `tests/unit/gemini-schema-keyword-properties.test.ts`.
  Twelve tests cover keyword arguments, nested objects/arrays, actual constraints,
  composition/reference expansion, placeholders, input immutability,
  `buildGeminiTools`, and OpenAI/Anthropic request translation with both stream flags.
  The original code reproduced argument corruption before the fix; upstream's
  type-injection tests alone would not reproduce this older-base defect.
- Validation: 115/115 tests across ten relevant schema/helper/request-translator
  suites; scoped ESLint with existing suppressions, `npm run typecheck:core`,
  production/test file-size gates, Prettier and `git diff --check` pass.
  No live provider call or full application build is claimed.

Other candidate decisions (heads/statuses observed during this run):

| PR                                                             | Status / head         | Decision for v3.8.48                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#12931](https://github.com/diegosouzapw/OmniRoute/pull/12931) | OPEN `c0b5f751c56c`   | Its `injectObjectType` phase is absent. The broader existing-phase collision is addressed through #13059 above.                                                                                                                                                          |
| [#12872](https://github.com/diegosouzapw/OmniRoute/pull/12872) | OPEN `27aef816af5d`   | Defer: stripping tuple keywords relies on `ensureArrayItems`, absent here; copying only the two keys can still emit invalid bare arrays.                                                                                                                                 |
| [#13073](https://github.com/diegosouzapw/OmniRoute/pull/13073) | OPEN `02c30a85e906`   | Defer: changes concurrent Codex cooldown persistence and requires later `providers/codexAccountState.ts`, absent here. The draft itself identifies pending concurrency/current-release review.                                                                           |
| [#13069](https://github.com/diegosouzapw/OmniRoute/pull/13069) | OPEN `05cc73e3978e`   | Not applicable literally: repairs the later `runNonStreamingProviderLeg` split, which this fork does not contain. Do not import that pipeline refactor.                                                                                                                  |
| [#13072](https://github.com/diegosouzapw/OmniRoute/pull/13072) | OPEN `dc3e47702d7d`   | The old semantic passthrough already calls `extractSystemRoleMessages`; the newer mid-conversation/directive-only path is absent. No matching regression on this base.                                                                                                   |
| [#13050](https://github.com/diegosouzapw/OmniRoute/pull/13050) | OPEN `6cac8d211036`   | Its web-search branch forces `stream:false`; this base's fallback preparation does not contain that forced-non-streaming branch. Do not import the newer pipeline or file-size rebaseline.                                                                               |
| [#13052](https://github.com/diegosouzapw/OmniRoute/pull/13052) | OPEN `2a3771cb52a7`   | Defer: security-sensitive combo/alias authority redesign also carries #12899 semantics previously rejected here. Requires independent old-base policy/cache integration coverage.                                                                                        |
| [#13047](https://github.com/diegosouzapw/OmniRoute/pull/13047) | OPEN `39bce7bb099c`   | Defer: changes the meaning of configured `minContentLength` for tool-only responses; helper tests do not verify interaction with this fork's empty-output/fallback guards.                                                                                               |
| [#13038](https://github.com/diegosouzapw/OmniRoute/pull/13038) | OPEN `d1e5c39e5aca`   | Defer: diagnostics span later dispatch gates/runtime units and response-header seams. A separate adaptation must establish attempt-count semantics on the old combo loop.                                                                                                |
| [#13008](https://github.com/diegosouzapw/OmniRoute/pull/13008) | OPEN `c5bb91c4b07f`   | Defer: missing quota error-text forwarding exists, but this changes account-wide quota poisoning for API-key providers. Verify the old dispatch/cache recovery path before a separate port; the upstream call-site test inspects source rather than exercising dispatch. |
| [#13083](https://github.com/diegosouzapw/OmniRoute/pull/13083) | OPEN `28488e54e20d`   | Not applicable: the affected custom-node `dailyQuotaResetTimezone` schema is absent on this base.                                                                                                                                                                        |
| [#12964](https://github.com/diegosouzapw/OmniRoute/pull/12964) | MERGED `0b7be09f44fe` | Status advanced to merged; functional head unchanged. The previous old-sanitizer-boundary deferral still applies (`credentialPatterns.ts` absent).                                                                                                                       |
| [#12863](https://github.com/diegosouzapw/OmniRoute/pull/12863) | OPEN `5002c412819b`   | Already adapted by `e5ed4b10b`; no new functional head.                                                                                                                                                                                                                  |

The open heads for #12585, #12644, #12827, #12785, #12737, #12818,
#12391, #12982, #12997 and #12935 still match the previous review, so its
ported/equivalent/deferred decisions stand. Unrelated UI, Electron, i18n, A2A,
MCP and out-of-scope provider work was excluded from the port.

This maintenance uses the `[skip ci]` publication policy documented above.
No tag, publish dispatch or deployment is part of this change.

## Releasing an image

```bash
git switch stable
# ...commit the change...
git tag -a 3.8.48-fork.N -m "..." && git push origin stable 3.8.48-fork.N
```

CI (`.github/workflows/fork-image-fenix007.yml`) builds `runner-base` for
linux/amd64 + linux/arm64 (separate jobs — the Dockerfile's shared apt cache
mounts deadlock in a single multi-platform build) and publishes
`ghcr.io/fenix007/omniroute:3.8.48-fork.N` (+ `stable`, `sha-*`).

ai-router side: set `OMNIROUTE_IMAGE=ghcr.io/fenix007/omniroute` and
`OMNIROUTE_VERSION=3.8.48-fork.N` in `.env`, then `make omniroute-update`.

Each release pulls another ~1.8 GB image and the VPS keeps every one of them.
Pulling fork.8 filled `/` to 100% on 217.65.79.232, and OmniRoute crash-looped on
`Unable to inspect existing database at /app/data/storage.sqlite: disk I/O error`
until the old images were removed. Check `df -h /` before updating and drop the
tags older than the current one plus its rollback:

```bash
docker rmi ghcr.io/fenix007/omniroute:3.8.48-fork.<old>
```

## Taking a newer upstream release later

```bash
git fetch upstream --tags
git switch -c stable-vX.Y.Z vX.Y.Z
git cherry-pick <patch commits from stable that upstream still lacks>
# run: npx tsc -p tsconfig.typecheck-core.json + the patch-set tests
# then point `stable` at the result and tag X.Y.Z-fork.1
```

Keep patches atomic and keep sending them upstream as PRs — every merged PR
shrinks the set to carry.

## Upstream review — 2026-09-11

Reviewed against `origin/stable` at `a39b546fa0f88e4ee6eac4fe918ac24b8fcdabaa` after
fetching both remotes. Discovery queried 591 upstream PRs updated from
2026-09-04 through 2026-09-11 and 394 open PRs; production-scope candidates
were inspected with their exact head, diff, discussion, tests and checks.

Adapted [#13110](https://github.com/diegosouzapw/OmniRoute/pull/13110)
(MERGED; reviewed head `3bc27642825e8477d6db32db0dbc41abb0f30167`, functional
commit `ef69a48c3d372ca3b166ff67e41f8fa5c1e9c184`): add `contentSchema` and
`unevaluatedItems` to the existing Claude JSON-schema sanitizer's schema-valued
slots. On this base a depth-truncation marker in either slot reached Anthropic as
a string and caused a native Messages schema HTTP 400. The minimal two-key
adaptation recursively replaces only recognized placeholders with `{}`; valid
boolean schemas, `required`, `additionalProperties`, descriptions and caller
input retain their values.

Adapted [#13274](https://github.com/diegosouzapw/OmniRoute/pull/13274)
(OPEN; reviewed head `ad7d4bf9e804e9163daf85315390716f26243b54`, functional
commit `e0ba8167994807e7d4aee7767b5faf583a488ffe`): redact every normalized
`*api-key` header spelling in both request-pipeline capture and persisted log
payloads. Gemini's `x-goog-api-key`, Azure's `api-key`, and ElevenLabs'
`xi-api-key` were otherwise retained in logs. Rate-limit headers remain readable.

[#13304](https://github.com/diegosouzapw/OmniRoute/pull/13304) (OPEN
`2b3e63a470d0bc35f608819f9b4480c9fc7b587f`) was reviewed for Responses-to-Chat
web-search replay. This frozen base already silently ignores the metadata item
and preserves the paired `function_call_output`; a regression test records that
equivalent behavior, so no production patch is needed.

Other production-scope candidates were not ported:

| PR                                                             | Status / head       | Decision for v3.8.48                                                                                                                                    |
| -------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#13285](https://github.com/diegosouzapw/OmniRoute/pull/13285) | OPEN `5eede28fa29d` | Defer: the existing stream terminal guard changes empty-stream ordering; the later Claude lifecycle integration must be adapted and tested as one unit. |
| [#13278](https://github.com/diegosouzapw/OmniRoute/pull/13278) | OPEN `1430ded91039` | Not applicable: the later native Responses passthrough/context-handoff seam is absent.                                                                  |
| [#13193](https://github.com/diegosouzapw/OmniRoute/pull/13193) | OPEN `36a2c23e4758` | Defer: Kiro host fallback must be validated against this fork's Builder-ID auth and response-format adaptations.                                        |
| [#13174](https://github.com/diegosouzapw/OmniRoute/pull/13174) | OPEN `475b75faa373` | Defer: changes Kiro historic tool-call semantics; preserve current parallel-tool grouping until old-base transcript coverage exists.                    |
| [#13171](https://github.com/diegosouzapw/OmniRoute/pull/13171) | OPEN `994a0258a9a2` | Not applicable: this base lacks the later JSON-to-SSE timeout wrapper seam.                                                                             |
| [#13141](https://github.com/diegosouzapw/OmniRoute/pull/13141) | OPEN `993203c9d49d` | Already equivalent: current `cooldownUntilMs` normalizes numeric epochs before combo eligibility.                                                       |
| [#13128](https://github.com/diegosouzapw/OmniRoute/pull/13128) | OPEN `3b5729a2e813` | Defer: custom-tool choice depends on later Responses tool pipeline behavior.                                                                            |
| [#13059](https://github.com/diegosouzapw/OmniRoute/pull/13059) | OPEN `8e98197411d6` | Already adapted by `fc71f2da9`; no new functional head.                                                                                                 |
| [#13221](https://github.com/diegosouzapw/OmniRoute/pull/13221) | OPEN `f6569f387481` | Defer: quota-aware candidate expansion is a later routing architecture.                                                                                 |
| [#13217](https://github.com/diegosouzapw/OmniRoute/pull/13217) | OPEN `462732bfab99` | Defer: alters combo key persistence and live-key filtering together.                                                                                    |
| [#13224](https://github.com/diegosouzapw/OmniRoute/pull/13224) | OPEN `65c05ca1cb79` | Already equivalent to the current Codex catalog/plan-tier refresh patch.                                                                                |
| [#13069](https://github.com/diegosouzapw/OmniRoute/pull/13069) | OPEN `84649e928895` | Not applicable: `runNonStreamingProviderLeg` is absent.                                                                                                 |
| [#13050](https://github.com/diegosouzapw/OmniRoute/pull/13050) | OPEN `5f2f2fab076b` | Still not applicable: no forced-non-streaming web-search branch exists here.                                                                            |
| [#12818](https://github.com/diegosouzapw/OmniRoute/pull/12818) | OPEN `5bc9f2cb71c7` | Existing deferral stands: 401 pin fallthrough needs old combo pin/failure coverage.                                                                     |

All unrelated UI, Electron, i18n, A2A, MCP and out-of-scope provider PRs were
excluded. No tag, publish dispatch or deployment is part of this maintenance.

## 2026-09-18 — Local quality-gate repair (pending publication)

Source: the owned stable patch set at
[`34f4d1ea5dd8b35ef5ebe1cb8eb66ef44980af52`](https://github.com/fenix007/OmniRoute/commit/34f4d1ea5dd8b35ef5ebe1cb8eb66ef44980af52).
This is local maintenance requested after the upstream review was blocked; it is
not an upstream port and does not update the frozen v3.8.48 base.

- Extract existing auth, token-health, Codex, speech, image-alias, chat and modal
  helpers, and split existing tests. File-size baselines and caps are unchanged.
- Move the fork-version route suite into the existing Vitest UI collector. Its
  authentication and disabled-updater checks now run through the normal script.
- Separate the shared Codex reset-credit cache from the HTTP/refresh service.
  Routing reads the same singleton, with the same 15-minute TTL; legacy exports
  remain compatible. This removes the routing-to-provider-mutation import cycle
  that pulled every executor into core auth typechecking.
- Correct nullable date-helper input types and remove obsolete ESLint
  suppressions; no typecheck configuration, test expectations, auth policy or
  production dependency is weakened.

Validation: file-size, test-discovery, core typecheck, lint, DB rules and error
helper gates pass. Focused auth/refresh, Codex, audio, image, provider validation,
chat/cache and reset-credit tests pass. The complete native unit run reports
23,239 passing, 51 failing and 14 skipped tests: 48 failures reproduce on clean
stable, and the remaining three models.dev network timeouts pass on retry (22/22
in that suite). The production build passes with worktree-local dependencies.
Full evidence is recorded in repository-local automation memory. Publication remains
blocked while mandatory checks are red. No release, image or deployment is part
of this maintenance; any eventual maintenance push must use the existing
`[skip ci]` policy.

Opus 5 review follow-up: import the extracted `ImageModelAliasEntry` type explicitly
and close the image test's SQLite connection before removing its owned temporary
DATA_DIR. The cleanup probe leaves a directory before the fix and none afterward;
image tests pass 44/44. Expanded typechecking of all changed production entrypoints
now has no new diagnostics against the base (1,129 baseline, 1,128 current); the
remaining diagnostics are pre-existing. Core typecheck, focused ESLint, size and
discovery gates pass. The existing full-unit failures still block publication.

Baseline test repair follow-up: normalize shell checkout policy with `.gitattributes`
and make text-based fixtures tolerate CRLF without rewriting golden content. Isolate
DNS tests behind an injected privileged-operation seam, reset semantic/provider
cooldown state in the shared chat harness, and replace the live models.dev unit probe
with deterministic HTTP-contract coverage. Combo routing preserves model-lockout enforcement while skipping lower-level
same-account retries when the combo requests failover first, propagating aborts during
fallback delay, and avoiding a second emergency fallback attempt. The account-only `quota-deadline` strategy is no longer exposed as
a combo strategy. Dependency and environment contracts now document the existing gRPC
and live-STT implementation. The complete unit suite passes, including dashboard and
serial collectors; core typecheck, lint, file-size, discovery and production build
remain green. This remains local fork maintenance, not an upstream port.
