// src/project/durable-object.ts — the project processor's HOST: the `project` facet on the context at
// `/` (`itx.repos.list()` and `itx.workspaces.list()` read its `snapshot()`, library.ts). Nothing
// beyond the processor: the catalog is the reduce. Hosted from `ctx.exports`
// (first-party-facets.ts): ordinary bundled worker code pulling `ProjectProcessor` from ./processor.ts.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import { ProjectProcessor } from "./processor.ts";

export class ProjectDurableObject extends StreamProcessorDurableObject {
  processor = new ProjectProcessor();
}
