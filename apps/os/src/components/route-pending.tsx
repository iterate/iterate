/**
 * The router-wide pending fallback (router.tsx `defaultPendingComponent`).
 * Rendered wherever a route match has no content yet: in the SSR shell for
 * `ssr: false` route leaves and while `beforeLoad`/`loader` run on the client.
 * Same muted-text + `data-spinner` idiom as the route-level pending fallbacks
 * (ItxPending, ProjectsIndexPending) so the e2e spinner-waiter recognizes it
 * as progress (docs/preview-e2e-flake-hunt.md flake 21).
 */
export function RoutePending() {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      Loading…
    </div>
  );
}
