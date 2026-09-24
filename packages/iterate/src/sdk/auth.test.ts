import { expect, test } from "vitest";
import { auth } from "./auth.ts";

// An empty Origin is foreign, like any other that is not this one; only an absent Origin (a
// non-browser client) is trusted (lib.ts isSameOriginBrowserRequest).
test.each<{ headers: Record<string, string>; status: number }>([
  { headers: { origin: "" }, status: 403 },
  { headers: { origin: "https://evil.example" }, status: 403 },
  { headers: { origin: "null" }, status: 403 },
  { headers: {}, status: 401 },
  { headers: { origin: "https://worker.example" }, status: 401 },
])("a POST with $headers and no principal → $status", ({ headers, status }) => {
  expect(auth.require(workerRequest("POST", headers))?.status).toBe(status);
});

// Signed out, every method answers the platform's sign-in challenge; the edge turns it into the
// sign-in redirect for a page load (apps/os project-host-sign-in.ts), under any base path.
test.for<{ method: string; headers: Record<string, string> }>([
  { method: "GET", headers: { origin: "" } },
  { method: "HEAD", headers: {} },
  { method: "OPTIONS", headers: {} },
  { method: "POST", headers: { origin: "https://worker.example" } },
])("a $method with no principal → 401 with the sign-in challenge", ({ method, headers }) => {
  const response = auth.require(workerRequest(method, headers));
  expect(response).toMatchObject({ status: 401 });
  expect(response!.headers.get("WWW-Authenticate")).toBe('Bearer realm="iterate"');
});

// A WebSocket handshake is a GET, but it is checked like a write: every `<routingSlug>--<project>.iterate.app`
// host is same-site with every other, so a SameSite=Lax cookie rides a socket another project opens.
const signedIn = { "x-itx-principal": JSON.stringify({ actor: "user:1" }) };
test.each<{ name: string; headers: Record<string, string>; status: number | null }>([
  { name: "cross-origin", headers: { origin: "https://evil.example", ...signedIn }, status: 403 },
  {
    name: "sibling-host",
    headers: { origin: "https://b--other.iterate.app", ...signedIn },
    status: 403,
  },
  {
    name: "same-origin signed in",
    headers: { origin: "https://worker.example", ...signedIn },
    status: null,
  },
  { name: "same-origin signed out", headers: { origin: "https://worker.example" }, status: 401 },
  { name: "absent-Origin signed in", headers: { ...signedIn }, status: null },
  { name: "absent-Origin signed out", headers: {}, status: 401 },
])("a WebSocket upgrade, $name → $status", ({ headers, status }) => {
  const request = workerRequest("GET", { upgrade: "WebSocket", ...headers });
  expect(auth.require(request)?.status ?? null).toBe(status);
});

test("a plain cross-origin GET with a principal still passes", () => {
  expect(
    auth.require(workerRequest("GET", { origin: "https://evil.example", ...signedIn })),
  ).toBeNull();
});

test("a same-origin POST with a principal still passes", () => {
  expect(
    auth.require(workerRequest("POST", { origin: "https://worker.example", ...signedIn })),
  ).toBeNull();
});

function workerRequest(method: string, headers: Record<string, string>) {
  return new Request("https://worker.example/x", { method, headers });
}
