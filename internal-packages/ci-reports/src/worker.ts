/**
 * ci-reports — the viewer that opens CI traces and Playwright HTML reports in one click
 * (docs/ci-traces.md). CI uploads them as Depot artifacts named `public-…`; the Preview OS and
 * Main OS e2e trace jobs link each one from a commit status as `<baseUrl>/<artifact-id>/`, and this
 * Worker serves it straight out of Depot's ZIP (artifact.ts). It also opens the repository's
 * explainers at any ref, `<baseUrl>/explainers/<ref>/<name>` (explainer.ts). It stores nothing.
 *
 * Cloudflare Access signs every visitor in before the Worker runs (docs/ci-traces.md#the-viewer):
 * the reports are of private repositories, and the Depot token reads every repository's.
 */
import { serveDepotArtifact } from "./artifact.ts";
import { serveExplainer } from "./explainer.ts";

export default {
  async fetch(request, env, ctx) {
    // The runtime sets `ctx.access` only on a request Access authenticated, so a Worker that Access
    // stopped covering serves nothing rather than everything.
    if (!ctx.access) return new Response("Sign in through Cloudflare Access", { status: 403 });
    const { pathname } = new URL(request.url);
    if (pathname === "/")
      return new Response(
        "CI reports: /<depot-artifact-id>/ opens a public- artifact of iterate's Depot CI, and /explainers/<ref>/<name> an explainers/<name>.html at a branch or commit (docs/ci-traces.md).\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    if (pathname.startsWith("/explainers/")) return serveExplainer(request, { fetch });
    return serveDepotArtifact(request, { token: env.DEPOT_CI_TELEMETRY_TOKEN, fetch });
  },
} satisfies ExportedHandler<{ DEPOT_CI_TELEMETRY_TOKEN: string }>;
