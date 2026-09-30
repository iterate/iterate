// src/workspace/contract.ts — A WORKSPACE: a domain object on the context at any path
// (`/workspaces/<name>` by convention). It is ONE private overlay over the project's repos; its facts
// live on that path's log, and THIS FILE is the only place they are spelled: the entity lifecycle
// every entity shares (src/project/entity-lifecycle.ts — creation and deletion, with nothing to
// provision: the overlay goes with the facet), and nothing else. Files are not state: the overlay
// lives in the host's own storage, a commit is a repo fact, and the mount table is derived from the
// project catalog. durable-object.ts keeps the overlay behind the `created` guard,
// src/project/collection.ts is `itx.workspaces` (`list`, `create`, `delete`), library.ts hands out
// the handle (`itx.workspaces.get(path)`: the host's verbs plus the typed `append`).
import { defineProcessorContract } from "iterate/stream/processor";
import { entityLifecycle } from "../project/entity-lifecycle.ts";

export const WorkspaceContract = defineProcessorContract({
  ...entityLifecycle("workspace"),
  version: "2",
  description: "A workspace: its creation and deletion.",
});
