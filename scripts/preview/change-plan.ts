import { matchesGlob } from "node:path";
import { CommitHistory } from "./commit-history.ts";
import CHANGE_TYPES, { type ChangeType } from "./change-types.ts";

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
  changes: Partial<Record<ChangeType, string[]>>,
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

type PreviewDecision = { changes: Partial<Record<ChangeType, string[]>>; reason: string } & (
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

/** A file has one type: the last matching entry in change-types.ts. */
export function classifyChanges(paths: string[]) {
  const changes: Partial<Record<ChangeType, string[]>> = {};
  for (const path of paths) {
    const type =
      changeTypes.findLast((type) => CHANGE_TYPES[type].some((glob) => matchesGlob(path, glob))) ||
      "Default";
    (changes[type] ||= []).push(path);
  }
  return changes;
}

function actionsForChanges(changes: Partial<Record<ChangeType, string[]>>) {
  const types = Object.keys(changes);
  return {
    test: types.some((type) => type !== "Docs"),
    deploy: types.some((type) => type !== "Docs" && type !== "Tests"),
  };
}

// Object.keys widens to string[]; this closed, local definition has exactly ChangeType keys.
const changeTypes = Object.keys(CHANGE_TYPES) as ChangeType[];
