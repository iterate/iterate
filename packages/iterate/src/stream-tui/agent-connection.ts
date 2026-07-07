/**
 * The chat TUI's connection to one project agent over the shared itx client
 * (apps/os/src/itx-client.ts): a capnweb WebSocket carrying the same `Agent`
 * capability the web app and CLI use. One live subscription pumps stream
 * events into the caller; sends go through `agent.sendMessage`. On a broken
 * session the connection re-dials and re-subscribes from the caller's resume
 * cursor (feed folds are offset-deduped, so replay overlap is harmless).
 */
import type { RpcStub } from "capnweb";
import { connectItx } from "../../../../apps/os/src/itx-client.ts";
import type {
  Agent,
  CapabilityProvision,
  ItxAuthCredentials,
  StreamEvent,
} from "../../../../apps/os/src/types.ts";
import { readConfig } from "../config.ts";
import {
  createMachineCapability,
  MACHINE_CAPABILITY_INSTRUCTIONS,
  MACHINE_CAPABILITY_TYPES,
  type MachineInvocation,
} from "./machine-capability.ts";

/** Path the machine capability mounts at on the agent's scope. */
export const MACHINE_CAPABILITY_PATH = ["usersMachine"];

const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export type AgentConnectionStatus =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting"; detail: string };

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
  /**
   * Provide the live machine capability on the current agent, and keep it
   * provided across reconnects until `stopSharingMachine` (the live stub dies
   * with its socket, so we re-provide on each fresh connection).
   */
  shareMachine(): Promise<void>;
  /** Revoke the machine capability and stop re-providing it on reconnect. */
  stopSharingMachine(): Promise<void>;
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
}): AgentConnection {
  let disposed = false;
  let agent: RpcStub<Agent> | undefined;
  let subscription: Disposable | undefined;
  let consecutiveFailures = 0;
  // When the user has `!share`d, this is set and we (re-)provide the capability
  // on every fresh connection. `provision` is the current live mount, if any.
  let sharingMachine = false;
  let provision: CapabilityProvision | undefined;

  const machineCapability = createMachineCapability({
    onInvocation: (invocation) => input.onMachineInvocation?.(invocation),
  });

  const provideMachine = async () => {
    if (!sharingMachine || agent === undefined || provision !== undefined) return;
    provision = await agent.provideCapability({
      type: "live",
      path: MACHINE_CAPABILITY_PATH,
      capability: machineCapability,
      instructions: MACHINE_CAPABILITY_INSTRUCTIONS,
      types: MACHINE_CAPABILITY_TYPES,
    });
  };

  const disposeAgent = () => {
    try {
      // The provision's revoke rides the same socket, so once the agent stub is
      // gone the mount is unreachable anyway; just drop our handle and re-provide
      // on the next connection.
      provision?.[Symbol.dispose]?.();
      subscription?.[Symbol.dispose]?.();
      agent?.[Symbol.dispose]?.();
    } catch {
      // The socket may already be gone; the stub is dead either way.
    }
    provision = undefined;
    subscription = undefined;
    agent = undefined;
  };

  const scheduleReconnect = (detail: string) => {
    if (disposed) return;
    disposeAgent();
    consecutiveFailures += 1;
    const delay = Math.min(RECONNECT_DELAY_MS * consecutiveFailures, MAX_RECONNECT_DELAY_MS);
    input.onStatus({ kind: "reconnecting", detail });
    setTimeout(() => void establish(), delay);
  };

  async function establish(): Promise<void> {
    if (disposed) return;
    input.onStatus({ kind: "connecting" });
    const nextAgent = connectItx({
      auth: input.auth,
      baseUrl: input.baseUrl,
      projectId: input.projectId,
      agentPath: input.agentPath,
    });
    agent = nextAgent;
    // Best-effort transport-death signal; a failed subscribe below covers the rest.
    (nextAgent as { onRpcBroken?: (cb: (error: unknown) => void) => void }).onRpcBroken?.(
      (error) => {
        if (agent !== nextAgent) return;
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
        disposeAgent();
        return;
      }
      consecutiveFailures = 0;
      input.onStatus({ kind: "live" });
      // Re-establish sharing on a fresh socket (no-op if not sharing).
      await provideMachine();
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
    async shareMachine() {
      sharingMachine = true;
      await provideMachine();
    },
    async stopSharingMachine() {
      sharingMachine = false;
      const current = provision;
      provision = undefined;
      if (current === undefined) return;
      try {
        await current.revoke();
      } catch {
        // Socket may be gone; the mount dies with it regardless.
      }
    },
    dispose() {
      disposed = true;
      sharingMachine = false;
      disposeAgent();
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
