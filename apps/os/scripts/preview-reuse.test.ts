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

test("a run tries the PR's newest full deployment, then main's; never a partial one, a half-made one or its own", () => {
  const deployments = group([
    ...full("pr7-1111111", 3),
    ...full("pr7-2222222", 2),
    // a later push's partial deployment: only the apps it changed
    worker("pr7-3333333-notes", 1),
    // a later push's deploy that failed before its apps uploaded
    worker("pr7-4444444-os", 0.5),
    ...full("main-aaaaaaa", 5),
    ...full("main-bbbbbbb", 4),
    ...full("pr8-5555555", 0.1),
    // this run's own, from an earlier attempt
    ...full("pr7-6666666", 0.2),
  ]);
  expect(reuseCandidates(deployments, "pr7-6666666", APPS).map(({ name }) => name)).toEqual([
    "pr7-2222222",
    "main-bbbbbbb",
  ]);
  expect(reuseCandidates(deployments, "pr9-7777777", APPS).map(({ name }) => name)).toEqual([
    "main-bbbbbbb",
  ]);
});

test.for<{ name: string; candidates: ReuseCandidate[]; reuses?: string; deploys: string[] }>(
  // prettier-ignore
  [
    { name: "a tests-only push: the PR's own deployment serves everything", candidates: [candidate("pr7-2222222", []), candidate("main-bbbbbbb", [])], reuses: "pr7-2222222", deploys: [] },
    { name: "a notes-only PR, first push: main's os and apps but notes", candidates: [candidate("main-bbbbbbb", ["notes"])], reuses: "main-bbbbbbb", deploys: ["notes"] },
    { name: "main moved apps/os since the PR's last push: main's newest is up to date", candidates: [candidate("pr7-2222222", ["os", "notes"]), candidate("main-bbbbbbb", ["notes"])], reuses: "main-bbbbbbb", deploys: ["notes"] },
    { name: "a package every app depends on", candidates: [candidate("pr7-2222222", ["dash", "agents", "voice", "kit"])], reuses: "pr7-2222222", deploys: ["dash", "agents", "voice", "kit"] },
    { name: "an os PR", candidates: [candidate("pr7-2222222", ["os"]), candidate("main-bbbbbbb", ["os"])], deploys: ["os", ...APPS] },
    { name: "a candidate whose commit could not be fetched", candidates: [{ name: "pr7-2222222", changed: undefined, unknown: "fetch failed" }, candidate("main-bbbbbbb", [])], reuses: "main-bbbbbbb", deploys: [] },
    { name: "no candidate", candidates: [], deploys: ["os", ...APPS] },
  ],
)("$name ⇒ reuses $reuses, deploys $deploys", ({ candidates, reuses, deploys }) => {
  const { plan, reasons } = planReuse({ deployment: "pr7-6666666", apps: APPS, candidates });
  expect(plan).toEqual({ deployment: "pr7-6666666", reuses, deploys });
  expect(reasons).toHaveLength(
    reuses ? candidates.findIndex((c) => c.name === reuses) + 1 : candidates.length + 1,
  );
});

function candidate(name: string, changed: ReuseCandidate["changed"] & object): ReuseCandidate {
  return { name, changed };
}

function worker(name: string, createdHoursAgo: number): PreviewMember {
  return {
    kind: "worker",
    name,
    id: name,
    createdAt: new Date(NOW - createdHoursAgo * 3_600_000).toISOString(),
  };
}

function full(name: string, createdHoursAgo: number) {
  return ["os", ...APPS].map((member) => worker(`${name}-${member}`, createdHoursAgo));
}

function group(members: PreviewMember[]) {
  const kvBindings = readWranglerBase().kv_namespaces.map(
    ({ binding }: { binding: string }) => binding,
  );
  return groupPreviewDeployments(members, previewMemberSuffixes(kvBindings));
}
