// src/project/durable-object.ts — the project processor's HOST: the `project` facet on the context at
// `/` (`itx.repos.list()` and `itx.workspaces.list()` read its `snapshot()`, library.ts). Nothing
// beyond the processor: the catalog is the reduce. build-sdk.mjs bundles THIS — pulling
// `ProjectProcessor` from ./processor.ts — into PROJECT_PROCESSOR_SOURCE.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import { ProjectProcessor } from "./processor.ts";

export class ProjectDurableObject extends StreamProcessorDurableObject {
  processor = new ProjectProcessor();
}
