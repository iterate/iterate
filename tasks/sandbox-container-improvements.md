---
state: backlog
priority: medium
size: medium
---

# Sandbox Container Improvements

Improvements identified during PR review for the daemonize-sandbox branch.

## Docker Layer Caching

### Issue

The Dockerfile copies the entire repo before running `pnpm install`, which breaks Docker layer caching:

```dockerfile
COPY . /iterate-repo
RUN pnpm install
```

Any source file change invalidates cache and forces full `pnpm install`.

### Fix

Reorder to copy package files first, install dependencies, then copy source:

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/os/package.json apps/os/
COPY apps/daemon/package.json apps/daemon/
# ... other package.json files
RUN pnpm install --frozen-lockfile
COPY . .
```

### Trade-offs

- Requires listing all package.json files explicitly
- May need updates when new packages are added
- Consider using multi-stage builds for even better caching

## TypeScript Environment Variable Validation

### Issue

Multiple `process.env` accesses without validation:

- `apps/os/sandbox/daytona-snapshot.ts:27` - `DAYTONA_API_KEY` passed without check
- `apps/os/sandbox/entry.ts` - Various env vars accessed without guards

### Fix

Add validation at module initialization:

```typescript
// At top of daytona-snapshot.ts
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
if (!DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY environment variable is required");
}

const daytona = new Daytona({ apiKey: DAYTONA_API_KEY });
```

Or use zod for typed config:

```typescript
import { z } from "zod/v4";

const envSchema = z.object({
  DAYTONA_API_KEY: z.string().nonempty(),
  // ...
});

const env = envSchema.parse(process.env);
```

## Curl Pipe to Bash Security

### Issue

`Dockerfile:13,15` executes unverified remote scripts:

```dockerfile
RUN curl -fsSL https://opencode.ai/install | bash
RUN curl -fsSL https://claude.ai/install.sh | bash
```

### Risk

- Supply chain attack if domains compromised
- No checksum/signature verification

### Mitigations (in priority order)

1. Pin specific versions if installers support it
2. Add SHA256 verification: `curl ... | sha256sum -c - && bash`
3. Consider using official Docker images for these tools
4. Document the trust relationship with these vendors

## Symlink Preservation Without Validation

### Issue

`daytona-snapshot.ts:56-58` preserves symlinks without validating targets:

```typescript
if (stats.isSymbolicLink()) {
  symlinkSync(readlinkSync(sourcePath), targetPath);
  continue;
}
```

A malicious symlink could point outside the container filesystem.

### Fix

Validate symlink targets stay within repo:

```typescript
if (stats.isSymbolicLink()) {
  const target = readlinkSync(sourcePath);
  const resolvedTarget = resolve(dirname(sourcePath), target);
  if (!resolvedTarget.startsWith(repoRoot)) {
    console.warn(`Skipping symlink outside repo: ${relativePath} -> ${target}`);
    continue;
  }
  symlinkSync(target, targetPath);
  continue;
}
```

## Missing Log Service for example-service-a

### Current State

Only `iterate-server` and `example-service-b-depends-on-a` have log services.
`example-service-a` logs go to stdout (inherited from s6-svscan).

### Fix

Add `s6-daemons/example-service-a/log/run`:

```bash
#!/bin/sh
mkdir -p /var/log/example-service-a
exec s6-log -b n20 s1000000 S50000000 T /var/log/example-service-a
```

### Note

Current inconsistency is intentional to demonstrate both logging approaches (stdout vs file-based).

## Health Check Background Process Reliability

### Issue

`s6-daemons/*/run` scripts spawn health check as background process:

```bash
"$ITERATE_REPO/scripts/s6-healthcheck-notify.sh" http://localhost:3000/api/health &
exec env ...
```

If health check dies before writing to fd 3, s6 never knows startup failed.

### Possible Improvements

1. Make health check part of main process lifecycle
2. Add watchdog for background health checker
3. Use s6's built-in readiness checking if available

## References

- Docker build best practices: https://docs.docker.com/build/building/best-practices/
- s6 overlay docs: https://github.com/just-containers/s6-overlay
