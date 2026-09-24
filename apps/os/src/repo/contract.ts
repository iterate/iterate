// src/repo/contract.ts — A REPO: a domain object on the context at any path (`/repos/<name>` by
// convention). Its git lives in Cloudflare Artifacts; its facts live on that path's log, and THIS
// FILE is the only place they are spelled: the entity lifecycle every entity shares
// (src/project/entity-lifecycle.ts — creation and deletion, whose sagas provision and tear down the
// Artifacts repo), and the commits that landed through it. durable-object.ts speaks git behind the
// `created` guard, src/project/collection.ts is `itx.repos` (`list`, `create`, `delete`), library.ts
// hands out the handle (`itx.repos.get(path)`: the host's verbs plus the typed `append`,
// `EventInput<typeof RepoContract>`).
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { entityLifecycle } from "../project/entity-lifecycle.ts";

/** `repo/commit-completed`'s payload: the commit that landed on main and the paths it changed. */
export const CommitCompleted = z.object({
  path: z.string().min(1),
  commitOid: z.string().min(1),
  message: z.string(),
  changedPaths: z.array(z.string()),
});
export type CommitCompleted = z.infer<typeof CommitCompleted>;

const lifecycle = entityLifecycle("repo");

export const RepoContract = defineProcessorContract({
  ...lifecycle,
  version: "2",
  description: "A repo: its creation and deletion, and the commits that landed through it.",
  events: {
    ...lifecycle.events,
    "events.iterate.com/repo/commit-completed": {
      description:
        "A commit landed on the repo's main through the repo facet: on the repo's path, and cross-posted to / — hence it names the path — where the project processor follows the config repo's commits with the apex (a commit to /repos/config IS its publication).",
      payloadSchema: CommitCompleted,
    },
  },
});
