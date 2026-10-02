import { expect, test, vi } from "vitest";
import worker from "./worker.ts";

test("a request Cloudflare Access did not authenticate is refused before anything is read", async () => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response("{}");
  });

  const anonymous = await invoke("/01a0d208-5706-711b-b168-ba7a00c8a25f/", undefined);
  expect(anonymous).toMatchObject({ status: 403 });
  expect(fetched).toEqual([]);

  const signedIn = await invoke("/", { aud: "ci-reports", getIdentity: async () => undefined });
  expect(signedIn).toMatchObject({ status: 200 });
});

/** The Worker invoked as the runtime invokes it: `ctx.access` is set only when Access
 *  authenticated the request. */
function invoke(path: string, access: unknown) {
  const request: any = new Request(`https://ci-reports.example${path}`);
  const ctx: any = { access, waitUntil() {}, passThroughOnException() {}, props: {} };
  return worker.fetch(request, { DEPOT_CI_TELEMETRY_TOKEN: "secret" }, ctx);
}
