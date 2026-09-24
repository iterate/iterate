import { expect, test } from "vitest";
import { auth } from "./auth.ts";

// An empty Origin is foreign, like any other that is not this one; only an absent Origin (a
// non-browser client) is trusted (lib.ts isSameOriginBrowserRequest).
test.each([
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

function workerRequest(method: string, headers: Record<string, string>) {
  return new Request("https://worker.example/x", { method, headers });
}
