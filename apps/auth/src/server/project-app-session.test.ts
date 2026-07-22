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

  it("bakes optional display identity into the claims and still validates", async () => {
    const userCanAccessProject = async () => true;
    const issued = await mintProjectAppSession(
      {
        audience,
        projectId,
        userId: "usr_one",
        email: "one@example.com",
        image: "https://example.com/one.png",
        name: "One Person",
      },
      { secret, userCanAccessProject },
    );
    assert.ok(issued);

    const payload = JSON.parse(
      Buffer.from(issued.token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    assert.equal(payload.email, "one@example.com");
    assert.equal(payload.image, "https://example.com/one.png");
    assert.equal(payload.name, "One Person");
    assert.equal(payload.userId, "usr_one");

    // The strict claims schema accepts the enriched token…
    const valid = await validateProjectAppSession(
      { audience, projectId, token: issued.token },
      { secret, userCanAccessProject },
    );
    assert.equal(valid?.userId, "usr_one");

    // …and blank display fields stay out of the claims entirely.
    const bare = await mintProjectAppSession(
      { audience, projectId, userId: "usr_one", email: "", image: " ", name: "  " },
      { secret, userCanAccessProject },
    );
    assert.ok(bare);
    const bareClaims = JSON.parse(
      Buffer.from(bare.token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    assert.equal("email" in bareClaims, false);
    assert.equal("image" in bareClaims, false);
    assert.equal("name" in bareClaims, false);
  });
});
