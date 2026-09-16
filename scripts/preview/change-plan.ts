import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CommitHistory } from "./commit-history.ts";

/** Decide work from the head commit, not the accumulated PR diff. */
export async function planPreview(
  history: CommitHistory,
  findPreviewDeployment: (commit: string) => Promise<PreviewDeployment | null>,
): Promise<PreviewDecision> {
  const changes = classifyChanges(history.changedFiles(history.head));
  const actions = actionsForChanges(changes);
  if (!actions.test) {
    return { action: "skip", changes, reason: "No preview tests are needed." };
  }
  if (actions.deploy) {
    return { action: "deploy", changes, reason: "The head commit needs deployment." };
  }

  for (const commit of history.throughMergeBase()) {
    const deployment = await findPreviewDeployment(commit);
    if (deployment) {
      return { action: "reuse", changes, deployment, reason: `Use the preview at ${commit}.` };
    }
    const ancestorChanges = classifyChanges(history.changedFiles(commit));
    if (actionsForChanges(ancestorChanges).deploy) {
      return {
        action: "deploy",
        changes,
        reason: `${commit} needs deployment but has no usable preview.`,
      };
    }
  }
  return { action: "deploy", changes, reason: "No usable preview through the merge-base." };
}

type PreviewDecision =
  | { action: "skip" | "deploy"; changes: Record<string, string[]>; reason: string }
  | {
      action: "reuse";
      changes: Record<string, string[]>;
      reason: string;
      deployment: PreviewDeployment;
    };

export type PreviewDeployment = { commit: string; slot: string };

/** A file has one type: the last matching entry in change-types.yml. */
export function classifyChanges(paths: string[]) {
  const changes: Record<string, string[]> = {};
  for (const path of paths) {
    const type =
      changeTypes.findLast(({ globs }) => globs.some((glob) => matchesGlob(path, glob)))?.type ||
      "Default";
    (changes[type] ||= []).push(path);
  }
  return changes;
}

function actionsForChanges(changes: Record<string, string[]>) {
  const types = Object.keys(changes);
  return {
    test: types.some((type) => type !== "Docs"),
    deploy: types.some((type) => type !== "Docs" && type !== "Tests"),
  };
}

const changeTypes = Object.entries(
  z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .parse(parse(readFileSync(new URL("./change-types.yml", import.meta.url), "utf8"))),
).map(([type, globs]) => ({ type, globs: Array.isArray(globs) ? globs : [globs] }));
