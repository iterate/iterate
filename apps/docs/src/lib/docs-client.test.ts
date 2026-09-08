import { describe, expect, test, vi } from "vitest";
import { createDocsClient, isSessionTransportError } from "./docs-client.ts";
import type { RefreshOutcome } from "./project-session.ts";

describe("isSessionTransportError", () => {
  test.each([
    { message: "RPC session was shut down by disposing the main stub", becomes: true },
    { message: "Network connection lost.", becomes: true },
    { message: "connection closed", becomes: true },
    { message: "WebSocket is closed before the connection is established.", becomes: true },
    { message: "os /api did not upgrade: 401", becomes: true },
    // OS refusing the vessel's re-dial with the token this browser session
    // was born with — a fresh browser handshake carries the renewed cookie.
    { message: "missing or invalid auth", becomes: true },
    { message: 'document "/repos/config/x.md" does not exist', becomes: false },
    { message: "commit is the workspace owner's act", becomes: false },
  ])("$message → $becomes", ({ message, becomes }) => {
    expect(isSessionTransportError(new Error(message))).toBe(becomes);
  });
});

/** A fake dial: each session is a number, operations decide by session. */
function fakeClient(overrides: Partial<Parameters<typeof createDocsClient>[0]> = {}) {
  let generation = 0;
  const disposed: number[] = [];
  const dial = vi.fn(() => {
    const id = ++generation;
    return {
      project: id,
      session: {
        [Symbol.dispose]: () => {
          disposed.push(id);
        },
      },
    };
  });
  const refresh =
    overrides.refresh ?? vi.fn(async () => ({ outcome: "renewed" as const, expiresAt: 0 }));
  const signInAgain = overrides.signInAgain ?? vi.fn();
  const client = createDocsClient({ ...overrides, dial, refresh, signInAgain });
  return { client, dial, disposed, refresh, signInAgain };
}

const transportFailure = () => new Error("RPC session was shut down by disposing the main stub");

/** Let every pending microtask (a few awaits deep) run. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("createDocsClient", () => {
  test("an application error leaves the shared session alone", async () => {
    const { client, dial, refresh } = fakeClient();
    await expect(
      client.withDocsProject(async () => {
        throw new Error('document "x.md" does not exist');
      }),
    ).rejects.toThrow("does not exist");
    expect(dial).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("a transport error re-dials once and retries the operation", async () => {
    const { client, dial, disposed } = fakeClient();
    const result = await client.withDocsProject(async (project) => {
      if (project === 1) throw transportFailure();
      return `ok on ${project}`;
    });
    expect(result).toBe("ok on 2");
    expect(dial).toHaveBeenCalledTimes(2);
    expect(disposed).toEqual([1]);
  });

  test("concurrent callers share one re-dial", async () => {
    const { client, dial } = fakeClient();
    const operation = async (project: number) => {
      if (project === 1) throw transportFailure();
      return project;
    };
    const results = await Promise.all([
      client.withDocsProject(operation),
      client.withDocsProject(operation),
      client.withDocsProject(operation),
    ]);
    expect(results).toEqual([2, 2, 2]);
    expect(dial).toHaveBeenCalledTimes(2);
  });

  test("a caller whose session was already replaced retries without another re-dial", async () => {
    const { client, dial } = fakeClient();
    // Caller A fails on session 1 and re-dials to 2. Caller B, still holding
    // session 1's failure, must ride session 2 instead of minting session 3.
    const first = client.withDocsProject(async (project) => {
      if (project === 1) throw transportFailure();
      return project;
    });
    await first;
    const second = await client.withDocsProject(async (project) => project);
    expect(second).toBe(2);
    expect(dial).toHaveBeenCalledTimes(2);
  });

  test("a failed re-dial renews the session and tries once more", async () => {
    const { client, dial, refresh } = fakeClient();
    const result = await client.withDocsProject(async (project) => {
      if (project < 3) throw transportFailure();
      return `ok on ${project}`;
    });
    expect(result).toBe("ok on 3");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledTimes(3);
  });

  test("a dead session hands off to sign-in instead of failing quietly", async () => {
    const { client, refresh, signInAgain } = fakeClient({
      refresh: vi.fn(async () => ({
        outcome: "signed-out" as const,
        login: "/_iterate/auth/login?return_to=%2Fx",
      })),
    });
    await expect(
      client.withDocsProject(async () => {
        throw transportFailure();
      }),
    ).rejects.toThrow(/signing in again/i);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signInAgain).toHaveBeenCalledWith("/_iterate/auth/login?return_to=%2Fx");
  });

  test("a session dialed while the renewal was pending is not trusted after it", async () => {
    let resolveRefresh: ((outcome: RefreshOutcome) => void) | null = null;
    const { client, dial } = fakeClient({
      refresh: vi.fn(
        () =>
          new Promise<RefreshOutcome>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    });
    // A loses session 1, then its replacement 2: it asks for a renewal and waits.
    const a = client.withDocsProject(async (project) => {
      if (project < 4) throw transportFailure();
      return `a on ${project}`;
    });
    await settle();
    expect(dial).toHaveBeenCalledTimes(2);
    // Meanwhile B loses session 2 and dials 3 — with the OLD cookie.
    const b = client.withDocsProject(async (project) => {
      if (project < 3) throw transportFailure();
      return `b on ${project}`;
    });
    await expect(b).resolves.toBe("b on 3");
    expect(dial).toHaveBeenCalledTimes(3);
    // The renewal lands: A must not ride 3, whose handshake predates it.
    resolveRefresh!({ outcome: "renewed", expiresAt: 0 });
    await expect(a).resolves.toBe("a on 4");
    expect(dial).toHaveBeenCalledTimes(4);
  });

  test("a caller retired by another caller's renewal rides it instead of renewing again", async () => {
    const renewals: Array<(outcome: RefreshOutcome) => void> = [];
    const refresh = vi.fn(
      () =>
        new Promise<RefreshOutcome>((resolve) => {
          renewals.push(resolve);
        }),
    );
    const { client, dial, disposed } = fakeClient({ refresh });
    // A loses 1 and its replacement 2, then waits on a renewal.
    const a = client.withDocsProject(async (project) => {
      if (project < 4) throw transportFailure();
      return `a on ${project}`;
    });
    await settle();
    expect(dial).toHaveBeenCalledTimes(2);
    // B loses 2 too, dials 3 with the old cookie, and is mid-call on it.
    let failB: (() => void) | null = null;
    const b = client.withDocsProject((project) => {
      if (project === 2) return Promise.reject(transportFailure());
      if (project === 3) {
        return new Promise<string>((_, reject) => {
          failB = () => reject(transportFailure());
        });
      }
      return Promise.resolve(`b on ${project}`);
    });
    await settle();
    expect(dial).toHaveBeenCalledTimes(3);
    // A's renewal lands: A retires 3 and dials 4 with the renewed cookie…
    renewals[0]!({ outcome: "renewed", expiresAt: 0 });
    await settle();
    expect(dial).toHaveBeenCalledTimes(4);
    expect(disposed).toContain(3);
    // …which kills B's call on 3. B must ride 4, not renew again and retire it.
    failB!();
    await expect(b).resolves.toBe("b on 4");
    await expect(a).resolves.toBe("a on 4");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(disposed).not.toContain(4);
  });

  test("concurrent callers share one renewal and one post-renewal dial", async () => {
    const refresh = vi.fn(async () => ({ outcome: "renewed" as const, expiresAt: 0 }));
    const { client, dial } = fakeClient({ refresh });
    const operation = async (project: number) => {
      if (project < 3) throw transportFailure();
      return project;
    };
    const results = await Promise.all([
      client.withDocsProject(operation),
      client.withDocsProject(operation),
      client.withDocsProject(operation),
    ]);
    expect(results).toEqual([3, 3, 3]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledTimes(3);
  });

  test("withDocsProjectOnce never re-dials", async () => {
    const { client, dial } = fakeClient();
    await expect(
      client.withDocsProjectOnce(async () => {
        throw transportFailure();
      }),
    ).rejects.toThrow("shut down");
    expect(dial).toHaveBeenCalledTimes(1);
  });
});
