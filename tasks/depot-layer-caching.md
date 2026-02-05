---
state: todo
priority: high
size: medium
tags:
  - ci
  - docker
  - performance
  - daytona
---

# Use Depot Layer Caching for Sandbox Docker Builds

Currently our CI uses Depot GitHub Actions runners (`depot-ubuntu-24.04-arm-4`) but still uses `docker buildx build` for image builds. This means we're not getting Depot's main value: **persistent layer caching on fast NVMe SSDs**.

## Current State

- `build-docker-image.ts` uses `docker buildx build` with:
  - Local cache: `type=local,src=${localCacheDir}`
  - Registry cache: `type=registry,ref=ghcr.io/iterate/sandbox:buildcache`
- Both require slow network transfers for cache restore/save
- Cache is not shared across builds or dev machines
- Daytona can't pull from ghcr.io efficiently (10+ min pulls noted in code comments)

## Goals

1. Replace `docker buildx build` with `depot build` for automatic persistent layer caching
2. Share the same layer cache across CI and all developer machines
3. Use Depot Registry for Daytona to pull images from (global CDN, fast pulls)

Benefits:

- **No cache transfer**: Cache lives on builder, not transferred over network
- **Instant cache restore**: Cache on fast NVMe attached to builder VM
- **Shared across CI + devs**: All CI runs AND local dev machines share the same project cache
- **Native ARM**: No QEMU emulation for `linux/arm64`
- **Up to 40x faster builds**
- **Fast Daytona pulls**: Depot Registry backed by global CDN

## Implementation

### 1. Create Depot Project

- Create project at [depot.dev](https://depot.dev) for sandbox image builds
- Add OIDC trust relationship for GitHub Actions (Depot dashboard → Project Settings → Trust relationships)

### 2. Update Workflows

Add `id-token: write` permission and use `depot/setup-action`:

```typescript
// local-docker-test.ts, build-sandbox-image.ts
permissions: {
  contents: "read",
  "id-token": "write",  // for depot OIDC auth
},
// ...
uses("depot/setup-action@v1"),
```

### 3. Option A: Use depot/build-push-action (simpler)

Replace `pnpm os docker:build` step with:

```typescript
{
  name: "build-docker-image",
  uses: "depot/build-push-action@v1",
  with: {
    project: "<depot-project-id>",
    context: ".",
    file: "apps/os/sandbox/Dockerfile",
    platforms: "${{ github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64' }}",
    load: true,
    tags: "ghcr.io/iterate/sandbox:ci",
  },
},
```

### 3. Option B: Update build-docker-image.ts to use depot CLI

```typescript
const buildArgs = [
  "depot",
  "build",
  "--project",
  "<depot-project-id>",
  "--platform",
  buildPlatform,
  push ? "--push" : "--load",
  "-f",
  "apps/os/sandbox/Dockerfile",
  ...tags.flatMap((tag) => ["-t", tag]),
  "--build-context",
  `iterate-repo-gitdir=${gitDir}`,
  "--build-context",
  `iterate-repo-commondir=${commonDir}`,
  "--build-arg",
  `GIT_SHA=${gitSha}`,
  // NO --cache-from/--cache-to needed! Depot handles automatically
  ".",
];
```

Option B preserves current script flexibility (git worktree handling, tag generation) while getting Depot caching.

### 4. Local Development (Shared Cache)

Developers can use the exact same layer cache as CI by using `depot build` locally:

```bash
# One-time setup
brew install depot/tap/depot
depot login

# Initialize project (creates depot.json with project ID)
depot init

# Build locally - uses same cache as CI!
depot build -t ghcr.io/iterate/sandbox:local --load -f apps/os/sandbox/Dockerfile .

# OR configure docker to use depot automatically
depot configure-docker
docker build -t ghcr.io/iterate/sandbox:local -f apps/os/sandbox/Dockerfile .
```

No additional config needed - any team member with project access automatically shares the cache.

### 5. Depot Registry + Daytona Integration

Instead of pulling from ghcr.io (slow), have CI push to Depot Registry and Daytona pull from there.

**CI: Save to Depot Registry**

```typescript
// In build-docker-image.ts or workflow
const buildArgs = [
  "depot",
  "build",
  "--project",
  "<depot-project-id>",
  "--save", // Save to Depot Registry
  "--save-tag",
  `sha-${gitSha}`, // Custom tag for this build
  "-f",
  "apps/os/sandbox/Dockerfile",
  ".",
];
```

**Daytona: Configure Private Registry**

1. Go to [Daytona Registries](https://app.daytona.io/dashboard/registries)
2. Add Registry:
   - Name: `depot`
   - URL: `registry.depot.dev`
   - Username: `x-token`
   - Password: Depot project/org/user token (store in Doppler)
3. Create Image in Daytona using full path: `registry.depot.dev/<depot-project-id>:sha-xxx`

**Benefits of Depot Registry:**

- Global CDN for fast pulls worldwide
- Direct push from Depot builder (no local network hop)
- Same auth as rest of Depot

**Image Retention**: Default 7 days, configurable to 30 days or unlimited in project settings.

### 6. Alternative: depot push to existing registry

If you prefer to keep using ghcr.io or another registry:

```bash
# Build and save to Depot Registry
depot build --save --save-tag my-tag .

# Then push from Depot Registry to ghcr.io (server-to-server, fast)
depot push --project <project-id> -t ghcr.io/iterate/sandbox:latest my-tag
```

This avoids pulling to local machine then pushing - transfer happens server-to-server.

## Affected Files

- `.github/ts-workflows/workflows/local-docker-test.ts`
- `.github/ts-workflows/workflows/build-sandbox-image.ts`
- `apps/os/sandbox/build-docker-image.ts`
- Daytona dashboard configuration (manual)
- Developer machines (one-time `depot login`)

## Open Questions

- [ ] Should we use Depot Registry directly or `depot push` to ghcr.io?
- [ ] What image retention policy? (7/14/30 days or unlimited)
- [ ] Store Depot token in Doppler for Daytona registry auth?

## References

- [Depot Container Builds Overview](https://depot.dev/docs/container-builds/overview)
- [Depot GitHub Actions Integration](https://depot.dev/docs/container-builds/reference/github-actions)
- [Depot Local Development](https://depot.dev/docs/container-builds/how-to-guides/local-development)
- [Depot Registry Overview](https://depot.dev/docs/registry/overview)
- [Depot Registry Quickstart](https://depot.dev/docs/registry/quickstart)
- [Daytona Private Registries](https://www.daytona.io/docs/images/#images-from-private-registries)
- [depot/build-push-action](https://github.com/depot/build-push-action)
