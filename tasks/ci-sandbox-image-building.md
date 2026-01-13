---
state: todo
tags:
  - infrastructure
  - ci
priority: medium
size: medium
---

# CI-based Sandbox Image Building

## Context

Currently, the sandbox Dockerfile clones the iterate repo at build time:

```dockerfile
RUN git clone https://github.com/iterate/iterate.git /iterate-repo && \
    cd /iterate-repo && \
    pnpm install
```

Then at container startup, entry.ts fetches the latest:

```typescript
execSync("git fetch origin main", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
execSync("git reset --hard origin/main", { cwd: ITERATE_REPO_PATH, stdio: "inherit" });
```

This works but has issues:

1. Docker layer caching means build-time clone can be stale
2. Runtime fetch adds startup latency
3. The pattern is a bit awkward

## Proposed Solution

Build the sandbox image in CI on every push to main:

1. CI workflow triggers on push to main
2. Build sandbox image with current code (no git clone needed - use COPY)
3. Push to container registry (GitHub Container Registry?)
4. Tag with commit SHA and `latest`

Benefits:

- Image always contains the code it was built from (no staleness)
- No runtime git fetch needed
- Faster container startup
- Cleaner Dockerfile

## Changes Required

1. **Dockerfile**: Replace git clone with COPY of the repo

   ```dockerfile
   COPY . /iterate-repo
   RUN cd /iterate-repo && pnpm install
   ```

2. **entry.ts**: Remove `cloneAndSetupIterateRepo()` git fetch/reset logic for production
   - Keep the fallback clone for cases where /iterate-repo doesn't exist
   - Dev mode (ITERATE_DEV=true) already skips git operations

3. **CI workflow**: Create `.github/workflows/build-sandbox.yml`
   - Build on push to main
   - Push to ghcr.io/iterate/sandbox:latest and ghcr.io/iterate/sandbox:<sha>

4. **Daytona/production config**: Update to pull from registry instead of building locally

## Notes

- Local dev workflow (bind mounts) is unaffected
- May want to also build on PR for testing, but don't push to `latest`
