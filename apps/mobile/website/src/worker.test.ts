import { expect, test } from "vitest";
import { getPlatformProxy } from "wrangler";
import worker, { type Env } from "./worker.ts";

test.each(["", "animal-cat-"])(
  "public filter assets with prefix %j keep caching, CORS and private-state isolation",
  async (prefix) => {
    const platform = await getPlatformProxy<Env>({ persist: false });
    await using _cleanup = { [Symbol.asyncDispose]: () => platform.dispose() };
    const filename = `${prefix}${"a".repeat(64)}.png`;
    await platform.env.STATE_BUCKET.put(`filter-assets/${filename}`, new Uint8Array([1, 2, 3]));
    await platform.env.STATE_BUCKET.put("channel-status/private", "private state");
    const request = (path: string, init?: RequestInit) =>
      worker.fetch(new Request(`https://mobile.iterate.com${path}`, init), platform.env);
    const response = await request(`/filter-assets/${filename}`, { headers: { origin: "null" } });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "image/png",
    });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    const head = await request(`/filter-assets/${filename}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const conditional = await request(`/filter-assets/${filename}`, {
      headers: { "if-none-match": response.headers.get("etag")! },
    });
    expect(conditional.status).toBe(304);
    const missing = await request(`/filter-assets/${"b".repeat(64)}.png`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(
      (await request(`/filter-assets/${filename}`, { method: "PUT", body: "replace" })).status,
    ).toBe(405);
    expect((await request("/filter-assets/channel-status/private")).status).toBe(404);
    expect((await request(`/filter-assets/${"a".repeat(64)}.js`)).status).toBe(404);
  },
);

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
