import { expect, test } from "vitest";
import { connectAgentFeed } from "./agent-connection.ts";

// The share/unshare lifecycle is the trust-critical path: "closing the CLI (or
// /unshare) narrows access back" must hold even when the user toggles faster
// than a provideCapability round-trip completes. These drive that with a fake
// connection whose project-scope provide can be held mid-flight.

test("/unshare while the /share provide is still in flight does not leak a project mount", async () => {
  using fake = fakeConnection();
  const conn = connectAgentFeed({ ...feedInput(), connect: fake.connect });
  await flush();

  fake.holdNextProjectProvide();
  const sharing = conn.shareWithProject(); // awaits the held provide
  await flush();
  await conn.unshareFromProject(); // user changed their mind before the mount landed

  fake.releaseProjectProvide(); // the provide finally resolves
  await sharing;
  await flush();

  const mount = fake.projectProvisions.at(-1)!;
  expect(mount.revoked).toBe(true); // reconciled away, not silently left live
  conn.dispose();
});

test("share provides a project-scope mount; unshare revokes exactly it", async () => {
  using fake = fakeConnection();
  const conn = connectAgentFeed({ ...feedInput(), connect: fake.connect });
  await flush();

  await conn.shareWithProject();
  await flush();
  const mount = fake.projectProvisions.at(-1)!;
  expect(fake.projectProvisions).toHaveLength(1);
  expect(mount.revoked).toBe(false); // retained while shared

  await conn.unshareFromProject();
  expect(mount.revoked).toBe(true);
  conn.dispose();
});

// ---------------------------------------------------------------------------

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function feedInput() {
  return {
    auth: { type: "bearer" as const, token: "t" },
    baseUrl: "https://os.example",
    projectId: "prj_test",
    agentPath: "/agents/onboarding",
    replayAfterOffset: () => 0,
    onEvents: () => {},
    onStatus: () => {},
  };
}

type FakeProvision = { revoked: boolean; revoke(): Promise<void>; [Symbol.dispose](): void };

function fakeConnection() {
  const projectProvisions: FakeProvision[] = [];
  const sessionProvisions: FakeProvision[] = [];
  let releaseHeldProvide: (() => void) | undefined;

  const newProvision = (into: FakeProvision[]): FakeProvision => {
    const provision: FakeProvision = {
      revoked: false,
      async revoke() {
        this.revoked = true;
      },
      [Symbol.dispose]() {},
    };
    into.push(provision);
    return provision;
  };

  const agent = {
    stream: { subscribe: async () => ({ [Symbol.dispose]() {} }) },
    sendMessage: async () => ({}),
    provideCapability: async () => newProvision(sessionProvisions),
    [Symbol.dispose]() {},
  };

  const project = {
    agents: { get: () => agent },
    async provideCapability() {
      if (releaseHeldProvide === undefined) return newProvision(projectProvisions);
      await new Promise<void>((r) => (releaseHeldProvide = r));
      return newProvision(projectProvisions);
    },
    [Symbol.dispose]() {},
  };

  return {
    connect: (() => project) as any,
    projectProvisions,
    sessionProvisions,
    /** Make the next project-scope provide block until releaseProjectProvide(). */
    holdNextProjectProvide() {
      releaseHeldProvide = () => {};
    },
    releaseProjectProvide() {
      releaseHeldProvide?.();
    },
    [Symbol.dispose]() {},
  };
}
