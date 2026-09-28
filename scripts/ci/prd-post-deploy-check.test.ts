import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { fakeSlack } from "./fake-slack.ts";
import {
  postDeployFindings,
  postDeployPageText,
  PRD_PROJECT_HOST_URLS,
  reportPostDeploy,
} from "./prd-post-deploy-check.ts";

test("production's project hosts come from envs.ts", () => {
  expect(PRD_PROJECT_HOST_URLS).toEqual([
    "https://iterate.com/",
    "https://garple.com/",
    "https://lispwoso.com/",
    "https://templestein.com/",
  ]);
});

test.for<{ case: string; hostStatus: number; pages: boolean }>([
  { case: "a host that answers", hostStatus: 200, pages: false },
  { case: "a host that redirects still answers", hostStatus: 302, pages: false },
  { case: "a host's own 404 is the site's answer", hostStatus: 404, pages: false },
  // 2026-09-23 after #2888: every project host answered 421 while /version was fine
  { case: "a host that answers 421", hostStatus: 421, pages: true },
  { case: "a host that answers 500", hostStatus: 500, pages: true },
  { case: "a host that does not answer", hostStatus: 0, pages: true },
])("$case → pages: $pages", ({ hostStatus, pages }) => {
  const findings = postDeployFindings({
    previousVersion: "old",
    liveVersion: "new",
    hosts: [
      { url: "https://iterate.com/", status: hostStatus },
      { url: "https://garple.com/", status: 200 },
    ],
  });
  expect(findings.length > 0).toBe(pages);
});

test.for<{ case: string; previousVersion?: string; liveVersion?: string; pages: boolean }>([
  {
    case: "/version names a new version",
    previousVersion: "old",
    liveVersion: "new",
    pages: false,
  },
  {
    case: "nothing was read before the deploy",
    previousVersion: "",
    liveVersion: "new",
    pages: false,
  },
  {
    case: "/version still names the previous version",
    previousVersion: "old",
    liveVersion: "old",
    pages: true,
  },
  {
    case: "/version never answered 200",
    previousVersion: "old",
    liveVersion: undefined,
    pages: true,
  },
])("$case → pages: $pages", ({ previousVersion, liveVersion, pages }) => {
  const findings = postDeployFindings({
    previousVersion,
    liveVersion,
    hosts: [{ url: "https://iterate.com/", status: 200 }],
  });
  expect(findings.length > 0).toBe(pages);
});

const now = Date.parse("2026-09-28T12:00:00Z");
const findings = postDeployFindings({
  previousVersion: "0f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
  liveVersion: "0f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
  hosts: [
    { url: "https://iterate.com/", status: 421 },
    { url: "https://garple.com/", status: 200 },
    { url: "https://lispwoso.com/", status: 0 },
  ],
});

test("the page names a /version that did not move and each host that is down, and links the run", () => {
  expect(
    postDeployPageText(
      {
        findings,
        sha: "bbbbbbb2222",
        since: "aaaaaaa1111",
        deploys: 2,
        runUrl: "https://depot.dev/run",
      },
      false,
    ),
  ).toBe(
    [
      "🚨 prd post-deploy check failed after the os-prd deploy at bbbbbbb <@U067G4QRFK2> <@U099JH9TAF2>",
      "Impact: https://os.iterate.com/version still names `0f3a9c21`, the version live before the deploy; the project host https://iterate.com/ answered 421; the project host https://lispwoso.com/ did not answer; failing since aaaaaaa, 2 deploys",
      "Do: read the check's output in the run, then roll back os-prd or fix forward",
      "<https://depot.dev/run|run>",
    ].join("\n"),
  );
});

test("a failing check pages, the next failing check edits that page, and a pass resolves it", async () => {
  const slack = fakeSlack({ now });

  expect(await reportPostDeploy(slack.client, reading("aaaaaaa1111", true))).toBe("post");
  expect(await reportPostDeploy(slack.client, reading("bbbbbbb2222", true))).toBe("edit");
  const [page] = slack.channel("#error-pulse");
  expect(slack.channel("#error-pulse")).toHaveLength(1);
  expect(page?.text).toContain("failing since aaaaaaa, 2 deploys");
  expect(page?.text).toContain("<https://depot.dev/run/bbbbbbb2222|run>");

  expect(await reportPostDeploy(slack.client, reading("ccccccc3333", false))).toBe("resolve");
  expect(page?.text.split("\n")[0]).toBe(
    "✅ resolved: prd post-deploy check failed after the os-prd deploy at bbbbbbb <@U067G4QRFK2> <@U099JH9TAF2>",
  );
  expect(page?.replies.map((reply) => reply.text)).toEqual([
    "✅ resolved: every project host answers on `1f3a9c21` <@U067G4QRFK2> <@U099JH9TAF2>",
  ]);
  // the next failure is a new incident: a new page, counting from one
  expect(await reportPostDeploy(slack.client, reading("ddddddd4444", true))).toBe("post");
  expect(slack.channel("#error-pulse").at(-1)?.text).toContain("failing since ddddddd, 1 deploy");
});

test("a passing check with no page open posts nothing", async () => {
  const slack = fakeSlack({ now });

  expect(await reportPostDeploy(slack.client, reading("aaaaaaa1111", false))).toBe("none");
  expect(slack.channel("#error-pulse")).toEqual([]);
});

test("every prd deploy checks the project hosts at once, in the deploy job, before its own post", () => {
  const workflow = parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/deploy-os.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: { id?: string; run?: string; if?: string }[] }> };
  const steps = workflow.jobs.deploy?.steps || [];
  const deploy = steps.findIndex((step) => step.id === "deploy");
  const previous = steps.findIndex((step) => step.id === "previous");
  expect(steps[deploy]?.run).toBe("pnpm run-script deploy --env prd");
  // the version live before the deploy is read first, so the check waits for the new one
  expect(previous).toBeGreaterThanOrEqual(0);
  expect(previous).toBeLessThan(deploy);
  expect(steps[deploy + 1]).toMatchObject({
    id: "check",
    run: 'node scripts/ci/prd-post-deploy-check.ts check --previous-version "${{ steps.previous.outputs.version }}"',
  });
  // then the deploy's own post: a failed deploy is paged only when the check did not page it
  expect(steps.slice(deploy + 2).map((step) => step.run)).toEqual([
    "node scripts/ci/notify.ts deploy-success",
    "node scripts/ci/notify.ts deploy-failure",
  ]);
  expect(steps.at(-1)?.if).toContain("steps.check.outputs.paged != 'true'");
});

/** One check's reading at `sha`: failing with the findings above, or passing. */
function reading(sha: string, failing: boolean) {
  return {
    findings: failing ? findings : [],
    liveVersion: "1f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
    sha,
    runUrl: `https://depot.dev/run/${sha}`,
    now: new Date(now),
  };
}
