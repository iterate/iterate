// @iterate-com/agents — the agents app: a collection of agents on a project, each a conversation
// driven by a model that acts through scripts against its context. A project's config repo
// re-exports these two classes from its `agents.ts` and installs them from its init case
// (install.ts); importing the package registers `itx.agents` on iterate/api's
// `InstalledAppRoots` (api.ts).
export { AgentCollectionDurableObject } from "./catalog.ts";
export { AgentDurableObject } from "./durable-object.ts";
export type { AgentHandleApi, AgentMessageInput, AgentsApi } from "./api.ts";
