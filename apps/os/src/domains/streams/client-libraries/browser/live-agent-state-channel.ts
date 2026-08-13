import type { AgentUiState } from "@iterate-com/ui/components/events/agent-ui-reducer";

type LiveAgentStateMessage =
  | { kind: "request" }
  | { kind: "claim"; sessionId: string; startedAtMs: number }
  | {
      kind: "state";
      sessionId: string;
      sequence: number;
      state: AgentUiState | null;
    };

export type LiveAgentStateChannelPort = {
  postMessage(message: unknown): void;
  setMessageHandler(handler: (message: unknown) => void): void;
  close(): void;
};

type LiveSession = {
  sessionId: string;
  startedAtMs: number;
  sequence: number;
  state: AgentUiState | null;
};

/**
 * Cross-tab relay for the current event connection's volatile agent projection.
 * Nothing in this class touches SQLite: old ephemeral events can never become
 * history merely because another tab needs to paint newly received events.
 */
export class LiveAgentStateChannel implements Disposable {
  readonly #port: LiveAgentStateChannelPort;
  readonly #onState: (state: AgentUiState | null) => void;
  readonly #now: () => number;
  readonly #createSessionId: () => string;
  #localSession: LiveSession | undefined;
  #activeSession: Pick<LiveSession, "sessionId" | "startedAtMs" | "sequence"> | undefined;
  #disposed = false;

  constructor(args: {
    name: string;
    onState: (state: AgentUiState | null) => void;
    createPort?: (name: string) => LiveAgentStateChannelPort;
    now?: () => number;
    createSessionId?: () => string;
  }) {
    this.#port = (args.createPort ?? createBrowserPort)(args.name);
    this.#onState = args.onState;
    this.#now = args.now ?? Date.now;
    this.#createSessionId = args.createSessionId ?? (() => crypto.randomUUID());
    this.#port.setMessageHandler((message) => this.#receive(message));
  }

  /** Ask the current writer to repeat its claim and latest volatile state. */
  request(): void {
    this.#post({ kind: "request" });
  }

  /** Become the writer for a newly opened event connection. */
  claim(state: AgentUiState | null): void {
    this.#assertOpen();
    const localSession: LiveSession = {
      sessionId: this.#createSessionId(),
      startedAtMs: this.#now(),
      sequence: 0,
      state,
    };
    this.#localSession = localSession;
    this.#activeSession = localSession;
    this.#sendSnapshot(localSession);
  }

  /** Publish the writer's newest in-memory projection. Readers never persist it. */
  publish(state: AgentUiState | null): void {
    const session = this.#localSession;
    if (!session || this.#disposed) return;
    session.sequence += 1;
    session.state = state;
    this.#activeSession = session;
    this.#post({
      kind: "state",
      sessionId: session.sessionId,
      sequence: session.sequence,
      state,
    });
  }

  /** Clear readers before relinquishing the writer lock. */
  release(): void {
    if (!this.#localSession) return;
    this.publish(null);
    this.#localSession = undefined;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    try {
      this.release();
    } finally {
      // BroadcastChannel.postMessage can throw during teardown. Closing the
      // port is still mandatory: otherwise a failed final snapshot leaks the
      // channel and its message handler for the lifetime of the tab.
      this.#disposed = true;
      this.#port.close();
    }
  }

  #receive(raw: unknown): void {
    if (this.#disposed) return;
    const message = parseMessage(raw);
    if (!message) return;

    if (message.kind === "request") {
      if (this.#localSession) this.#sendSnapshot(this.#localSession);
      return;
    }

    if (message.kind === "claim") {
      if (!isNewerClaim(message, this.#activeSession)) return;
      this.#activeSession = { ...message, sequence: -1 };
      this.#onState(null);
      return;
    }

    const active = this.#activeSession;
    if (!active || message.sessionId !== active.sessionId || message.sequence <= active.sequence) {
      return;
    }
    active.sequence = message.sequence;
    this.#onState(message.state);
  }

  #sendSnapshot(session: LiveSession): void {
    this.#post({
      kind: "claim",
      sessionId: session.sessionId,
      startedAtMs: session.startedAtMs,
    });
    this.#post({
      kind: "state",
      sessionId: session.sessionId,
      sequence: session.sequence,
      state: session.state,
    });
  }

  #post(message: LiveAgentStateMessage): void {
    if (!this.#disposed) this.#port.postMessage(message);
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("live agent state channel is disposed");
  }
}

export function liveAgentStateChannelName(args: {
  projectId: string;
  streamPath: string;
  processorSchemaVersionKey: string;
}): string {
  return [
    "stream-live-agent",
    encodeURIComponent(args.projectId),
    encodeURIComponent(args.streamPath),
    encodeURIComponent(args.processorSchemaVersionKey),
  ].join(":");
}

function createBrowserPort(name: string): LiveAgentStateChannelPort {
  const channel = new BroadcastChannel(name);
  return {
    postMessage: (message) => channel.postMessage(message),
    setMessageHandler: (handler) => {
      channel.onmessage = (event: MessageEvent<unknown>) => handler(event.data);
    },
    close: () => channel.close(),
  };
}

function isNewerClaim(
  candidate: Extract<LiveAgentStateMessage, { kind: "claim" }>,
  current: Pick<LiveSession, "sessionId" | "startedAtMs"> | undefined,
): boolean {
  if (!current) return true;
  if (candidate.sessionId === current.sessionId) return false;
  if (candidate.startedAtMs !== current.startedAtMs) {
    return candidate.startedAtMs > current.startedAtMs;
  }
  return candidate.sessionId > current.sessionId;
}

function parseMessage(raw: unknown): LiveAgentStateMessage | undefined {
  if (typeof raw !== "object" || !raw) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kind === "request") return { kind: "request" };
  if (
    value.kind === "claim" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length &&
    typeof value.startedAtMs === "number" &&
    Number.isFinite(value.startedAtMs)
  ) {
    return {
      kind: "claim",
      sessionId: value.sessionId,
      startedAtMs: value.startedAtMs,
    };
  }
  if (
    value.kind === "state" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    (!value.state || (typeof value.state === "object" && value.state))
  ) {
    return {
      kind: "state",
      sessionId: value.sessionId,
      sequence: value.sequence,
      state: value.state as AgentUiState | null,
    };
  }
  return undefined;
}
