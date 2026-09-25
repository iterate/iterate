// @iterate-com/agents — the agents app: a collection of agents on a project, each a conversation
// driven by a model that acts through scripts against its context. A project installs it from a
// folder of its config repo that re-exports these two classes (install.ts); importing the package
// registers `itx.agents` on iterate/api's `InstalledAppRoots` (api.ts).
export { AgentCollectionDurableObject } from "./catalog.ts";
export { AgentDurableObject } from "./durable-object.ts";
export type { AgentHandleApi, AgentMessageInput, AgentsApi } from "./api.ts";
