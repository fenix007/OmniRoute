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
