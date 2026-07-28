// The Guestbook's physical identity. Keeping the durable key stable preserves
// its processor storage while the implementation moves out of config repos.
import type { StreamEventInput } from "../../processors/index.ts";
import type { StatefulDynamicWorkerRef } from "../../sdk.ts";

export const guestbookStreamPath = "/guestbook";

export const guestbookWorkerRef = {
  className: "GuestbookApp",
  // "-stream" keeps clear of a retired predecessor's durable identity.
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

/**
 * The Guestbook's creation facts. The project worker owns committed event
 * delivery through GuestbookApp.processEvent; no stream ever carries an
 * app-specific subscription for the Guestbook (streams that predate the
 * current subscription model are recreated, not migrated), so there is no
 * retirement fact to append — removing a key that was never configured is a
 * hard error.
 */
export function guestbookCreationEvents(): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/guestbook/created",
      payload: { config: { title: "Guestbook" } },
      idempotencyKey: "guestbook/created",
    },
  ];
}
