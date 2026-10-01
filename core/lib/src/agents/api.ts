// api.ts — `itx.agents`, the agents app's published type. A project installs the app (install.ts
// mounts the collection facet as the `itx.agents` rewrite rule), so iterate/api does not name it.
// Importing `iterate/agents` registers the root on iterate/api's `InstalledAppRoots`, and a caller
// that knows agents are installed writes `itx as IterateContextApiWith<"agents">`. catalog.ts and
// collection.ts implement it.
import type { StreamEvent } from "../stream/processor.ts";

/** What `agents.get(path).message(input)` takes: the words, or the words with attachments (each
 *  stored under the agent's path in `itx.files` and named on the event). */
export type AgentMessageInput =
  | string
  | {
      message: string;
      files?: { contentType: string; filename: string; data: Uint8Array | ArrayBuffer | string }[];
    };

/** `itx.agents.get(path)`: one agent. Anything else on its context is a plain
 *  `itx.cd(path).append(…)`, stamped with where it came from. */
export interface AgentHandleApi {
  /** A person's words: ONE `events.iterate.com/agent/context-added`, the trigger of the agent's
   *  next turn, answered so a caller can wait for what follows it. Sent from another agent, the model reads them as `[from <sender's context>]` — the collection's base, which
   *  the sender's own `itx.agents` row pins (collection.ts); from anywhere else they read as a
   *  person's. A deleted agent, or one never created, refuses. */
  message(input: AgentMessageInput): Promise<StreamEvent>;
}

/** `itx.agents` — installed by rewrite rule on the project's root and on each agent's context.
 *  `create` and `delete` are sagas on the agent's path (a deleted agent is not re-creatable). */
export interface AgentsApi {
  list(): Promise<{ path: string; createdAt: string }[]>;
  get(path: string): AgentHandleApi;
  create(path: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string }>;
}

declare module "iterate/api" {
  interface InstalledAppRoots {
    agents: AgentsApi;
  }
}
