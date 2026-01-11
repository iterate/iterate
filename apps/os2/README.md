# os2

## Daytona Snapshots

The os2 app uses Daytona sandboxes for machine execution. Snapshots are Docker images pre-configured with the necessary tools and dependencies.

### Naming Convention

Snapshots follow the naming pattern: `<prefix><timestamp>`

- **Prefix**: Environment-specific, ending with `--` (double hyphen delimiter)
- **Timestamp**: UTC time in `YYYYMMDD-HHMMSS` format

Examples:

- `iterate-sandbox-dev--20260111-193045`
- `iterate-sandbox-stg--20260111-193045`
- `iterate-sandbox-prd--20260111-193045`

### Environment Configuration

The `DAYTONA_SNAPSHOT_PREFIX` environment variable is configured in Doppler for each environment:

| Environment | Doppler Config | Prefix                  |
| ----------- | -------------- | ----------------------- |
| Development | `dev`          | `iterate-sandbox-dev--` |
| Staging     | `stg`          | `iterate-sandbox-stg--` |
| Production  | `prd`          | `iterate-sandbox-prd--` |

### Creating a New Snapshot

To create a new snapshot:

```bash
doppler run -- tsx apps/os2/sandbox/snapshot.ts
```

This will:

1. Read the prefix from `DAYTONA_SNAPSHOT_PREFIX`
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
