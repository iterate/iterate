import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { fakeSlack } from "./fake-slack.ts";
import {
  inRestoreWindow,
  postDeployFindings,
  postDeployPageText,
  PRD_PROJECT_HOST_URLS,
  readPostDeployPage,
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

// every row is the deploy after an erase (`/version` named `parked` before it) unless it says not
test.for<{ case: string; statuses: number[]; restoreWindow: boolean; notAfterAnErase?: true }>([
  {
    case: "421s until `project-seed apply` are the restore window",
    statuses: [421, 421],
    restoreWindow: true,
  },
  {
    case: "a host restored already leaves the others in it",
    statuses: [200, 421],
    restoreWindow: true,
  },
  { case: "a host answering 500 pages", statuses: [421, 500], restoreWindow: false },
  { case: "a host that does not answer pages", statuses: [421, 0], restoreWindow: false },
  { case: "every host answering is a plain pass", statuses: [200, 200], restoreWindow: false },
  {
    case: "421s after an ordinary deploy page",
    statuses: [421, 421],
    restoreWindow: false,
    notAfterAnErase: true,
  },
])("$case → restore window: $restoreWindow", ({ statuses, restoreWindow, notAfterAnErase }) => {
  const hosts = statuses.map((status, index) => ({ url: PRD_PROJECT_HOST_URLS[index]!, status }));
  const previousVersion = notAfterAnErase ? "old" : "parked";
  expect(inRestoreWindow({ previousVersion, liveVersion: "new", hosts })).toBe(restoreWindow);
});

test("after an erase, a /version that never answered 200 is no restore window: it pages", () => {
  const hosts = [{ url: "https://iterate.com/", status: 421 }];
  expect(inRestoreWindow({ previousVersion: "parked", liveVersion: undefined, hosts })).toBe(false);
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
        rollbackTo: "9e2b7c10-5a4d-4c3b-8f1e-7d6c5b4a3f21",
        runUrl: "https://depot.dev/run",
      },
      false,
    ),
  ).toBe(
    [
      "🚨 prd post-deploy check failed after the os-prd deploy at bbbbbbb <@U067G4QRFK2> <@U099JH9TAF2>",
      "Impact: https://os.iterate.com/version still names `0f3a9c21`, the version live before the deploy; the project host https://iterate.com/ answered 421; the project host https://lispwoso.com/ did not answer; failing since aaaaaaa, 2 deploys",
      "Do: read the check's output in the run, then fix forward, or roll back to the version live before the deploy at aaaaaaa: `wrangler rollback 9e2b7c10-5a4d-4c3b-8f1e-7d6c5b4a3f21 --name os-prd`",
      "<https://depot.dev/run|run>",
    ].join("\n"),
  );
});

test.for<{ rollbackTo: string; action: string }>([
  {
    rollbackTo: "9e2b7c10-5a4d-4c3b-8f1e-7d6c5b4a3f21",
    action:
      "fix forward, or roll back to the version live before the deploy at aaaaaaa: `wrangler rollback 9e2b7c10-5a4d-4c3b-8f1e-7d6c5b4a3f21 --name os-prd`",
  },
  {
    rollbackTo: "parked",
    action:
      "fix forward. Do NOT roll back: the version live before the deploy at aaaaaaa is erase-data's parked worker, and a rollback onto it deletes every Durable Object",
  },
  {
    rollbackTo: "",
    action:
      "fix forward: https://os.iterate.com/version did not answer before the deploy at aaaaaaa, so no rollback target is known",
  },
])("the page names its exact rollback target, `$rollbackTo`, and gives it back", (input) => {
  const text = postDeployPageText(
    { findings, sha: "aaaaaaa1111", since: "aaaaaaa1111", deploys: 1, runUrl: null, ...input },
    false,
  );
  expect(text.split("\n")[2]).toBe(`Do: read the check's output in the run, then ${input.action}`);
  expect(readPostDeployPage(text)).toEqual({
    since: "aaaaaaa",
    deploys: 1,
    rollbackTo: input.rollbackTo,
  });
});

test("a failing check pages, the next failing check edits that page, and a pass resolves it", async () => {
  const slack = fakeSlack({ now });

  const first = reading("aaaaaaa1111", true);
  expect(await reportPostDeploy(slack.client, first)).toBe("post");
  // the version live before the next deploy failed the check too: the page keeps the one before
  const next = { ...reading("bbbbbbb2222", true), previousVersion: first.liveVersion };
  expect(await reportPostDeploy(slack.client, next)).toBe("edit");
  const [page] = slack.channel("#error-pulse");
  expect(slack.channel("#error-pulse")).toHaveLength(1);
  expect(page?.text).toContain("failing since aaaaaaa, 2 deploys");
  expect(page?.text).toContain(`wrangler rollback ${first.previousVersion} --name os-prd`);
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

test("after an erase, hosts answering 421 post to #ci, page no one and warn off the rollback", async () => {
  const slack = fakeSlack({ now });
  const hosts = [
    { url: "https://iterate.com/", status: 421 },
    { url: "https://garple.com/", status: 200 },
  ];
  const restoring = {
    ...reading("aaaaaaa1111", true),
    findings: postDeployFindings({ previousVersion: "parked", liveVersion: "new", hosts }),
    previousVersion: "parked",
    restoreWindow: true,
  };

  expect(await reportPostDeploy(slack.client, restoring)).toBe("restore-window");
  expect(slack.channel("#error-pulse")).toEqual([]);
  expect(slack.channel("#ci").map((message) => message.text)).toEqual([
    [
      "The os-prd deploy at aaaaaaa is the first since an erase: its project hosts answer 421 until `project-seed apply` recreates their projects (the project host https://iterate.com/ answered 421)",
      "Do NOT roll back: the version live before this deploy is erase-data's parked worker, and a rollback onto it deletes every Durable Object",
      "<https://depot.dev/run/aaaaaaa1111|run>",
    ].join("\n"),
  ]);
});

/** What erase-data's parked worker (scripts/lib/do-reset.ts) answers every request, `/version` too. */
const parkedAnswer: string = await (
  await import(String(new URL("../lib/parked-worker/worker.js", import.meta.url)))
).default
  .fetch()
  .text();

test.for<{ case: string; body: string; exit: number; version: string }>([
  {
    case: "prd names its version",
    body: "0f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70 https://os.iterate.com",
    exit: 0,
    version: "0f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
  },
  // curl's --fail exits 22 on an HTTP error
  {
    case: "prd serves erase-data's parked worker",
    body: parkedAnswer,
    exit: 22,
    version: "parked",
  },
  { case: "prd answers another error", body: "error code: 1101", exit: 22, version: "" },
  { case: "prd does not answer", body: "", exit: 28, version: "" },
])("the version read before a deploy: $case → `$version`", ({ body, exit, version }) => {
  using directory = temporaryDirectory();
  // a curl on PATH that answers $BODY with exit code $EXIT, printing an HTTP error's body only
  // under --fail-with-body, as curl does
  writeFileSync(
    join(directory.path, "curl"),
    [
      "#!/bin/sh",
      `case "$*" in *--fail-with-body*) printf '%s' "$BODY" ;; *) [ "$EXIT" -ne 0 ] || printf '%s' "$BODY" ;; esac`,
      "exit $EXIT",
    ].join("\n"),
    { mode: 0o755 },
  );
  const output = join(directory.path, "output");
  writeFileSync(output, "");
  const step = deploySteps().find((entry) => entry.id === "previous");
  // a runner runs a step's `run` as `bash -eo pipefail`
  execFileSync("bash", ["-eo", "pipefail", "-c", step!.run!], {
    env: {
      ...process.env,
      PATH: `${directory.path}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      BODY: body,
      EXIT: String(exit),
    },
  });
  expect(/^version=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? "").toBe(version);
});

test("every prd deploy checks the project hosts at once, in the deploy job, before its own post", () => {
  const steps = deploySteps();
  const deploy = steps.findIndex((step) => step.id === "deploy");
  const previous = steps.findIndex((step) => step.id === "previous");
  expect(steps[deploy]?.run).toBe("pnpm os:deploy --env prd");
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

/** Deploy OS's deploy job's steps, as .depot/workflows/deploy-os.yml lists them. */
function deploySteps() {
  const workflow = parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/deploy-os.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: { id?: string; run?: string; if?: string }[] }> };
  return workflow.jobs.deploy?.steps || [];
}

/** One check's reading at `sha`: failing with the findings above, or passing. */
function reading(sha: string, failing: boolean) {
  return {
    findings: failing ? findings : [],
    restoreWindow: false,
    previousVersion: "9e2b7c10-5a4d-4c3b-8f1e-7d6c5b4a3f21",
    liveVersion: "1f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
    sha,
    runUrl: `https://depot.dev/run/${sha}`,
    now: new Date(now),
  };
}
