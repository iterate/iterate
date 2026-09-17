import type { Project } from "iterate/node";
import type { RpcStub } from "capnweb";
import { noOpAgent } from "./resilient-ai-interceptor.ts";

/** Session-owned interception; scripts that need a reply replace the background handler. */
export async function createProject(
  project: RpcStub<Project>,
  args: NonNullable<Parameters<Project["create"]>[0]> = {},
) {
  const created = await project.create({ aiPolicy: { liveAgentPaths: [] }, ...args });
  // The mount lives on the caller's session. Closing it leaves the immutable
  // interception policy in place: late work can never fall back to paid AI.
  await created.ai.intercept(noOpAgent);
  return created;
}
