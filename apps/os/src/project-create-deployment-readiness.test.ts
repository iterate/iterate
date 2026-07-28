import { beforeEach, describe, expect, it, vi } from "vitest";

const waitForProjectBirthDeploymentVersion = vi.hoisted(() => vi.fn());
const streamGetByName = vi.hoisted(() => vi.fn());
const projectDirectoryPut = vi.hoisted(() => vi.fn(async () => undefined));
const projectDirectoryDelete = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./domains/projects/project-birth-deployment-readiness.ts", () => ({
  waitForProjectBirthDeploymentVersion,
}));

vi.mock("./env.ts", () => ({
  itxEnv: {
    PROJECT_DIRECTORY: {
      delete: projectDirectoryDelete,
      put: projectDirectoryPut,
    },
    STREAM: {
      getByName: streamGetByName,
    },
  },
  workerDeploymentVersion: () => ({ id: "version-new" }),
  workerVersion: () => "version-new",
  WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT: "metadata-v1",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("ProjectRpcTarget create deployment readiness", () => {
  beforeEach(() => {
    waitForProjectBirthDeploymentVersion.mockReset();
    streamGetByName.mockReset();
    projectDirectoryPut.mockClear();
    projectDirectoryDelete.mockClear();
    vi.restoreAllMocks();
  });

  it("does not append root birth facts until the Project Durable Object is current", async () => {
    const notReady = new Error("Project Durable Object did not converge");
    waitForProjectBirthDeploymentVersion.mockRejectedValueOnce(notReady);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const target = new ProjectRpcTarget({
      auth: {
        assertCanAccessProject: vi.fn(),
        canAccessProject: () => true,
        isAdmin: () => true,
        listAccessibleProjects: () => [],
        principal: "test-admin",
      },
      ctx: { waitUntil: vi.fn() },
      prospectiveSlug: "rollout-race",
    } as never);

    await expect(
      target.create({ projectId: "prj_rollout_race" }, { waitUntilReady: false }),
    ).rejects.toBe(notReady);

    expect(projectDirectoryPut).toHaveBeenCalledTimes(2);
    expect(waitForProjectBirthDeploymentVersion).toHaveBeenCalledWith({
      expectedVersion: { id: "version-new" },
      getTarget: expect.any(Function),
      projectId: "prj_rollout_race",
    });
    expect(streamGetByName).not.toHaveBeenCalled();
  });
});
