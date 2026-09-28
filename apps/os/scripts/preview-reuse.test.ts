import { expect, test } from "vitest";
import { PREVIEW_DEPLOYMENT_APPS } from "../../../envs.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";
import { planReuse, reuseCandidates, type ReuseCandidate } from "./preview-reuse.ts";
import {
  groupPreviewDeployments,
  previewMemberSuffixes,
  type PreviewMember,
} from "./preview-sweep.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const APPS = [...PREVIEW_DEPLOYMENT_APPS];

test("a run's candidates are the PR's and main's full deployments; never a partial one, a half-made one, another PR's or its own", () => {
  const deployments = group([
    ...full("pr7-1111111"),
    ...full("pr7-2222222"),
    // a later push's partial deployment: only the apps it changed
    worker("pr7-3333333-notes"),
    // a later push's deploy that failed before its apps uploaded
    worker("pr7-4444444-os"),
    ...full("main-aaaaaaa"),
    ...full("main-bbbbbbb"),
    ...full("pr8-5555555"),
    // this run's own, from an earlier attempt
    ...full("pr7-6666666"),
  ]);
  expect(reuseCandidates(deployments, "pr7-6666666", "pr7", APPS).map(({ name }) => name)).toEqual([
    "pr7-1111111",
    "pr7-2222222",
    "main-aaaaaaa",
    "main-bbbbbbb",
  ]);
});

test.for<{ name: string; candidates: ReuseCandidate[]; reuses?: string; deploys: string[] }>(
  // prettier-ignore
  [
    { name: "a tests-only push: the previous push's deployment serves everything", candidates: [placed("pr7-2222222", 1, []), placed("main-aaaaaaa", 4, [])], reuses: "pr7-2222222", deploys: [] },
    { name: "a notes-only PR's first push: main's deployment where it branched serves all but notes", candidates: [placed("main-aaaaaaa", 1, ["notes"])], reuses: "main-aaaaaaa", deploys: ["notes"] },
    { name: "the nearest changed apps/os since: never a farther one", candidates: [placed("pr7-2222222", 1, ["os"]), placed("main-aaaaaaa", 3, [])], deploys: ["os", ...APPS] },
    { name: "a package every app depends on", candidates: [placed("pr7-2222222", 1, ["dash", "agents", "voice", "kit"])], reuses: "pr7-2222222", deploys: ["dash", "agents", "voice", "kit"] },
    { name: "main's newest, not an ancestor of the head, and main's deployment where it branched", candidates: [{ name: "main-bbbbbbb", commitsBack: undefined, unplaced: "not an ancestor of this commit" }, placed("main-aaaaaaa", 2, [])], reuses: "main-aaaaaaa", deploys: [] },
    { name: "no candidate", candidates: [], deploys: ["os", ...APPS] },
  ],
)("$name ⇒ reuses $reuses, deploys $deploys", ({ candidates, reuses, deploys }) => {
  const { plan, reasons } = planReuse({ deployment: "pr7-6666666", apps: APPS, candidates });
  expect(plan).toEqual({ deployment: "pr7-6666666", reuses, deploys });
  expect(reasons.at(-1)).toMatch(reuses ? `${reuses}, ` : "deploys everything");
});

function placed(
  name: string,
  commitsBack: number,
  changed: (ReuseCandidate & { commitsBack: number })["changed"],
): ReuseCandidate {
  return { name, commitsBack, changed };
}

function worker(name: string): PreviewMember {
  return { kind: "worker", name, id: name, createdAt: new Date(NOW).toISOString() };
}

function full(name: string) {
  return ["os", ...APPS].map((member) => worker(`${name}-${member}`));
}

function group(members: PreviewMember[]) {
  const kvBindings = readWranglerBase().kv_namespaces.map(
    ({ binding }: { binding: string }) => binding,
  );
  return groupPreviewDeployments(members, previewMemberSuffixes(kvBindings));
}
