# os

## Local Docker Development

For local development, you can create machines using local Docker containers instead of Daytona. This requires OrbStack (or Docker Desktop) with the TCP API enabled.

### OrbStack Setup

1. Open **OrbStack** → Click the gear icon (Settings) → **Docker** tab
2. In the "Docker Engine" config section, add:
   ```json
   {
     "hosts": ["tcp://127.0.0.1:2375", "unix:///var/run/docker.sock"]
   }
   ```
3. Click **Apply & Restart**

To verify it's working:

```bash
curl http://127.0.0.1:2375/version
```

### Local Docker Snapshots

When you run `pnpm dev`, the `iterate-sandbox:local` Docker image is automatically built in the background using `apps/os/sandbox/Dockerfile`. Images are always built from the current commit SHA.

To manually rebuild the local Docker snapshot from the repo root or `apps/os`:

```bash
pnpm snapshot:local-docker
```

New local-docker machines always use the latest `iterate-sandbox:local` image tag.

### Creating a Local Machine

In the UI, select "local-docker" as the machine type when creating a new machine. The container will run locally and be accessible at `http://localhost:<port>`.

---

## Daytona Snapshots

The os app uses Daytona sandboxes for machine execution. Snapshots are Docker images pre-configured with the necessary tools and dependencies.

### Naming Convention

Snapshots follow the naming pattern: `iterate-sandbox-{commitSha}`

The commit SHA is the full 40-character git commit hash. This makes snapshots idempotent - building from the same commit always produces the same snapshot name.

Example: `iterate-sandbox-abc123def456...` (full 40-char SHA)

### Creating a New Snapshot

To create a new Daytona snapshot from `apps/os`:

```bash
pnpm snapshot:daytona
```

Or from the repo root:

```bash
pnpm --filter os snapshot:daytona
```

This will:

1. Get the current commit SHA (or use `SANDBOX_ITERATE_REPO_REF` if set)
2. Build the Docker image using `apps/os/sandbox/Dockerfile`
3. Push the snapshot to Daytona as `iterate-sandbox-{commitSha}`

If the snapshot already exists (same commit SHA), the build is skipped.

### Configuring Which Snapshot to Use

The `DAYTONA_SNAPSHOT_NAME` environment variable (in Doppler) specifies which snapshot to use when creating Daytona machines. This must be set explicitly to a full snapshot name like `iterate-sandbox-abc123...`.

To deploy a new snapshot:

1. Build and push: `pnpm snapshot:daytona`
2. Note the snapshot name from the output
3. Update `DAYTONA_SNAPSHOT_NAME` in Doppler (dev/stg/prd config)

### Snapshot Contents

The snapshot (`apps/os/sandbox/Dockerfile`) includes:

- Node.js 24
- pnpm 10, tsx 4
- GitHub CLI (gh)
- Claude CLI
- OpenCode CLI
- Git (configured for iterate-bot)

The entry point (`apps/os/sandbox/entry.sh`) sets up the environment and starts s6 process supervision.

For detailed documentation on the s6 process supervision setup, see [`apps/os/sandbox/README.md`](./sandbox/README.md).

---

## Analytics (PostHog)

OS uses PostHog for product analytics, session replay, and group analytics with EU data residency. **PostHog is optional** - if no key is configured, the app works normally without analytics.

### Configuration

PostHog is configured via environment variables (managed by Doppler). All are optional:

| Variable                  | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `POSTHOG_PUBLIC_KEY`      | PostHog project API key (server-side, optional)                          |
| `VITE_POSTHOG_PUBLIC_KEY` | PostHog project API key (client-side, reference to `POSTHOG_PUBLIC_KEY`) |
| `VITE_POSTHOG_PROXY_URL`  | Proxy endpoint for PostHog (default: `/api/integrations/posthog/proxy`)  |

### Architecture

- **Client-side**: PostHog JS SDK with session replay enabled
- **Server-side**: posthog-node for tRPC mutation tracking
- **Proxy**: `/ingest/*` routes proxy to PostHog EU (`eu.i.posthog.com`) for ad-blocker bypass

### Environments

All environments use a single PostHog project with `$environment` property set via `VITE_APP_STAGE`:

| Stage     | Description                  |
| --------- | ---------------------------- |
| `local-*` | Developer local environments |
| `stg`     | Staging                      |
| `prd`     | Production                   |
| `pr-*`    | PR preview environments      |

Filter by `$environment` in PostHog to see data from specific environments.

### Group Analytics

Two group types are configured:

- **organization**: Tracks organization-level metrics
- **project**: Tracks project-level metrics

Users are identified in the auth-required layout (covering all authenticated routes), and groups are set when navigating to org/project routes. PostHog is reset on logout to prevent session linking.

### Adding New Tracked Mutations

To track a new tRPC mutation, add it to `backend/trpc/tracked-mutations.ts`:

```typescript
registerTrackedMutation("router.mutationName", {
  eventName: "human_readable_event_name",
  extractProperties: (input) => ({
    // Extract only safe, non-sensitive properties
    some_property: input.someField,
  }),
});
```

### PostHog Project Setup

1. Create a PostHog account at https://eu.posthog.com (EU data residency)
2. Create a single project named "OS"
3. Get API key from Settings > Project API Key
4. Enable Session Replay in settings
5. Add environment variables to Doppler for each environment (dev, stg, prd)

**Note:** Group types (`organization` and `project`) are automatically created when the first event with a group is sent. You'll see them appear in Settings > Group Analytics after deploying and using the app.

### Privacy Considerations

- Session replay has no masking (can be enabled if needed)
- Server-side tracking filters sensitive data (passwords, tokens, env var values)
- User identification uses internal IDs, not emails (though email is set as a property)
