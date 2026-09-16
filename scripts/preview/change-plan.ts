import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CommitHistory } from "./commit-history.ts";

/** Head paths decide new work; docs inherit a result only across unchanged behavior. */
export async function planPreview(
  history: CommitHistory,
  evidence: PreviewEvidence,
): Promise<PreviewDecision> {
  const changes = classifyChanges(history.changedFiles(history.head));
  const actions = actionsForChanges(changes);
  if (actions.deploy)
    return { action: "deploy", changes, reason: "The head needs deployment and tests." };
  if (actions.test) return planTests(history, evidence, changes);

  for (const commit of history.throughMergeBase()) {
    const result = await evidence.findPreviewResult(commit);
    if (result)
      return {
        action: "inherit",
        changes,
        result,
        reason: `Inherit ${result.conclusion} from ${commit}.`,
      };

    const untested = actionsForChanges(classifyChanges(history.changedFiles(commit)));
    if (untested.deploy)
      return {
        action: "deploy",
        changes,
        reason: `${commit} changed product behavior without a conclusive result.`,
      };
    if (untested.test) return planTests(history, evidence, changes);
  }
  return { action: "deploy", changes, reason: "No conclusive result through the merge-base." };
}

/** A live deployment is usable before its commit's changed paths become a barrier. */
async function planTests(
  history: CommitHistory,
  evidence: PreviewEvidence,
  changes: Record<string, string[]>,
): Promise<PreviewDecision> {
  for (const commit of history.throughMergeBase()) {
    const deployment = await evidence.findPreviewDeployment(commit);
    if (deployment)
      return {
        action: "reuse",
        changes,
        deployment,
        reason: `Run head tests against the preview at ${commit}.`,
      };
    if (actionsForChanges(classifyChanges(history.changedFiles(commit))).deploy) {
      return {
        action: "deploy",
        changes,
        reason: `${commit} needs deployment but has no usable preview.`,
      };
    }
  }
  return { action: "deploy", changes, reason: "No usable deployment through the merge-base." };
}

type PreviewDecision = { changes: Record<string, string[]>; reason: string } & (
  | { action: "deploy" }
  | { action: "reuse"; deployment: PreviewDeployment }
  | { action: "inherit"; result: PreviewResult }
);
export type PreviewDeployment = { commit: string; slot: string };
export type PreviewResult = { commit: string; conclusion: "success" | "failure"; url: string };
type PreviewEvidence = {
  findPreviewDeployment(commit: string): Promise<PreviewDeployment | null>;
  findPreviewResult(commit: string): Promise<PreviewResult | null>;
};

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
