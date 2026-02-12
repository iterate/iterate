# os

## Sandbox

Sandbox docs are centralized in [`sandbox/README.md`](../../sandbox/README.md).

Use that doc for:

- Docker/Fly provider behavior (Daytona is optional/manual-only)
- Image + snapshot tag formats
- Doppler defaults (`DOCKER_DEFAULT_IMAGE`, `FLY_DEFAULT_IMAGE`)
- Build/push/bootstrap/test commands

Keep sandbox details out of this file to avoid drift.

---

## Project ingress env vars

These vars control machine service ingress hostnames:

| Variable                               | Purpose                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PROJECT_INGRESS_PROXY_CANONICAL_HOST` | Canonical base host used to build service links: `<port>__<machine_id>.<canonical-host>` |
| `PROJECT_INGRESS_PROXY_HOST_MATCHERS`  | Comma-separated glob patterns for incoming host matching in OS ingress routing           |
| `OS_WORKER_ROUTES`                     | Comma-separated Cloudflare route host patterns mounted to the `os` worker                |
| `DEV_TUNNEL`                           | Local tunnel subdomain input; use with Doppler expansion for canonical host              |

Local dev default example:

`PROJECT_INGRESS_PROXY_CANONICAL_HOST=${DEV_TUNNEL}.dev.iterate.com`

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
