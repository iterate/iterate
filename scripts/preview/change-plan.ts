import { matchesGlob } from "node:path";
import { CommitHistory } from "./commit-history.ts";
import CHANGE_TYPES, { type ChangeType } from "./change-types.ts";

/** Head paths decide new work; docs inherit a result only across unchanged behavior. */
export async function planPreview(
  history: CommitHistory,
  evidence: PreviewEvidence,
): Promise<PreviewDecision> {
  const changes = classifyChanges(history.changedFiles(history.head));
  const commits = history.throughMergeBase();

  for (const commit of commits) {
    const result = commit === history.head ? null : await evidence.findPreviewResult(commit);
    if (result) {
      // hooray, we landed on a commit with a result we can just inherit, no need to deploy or test.
      const reason = `Inherit ${result.conclusion} from ${commit}.`;
      return { action: "inherit", changes, result, reason };
    }

    const actionsNeeded = getActionsNeeded(classifyChanges(history.changedFiles(commit)));

    if (actionsNeeded.deploy) {
      return { action: "deploy", changes, reason: `${commit} changed product behavior.` };
    }

    if (actionsNeeded.test) {
      // Tests must run. Search from head: a newer commit may have a usable
      // deployment, even though we have already passed it while looking for results.
      for (const candidate of commits) {
        const deployment = await evidence.findPreviewDeployment(candidate);
        if (deployment)
          return {
            action: "reuse",
            changes,
            deployment,
            reason: `Run head tests against the preview at ${candidate}.`,
          };
        if (getActionsNeeded(classifyChanges(history.changedFiles(candidate))).deploy) {
          return {
            action: "deploy",
            changes,
            reason: `${candidate} needs deployment but has no usable preview.`,
          };
        }
      }

      // The tests still need to run; never resume inheriting older results.
      return { action: "deploy", changes, reason: "No usable deployment through the merge-base." };
    }
  }
  return { action: "deploy", changes, reason: "No usable result up to merge-base." };
}

type PreviewEvidence = {
  findPreviewDeployment(commit: string): Promise<PreviewDeployment | null>;
  findPreviewResult(commit: string): Promise<PreviewResult | null>;
};

type PreviewDecision = { changes: Partial<Record<ChangeType, string[]>>; reason: string } & (
  | { action: "deploy" }
  | { action: "reuse"; deployment: PreviewDeployment }
  | { action: "inherit"; result: PreviewResult }
);
export type PreviewDeployment = { commit: string; slot: string };
export type PreviewResult = { commit: string; conclusion: "success" | "failure"; url: string };
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

export function getActionsNeeded(changes: Partial<Record<ChangeType, string[]>>) {
  const types = Object.keys(changes);
  return {
    test: types.some((type) => type !== "Docs"),
    deploy: types.some((type) => type !== "Docs" && type !== "Tests"),
  };
}

// Object.keys widens to string[]; this closed, local definition has exactly ChangeType keys.
const changeTypes = Object.keys(CHANGE_TYPES) as ChangeType[];
