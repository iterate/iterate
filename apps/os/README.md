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

When you run `pnpm dev`, the `iterate-sandbox:local` Docker image is automatically built in the background from the repo root using `sandbox/Dockerfile`. Docker's layer caching ensures this is fast (~2s) if nothing changed, while still picking up Dockerfile changes without manual rebuilds.

To manually rebuild the local Docker snapshot from the repo root:

```bash
pnpm docker:build
```

New docker machines always use the latest `iterate-sandbox:local` image tag.

### Creating a Local Machine

In the UI, select "docker" as the machine type when creating a new machine. The container will run locally and be accessible at `http://localhost:<port>`.

---

## Daytona Snapshots

The os app uses Daytona sandboxes for machine execution. Snapshots are Docker images pre-configured with the necessary tools and dependencies.

### Naming Convention

Snapshots follow the naming pattern: `<alchemy-stage>--<timestamp>`

- **Alchemy stage name**: Matches the alchemy stage name (e.g., `dev-jonas`, `stg`, `prd`)
- **Timestamp**: UTC time in `YYYYMMDD-HHMMSS` format

Examples:

- `dev-jonas--20260111-193045` (dev, user-specific)
- `stg--20260111-193045`
- `prd--20260111-193045`

### Environment Configuration

The snapshot prefix is derived from the stage, which is constructed from environment variables:

| Environment | Doppler Config | Stage Construction         | Example Prefix |
| ----------- | -------------- | -------------------------- | -------------- |
| Development | `dev`          | `dev-${ITERATE_USER}`      | `dev-jonas--`  |
| Staging     | `stg`          | `APP_STAGE` (set to `stg`) | `stg--`        |
| Production  | `prd`          | `APP_STAGE` (set to `prd`) | `prd--`        |

For local development, each developer gets their own namespace based on `ITERATE_USER`.

### Creating a New Snapshot

To create a new Daytona snapshot from the repo root:

```bash
pnpm build:daytona
```

To target a specific Doppler config from the repo root:

```bash
# For development snapshots
doppler run --config dev -- pnpm build:daytona

# For staging snapshots
doppler run --config stg -- pnpm build:daytona

# For production snapshots
doppler run --config prd -- pnpm build:daytona
```

If you want to force a specific Doppler config:

```bash
doppler run --config stg -- pnpm build:daytona
```

This will:

1. Construct the stage from `ITERATE_USER` (dev) or `APP_STAGE` (stg/prd)
2. Generate a timestamp-based snapshot name
3. Build the Docker image from the repo root using `sandbox/Dockerfile`
4. Push the snapshot to Daytona

### Dynamic Snapshot Resolution

When a machine is created, the app automatically fetches the latest snapshot matching the configured prefix. This is done by:

1. Calling the Daytona REST API with `name=<prefix>`, `sort=createdTime`, `order=desc`
2. Using the first (most recent) matching snapshot
3. Caching the result for 5 minutes to reduce API calls (disabled for dev prefixes)

This means new snapshots are automatically picked up quickly in dev and within 5 minutes in staging/production, without requiring code changes or redeployment.

### Snapshot Contents

The snapshot (`sandbox/Dockerfile`) includes:

- Node.js 24
- pnpm 10, tsx 4
- GitHub CLI (gh)
- Claude CLI
- OpenCode CLI
- Git (configured for iterate-bot)

The entry point (`sandbox/entry.sh`) sets up the environment and starts s6 process supervision.

For detailed documentation on the sandbox setup, see [`sandbox/README.md`](../../sandbox/README.md).

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
