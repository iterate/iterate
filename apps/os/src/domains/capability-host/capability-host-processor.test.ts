// The capability-host processor's executable spec, on the generic step
// harness from iterate/processors/testing: the REAL StreamProcessorRunner
// over the shared MemoryStream (production idempotency semantics: a same-key
// append with a different body is REJECTED), virtual time, and
// eviction-faithful crash(). Scenarios are ordered steps — typed appends,
// crash, and function steps driving the scripted script-execution worker (the
// only capability-host-specific fake, defined here).
//
// The harness's real keepalive and recovery adapters also drive the recovery
// scenarios below; capability-host-recovery.test.ts keeps the focused
// zero-lag end-to-end proof.

import { describe, expect, it, vi } from "vitest";
import {
  KEEPALIVE_ALARM_LEAD_MS,
  type ConsumedInput,
  type StreamEvent,
  type StreamEventInput,
} from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { Project } from "../../itx-api.generated.ts";
import type { StreamContext } from "../projects/stream-context.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorDeps,
} from "./capability-host-processor-implementation.ts";

type HostEventInput = ConsumedInput<CapabilityHostProcessorContract>;

const REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const STARTED = "events.iterate.com/capability-host/script-run-started";
const SETTLED = "events.iterate.com/capability-host/script-run-settled";

// -----------------------------------------------------------------------------
// Event literals: the birth bundle and the recurring request shape. These are
// event BUILDERS (data), not append wrappers — every test appends through the
// harness's typed append.
// -----------------------------------------------------------------------------

const NEW_HOST_EVENTS = [
  {
    type: "events.iterate.com/capability-host/created",
    payload: { config: {}, fallback: null },
  },
] satisfies HostEventInput[];

function scriptRunRequested(
  executionId: string,
  expiresAt: number,
  code = "async () => 1",
): HostEventInput {
  return { type: REQUESTED, payload: { code, executionId, expiresAt } };
}

// -----------------------------------------------------------------------------
// Scripted script-execution entrypoint: start() records the short handoff and
// returns immediately. `succeed()` models the independently-lived executor by
// committing its keyed terminal fact directly to the exact stream lifetime.
// -----------------------------------------------------------------------------

function makeScriptedWorker() {
  let stream:
    | {
        appendIfStreamId(args: {
          streamId: string;
          events: StreamEventInput[];
        }): Promise<StreamEvent[]>;
      }
    | undefined;
  const calls: {
    code: string;
    options: {
      emittedJs?: string;
      executionExpiresAt: number;
      settlementExpiresAt: number;
      streamContext: Extract<StreamContext, { kind: "script-execution" }>;
      streamId: string;
    };
  }[] = [];
  return {
    calls,
    attach(target: typeof stream) {
      stream = target;
    },
    async succeed(result: unknown, callIndex = calls.length - 1) {
      const call = calls[callIndex]!;
      await stream!.appendIfStreamId({
        streamId: call.options.streamId,
        events: [
          {
            type: SETTLED,
            idempotencyKey: `capability-host/script-run-settled@${call.options.streamContext.executionId}`,
            payload: {
              executionId: call.options.streamContext.executionId,
              settlement: { status: "succeeded", result },
            },
          },
        ],
      });
    },
    async start(
      code: string,
      options: {
        emittedJs?: string;
        executionExpiresAt: number;
        settlementExpiresAt: number;
        streamContext: Extract<StreamContext, { kind: "script-execution" }>;
        streamId: string;
      },
    ) {
      calls.push({ code, options });
    },
  };
}

/** The generic harness plus the scripted worker, wired in createProcessor. */
function makeHostHarness(
  args: {
    substrate?: HarnessSubstrate;
    typecheckScript?: CapabilityHostProcessorDeps["typecheckScript"];
  } = {},
) {
  const worker = makeScriptedWorker();
  const harness = makeProcessorHarness<CapabilityHostProcessorContract, CapabilityHostProcessor>({
    createProcessor: (deps) =>
      new CapabilityHostProcessor({
        ...deps,
        itx: {} as Project,
        reads: deps.reads,
        scriptExecutionExecutor: { start: (code, options) => worker.start(code, options) },
        ...(args.typecheckScript === undefined ? {} : { typecheckScript: args.typecheckScript }),
      }),
    path: "/capability-host-test",
    ...(args.substrate === undefined ? {} : { substrate: args.substrate }),
  });
  worker.attach(harness.stream);
  return { ...harness, worker };
}

// =============================================================================
// The script-run obligation lifecycle
// =============================================================================

describe("CapabilityHostProcessor script runs", () => {
  it("runs a requested script: started evidence before the body, ONE settled fact after, obligation cleared", async () => {
    const h = makeHostHarness();
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      ["append", scriptRunRequested("exec-1", h.clock.now + 60_000, "async () => 1")],
    );

    // The attempt began: the started fact is durable BEFORE the worker was
    // dialed (that ordering is the whole "provably never ran" evidence rule),
    // and the obligation reduced to `started`.
    expect(h.events(STARTED)).toMatchObject([
      {
        idempotencyKey: "capability-host/script-run-started@exec-1",
        payload: { executionId: "exec-1" },
      },
    ]);
    expect(h.worker.calls).toHaveLength(1);
    expect(h.worker.calls[0]!.code).toBe("async () => 1");
    expect(h.worker.calls[0]!.options).toMatchObject({
      streamContext: {
        kind: "script-execution",
        streamPath: "/capability-host-test",
        scriptRunRequestedEventOffset: 2,
        executionId: "exec-1",
      },
    });
    expect(h.state().scriptExecutions["exec-1"]).toMatchObject({ status: "started" });

    await h.play(() => h.worker.succeed({ ok: true }));

    expect(h.events(SETTLED)).toMatchObject([
      {
        idempotencyKey: "capability-host/script-run-settled@exec-1",
        payload: {
          executionId: "exec-1",
          settlement: { status: "succeeded", result: { ok: true } },
        },
      },
    ]);
    // The settled fact deleted the obligation; a later at-head pass finds
    // nothing to do.
    expect(h.state().scriptExecutions).toEqual({});
  });

  it("script obligations wait for the birth certificate; birth at head starts them", async () => {
    const h = makeHostHarness();
    await h.play(["append", scriptRunRequested("exec-early", h.clock.now + 60_000)]);

    // The obligation reduced, but nothing runs on an unborn host.
    expect(h.state().scriptExecutions["exec-early"]).toMatchObject({ status: "requested" });
    expect(h.worker.calls).toHaveLength(0);
    expect(h.events(STARTED)).toHaveLength(0);

    // The created event's own at-head delivery is the turn that starts it.
    await h.play(["append", ...NEW_HOST_EVENTS]);
    expect(h.worker.calls).toHaveLength(1);
    await h.play(() => h.worker.succeed("late birth"));
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { executionId: "exec-early", settlement: { status: "succeeded" } } },
    ]);
  });

  it("a script with a PROVABLE type error settles without ever running (no started event)", async () => {
    const h = makeHostHarness({
      typecheckScript: async () => ({
        verdict: "problems",
        problems: ["Property 'unreadCout' does not exist. Did you mean 'unreadCount'?"],
      }),
    });
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      ["append", scriptRunRequested("exec-typo", h.clock.now + 60_000)],
    );

    expect(h.worker.calls).toHaveLength(0);
    expect(h.events(STARTED)).toHaveLength(0);
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          executionId: "exec-typo",
          settlement: {
            status: "failed",
            failureKind: "typecheck",
            phase: "typecheck",
            executionMayHaveOccurred: false,
            error: expect.stringContaining("Did you mean 'unreadCount'?"),
          },
        },
      },
    ]);
    expect(h.state().scriptExecutions).toEqual({});
  });

  it("a checker failure means UNCHECKED, never blocked: the script still runs", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness({
        typecheckScript: () => {
          throw new Error("typechecker sidecar unreachable");
        },
      });
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        ["append", scriptRunRequested("exec-unchecked", h.clock.now + 60_000)],
      );
      expect(h.worker.calls).toHaveLength(1);
      expect(consoleWarn).toHaveBeenCalledWith(
        "[capability-host] script typecheck skipped",
        expect.anything(),
      );
      await h.play(() => h.worker.succeed("ran unchecked"));
      expect(h.events(SETTLED)).toMatchObject([
        { payload: { settlement: { status: "succeeded", result: "ran unchecked" } } },
      ]);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("an expired request settles expired WITHOUT dialing the worker", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness();
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        // The request's horizon already passed when it reaches head (the host
        // slept past it — e.g. recovery delivering the request arbitrarily
        // late).
        ["append", scriptRunRequested("exec-expired", h.clock.now - 1)],
      );

      expect(h.worker.calls).toHaveLength(0);
      expect(h.events(STARTED)).toHaveLength(0);
      expect(h.events(SETTLED)).toMatchObject([
        {
          payload: {
            executionId: "exec-expired",
            settlement: {
              status: "failed",
              failureKind: "expired",
              executionMayHaveOccurred: false,
              error: expect.stringContaining("expired"),
            },
          },
        },
      ]);
      expect(h.state().scriptExecutions).toEqual({});
    } finally {
      consoleInfo.mockRestore();
    }
  });
});

// =============================================================================
// Recovery — crash, revival, and the settle idempotency race
// =============================================================================

describe("CapabilityHostProcessor recovery", () => {
  it("crash mid-execution: the successor resumes the settlement watch and accepts the executor result", async () => {
    const h = makeHostHarness();
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      ["append", scriptRunRequested("exec-survives-host", h.clock.now + 60_000)],
    );
    expect(h.worker.calls).toHaveLength(1);

    await h.play(["crash"], ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1]);

    // Losing the host-side waiter does NOT imply the independently-lived
    // executor died. The successor waits under the original deadline and
    // never invokes arbitrary script code a second time.
    expect(h.worker.calls).toHaveLength(1);
    expect(h.events(SETTLED)).toHaveLength(0);
    expect(h.state().scriptExecutions["exec-survives-host"]).toMatchObject({
      status: "started",
    });

    await h.play(() => h.worker.succeed("completed after host reset"));
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          executionId: "exec-survives-host",
          settlement: { status: "succeeded", result: "completed after host reset" },
        },
      },
    ]);
    expect(h.state().scriptExecutions).toEqual({});
  });

  it("a started execution with no durable result settles orphaned only after its original deadline", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness();
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        ["append", scriptRunRequested("exec-orphan", h.clock.now + 20_000)],
      );
      await h.play(
        ["crash"],
        ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1],
        // The first successor correctly resumed the watch while unexpired.
        // Evict it too; the next revival occurs after the absolute deadline
        // and is the first turn allowed to classify the obligation orphaned.
        ["crash"],
        ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1],
      );

      expect(h.worker.calls).toHaveLength(1);
      expect(h.events(SETTLED)).toMatchObject([
        {
          payload: {
            executionId: "exec-orphan",
            settlement: {
              status: "failed",
              failureKind: "orphaned",
              executionMayHaveOccurred: true,
              cancellation: "external-work-may-continue",
            },
          },
        },
      ]);
      expect(h.state().scriptExecutions).toEqual({});
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("a request whose started evidence never landed provably never ran: the successor runs it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness();
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        () => {
          h.stream.failAppendsOfType = STARTED;
        },
        ["append", scriptRunRequested("exec-2", h.clock.now + 60_000)],
      );
      // The started append failed, so the body never ran and no settlement
      // may exist — the obligation stays `requested`.
      expect(h.worker.calls).toHaveLength(0);
      expect(h.events(SETTLED)).toHaveLength(0);
      expect(h.state().scriptExecutions["exec-2"]).toMatchObject({ status: "requested" });

      await h.play(
        ["crash"],
        () => {
          h.stream.failAppendsOfType = undefined;
        },
        ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1],
      );

      // requested-without-started = safe to start late: the successor's
      // at-head pass runs the whole attempt from reduced state alone.
      expect(h.events(STARTED)).toHaveLength(1);
      expect(h.worker.calls).toHaveLength(1);
      await h.play(() => h.worker.succeed("ok"));
      expect(h.events(SETTLED)).toMatchObject([
        { payload: { executionId: "exec-2", settlement: { status: "succeeded", result: "ok" } } },
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a full replay (fresh progress over the same stream) re-reduces everything without re-running scripts or growing the stream", async () => {
    const h = makeHostHarness();
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/capability-provided",
          payload: {
            type: "itx-call",
            path: ["pets"],
            expression: ["openapi", ["connect", { specUrl: "https://pets.example/openapi.json" }]],
          },
        },
      ],
      ["append", scriptRunRequested("exec-replay", h.clock.now + 60_000)],
    );
    await h.play(() => h.worker.succeed({ done: true }));
    expect(h.events(SETTLED)).toHaveLength(1);
    const committedOffsets = h.events().map((row) => row.offset);

    // The harshest at-least-once redelivery: a fresh progress store over the
    // SAME stream replays every event from offset zero. Mid-replay the
    // delivery is not caught up, so no obligation work runs; at head the
    // settled fact has already deleted the obligation. The stream must come
    // out byte-for-byte unchanged and the reduced state identical.
    const replay = makeHostHarness({
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(CapabilityHostProcessorContract),
      },
    });
    await replay.settle();

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.worker.calls).toHaveLength(0);
    expect(replay.state().scriptExecutions).toEqual({});
    expect(replay.state().capabilities).toEqual(h.state().capabilities);
    expect(replay.state().birthCertificate).toEqual(h.state().birthCertificate);
  });
});

// =============================================================================
// The capability table reduction
// =============================================================================

describe("CapabilityHostProcessor capability table", () => {
  it("mounts carry providedAtOffset identity: re-provide replaces the row, revoke honors the exact offset", async () => {
    const h = makeHostHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/capability-host/created",
        payload: { config: {}, fallback: ["capabilityHosts", ["get", "/"]] },
      },
      {
        type: "events.iterate.com/capability-host/capability-provided",
        payload: {
          type: "itx-call",
          path: ["pets"],
          expression: ["openapi", ["connect", { specUrl: "https://pets.example/openapi.json" }]],
          instructions: "v1",
        },
      },
    ]);
    expect(h.state().birthCertificate).toMatchObject({
      fallback: ["capabilityHosts", ["get", "/"]],
    });
    const firstProvided = h.events("events.iterate.com/capability-host/capability-provided")[0]!;
    expect(h.state().capabilities).toMatchObject([
      { path: ["pets"], providedAtOffset: firstProvided.offset, instructions: "v1" },
    ]);

    // A re-provide at the same path REPLACES the row (still one row), with the
    // new event's offset as the new identity.
    await h.play([
      "append",
      {
        type: "events.iterate.com/capability-host/capability-provided",
        payload: {
          type: "itx-call",
          path: ["pets"],
          expression: ["openapi", ["connect", { specUrl: "https://pets.example/openapi.json" }]],
          instructions: "v2",
        },
      },
    ]);
    const secondProvided = h.events("events.iterate.com/capability-host/capability-provided")[1]!;
    expect(h.state().capabilities).toMatchObject([
      { path: ["pets"], providedAtOffset: secondProvided.offset, instructions: "v2" },
    ]);

    // A revoke naming the STALE offset is a no-op — it must not tear down the
    // newer mount that replaced the one the revoker held.
    await h.play([
      "append",
      {
        type: "events.iterate.com/capability-host/capability-revoked",
        payload: { path: ["pets"], providedAtOffset: firstProvided.offset },
      },
    ]);
    expect(h.state().capabilities).toHaveLength(1);

    // An offset-less revoke removes whatever currently sits at the path.
    await h.play([
      "append",
      {
        type: "events.iterate.com/capability-host/capability-revoked",
        payload: { path: ["pets"] },
      },
    ]);
    expect(h.state().capabilities).toEqual([]);

    // A started fact for an unknown (already settled or never requested)
    // execution reduces to nothing.
    await h.play(["append", { type: STARTED, payload: { executionId: "ghost" } }]);
    expect(h.state().scriptExecutions).toEqual({});
  });
});
