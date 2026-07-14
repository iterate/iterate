import { describe, expect, it, vi } from "vitest";
import { shouldDeployOs, SKIP_MAIN_CI_DEPLOY_LABEL } from "./should-deploy-os.ts";

function githubResponse(pullRequests: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(pullRequests), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
}

describe("shouldDeployOs", () => {
  it("always permits an explicit dispatch", async () => {
    await expect(shouldDeployOs({ eventName: "workflow_dispatch" })).resolves.toMatchObject({
      shouldDeploy: true,
    });
  });

  it("skips a main push associated with a labelled PR", async () => {
    const result = await shouldDeployOs({
      eventName: "push",
      repository: "iterate/iterate",
      sha: "abc",
      token: "token",
      fetchImpl: githubResponse([{ number: 42, labels: [{ name: SKIP_MAIN_CI_DEPLOY_LABEL }] }]),
    });
    expect(result).toEqual({
      shouldDeploy: false,
      reason: "PR #42 carries skip-main-ci-deploy",
    });
  });

  it("permits ordinary PR merges and direct pushes", async () => {
    const ordinary = await shouldDeployOs({
      eventName: "push",
      repository: "iterate/iterate",
      sha: "abc",
      token: "token",
      fetchImpl: githubResponse([{ number: 43, labels: [] }]),
    });
    const direct = await shouldDeployOs({
      eventName: "push",
      repository: "iterate/iterate",
      sha: "def",
      token: "token",
      fetchImpl: githubResponse([]),
    });
    expect(ordinary.shouldDeploy).toBe(true);
    expect(direct.shouldDeploy).toBe(true);
  });
});
