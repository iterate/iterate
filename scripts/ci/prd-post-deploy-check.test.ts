import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { PRD_PROJECT_HOST_URLS, renderPostDeployPage } from "./prd-post-deploy-check.ts";

test("production's project hosts come from envs.ts", () => {
  expect(PRD_PROJECT_HOST_URLS).toEqual([
    "https://iterate.com/",
    "https://garple.com/",
    "https://lispwoso.com/",
    "https://templestein.com/",
  ]);
});

test.each<{ case: string; hostStatus: number; pages: boolean }>([
  { case: "a host that answers", hostStatus: 200, pages: false },
  { case: "a host that redirects still answers", hostStatus: 302, pages: false },
  { case: "a host's own 404 is the site's answer", hostStatus: 404, pages: false },
  // 2026-09-23 after #2888: every project host answered 421 while /version was fine
  { case: "a host that answers 421", hostStatus: 421, pages: true },
  { case: "a host that answers 500", hostStatus: 500, pages: true },
  { case: "a host that does not answer", hostStatus: 0, pages: true },
])("$case → pages: $pages", ({ hostStatus, pages }) => {
  const page = renderPostDeployPage({
    previousVersion: "old",
    liveVersion: "new",
    hosts: [
      { url: "https://iterate.com/", status: hostStatus },
      { url: "https://garple.com/", status: 200 },
    ],
  });
  expect(Boolean(page)).toBe(pages);
});

test.each<{ case: string; previousVersion?: string; liveVersion?: string; pages: boolean }>([
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
  const page = renderPostDeployPage({
    previousVersion,
    liveVersion,
    hosts: [{ url: "https://iterate.com/", status: 200 }],
  });
  expect(Boolean(page)).toBe(pages);
});

test("the page names a /version that did not move and each host that is down, and links the run", () => {
  expect(
    renderPostDeployPage({
      previousVersion: "0f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
      liveVersion: "0f3a9c21-7d4e-4b8a-9c1e-2a6b5d8e4f70",
      hosts: [
        { url: "https://iterate.com/", status: 421 },
        { url: "https://garple.com/", status: 200 },
        { url: "https://lispwoso.com/", status: 0 },
      ],
      runUrl: "https://depot.dev/run",
    }),
  ).toMatchInlineSnapshot(`
    "🚨 prd post-deploy check failed after the os-prd deploy <@U067G4QRFK2>
    • https://os.iterate.com/version still names \`0f3a9c21\`, the version live before the deploy
    • the project host https://iterate.com/ answered 421
    • the project host https://lispwoso.com/ did not answer
    <https://depot.dev/run|the deploy run>"
  `);
});

test("every prd deploy checks the project hosts at once, in the deploy job, before notifying", () => {
  const workflow = parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/deploy-os.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: { id?: string; run?: string; if?: string }[] }> };
  expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
  const steps = workflow.jobs.deploy?.steps || [];
  const deploy = steps.findIndex((step) => step.id === "deploy");
  const previous = steps.findIndex((step) => step.id === "previous");
  expect(steps[deploy]?.run).toBe("doppler run -- pnpm run-script deploy --env prd");
  // the version live before the deploy is read first, so the check waits for the new one
  expect(previous).toBeGreaterThanOrEqual(0);
  expect(previous).toBeLessThan(deploy);
  expect(steps[deploy + 1]?.run).toBe(
    'pnpm tsx scripts/ci/prd-post-deploy-check.ts check --previous-version "${{ steps.previous.outputs.version }}"',
  );
  // a failed, timed-out or cancelled deploy (or a failed check) still reports the deploy's own
  // result to #ci
  expect(steps.at(-1)).toMatchObject({
    if: "${{ always() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    run: "pnpm tsx scripts/ci/notify.ts deploy-${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}",
  });
});
