import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintProjectAppSession, validateProjectAppSession } from "./project-app-session.ts";

const audience = "https://internal--demo.iterate.app";
const projectId = "prj_demo";
const secret = "test-project-app-session-secret";

describe("project app sessions", () => {
  it("mints an origin-scoped token and re-checks membership on validation", async () => {
    let member = true;
    const userHasProject = async (input: { projectId: string; userId: string }) => {
      assert.deepEqual(input, { projectId, userId: "usr_one" });
      return member;
    };
    const issued = await mintProjectAppSession(
      { audience, projectId, userId: "usr_one" },
      { secret, userHasProject },
    );
    assert.ok(issued);

    const valid = await validateProjectAppSession(
      { audience, projectId, token: issued.token },
      { secret, userHasProject },
    );
    assert.ok(valid?.expiresAt && valid.expiresAt > Date.now() / 1000);

    member = false;
    assert.equal(
      await validateProjectAppSession(
        { audience, projectId, token: issued.token },
        { secret, userHasProject },
      ),
      null,
    );
  });

  it("does not mint for a non-member", async () => {
    assert.equal(
      await mintProjectAppSession(
        { audience, projectId, userId: "usr_outsider" },
        { secret, userHasProject: async () => false },
      ),
      null,
    );
  });

  it("rejects a token outside its project or app origin", async () => {
    const userHasProject = async () => true;
    const issued = await mintProjectAppSession(
      { audience, projectId, userId: "usr_one" },
      { secret, userHasProject },
    );
    assert.ok(issued);

    assert.equal(
      await validateProjectAppSession(
        { audience: "https://other.iterate.app", projectId, token: issued.token },
        { secret, userHasProject },
      ),
      null,
    );
    assert.equal(
      await validateProjectAppSession(
        { audience, projectId: "prj_other", token: issued.token },
        { secret, userHasProject },
      ),
      null,
    );
    assert.equal(
      await validateProjectAppSession(
        { audience, projectId, token: "not-a-token" },
        { secret, userHasProject },
      ),
      null,
    );
  });
});
