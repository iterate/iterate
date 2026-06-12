/** Workspace worker: filesystem/git workspaces over Cloudflare Shell. */
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-workspace" }, { status: 404 }),
};
