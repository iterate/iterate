// The overlap socket is deliberately held in ProjectDO memory while its
// native secret/egress fetch is unresolved. Cancellation/expiry must release
// the claim immediately but retain the in-flight operation's capacity slot
// until that fetch returns, so a late 101 can be closed rather than leaked.

import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectDurableObject } from "./project-durable-object.ts";
import { withStreamContext } from "./stream-context.ts";
import {
  VOICE_HANDSHAKE_OVERLAP_PREFIX,
  VOICE_HANDSHAKE_OVERLAP_PROJECT_ID,
  VOICE_HANDSHAKE_OVERLAP_TTL_MS,
  VOICE_HANDSHAKE_OVERLAP_URL,
} from "./voice-handshake-overlap-control.ts";

// Node's Response intentionally cannot represent a 101. This small test-only
// transport substitution returns the fake Workers response unchanged, leaving
// ProjectDO's real ownership, capacity, and claim logic under test.
vi.mock("../secrets/websocket-handshake.ts", () => ({
  withWebSocketHandshakeHeaders: async (_request: Request, response: Response) => response,
}));

const activation = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const streamPath = (index: number) => `${VOICE_HANDSHAKE_OVERLAP_PREFIX}${index}`;

afterEach(() => vi.restoreAllMocks());

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; settled: boolean };
function deferred<T>(): Deferred<T> {
  let finish!: (value: T) => void;
  const value: Deferred<T> = {
    promise: new Promise<T>((resolve) => (finish = resolve)),
    resolve(next) {
      if (value.settled) return;
      value.settled = true;
      finish(next);
    },
    settled: false,
  };
  return value;
}

function fakeUpgrade() {
  const socket = { accept: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  return {
    response: { status: 101, webSocket: socket, headers: new Headers(), body: null } as Response,
    socket,
  };
}

function requestFor(path: string): Request {
  return withStreamContext(
    new Request(VOICE_HANDSHAKE_OVERLAP_URL, {
      headers: { Authorization: 'Bearer getSecret("/secrets/openai")', Upgrade: "websocket" },
    }),
    { kind: "scope", scopePath: path },
  );
}

function harness(options: { delayPolicySnapshot?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const work: Promise<unknown>[] = [];
  const prepared: Array<{ activation: string; streamPath: string }> = [];
  const fetches: Deferred<Response>[] = [];
  let tearingDown = false;
  const snapshots: Deferred<{
    offset: number;
    state: ReturnType<typeof ProjectProcessorContract.stateSchema.parse>;
  }>[] = [];
  const reduced = ProjectProcessorContract.stateSchema.parse({});
  const ctx = {
    id: {
      name: DurableObjectNameCodec.stringify({
        projectId: VOICE_HANDSHAKE_OVERLAP_PROJECT_ID,
        path: "/",
      }),
    },
    storage: {
      sql: {
        databaseSize: 0,
        exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
          const rows = db
            .prepare(sql)
            .all(
              ...bindings.map((binding) =>
                binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
              ),
            )
            .map((row) => ({ ...row }));
          return { toArray: () => rows as T[] };
        },
      },
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
    waitUntil: (promise: Promise<unknown>) => work.push(promise),
  } as unknown as DurableObjectState;
  const env = {
    DEPLOYMENT_ENV: "preview_17",
    STREAM: {
      getByName: () => ({
        processorFacade: () => ({
          snapshot: async () => {
            if (tearingDown || !options.delayPolicySnapshot) return { offset: 0, state: reduced };
            const next = deferred<{ offset: number; state: typeof reduced }>();
            snapshots.push(next);
            return next.promise;
          },
        }),
      }),
    },
    SECRET: {
      getByName: () => ({
        fetch: () => {
          if (tearingDown) {
            return Promise.resolve({
              status: 500,
              webSocket: null,
              headers: new Headers(),
              body: null,
            } as Response);
          }
          const next = deferred<Response>();
          fetches.push(next);
          return next.promise;
        },
      }),
    },
  } as unknown as Env;
  return {
    db,
    fetches,
    snapshots,
    object: new ProjectDurableObject(ctx, env),
    prepare(index: number) {
      const input = { streamPath: streamPath(index), activation: activation(index) };
      prepared.push(input);
      return this.object.prepareVoiceHandshakeOverlap(input);
    },
    cancel(index: number) {
      return this.object.cancelVoiceHandshakeOverlap({
        streamPath: streamPath(index),
        activation: activation(index),
      });
    },
    async waitForFetches(count: number) {
      await vi.waitFor(() => expect(fetches).toHaveLength(count));
    },
    async waitForSnapshots(count: number) {
      await vi.waitFor(() => expect(snapshots).toHaveLength(count));
    },
    async awaitWork(index: number) {
      await work[index];
    },
    async cleanup() {
      tearingDown = true;
      for (const input of prepared) this.object.cancelVoiceHandshakeOverlap(input);
      for (const snapshot of snapshots) {
        if (!snapshot.settled) snapshot.resolve({ offset: 0, state: reduced });
      }
      for (const fetch of fetches) {
        if (!fetch.settled) {
          fetch.resolve({
            status: 500,
            webSocket: null,
            headers: new Headers(),
            body: null,
          } as Response);
        }
      }
      await Promise.allSettled(work);
      vi.clearAllTimers();
      db.close();
    },
  };
}

test("cancelled pending upgrades remain charged until late sockets are closed, then capacity is reusable", async () => {
  const h = harness();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 8; index += 1) {
      expect(h.prepare(index)).toEqual({ accepted: true });
    }
    await h.waitForFetches(8);

    for (let index = 0; index < 8; index += 1) {
      expect(h.cancel(index)).toEqual({ cancelled: true });
    }
    await expect(h.object.fetch(requestFor(streamPath(0)))).resolves.toMatchObject({ status: 409 });
    expect(() => h.prepare(8)).toThrow(/eight-upgrade capacity/);

    const late = fakeUpgrade();
    h.fetches[0]!.resolve(late.response);
    await h.awaitWork(0);
    expect(late.socket.accept).toHaveBeenCalledTimes(1);
    expect(late.socket.close).toHaveBeenCalledWith(1000, "no longer claimable");

    expect(h.prepare(8)).toEqual({ accepted: true });
    await h.waitForFetches(9);
    const ready = fakeUpgrade();
    h.fetches[8]!.resolve(ready.response);
    await h.awaitWork(8);
    await expect(h.object.fetch(requestFor(streamPath(8)))).resolves.toBe(ready.response);
    await expect(h.object.fetch(requestFor(streamPath(8)))).resolves.toMatchObject({ status: 409 });
  } finally {
    await h.cleanup();
  }
});

test("expiry keeps an unresolved upgrade charged until its late response is closed", async () => {
  vi.useFakeTimers();
  const h = harness();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 8; index += 1) {
      h.prepare(index);
    }
    await h.waitForFetches(8);
    await vi.advanceTimersByTimeAsync(VOICE_HANDSHAKE_OVERLAP_TTL_MS);

    expect(() => h.prepare(8)).toThrow(/eight-upgrade capacity/);
    const late = fakeUpgrade();
    h.fetches[0]!.resolve(late.response);
    await h.awaitWork(0);
    expect(late.socket.close).toHaveBeenCalledWith(1000, "no longer claimable");
    expect(h.prepare(8)).toEqual({ accepted: true });
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});

test("cancellation during policy catch-up starts no provider fetch and retains capacity until the read settles", async () => {
  const h = harness({ delayPolicySnapshot: true });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 8; index += 1) {
      h.prepare(index);
    }
    await h.waitForSnapshots(8);
    for (let index = 0; index < 8; index += 1) {
      h.cancel(index);
    }
    expect(h.fetches).toHaveLength(0);
    expect(() => h.prepare(8)).toThrow(/eight-upgrade capacity/);

    h.snapshots[0]!.resolve({ offset: 0, state: ProjectProcessorContract.stateSchema.parse({}) });
    await h.awaitWork(0);
    expect(h.fetches).toHaveLength(0);
    expect(h.prepare(8)).toEqual({ accepted: true });
  } finally {
    await h.cleanup();
  }
});
