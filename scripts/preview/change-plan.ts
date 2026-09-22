import { matchesGlob } from "node:path";
import { CommitHistory } from "./commit-history.ts";
import CHANGE_TYPES, { type ChangeType } from "./change-types.ts";

/** Head paths decide new work; docs inherit a result only across unchanged behavior. */
export async function planPreview(
  history: CommitHistory,
  evidence: PreviewEvidence,
): Promise<PreviewDecision> {
  let changes: Partial<Record<ChangeType, string[]>> = {};

  for await (const commit of history.throughMergeBase()) {
    if (commit.sha === history.head) changes = classifyChanges(commit.files);
    const result =
      commit.sha === history.head ? null : await evidence.findPreviewResult(commit.sha);
    if (result) {
      // hooray, we landed on a commit with a result we can just inherit, no need to deploy or test.
      const reason = `Inherit ${result.conclusion} from ${commit.sha}.`;
      return { action: "inherit", changes, result, reason };
    }

    const actionsNeeded = getActionsNeeded(
      commit.sha === history.head ? changes : classifyChanges(commit.files),
    );

    if (actionsNeeded.deploy) {
      return { action: "deploy", changes, reason: `${commit.sha} changed product behavior.` };
    }

    if (actionsNeeded.test) {
      // Tests must run. Search from head: a newer commit may have a usable
      // deployment, even though we have already passed it while looking for results.
      for await (const candidate of history.throughMergeBase()) {
        const deployment = await evidence.findPreviewDeployment(candidate.sha);
        // We found a usable deployment before hitting a change that requires a newer one.
        if (deployment)
          return {
            action: "reuse",
            changes,
            deployment,
            reason: `Run head tests against the preview at ${candidate.sha}.`,
          };
        if (getActionsNeeded(classifyChanges(candidate.files)).deploy) {
          return {
            action: "deploy",
            changes,
            reason: `${candidate.sha} needs deployment but has no usable preview.`,
          };
        }
      }

      // The tests still need to run; never resume inheriting older results.
      return {
        action: "deploy",
        changes,
        reason: history.stopReason || "No usable deployment through the merge-base.",
      };
    }
  }
  return {
    action: "deploy",
    changes,
    reason: history.stopReason || "No usable result up to merge-base.",
  };
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

function getActionsNeeded(changes: Partial<Record<ChangeType, string[]>>) {
  const types = Object.keys(changes);
  return {
    test: types.some((type) => type !== "Docs"),
    deploy: types.some((type) => type !== "Docs" && type !== "Tests"),
  };
}

// Object.keys widens to string[]; this closed, local definition has exactly ChangeType keys.
const changeTypes = Object.keys(CHANGE_TYPES) as ChangeType[];
