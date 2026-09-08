import { describe, expect, test, vi } from "vitest";
import {
  loginPathFor,
  nextRefreshDelayMs,
  refreshProjectSession,
  startProjectSessionKeepalive,
  type RefreshOutcome,
} from "./project-session.ts";

const MINUTE = 60_000;

describe("refreshProjectSession", () => {
  const returnTo = "/?workspace=%2Fworkspaces%2Fscratch%2Fx&path=a.md";
  // A synchronous retry policy: the loop runs to its verdict without real time.
  const noWait = { attempts: 4, delayMs: () => 0, sleep: async () => {} };

  test("posts same-origin to the refresh route and reads back the new expiry", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, expiresAt: 1_800_000_900 })),
    );
    await expect(
      refreshProjectSession({ fetch: fetchImpl, returnTo, retry: noWait }),
    ).resolves.toEqual({
      outcome: "renewed",
      expiresAt: 1_800_000_900,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/_iterate/auth/refresh?return_to=${encodeURIComponent(returnTo)}`);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  test("retries the project host's intermittent 500 and renews once it clears", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, expiresAt: 42 })));
    await expect(
      refreshProjectSession({ fetch: fetchImpl, returnTo, retry: noWait }),
    ).resolves.toEqual({ outcome: "renewed", expiresAt: 42 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("gives up to the keepalive after a sustained outage spends the attempts", async () => {
    const fetchImpl = vi.fn(async () => new Response("still down", { status: 503 }));
    await expect(
      refreshProjectSession({ fetch: fetchImpl, returnTo, retry: noWait }),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test("a dead session is final: it never retries", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: "/_iterate/auth/login?x" }), { status: 401 }),
    );
    await expect(
      refreshProjectSession({ fetch: fetchImpl, returnTo, retry: noWait }),
    ).resolves.toEqual({ outcome: "signed-out", login: "/_iterate/auth/login?x" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: "a 401 is a dead session, with the gate's login pointer",
      response: () =>
        new Response(JSON.stringify({ authenticated: false, login: "/_iterate/auth/login?x" }), {
          status: 401,
        }),
      becomes: { outcome: "signed-out", login: "/_iterate/auth/login?x" },
    },
    {
      name: "a 401 without a pointer still points at the login for this page",
      response: () => new Response("nope", { status: 401 }),
      becomes: { outcome: "signed-out", login: loginPathFor(returnTo) },
    },
    {
      name: "a 503 is a transient outage",
      response: () => new Response("later", { status: 503 }),
      becomes: { outcome: "unavailable" },
    },
    {
      name: "a network failure is a transient outage",
      response: () => {
        throw new TypeError("Failed to fetch");
      },
      becomes: { outcome: "unavailable" },
    },
  ])("$name", async ({ response, becomes }) => {
    await expect(
      refreshProjectSession({ fetch: vi.fn(async () => response()), returnTo, retry: noWait }),
    ).resolves.toEqual(becomes);
  });
});

describe("nextRefreshDelayMs", () => {
  test.each([
    { remainingMin: 15, becomes: 7.5 * MINUTE },
    { remainingMin: 4, becomes: 2 * MINUTE },
    { remainingMin: 1, becomes: MINUTE / 2 },
    // Never a floor that waits past expiry: a lapsed session renews at once.
    { remainingMin: 0, becomes: 1_000 },
    { remainingMin: -5, becomes: 1_000 },
    { remainingMin: 60, becomes: 10 * MINUTE },
  ])("$remainingMin min left → refresh in $becomes ms", ({ remainingMin, becomes }) => {
    const now = 1_800_000_000_000;
    expect(nextRefreshDelayMs(now / 1000 + remainingMin * 60, now)).toBe(becomes);
  });
});

describe("startProjectSessionKeepalive", () => {
  function harness(outcomes: RefreshOutcome[]) {
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextId = 1;
    let now = 1_800_000_000_000;
    let visibleListener: (() => void) | null = null;
    const refresh = vi.fn(async () => outcomes.shift() ?? { outcome: "unavailable" as const });
    const onSignedOut = vi.fn();
    const stop = startProjectSessionKeepalive({
      refresh,
      now: () => now,
      timers: {
        set: (fn, ms) => {
          const id = nextId++;
          timers.set(id, { fn, ms });
          return id;
        },
        clear: (id) => void timers.delete(id),
      },
      onSignedOut,
      visibility: {
        isVisible: () => true,
        onVisible: (fn) => {
          visibleListener = fn;
          return () => {
            visibleListener = null;
          };
        },
      },
    });
    const settle = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    const fire = async () => {
      const [id, timer] = [...timers.entries()][0] ?? [];
      if (id === undefined || timer === undefined) throw new Error("no timer armed");
      timers.delete(id);
      now += timer.ms;
      timer.fn();
      await settle();
    };
    return {
      refresh,
      onSignedOut,
      stop,
      fire,
      advance: (ms: number) => {
        now += ms;
      },
      visible: async () => {
        visibleListener?.();
        await settle();
      },
      settle,
      armed: () => [...timers.values()].map((t) => t.ms),
    };
  }

  test("refreshes on start, then at half the remaining lifetime", async () => {
    const h = harness([{ outcome: "renewed", expiresAt: 1_800_000_000 + 15 * 60 }]);
    await h.settle();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.armed()).toEqual([7.5 * MINUTE]);
  });

  test("an outage retries in a minute; a dead session hands off once and stops", async () => {
    const h = harness([
      { outcome: "unavailable" },
      { outcome: "signed-out", login: "/_iterate/auth/login?return_to=%2F" },
    ]);
    await h.settle();
    expect(h.armed()).toEqual([MINUTE]);
    await h.fire();
    expect(h.onSignedOut).toHaveBeenCalledWith("/_iterate/auth/login?return_to=%2F");
    expect(h.armed()).toEqual([]);
  });

  test("coming back to a tab refreshes at once when the last renewal is stale", async () => {
    const h = harness([
      { outcome: "renewed", expiresAt: 1_800_000_000 + 15 * 60 },
      { outcome: "renewed", expiresAt: 1_800_000_000 + 20 * 60 },
    ]);
    await h.settle();
    h.advance(2 * MINUTE);
    await h.visible();
    expect(h.refresh).toHaveBeenCalledTimes(2);
    // The pending timer was replaced by the fresh schedule, not doubled.
    expect(h.armed()).toHaveLength(1);
    h.stop();
    expect(h.armed()).toEqual([]);
  });

  test("a fresh renewal ignores a visibility flap", async () => {
    const h = harness([{ outcome: "renewed", expiresAt: 1_800_000_000 + 15 * 60 }]);
    await h.settle();
    h.advance(10_000);
    await h.visible();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
