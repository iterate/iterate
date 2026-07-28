import { describe, expect, it } from "vitest";
import {
  WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT,
  workerDeploymentVersionRpcResponse,
  type Env,
} from "./env.ts";

describe("workerDeploymentVersionRpcResponse", () => {
  const env = {
    CF_VERSION_METADATA: {
      id: "version-new",
      timestamp: "2026-07-28T12:48:43.221246Z",
    },
  } as Env;

  it("preserves the legacy no-argument string response", () => {
    expect(workerDeploymentVersionRpcResponse(env)).toBe("version-new");
  });

  it("returns directional metadata only when a new caller requests it", () => {
    expect(
      workerDeploymentVersionRpcResponse(env, WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT),
    ).toEqual({
      id: "version-new",
      timestamp: "2026-07-28T12:48:43.221246Z",
    });
  });
});
