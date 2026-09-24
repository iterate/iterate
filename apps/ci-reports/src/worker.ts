/**
 * ci-reports — the viewer that opens CI traces and Playwright HTML reports in one click
 * (docs/ci-traces.md). CI uploads them as Depot artifacts named `public-…`; the Preview OS and
 * Main OS e2e trace jobs link each one from a commit status as `<baseUrl>/<artifact-id>/`, and this
 * Worker serves it straight out of Depot's ZIP (artifact.ts). It stores nothing.
 */
import { serveDepotArtifact } from "./artifact.ts";

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/")
      return new Response(
        "CI reports: /<depot-artifact-id>/ opens a public- artifact of iterate/iterate's Depot CI.\nhttps://github.com/iterate/iterate/blob/main/docs/ci-traces.md\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    return serveDepotArtifact(request, { token: env.DEPOT_CI_TELEMETRY_TOKEN, fetch });
  },
} satisfies ExportedHandler<{ DEPOT_CI_TELEMETRY_TOKEN: string }>;
