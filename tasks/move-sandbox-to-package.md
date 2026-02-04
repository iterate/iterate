---
state: pending
priority: high
size: large
---

# Move Sandbox to Top-Level Package

Move `apps/os/sandbox/` to a top-level `sandbox/` package, rename "local-docker" to "docker" everywhere, and create a unified provider interface.

## Current → New File Mapping

### Shared container files → `sandbox/` root

These are used by ALL providers (the container image is shared):

| Current                                 | New                             |
| --------------------------------------- | ------------------------------- |
| `apps/os/sandbox/Dockerfile`            | `sandbox/Dockerfile`            |
| `apps/os/sandbox/entry.sh`              | `sandbox/entry.sh`              |
| `apps/os/sandbox/sync-home-skeleton.sh` | `sandbox/sync-home-skeleton.sh` |
| `apps/os/sandbox/pidnap.config.ts`      | `sandbox/pidnap.config.ts`      |
| `apps/os/sandbox/egress-proxy-addon.py` | `sandbox/egress-proxy-addon.py` |
| `apps/os/sandbox/home-skeleton/`        | `sandbox/home-skeleton/`        |

### Docker provider → `sandbox/providers/docker/`

| Current                                               | New                                               |
| ----------------------------------------------------- | ------------------------------------------------- |
| `apps/os/sandbox/build-docker-image.ts`               | `sandbox/providers/docker/build-image.ts`         |
| `apps/os/sandbox/local-docker-shell.ts`               | `sandbox/providers/docker/shell.ts`               |
| `apps/os/sandbox/sync-repo-from-host.sh`              | `sandbox/providers/docker/sync-repo-from-host.sh` |
| `apps/os/sandbox/tests/providers/local-docker.ts`     | `sandbox/providers/docker/provider.ts`            |
| `apps/os/sandbox/tests/helpers/local-docker-utils.ts` | `sandbox/providers/docker/utils.ts`               |
| `apps/os/backend/providers/local-docker.ts`           | Merged into above                                 |

### Daytona provider → `sandbox/providers/daytona/`

| Current                                           | New                                           |
| ------------------------------------------------- | --------------------------------------------- |
| `apps/os/sandbox/push-docker-image-to-daytona.ts` | `sandbox/providers/daytona/push-snapshot.ts`  |
| `apps/os/sandbox/build-daytona-snapshot.ts`       | `sandbox/providers/daytona/build-snapshot.ts` |
| `apps/os/sandbox/tests/providers/daytona.ts`      | `sandbox/providers/daytona/provider.ts`       |
| `apps/os/backend/providers/daytona.ts`            | Merged into above                             |

### Tests → `sandbox/test/`

| Current                                       | New                                  |
| --------------------------------------------- | ------------------------------------ |
| `apps/os/sandbox/local-docker.test.ts`        | `sandbox/test/provider.test.ts`      |
| `apps/os/sandbox/test-egress-proxy.sh`        | `sandbox/test/test-egress-proxy.sh`  |
| `apps/os/sandbox/tests/fixtures.ts`           | `sandbox/test/fixtures.ts`           |
| `apps/os/sandbox/tests/helpers/*`             | `sandbox/test/helpers/*`             |
| `apps/os/sandbox/tests/integration/*`         | `sandbox/test/integration/*`         |
| `apps/os/sandbox/tests/local/*`               | `sandbox/test/local/*`               |
| `apps/os/sandbox/tests/mock-iterate-os-api/*` | `sandbox/test/mock-iterate-os-api/*` |

---

## Final Folder Structure

```
sandbox/
├── package.json
├── tsconfig.json
├── README.md
│
├── Dockerfile                      # Shared container image definition
├── entry.sh                        # Shared container entrypoint
├── sync-home-skeleton.sh           # Shared home dir setup
├── pidnap.config.ts                # Shared process manager config
├── egress-proxy-addon.py           # Shared mitmproxy addon
│
├── home-skeleton/                  # Shared container home template
│   └── ...
│
├── providers/
│   ├── index.ts                    # Provider registry & getProvider()
│   ├── types.ts                    # Shared types
│   │
│   ├── docker/
│   │   ├── definition.ts           # Env schema + provider definition
│   │   ├── provider.ts             # Provider implementation
│   │   ├── handle.ts               # SandboxHandle implementation
│   │   ├── api.ts                  # Docker API helpers
│   │   ├── utils.ts                # Git info utilities
│   │   ├── build-image.ts          # Script: build Docker image
│   │   ├── shell.ts                # Script: open interactive shell
│   │   └── sync-repo-from-host.sh  # Docker-specific repo sync
│   │
│   └── daytona/
│       ├── definition.ts           # Env schema + provider definition
│       ├── provider.ts             # Provider implementation
│       ├── handle.ts               # SandboxHandle implementation
│       ├── push-snapshot.ts        # Script: push to Daytona registry
│       └── build-snapshot.ts       # Script: build snapshot on Daytona
│
└── test/
    ├── provider.test.ts            # Parameterized tests (all providers)
    ├── fixtures.ts
    ├── test-egress-proxy.sh
    ├── helpers/
    ├── integration/
    ├── local/
    └── mock-iterate-os-api/
```

---

## Dockerfile COPY Updates

The Dockerfile is shared, built from repo root with `-f sandbox/Dockerfile`:

```dockerfile
# Shared files (from sandbox/ root)
COPY sandbox/entry.sh /entry.sh
COPY sandbox/sync-home-skeleton.sh /usr/local/bin/
COPY sandbox/egress-proxy-addon.py /app/egress-proxy/
COPY sandbox/pidnap.config.ts /app/pidnap/
COPY sandbox/home-skeleton /etc/skel-iterate

# Docker-specific (exists in image but only used by Docker provider)
COPY sandbox/providers/docker/sync-repo-from-host.sh /usr/local/bin/
```

Note: `sync-repo-from-host.sh` is Docker-specific (mounts host repo), but it's safe to include in the shared image—Daytona just won't use it.

---

## Package Scripts

### sandbox/package.json

```json
{
  "name": "@iterate-com/sandbox",
  "type": "module",
  "private": true,
  "scripts": {
    "docker:build": "doppler run -- tsx providers/docker/build-image.ts",
    "docker:shell": "doppler run -- tsx providers/docker/shell.ts",
    "docker:test": "RUN_DOCKER_TESTS=true pnpm test",

    "daytona:push": "doppler run -- tsx providers/daytona/push-snapshot.ts",
    "daytona:build": "doppler run -- tsx providers/daytona/build-snapshot.ts",
    "daytona:test": "RUN_DAYTONA_TESTS=true pnpm test",

    "build": "pnpm docker:build",
    "push": "pnpm daytona:push",
    "shell": "pnpm docker:shell",
    "test": "vitest run",
    "test:all": "RUN_DOCKER_TESTS=true RUN_DAYTONA_TESTS=true pnpm test"
  }
}
```

### Root package.json

```json
{
  "scripts": {
    "sandbox": "pnpm --filter @iterate-com/sandbox",
    "sandbox:build": "pnpm sandbox build",
    "sandbox:push": "pnpm sandbox push",
    "sandbox:shell": "pnpm sandbox shell"
  }
}
```

### Usage

```bash
# From repo root
pnpm sandbox build          # Build Docker image
pnpm sandbox push           # Push to Daytona
pnpm sandbox shell          # Open Docker shell
pnpm sandbox docker:test    # Run Docker tests
pnpm sandbox daytona:test   # Run Daytona tests

# Shortcuts
pnpm sandbox:build
pnpm sandbox:push
```

---

## Rename: local-docker → docker

### Files to rename

- `LOCAL_DOCKER_*` env vars → `DOCKER_*`
- `RUN_LOCAL_DOCKER_TESTS` → `RUN_DOCKER_TESTS`
- DB schema: `"local-docker"` → `"docker"`
- Types: `LocalDockerProvider` → `DockerProvider`

### Database migration

```sql
-- apps/os/backend/db/migrations/XXXX_rename_local_docker_to_docker.sql
UPDATE machines SET type = 'docker' WHERE type = 'local-docker';
```

### Schema change

```typescript
// apps/os/backend/db/schema.ts
export const MachineType = ["daytona", "docker", "local"] as const;
```

---

## Unified Provider Interface

```typescript
// sandbox/providers/types.ts

import { z } from "zod/v4";

export type ProviderType = "docker" | "daytona";

export interface CreateSandboxOptions {
  id: string;
  name: string;
  envVars: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface CreateSandboxResult {
  externalId: string;
  metadata: Record<string, unknown>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxHandle {
  readonly externalId: string;
  readonly type: ProviderType;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  archive(): Promise<void>;
  delete(): Promise<void>;

  exec(cmd: string[], opts?: { timeout?: number }): Promise<ExecResult>;
  execString(cmd: string[]): Promise<string>;

  readonly previewUrl: string;
  getUrl(port: number): string;

  waitForServiceHealthy(opts: {
    process: string;
    timeoutMs?: number;
  }): Promise<WaitHealthyResponse>;
  getState(): Promise<ProviderState>;
}

export interface Provider {
  readonly type: ProviderType;
  readonly displayInfo: DisplayInfo;

  create(opts: CreateSandboxOptions): Promise<CreateSandboxResult>;
  connect(opts: { externalId: string; metadata?: Record<string, unknown> }): SandboxHandle;
}

export interface ProviderDefinition<TEnv extends z.ZodRawShape = z.ZodRawShape> {
  type: ProviderType;
  name: string;
  description: string;
  envSchema: z.ZodObject<TEnv>;
  create(env: z.infer<z.ZodObject<TEnv>>): Provider;
  scripts?: { build?: string; push?: string; shell?: string };
}
```

---

## Parameterized Tests

```typescript
// sandbox/test/provider.test.ts

const providersToTest: ProviderType[] = [];
if (process.env.RUN_DOCKER_TESTS === "true") providersToTest.push("docker");
if (process.env.RUN_DAYTONA_TESTS === "true") providersToTest.push("daytona");

describe.skipIf(providersToTest.length === 0)("Provider Tests", () => {
  describe.each(providersToTest)("%s provider", (providerType) => {
    let provider: Provider;
    beforeAll(() => {
      provider = getProvider(providerType);
    });

    test("creates sandbox", async () => {
      const result = await provider.create({ id: `test-${Date.now()}`, name: "test", envVars: {} });
      expect(result.externalId).toBeDefined();
      const handle = provider.connect({ externalId: result.externalId, metadata: result.metadata });
      await handle.delete();
    });

    // Docker-only test
    test.skipIf(providerType === "daytona")("syncs from host repo", async () => {
      // Only Docker mounts host filesystem
    });
  });
});
```

---

## Migration Steps

1. **Package setup**: Create `sandbox/`, `package.json`, `tsconfig.json`, update `pnpm-workspace.yaml`
2. **Move shared files**: `Dockerfile`, `entry.sh`, `sync-home-skeleton.sh`, `pidnap.config.ts`, `egress-proxy-addon.py`, `home-skeleton/`
3. **Create providers/types.ts**: Unified interface
4. **Create providers/docker/**: Move scripts, provider code, `sync-repo-from-host.sh`
5. **Create providers/daytona/**: Move scripts, provider code
6. **Move tests**: Reorganize to `sandbox/test/`, parameterize
7. **Rename local-docker → docker**: Env vars, types, DB migration
8. **Update backend**: Use unified providers from sandbox package
9. **Update imports**: `alchemy.run.ts`, `docker-compose.ts`, workflows
10. **Update Dockerfile**: New COPY paths
11. **Verify**: `pnpm typecheck && pnpm lint && pnpm sandbox build`
