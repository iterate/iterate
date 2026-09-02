import { expect, test } from "vitest";
import worker, { type Env } from "./worker.ts";

test("serves the apple-app-site-association for universal links, both paths", async () => {
  for (const path of ["/.well-known/apple-app-site-association", "/apple-app-site-association"]) {
    const response = await fetchWorker(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const aasa: any = await response.json();
    expect(aasa).toMatchObject({
      applinks: {
        details: [
          {
            appIDs: ["5N6A5Q26NT.com.iterate.mobile"],
            // ONLY preview-channel: install/manifest pages must stay web —
            // opening the old app would hide the Install button.
            components: [{ "/": "/preview-channel/*" }],
          },
        ],
      },
    });
  }
});

test("bare and /m/ paths both serve every page (bare is canonical; /m/ is printed on old QRs)", async () => {
  for (const path of ["/preview-channel/my-feature", "/m/preview-channel/my-feature"]) {
    const response = await fetchWorker(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("iterate://preview-channel/my-feature");
  }
  for (const path of ["/install/my-feature", "/m/install/my-feature"]) {
    expect((await fetchWorker(path)).status).toBe(200);
  }
  // Empty bucket: JSON status 404s honestly, manifest 404s.
  expect((await fetchWorker("/channel-status/my-feature")).status).toBe(404);
  expect((await fetchWorker("/m/install-manifest/my-feature")).status).toBe(404);
});

test("unknown paths 404 and the root answers", async () => {
  expect((await fetchWorker("/")).status).toBe(200);
  expect((await fetchWorker("/nope")).status).toBe(404);
  expect((await fetchWorker("/m/install/too/many/segments")).status).toBe(404);
});

function fetchWorker(path: string): Promise<Response> {
  const env: Env = {
    STATE_BUCKET: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
      // The worker only calls get/put/delete; the rest of R2Bucket is unused.
    } as unknown as R2Bucket,
    APP_CONFIG_ADMIN_API_SECRET: "test-secret",
  };
  return Promise.resolve(
    worker.fetch(new Request(`https://mobile.iterate.com${path}`), env) as Promise<Response>,
  );
}
