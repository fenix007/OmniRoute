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
