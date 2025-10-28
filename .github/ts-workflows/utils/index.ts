import type { Workflow } from "@jlarky/gha-ts/workflow-types";

export * from "./github-script.ts";

export const prTriggerable = {
  on: {} satisfies Workflow["on"],
};
