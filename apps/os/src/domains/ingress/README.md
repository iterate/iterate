# Ingress Domain

Ingress owns host routing and fetch-callable dispatch: mapping public request
hostnames to project-bound runtime behavior.

This domain folder currently holds no code. The ingress implementation lives
elsewhere:

- `apps/os/src/ingress/` — `matchIngressRequest` / `dispatchFetchCallable`
  (`host-routing.ts`) and `lookupIngressRule` (`lookup.ts`), which resolves a
  request host in priority order: explicit D1 ingress-route row, itx
  capability host, project platform host (`<slug>.iterate.app` and friends),
  project custom hostname.
- `apps/os/src/worker.ts` — dispatches project-host traffic through the above
  before falling through to the dashboard app.
- `~/domains/projects/entrypoints/project-ingress-entrypoint.ts` — the
  project-bound ingress entrypoint; ingress remains partly intertwined with
  Projects until the boundary grows clearer.
