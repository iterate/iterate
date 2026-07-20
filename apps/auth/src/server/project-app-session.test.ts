import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintProjectAppSession, validateProjectAppSession } from "./project-app-session.ts";

const audience = "https://internal--demo.iterate.app";
const projectId = "prj_demo";
const secret = "test-project-app-session-secret";

describe("project app sessions", () => {
  it("mints an origin-scoped token and re-checks access on validation", async () => {
    let canAccess = true;
    const userCanAccessProject = async (input: { projectId: string; userId: string }) => {
      assert.deepEqual(input, { projectId, userId: "usr_one" });
      return canAccess;
    };
    const issued = await mintProjectAppSession(
      { audience, projectId, userId: "usr_one" },
      { secret, userCanAccessProject },
    );
    assert.ok(issued);

    const valid = await validateProjectAppSession(
      { audience, projectId, token: issued.token },
      { secret, userCanAccessProject },
    );
    assert.equal(valid?.userId, "usr_one");
    assert.ok(valid?.expiresAt && valid.expiresAt > Date.now() / 1000);

    canAccess = false;
    assert.equal(
      await validateProjectAppSession(
        { audience, projectId, token: issued.token },
        { secret, userCanAccessProject },
      ),
      null,
    );
  });

  it("does not mint without project access", async () => {
    assert.equal(
      await mintProjectAppSession(
        { audience, projectId, userId: "usr_outsider" },
        { secret, userCanAccessProject: async () => false },
      ),
      null,
    );
  });

  it("rejects a token outside its project or app origin", async () => {
    const userCanAccessProject = async () => true;
    const issued = await mintProjectAppSession(
      { audience, projectId, userId: "usr_one" },
      { secret, userCanAccessProject },
    );
    assert.ok(issued);

    assert.equal(
      await validateProjectAppSession(
        { audience: "https://other.iterate.app", projectId, token: issued.token },
        { secret, userCanAccessProject },
      ),
      null,
    );
    assert.equal(
      await validateProjectAppSession(
        { audience, projectId: "prj_other", token: issued.token },
        { secret, userCanAccessProject },
      ),
      null,
    );
    assert.equal(
      await validateProjectAppSession(
        { audience, projectId, token: "not-a-token" },
        { secret, userCanAccessProject },
      ),
      null,
    );
  });

  it("accepts tokens minted under the legacy secret during a cutover", async () => {
    const userCanAccessProject = async () => true;
    const issued = await mintProjectAppSession(
      { audience, projectId, userId: "usr_legacy" },
      { secret: "old-secret", userCanAccessProject },
    );
    assert.ok(issued);

    // New deployments verify with the dedicated secret first, then fall back
    // to the previous one until in-flight tokens age out (15-minute TTL).
    const valid = await validateProjectAppSession(
      { audience, projectId, token: issued.token },
      { secret: "new-dedicated-secret", legacySecret: "old-secret", userCanAccessProject },
    );
    assert.ok(valid);
    assert.equal(valid.userId, "usr_legacy");

    assert.equal(
      await validateProjectAppSession(
        { audience, projectId, token: issued.token },
        { secret: "new-dedicated-secret", userCanAccessProject },
      ),
      null,
    );
  });
});
