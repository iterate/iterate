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
import { KEEPALIVE_ALARM_LEAD_MS, type ConsumedInput } from "iterate/processors";
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
// Scripted script-execution worker: every run() call parks until the test
// settles it, so the test controls exactly when (and whether) a script body
// "finishes". The worker returns a ScriptExecutionSettlement value, like the
// production loopback entrypoint.
// -----------------------------------------------------------------------------

function makeScriptedWorker() {
  const calls: {
    code: string;
    options: {
      emittedJs?: string;
      expiresAt: number;
      preambleJs?: string;
      streamContext: Extract<StreamContext, { kind: "script-execution" }>;
    };
    resolve: (settlement: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    calls,
    succeed(result: unknown) {
      calls.at(-1)!.resolve({ status: "succeeded", result });
    },
    run(
      code: string,
      options: {
        emittedJs?: string;
        expiresAt: number;
        preambleJs?: string;
        streamContext: Extract<StreamContext, { kind: "script-execution" }>;
      },
    ) {
      return new Promise<unknown>((resolve, reject) => {
        calls.push({ code, options, resolve, reject });
      });
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
        scriptExecutionEntrypoint: { run: (code, options) => worker.run(code, options) },
        ...(args.typecheckScript && { typecheckScript: args.typecheckScript }),
      }),
    path: "/capability-host-test",
    ...(args.substrate && { substrate: args.substrate }),
  });
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

describe("CapabilityHostProcessor copied events", () => {
  it("a COPIED capability-host fact is data, never this scope's own lifecycle", async () => {
    // The clients-to-root subscription copies client scopes' provider Pager
    // facts onto "/": the root host must not reduce them (phantom pager
    // entries keyed by copy offsets would accumulate forever, and a source
    // offset colliding with a real root pager's would clear the real one).
    const copiedFrom = [
      {
        name: "clients-to-root",
        streamId: "11111111-1111-4111-8111-111111111111",
        streamCreatedAt: "2026-08-07T09:00:00.000Z",
        cursorChangedAtSourceOffset: 1,
        createdAt: "2026-08-07T10:00:00.000Z",
        offset: 3,
        path: "/clients/chrome",
        projectId: "proj_harness",
        type: "events.iterate.com/capability-host/capability-provider-pager-connected",
      },
    ];
    const h = makeHostHarness();
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/capability-provider-pager-connected",
          payload: {},
          source: { copiedFrom },
        } as HostEventInput,
      ],
    );
    expect(h.state().capabilityProviderPagers).toEqual([]);

    // A first-hand fact still reduces exactly as before.
    await h.play([
      "append",
      {
        type: "events.iterate.com/capability-host/capability-provider-pager-connected",
        payload: {},
      },
    ]);
    expect(h.state().capabilityProviderPagers).toHaveLength(1);
  });
});

describe("CapabilityHostProcessor recovery", () => {
  it("crash mid-execution: the revival turn settles the orphan as a FAILURE and never re-runs the body", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness();
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        ["append", scriptRunRequested("exec-orphan", h.clock.now + 60_000)],
      );
      expect(h.worker.calls).toHaveLength(1); // the doomed attempt, parked

      await h.play(["crash"], ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1]);

      // The successor's at-head pass found `started` with no live run: the
      // body may have half-executed, so it settles failed/orphaned — the
      // worker is NOT dialed again.
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

  it("a zombie worker finishing after the successor settled loses the settle race and is superseded", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness();
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        ["append", scriptRunRequested("exec-late", h.clock.now + 60_000)],
      );
      await h.play(["crash"], ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1]);
      expect(h.events(SETTLED)).toMatchObject([
        { payload: { settlement: { failureKind: "orphaned", status: "failed" } } },
      ]);

      // The old incarnation's worker call survives the crash as a zombie
      // closure and finishes anyway: its settle append carries the same
      // `script-run-settled@exec-late` key with a DIFFERENT body, the stream
      // rejects it, and the zombie reads back the durable orphan outcome and
      // stands down — an observed loser, not error telemetry.
      await h.play(() => h.worker.calls[0]!.resolve({ status: "succeeded", result: "too late" }));

      expect(h.events(SETTLED)).toHaveLength(1);
      expect(h.events(SETTLED)[0]!.payload).toMatchObject({
        settlement: { status: "failed", failureKind: "orphaned" },
      });
      expect(consoleInfo).toHaveBeenCalledWith(
        "[capability-host] late script settlement superseded by durable outcome",
        expect.objectContaining({
          attemptedStatus: "succeeded",
          durableFailureKind: "orphaned",
          executionId: "exec-late",
        }),
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleInfo.mockRestore();
      consoleError.mockRestore();
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

  it("a failed settle append is retried with the SAME known settlement — never reclassified as an orphan", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = makeHostHarness();
      await h.play(
        ["append", ...NEW_HOST_EVENTS],
        ["append", scriptRunRequested("exec-retry", h.clock.now + 60_000)],
      );
      expect(h.worker.calls).toHaveLength(1);

      // The worker finishes but the settle append hits a transient stream
      // outage: the exact outcome is remembered in-memory, the obligation
      // stays open.
      await h.play(
        () => {
          h.stream.failAppendsOfType = SETTLED;
        },
        () => h.worker.succeed("ok"),
      );
      expect(h.events(SETTLED)).toHaveLength(0);
      expect(h.state().scriptExecutions["exec-retry"]).toMatchObject({ status: "started" });

      // The stream recovers; the next delivery reaching head retries the
      // remembered settlement verbatim — NOT an invented orphan
      // classification.
      await h.play(() => {
        h.stream.failAppendsOfType = undefined;
      }, ["advanceTime", KEEPALIVE_ALARM_LEAD_MS + 1]);
      expect(h.events(SETTLED)).toMatchObject([
        {
          payload: { executionId: "exec-retry", settlement: { status: "succeeded", result: "ok" } },
        },
      ]);
      expect(consoleInfo).not.toHaveBeenCalledWith(
        "[capability-host] recovering undriven script execution",
        expect.anything(),
      );
    } finally {
      consoleInfo.mockRestore();
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

  it("one Pager can own many mounts and disconnect retires only mounts still on that Pager", async () => {
    const h = makeHostHarness();
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/capability-provider-pager-connected",
          payload: {},
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/capability-provided",
          payload: {
            type: "live",
            path: ["first"],
            providerPager: { connectedAtOffset: 2 },
          },
        },
        {
          type: "events.iterate.com/capability-host/capability-provided",
          payload: {
            type: "live",
            path: ["shared"],
            providerPager: { connectedAtOffset: 2 },
          },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/capability-provider-pager-connected",
          payload: {},
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/capability-provided",
          payload: {
            type: "live",
            path: ["shared"],
            providerPager: { connectedAtOffset: 5 },
          },
        },
        {
          type: "events.iterate.com/capability-host/capability-provided",
          payload: {
            type: "live",
            path: ["second"],
            providerPager: { connectedAtOffset: 5 },
          },
        },
      ],
    );

    expect(h.state().capabilityProviderPagers).toEqual([
      { connectedAtOffset: 2 },
      { connectedAtOffset: 5 },
    ]);
    expect(h.state().capabilities).toMatchObject([
      { path: ["first"], providerPager: { connectedAtOffset: 2 } },
      { path: ["shared"], providerPager: { connectedAtOffset: 5 } },
      { path: ["second"], providerPager: { connectedAtOffset: 5 } },
    ]);

    await h.play([
      "append",
      {
        type: "events.iterate.com/capability-host/capability-provider-pager-disconnected",
        payload: { connectedAtOffset: 2 },
      },
    ]);

    expect(h.state().capabilityProviderPagers).toEqual([{ connectedAtOffset: 5 }]);
    expect(h.state().capabilities).toMatchObject([
      { path: ["shared"], providerPager: { connectedAtOffset: 5 } },
      { path: ["second"], providerPager: { connectedAtOffset: 5 } },
    ]);
  });
});

// =============================================================================
// The preamble: settled results reduce into retained rows, and the NEXT run
// receives the assembled preamble — ts to the typecheck gate, js to the worker.
// =============================================================================

describe("CapabilityHostProcessor preamble", () => {
  it("derives the results array from settled runs and injects it into the next script", async () => {
    const h = makeHostHarness();
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      ["append", scriptRunRequested("exec-1", h.clock.now + 60_000, "async () => 1")],
    );
    await h.play(() => h.worker.succeed({ users: ["amy"] }));

    expect(h.state().settledScriptResults).toMatchObject([
      { kind: "data", executionId: "exec-1", resultJson: '{"users":["amy"]}' },
    ]);

    await h.play([
      "append",
      scriptRunRequested("exec-2", h.clock.now + 60_000, "async () => results[0].data"),
    ]);
    expect(h.worker.calls).toHaveLength(2);
    const preambleJs = h.worker.calls[1]!.options.preambleJs!;
    expect(preambleJs).toContain("const __resultRows = [");
    expect(preambleJs).toContain('executionId: "exec-1", data: {"users":["amy"]} }');
    // js variant, not ts: the worker only ever needs the no-emit fallback text
    expect(preambleJs).not.toContain("as const");

    // The FIRST run had nothing to inject — the empty scope pays nothing.
    expect(h.worker.calls[0]!.options.preambleJs).toBeUndefined();
  });

  it("hands the ts preamble to the typecheck gate alongside the script", async () => {
    const seen: (string | undefined)[] = [];
    const h = makeHostHarness({
      typecheckScript: async (input) => {
        seen.push(input.preamble);
        return { verdict: "clean" };
      },
    });
    await h.play(
      ["append", ...NEW_HOST_EVENTS],
      [
        "append",
        {
          type: "events.iterate.com/capability-host/preamble-set",
          payload: { key: "channels", code: 'const TECH_CHANNEL_ID = "c1234";' },
        },
      ],
      ["append", scriptRunRequested("exec-1", h.clock.now + 60_000, "async () => TECH_CHANNEL_ID")],
    );
    await h.play(() => h.worker.succeed(null));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('const TECH_CHANNEL_ID = "c1234";');
    expect(h.state().preamble).toMatchObject([{ key: "channels" }]);
  });

  it("caps retained results and drops the oldest beyond the limit", async () => {
    const h = makeHostHarness();
    await h.play(["append", ...NEW_HOST_EVENTS]);
    for (let i = 0; i < 25; i++) {
      await h.play([
        "append",
        scriptRunRequested(`exec-${i}`, h.clock.now + 60_000, "async () => 1"),
      ]);
      await h.play(() => h.worker.succeed(i));
    }
    const retained = h.state().settledScriptResults;
    expect(retained).toHaveLength(20);
    expect(retained[0]).toMatchObject({ executionId: "exec-5" });
    expect(retained.at(-1)).toMatchObject({ executionId: "exec-24" });
  });
});
