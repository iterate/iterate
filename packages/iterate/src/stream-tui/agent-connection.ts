/**
 * The chat TUI's connection to one project agent over the shared itx client
 * (apps/os/src/itx-client.ts): a capnweb WebSocket carrying the same `Agent`
 * capability the web app and CLI use. One live subscription pumps stream
 * events into the caller; sends go through `agent.sendMessage`. On a broken
 * session the connection re-dials and re-subscribes from the caller's resume
 * cursor (feed folds are offset-deduped, so replay overlap is harmless).
 *
 * The connection also SHARES THE HUMAN'S MACHINE with the agent, as a live
 * capability at `itx.usersMachine`. Two scopes:
 *   - By default it's mounted on the AGENT'S scope — only the agent you're
 *     chatting with can reach your machine, for this session only. A chat
 *     without filesystem access would be a coding agent that can't touch code,
 *     so this is on from the start, no command needed.
 *   - `shareWithProject()` (the `/share` command) additionally mounts it on the
 *     PROJECT root, so every agent in the project can reach your machine while
 *     the CLI runs. `unshareFromProject()` (`/unshare`) removes that.
 * Both mounts are `type: "live"`, so they die with the socket — closing the CLI
 * (Ctrl+C) revokes all filesystem access.
 */
import type { RpcStub } from "capnweb";
import { connectItx } from "../../../../apps/os/src/itx-client.ts";
import type {
  Agent,
  CapabilityProvision,
  ItxAuthCredentials,
  Project,
  StreamEvent,
} from "../../../../apps/os/src/itx-api.generated.ts";
import { readConfig } from "../config.ts";
import {
  createMachineCapability,
  MACHINE_CAPABILITY_INSTRUCTIONS,
  MACHINE_CAPABILITY_TYPES,
  type MachineInvocation,
} from "./machine-capability.ts";

/** Path the machine capability mounts at, on both the agent and project scopes. */
export const MACHINE_CAPABILITY_PATH = ["usersMachine"];

const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export type AgentConnectionStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting"; detail: string };

/** Whether the machine is shared only with this session's agent, or the whole project. */
export type MachineShareScope = "session" | "project";

/** The one bit of `connectItx` this module uses — injectable so tests can drive a fake. */
type ConnectProject = (input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
}) => RpcStub<Project>;

/**
 * Resolve itx credentials for the TUI, in priority order: an admin API secret
 * from the environment (doppler / e2e lanes), an explicit bearer token, then
 * the stored `iterate login` session for the named config. The launcher
 * (`iterate chat`) refreshes the stored session before spawning the TUI, so a
 * plain bearer read is enough here.
 */
export function resolveItxAuth(input: { configName: string | undefined }): ItxAuthCredentials {
  const adminSecret = readEnv("APP_CONFIG_ADMIN_API_SECRET");
  if (adminSecret) return { type: "admin-secret", secret: adminSecret };

  const bearerToken = readEnv("ITERATE_BEARER_TOKEN");
  if (bearerToken) return { type: "bearer", token: bearerToken };

  if (input.configName) {
    const config = readConfig(input.configName, { throw: true });
    if (config.session?.token) return { type: "bearer", token: config.session.token };
  }

  throw new Error(
    "No credentials: run `iterate login`, or set an admin API secret " +
      "(APP_CONFIG_ADMIN_API_SECRET) or a bearer token (ITERATE_BEARER_TOKEN).",
  );
}

type AgentConnection = {
  /** Append one user message to the agent stream (triggers the agent loop). */
  sendMessage(text: string): Promise<void>;
  /** Widen machine sharing from this session's agent to the whole project (`/share`). */
  shareWithProject(): Promise<void>;
  /** Narrow machine sharing back to this session's agent only (`/unshare`). */
  unshareFromProject(): Promise<void>;
  dispose(): void;
};

export function connectAgentFeed(input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  agentPath: string;
  /** Resume cursor for (re)subscribes — typically the feed model's lastOffset. */
  replayAfterOffset: () => number;
  onEvents: (events: readonly StreamEvent[]) => void;
  onStatus: (status: AgentConnectionStatus) => void;
  /** Called before each method the agent invokes on the shared machine. */
  onMachineInvocation?: (invocation: MachineInvocation) => void;
  /** Override the itx connect fn (tests inject a fake project stub). */
  connect?: ConnectProject;
}): AgentConnection {
  const connect: ConnectProject = input.connect ?? (connectItx as ConnectProject);
  let disposed = false;
  let project: RpcStub<Project> | undefined;
  let agent: RpcStub<Agent> | undefined;
  let subscription: Disposable | undefined;
  let consecutiveFailures = 0;
  // The default (agent-scope) mount is always provided; the project-scope mount
  // only while the user has `/share`d. Both are re-provided on each fresh socket.
  let sessionProvision: CapabilityProvision | undefined;
  let projectProvision: CapabilityProvision | undefined;
  let sharingWithProject = false;

  const machineCapability = createMachineCapability({
    onInvocation: (invocation) => input.onMachineInvocation?.(invocation),
  });

  const provideInput = {
    type: "live" as const,
    path: MACHINE_CAPABILITY_PATH,
    capability: machineCapability,
    instructions: MACHINE_CAPABILITY_INSTRUCTIONS,
    types: MACHINE_CAPABILITY_TYPES,
  };

  // provideCapability is a network round-trip. Between the guard check and the
  // await resolving, the user can `/unshare`, the socket can reconnect, or we
  // can dispose — so each provide RECONCILES against the desired state after the
  // await and revokes the fresh mount if it's no longer wanted, instead of
  // blindly retaining it. The in-flight flags stop two concurrent callers from
  // both provisioning the same scope (e.g. `/share` racing a reconnect's
  // re-provide). Together these keep "the mount reflects what the user asked
  // for" true even under fast toggling over a slow link.
  let providingSession = false;
  let providingProject = false;

  const provideSession = async () => {
    if (agent === undefined || sessionProvision !== undefined || providingSession) return;
    providingSession = true;
    const providingOn = agent;
    try {
      const provision = await providingOn.provideCapability(provideInput);
      if (disposed || agent !== providingOn) {
        await provision.revoke().catch(() => {});
        return;
      }
      sessionProvision = provision;
    } finally {
      providingSession = false;
    }
  };

  const provideProject = async () => {
    if (
      !sharingWithProject ||
      project === undefined ||
      projectProvision !== undefined ||
      providingProject
    ) {
      return;
    }
    providingProject = true;
    const providingOn = project;
    try {
      const provision = await providingOn.provideCapability(provideInput);
      // Reconcile: if the user `/unshare`d, we disposed, or the socket was
      // replaced while awaiting, this mount is unwanted — revoke and bail.
      if (!sharingWithProject || disposed || project !== providingOn) {
        await provision.revoke().catch(() => {});
        return;
      }
      projectProvision = provision;
    } finally {
      providingProject = false;
    }
  };

  const disposeConnection = () => {
    try {
      // Provisions ride the same socket, so once it's gone the mounts are
      // unreachable anyway; drop the handles and re-provide on the next connect.
      projectProvision?.[Symbol.dispose]?.();
      sessionProvision?.[Symbol.dispose]?.();
      subscription?.[Symbol.dispose]?.();
      agent?.[Symbol.dispose]?.();
      project?.[Symbol.dispose]?.();
    } catch {
      // The socket may already be gone; the stubs are dead either way.
    }
    projectProvision = undefined;
    sessionProvision = undefined;
    subscription = undefined;
    agent = undefined;
    project = undefined;
  };

  const scheduleReconnect = (detail: string) => {
    if (disposed) return;
    disposeConnection();
    consecutiveFailures += 1;
    const delay = Math.min(RECONNECT_DELAY_MS * consecutiveFailures, MAX_RECONNECT_DELAY_MS);
    input.onStatus({ kind: "reconnecting", detail });
    setTimeout(() => void establish(), delay);
  };

  async function establish(): Promise<void> {
    if (disposed) return;
    input.onStatus({ kind: "connecting" });
    // Connect at the PROJECT scope and derive the agent from it, so we hold both
    // stubs on ONE socket: the agent for chat + the session-scoped mount, the
    // project for the `/share` mount.
    const nextProject = connect({
      auth: input.auth,
      baseUrl: input.baseUrl,
      projectId: input.projectId,
    });
    const nextAgent = nextProject.agents.get(input.agentPath) as RpcStub<Agent>;
    project = nextProject;
    agent = nextAgent;
    // Best-effort transport-death signal; a failed subscribe below covers the rest.
    (nextProject as { onRpcBroken?: (cb: (error: unknown) => void) => void }).onRpcBroken?.(
      (error) => {
        if (project !== nextProject) return;
        scheduleReconnect(errorMessage(error));
      },
    );
    try {
      subscription = await nextAgent.stream.subscribe({
        processEventBatch: (batch) => input.onEvents(batch.events),
        replayAfterOffset: input.replayAfterOffset(),
        subscriber: { description: "iterate chat TUI" },
      });
      if (disposed) {
        disposeConnection();
        return;
      }
      consecutiveFailures = 0;
      input.onStatus({ kind: "live" });
      // Filesystem access is on by default for this session; re-establish the
      // project-wide share too if the user had `/share`d.
      await provideSession();
      await provideProject();
    } catch (error) {
      if (agent === nextAgent) scheduleReconnect(errorMessage(error));
    }
  }

  void establish();

  return {
    async sendMessage(text) {
      if (agent === undefined) throw new Error("not connected");
      await agent.sendMessage(text);
    },
    async shareWithProject() {
      sharingWithProject = true;
      await provideProject();
    },
    async unshareFromProject() {
      sharingWithProject = false;
      const current = projectProvision;
      projectProvision = undefined;
      if (current === undefined) return;
      try {
        await current.revoke();
      } catch {
        // Socket may be gone; the mount dies with it regardless.
      }
    },
    dispose() {
      disposed = true;
      sharingWithProject = false;
      disposeConnection();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
