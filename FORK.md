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
| ci(fork): fork-image-fenix007.yml                                        | —               | fork-only                                                                                                                                            |

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
