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

test("a GET with an empty Origin and no principal still redirects to sign in", () => {
  const response = auth.require(workerRequest("GET", { origin: "" }));
  expect(response?.status).toBe(302);
  expect(response?.headers.get("Location")).toBe("/.auth/login?next=%2Fx");
});

// A WebSocket handshake is a GET, but it is checked like a write: every `<app>--<project>.iterate.app`
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
