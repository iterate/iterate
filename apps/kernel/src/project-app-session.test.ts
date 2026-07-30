import { describe, expect, test } from "vitest";
import { mintProjectAppSession, verifyProjectAppSessionToken } from "./project-app-session.ts";

// The project-app-session is the NARROW, project-scoped grant a project app carries instead of the
// user's over-privileged access token (review #3). Mint + local HS256 verify, no worker needed.
const secret = "unit-test-secret";

describe("project-app-session token", () => {
  test("round-trips: mint then verify returns the scoped grant", async () => {
    const token = await mintProjectAppSession(secret, { projectId: "alice", userId: "u1" });
    expect(await verifyProjectAppSessionToken(secret, token)).toEqual({
      projectId: "alice",
      userId: "u1",
    });
  });

  test("a wrong secret does not verify (forged / cross-deployment)", async () => {
    const token = await mintProjectAppSession(secret, { projectId: "alice", userId: "u1" });
    expect(await verifyProjectAppSessionToken("other-secret", token)).toBeNull();
  });

  test("a tampered payload does not verify", async () => {
    const token = await mintProjectAppSession(secret, { projectId: "alice", userId: "u1" });
    const [header, , signature] = token.split(".");
    const forgedPayload = btoa(
      JSON.stringify({ projectId: "bob", userId: "u1", type: "project-app-session", exp: 9e9 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyProjectAppSessionToken(secret, `${header}.${forgedPayload}.${signature}`),
    ).toBeNull();
  });

  test("an expired token does not verify", async () => {
    const token = await mintProjectAppSession(secret, { projectId: "alice", userId: "u1" }, -1);
    expect(await verifyProjectAppSessionToken(secret, token)).toBeNull();
  });

  test("garbage is rejected, never thrown", async () => {
    expect(await verifyProjectAppSessionToken(secret, "not.a.jwt")).toBeNull();
    expect(await verifyProjectAppSessionToken(secret, "")).toBeNull();
  });
});
