// api.ts — `itx.agents`, the agents app's published type. The app is userspace: a project installs
// it (install.ts mounts the collection facet as the `itx.agents` rewrite rule), the platform never
// ships it, so iterate/api does not name it. Importing this package registers the root on
// iterate/api's `InstalledAppRoots`, and a caller that knows agents are installed writes
// `itx as IterateContextApiWith<"agents">`. catalog.ts and collection.ts implement it.
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";

/** What `agents.get(path).message(input)` takes: the words, or the words with attachments (each
 *  stored under the agent's path in `itx.files` and named on the event). */
export type AgentMessageInput =
  | string
  | {
      message: string;
      files?: { contentType: string; filename: string; data: Uint8Array | ArrayBuffer | string }[];
    };

/** `itx.agents.get(path)`: one agent. */
export interface AgentHandleApi {
  /** A person's words: ONE `events.iterate.com/agent/context-added`, the trigger of the agent's
   *  next turn, answered so a caller can wait for what follows it. A deleted agent, or one never
   *  created, refuses. */
  message(input: AgentMessageInput): Promise<StreamEvent>;
  /** Append to the agent's context. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
}

/** `itx.agents` — installed by rewrite rule on the project's root and on each agent's context.
 *  `create` and `delete` are sagas on the agent's path (a deleted agent is not re-creatable);
 *  `upgrade` rebinds every agent to the installed runtime. */
export interface AgentsApi {
  list(): Promise<{ path: string; createdAt: string }[]>;
  get(path: string): AgentHandleApi;
  create(path: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string }>;
  upgrade(): Promise<void>;
}

declare module "iterate/api" {
  interface InstalledAppRoots {
    agents: AgentsApi;
  }
}
