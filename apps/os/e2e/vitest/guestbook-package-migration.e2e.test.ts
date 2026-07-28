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

  // Recreate the pre-packaging world. The seeded project worker forwards
  // every committed event to the Guestbook Durable Object with the PACKAGED
  // ref, and the stateful worker host aborts its facet (killing in-flight
  // calls) whenever the source flips — so that delivery would race the
  // createApp-phase calls below. Park the project worker for the createApp
  // phase; its restore below is the packaging migration this test is about.
  const packagedWorker = await project.repo.readFile({ path: "worker.ts" });
  await project.repo.commitFiles({
    message: "pre-packaging stand-in project worker (guestbook migration spec)",
    changes: [{ path: "worker.ts", content: PRE_PACKAGING_PROJECT_WORKER }],
  });

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

  // The packaged world arrives: the template project worker (packaged-app
  // event delivery included) replaces the stand-in.
  await project.repo.commitFiles({
    message: "adopt the packaged project worker (guestbook migration spec)",
    changes: [{ path: "worker.ts", content: packagedWorker!.content }],
  });

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

/** A project worker from before app packaging: no packaged-app event
 * delivery, so nothing invokes the Guestbook DO with the packaged source
 * while the createApp phase drives it. (`processEvent` defaults to a no-op.) */
const PRE_PACKAGING_PROJECT_WORKER = `import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  async fetch(): Promise<Response> {
    return new Response("guestbook-package-migration stand-in", { status: 200 });
  }
}
`;
