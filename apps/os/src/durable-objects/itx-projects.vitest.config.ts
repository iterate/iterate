import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = process.env.OS_ITX_PROJECTS_TEST_APP_ROOT ?? process.cwd();
const repoRoot = resolve(appRoot, "../..");
const testRoot = fileURLToPath(new URL(".", import.meta.url));
const cloudflareVitestPath = resolve(
  repoRoot,
  "packages/shared/node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs",
);
const cloudflareVitest = await import(pathToFileURL(cloudflareVitestPath).href);
const requireFromCloudflareVitest = createRequire(cloudflareVitestPath);
const miniflare = await import(
  pathToFileURL(requireFromCloudflareVitest.resolve("miniflare")).href
);

export default defineConfig({
  root: resolve(repoRoot, "packages/shared"),
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(testRoot, "itx-projects-test-entry.ts"),
      miniflare: {
        serviceBindings: {
          HARNESS: {
            entrypoint: "ItxProjectsHarness",
            name: miniflare.kCurrentWorker,
          },
        },
        // The fake auth worker: every outbound fetch lands here. It answers
        // the one oRPC call the user create path makes — minting a
        // deterministic prj_ id from the requested slug — and fails anything
        // else loudly, which doubles as a no-unexpected-egress assertion.
        async outboundService(request: Request) {
          const url = new URL(request.url);
          if (
            url.origin === "https://auth.test" &&
            url.pathname === "/api/orpc/internal/project/createForOrganization"
          ) {
            const body = (await request.json()) as { json: { name: string; slug: string } };
            return Response.json({
              json: {
                id: `prj_authminted_${body.json.slug.replaceAll(/[^a-z0-9]/g, "")}`,
                organizationId: "org_acme",
                name: body.json.name,
                slug: body.json.slug,
                metadata: {},
                archivedAt: null,
              },
              meta: [],
            });
          }
          return new Response(`unexpected outbound fetch: ${request.method} ${request.url}`, {
            status: 500,
          });
        },
      },
      wrangler: {
        configPath: resolve(testRoot, "itx-projects.wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    exclude: defaultExclude,
    hookTimeout: 60_000,
    include: [resolve(testRoot, "itx-projects.test.ts")],
    testTimeout: 60_000,
  },
});
