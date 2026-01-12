# os2

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

### Automatic Image Building

When you run `pnpm dev`, the `iterate-sandbox:local` Docker image is automatically built from `sandbox/Dockerfile` if it doesn't exist.

To manually rebuild the image:

```bash
docker build -t iterate-sandbox:local ./sandbox
```

### Creating a Local Machine

In the UI, select "local-docker" as the machine type when creating a new machine. The container will run locally and be accessible at `http://localhost:<port>`.

---

## Daytona Snapshots

The os2 app uses Daytona sandboxes for machine execution. Snapshots are Docker images pre-configured with the necessary tools and dependencies.

### Naming Convention

Snapshots follow the naming pattern: `<stage>--<timestamp>`

- **Stage**: Matches the alchemy stage (e.g., `local-jonas`, `stg`, `prd`)
- **Timestamp**: UTC time in `YYYYMMDD-HHMMSS` format

Examples:

- `local-jonas--20260111-193045` (dev, user-specific)
- `stg--20260111-193045`
- `prd--20260111-193045`

### Environment Configuration

The snapshot prefix is derived from the stage, which is constructed from environment variables:

| Environment | Doppler Config | Stage Construction         | Example Prefix  |
| ----------- | -------------- | -------------------------- | --------------- |
| Development | `dev`          | `local-${ITERATE_USER}`    | `local-jonas--` |
| Staging     | `stg`          | `APP_STAGE` (set to `stg`) | `stg--`         |
| Production  | `prd`          | `APP_STAGE` (set to `prd`) | `prd--`         |

For local development, each developer gets their own namespace based on `ITERATE_USER`.

### Creating a New Snapshot

To create a new snapshot, run from the repo root with the appropriate Doppler config:

```bash
# For development snapshots
doppler run --config dev -- tsx apps/os2/sandbox/snapshot.ts

# For staging snapshots
doppler run --config stg -- tsx apps/os2/sandbox/snapshot.ts

# For production snapshots
doppler run --config prd -- tsx apps/os2/sandbox/snapshot.ts
```

Or from the `apps/os2` directory:

```bash
doppler run --config prd -- tsx sandbox/snapshot.ts
```

This will:

1. Construct the stage from `ITERATE_USER` (dev) or `APP_STAGE` (stg/prd)
2. Generate a timestamp-based snapshot name
3. Build the Docker image from `sandbox/Dockerfile`
4. Push the snapshot to Daytona

### Dynamic Snapshot Resolution

When a machine is created, the app automatically fetches the latest snapshot matching the configured prefix. This is done by:

1. Calling the Daytona REST API with `name=<prefix>`, `sort=createdTime`, `order=desc`
2. Using the first (most recent) matching snapshot
3. Caching the result for 5 minutes to reduce API calls

This means new snapshots are automatically picked up within 5 minutes of creation, without requiring code changes or redeployment.

### Snapshot Contents

The snapshot (`sandbox/Dockerfile`) includes:

- Node.js 24
- pnpm 10, tsx 4
- GitHub CLI (gh)
- Claude CLI
- OpenCode CLI
- Git (configured for iterate-bot)

The entry point (`sandbox/entry.ts`) clones the iterate repository and starts the daemon server on port 3000.
