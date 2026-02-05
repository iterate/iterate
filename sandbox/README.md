# Sandbox Docker Images

Guide to building sandbox Docker images via CI or locally, and pushing to Daytona.

## Prerequisites

### Depot CLI (for local builds)

Depot provides persistent layer caching shared between CI and all developers.

```bash
brew install depot/tap/depot   # or: curl -L https://depot.dev/install-cli.sh | sh
depot login
```

### Daytona CLI (for pushing snapshots)

```bash
# Install
ARCH=$(uname -m); [[ "$ARCH" == "arm64" ]] || ARCH="amd64"
curl -sfLo daytona "https://download.daytona.io/cli/latest/daytona-darwin-$ARCH"
chmod +x daytona && sudo mv daytona /usr/local/bin/

# Login
daytona login
```

---

## CI Workflows

### Build Docker Image

Builds the sandbox image using Depot. Invokable directly or as a reusable workflow.

```bash
# Build current branch
gh workflow run "Build Docker Image"

# Build specific ref (branch, tag, or SHA)
gh workflow run "Build Docker Image" -f ref=main
gh workflow run "Build Docker Image" -f ref=abc123def

# Build for ARM64 (default is AMD64)
gh workflow run "Build Docker Image" -f docker_platform=linux/arm64

# Watch the run
gh run watch
```

### Build Daytona Snapshot

Builds the image AND pushes to Daytona as a snapshot.

```bash
# Build and push to Daytona (dev config)
gh workflow run "Build Daytona Snapshot"

# Build specific ref and push
gh workflow run "Build Daytona Snapshot" -f ref=main -f doppler_config=dev

# For production
gh workflow run "Build Daytona Snapshot" -f doppler_config=prd

# Watch the run
gh run watch
```

### Local Docker Tests

Builds the image and runs the local Docker test suite.

```bash
# Run tests on current branch
gh workflow run "Local Docker Tests"

# Test specific ref
gh workflow run "Local Docker Tests" -f ref=feature-branch

# Test with custom image name
gh workflow run "Local Docker Tests" -f image_name=iterate-sandbox:test

# Watch the run
gh run watch
```

### Checking CI Status

```bash
# List recent runs
gh run list --limit 10

# List runs for specific workflow
gh run list --workflow "Build Docker Image" --limit 5

# View a specific run
gh run view <run-id>

# View run logs
gh run view <run-id> --log
```

---

## Local Development

### Build the Image

```bash
# Build for local Docker daemon (tagged as iterate-sandbox:local)
pnpm os docker:build

# Build for specific platform
SANDBOX_BUILD_PLATFORM=linux/arm64 pnpm os docker:build

# Build with custom tag
LOCAL_DOCKER_IMAGE_NAME=my-sandbox:test pnpm os docker:build
```

Build output is cached via Depot. Unchanged builds complete in ~10 seconds.

### Test the Image

```bash
# Run the local Docker test suite
RUN_LOCAL_DOCKER_TESTS=true pnpm os docker:test

# Or run a shell in the container
pnpm os docker:shell
```

### Push to Daytona

After building locally, push to Daytona as a snapshot:

```bash
# Push with auto-generated name (iterate-sandbox-{date}-{sha}-{user})
doppler run --config dev -- pnpm os daytona:build

# Push with custom name
doppler run --config dev -- pnpm os daytona:build --name my-snapshot

# Push with custom resources
doppler run --config dev -- pnpm os daytona:build --cpu 4 --memory 8 --disk 20

# Push without updating Doppler secrets
doppler run --config dev -- pnpm os daytona:build --no-update-doppler
```

#### Options

| Flag                  | Default               | Description                   |
| --------------------- | --------------------- | ----------------------------- |
| `--name`, `-n`        | auto                  | Snapshot name                 |
| `--image`, `-i`       | iterate-sandbox:local | Local image to push           |
| `--cpu`, `-c`         | 2                     | CPU cores                     |
| `--memory`, `-m`      | 4                     | Memory in GB                  |
| `--disk`, `-d`        | 10                    | Disk in GB                    |
| `--no-update-doppler` | false                 | Skip updating Doppler secrets |

### Full Local Workflow

```bash
# 1. Build the image
pnpm os docker:build

# 2. Test it works
pnpm os docker:shell
# Inside container: git status, pnpm test, etc.
# Exit with: exit

# 3. Push to Daytona (updates DAYTONA_SNAPSHOT_NAME in Doppler)
doppler run --config dev -- pnpm os daytona:build
```

---

## Depot Cache

CI and local builds share the same Depot layer cache. This means:

- First build by anyone primes the cache
- Subsequent builds (local or CI) get instant cache hits
- Cache persists across CI runs and developer machines

### Verify cache is working

```bash
# Build twice - second should be <30s
time pnpm os docker:build
time pnpm os docker:build
```

### Check cache status

Visit [depot.dev](https://depot.dev) → Project → Builds to see cache hit rates.

---

## Troubleshooting

### "depot: command not found"

Install Depot CLI: `brew install depot/tap/depot && depot login`

### "daytona: command not found"

Install Daytona CLI (see Prerequisites above)

### Build fails with OIDC error in CI

Ensure the workflow has `id-token: write` permission:

```typescript
permissions: {
  contents: "read",
  "id-token": "write",
}
```

### Daytona push fails with auth error

Run with Doppler to inject credentials:

```bash
doppler run --config dev -- pnpm os daytona:build
```

### Image not found when pushing to Daytona

Build first: `pnpm os docker:build`

### OrbStack socket not found

Daytona CLI needs `DOCKER_HOST` set. The script auto-detects OrbStack, but you can set it manually:

```bash
export DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
```

---

## Key Files

| File                                              | Description                          |
| ------------------------------------------------- | ------------------------------------ |
| `apps/os/sandbox/Dockerfile`                      | The sandbox image definition         |
| `apps/os/sandbox/build-docker-image.ts`           | Local build script                   |
| `apps/os/sandbox/push-docker-image-to-daytona.ts` | Daytona push script                  |
| `.github/workflows/build-docker-image.yml`        | CI build workflow                    |
| `.github/workflows/build-daytona-snapshot.yml`    | CI build + Daytona push              |
| `.github/workflows/local-docker-test.yml`         | CI build + test suite                |
| `depot.json`                                      | Depot project config (cache sharing) |
