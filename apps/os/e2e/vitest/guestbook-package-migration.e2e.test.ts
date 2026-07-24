import { expect, test } from "vitest";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("the packaged Guestbook adopts state from its former createApp source", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects
    .get(`guestbook-package-migration-${crypto.randomUUID().slice(0, 8)}`)
    .create({});

  const name = `Before packaging ${crypto.randomUUID().slice(0, 8)}`;
  {
    using configOwnedGuestbook = project.workers.get(
      configOwnedGuestbookRef,
    ) as unknown as GuestbookWorker;
    await configOwnedGuestbook.sign(name, "This entry crosses the source boundary.");
    expect(await configOwnedGuestbook.getState()).toMatchObject({
      entries: [{ name }],
    });
  }

  // Only the source mode changes. The class, scope, durable key, processor
  // contract, and SQLite storage address remain stable.
  using packagedGuestbook = project.workers.get(packagedGuestbookRef) as unknown as GuestbookWorker;
  expect(await packagedGuestbook.getState()).toMatchObject({
    entries: [{ name }],
  });
});

type GuestbookWorker = Disposable & {
  getState(): Promise<{ entries: { name: string }[] }>;
  sign(name: string, message: string): Promise<void>;
};

const configOwnedGuestbookRef = {
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook-stream",
  path: "/",
  source: {
    createApp: {
      client: "apps/guestbook/client.tsx",
      files: { repoPath: "/repos/config", type: "repo" },
      server: "apps/guestbook/server.tsx",
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

const packagedGuestbookRef = {
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook-stream",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "node_modules/iterate/dist/starter-apps/guestbook/configured-worker.mjs",
      files: {
        include: ["package.json"],
        repoPath: "/repos/config",
        type: "repo",
      },
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;
