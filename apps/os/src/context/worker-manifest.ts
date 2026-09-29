// context/worker-manifest.ts — A PUBLICATION'S MANIFEST, the platform's own record of a published
// worker (project/publication.ts writes it into the config pointer's `workers.get` spec): each
// top-level module of the source by path, with its `identity` — the hash of what the loader loads
// with it as the main module, npm dependencies included (worker-loader.ts `moduleIdentityOf`) — and
// the Durable Object classes it exports that a loader hosts by name, and the publication's
// `generation`, which only grows. Read only from the config pointer (worker-loader.ts
// `namedWorkerLoad`): a facet or a worker named by it loads under its module's identity.
import { z } from "zod";

export const WorkerManifest = z.object({
  generation: z.number().int().positive(),
  modules: z.record(
    z.string(),
    z.object({ identity: z.string().min(1), classes: z.array(z.string()) }),
  ),
});
export type WorkerManifest = z.infer<typeof WorkerManifest>;
