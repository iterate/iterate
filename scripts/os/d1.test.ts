import { expect, test } from "vitest";
import { ensureD1 } from "./d1.ts";
import type { Cf } from "./preview-artifacts.ts";

test("a preview's D1 is created with no location hint, so D1 places it near the job creating it", async () => {
  const { cf, requests } = fakeCloudflare([]);
  await ensureD1(cf, "os-latency-db", "automatic");
  expect(requests.find((request) => request.route === "/d1/database")).toEqual({
    route: "/d1/database",
    body: { name: "os-latency-db" },
  });
});

test("prd's and the parent's D1 is created in western Europe", async () => {
  const { cf, requests } = fakeCloudflare([]);
  await ensureD1(cf, "os-prd-db", "weur");
  expect(requests.find((request) => request.route === "/d1/database")).toEqual({
    route: "/d1/database",
    body: { name: "os-prd-db", primary_location_hint: "weur" },
  });
});

test("a D1 that exists is found and left where it is", async () => {
  const { cf, requests } = fakeCloudflare([{ uuid: "old-uuid", name: "os-latency-db" }]);
  expect(await ensureD1(cf, "os-latency-db", "automatic")).toMatchObject({ uuid: "old-uuid" });
  expect(requests.map((request) => request.route)).toEqual(["/d1/database?per_page=100&page=1"]);
});

/** A Cloudflare API holding `existing`, recording every request; a created D1 runs in ENAM. */
function fakeCloudflare(existing: { uuid: string; name: string }[]) {
  const requests: { route: string; body?: unknown }[] = [];
  const cf = (async (route: string, init?: RequestInit) => {
    requests.push({ route, ...(init?.body && { body: JSON.parse(String(init.body)) }) });
    if (route.startsWith("/d1/database?")) return existing;
    if (route === "/d1/database") return { uuid: "new-uuid", name: "created" };
    if (route === "/d1/database/new-uuid") return { running_in_region: "ENAM" };
    throw new Error(`unexpected route ${route}`);
  }) as Cf;
  return { cf, requests };
}
