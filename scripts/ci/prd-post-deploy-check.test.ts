import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import type { FaultReading } from "./prd-fault-alarm.ts";
import { PRD_PROJECT_HOST_URLS, renderPostDeployPage } from "./prd-post-deploy-check.ts";

const quiet: FaultReading = { serverErrors: [], heals: [], errors: [] };

test("production's project hosts come from envs.ts", () => {
  expect(PRD_PROJECT_HOST_URLS).toEqual([
    "https://iterate.com/",
    "https://garple.com/",
    "https://lispwoso.com/",
    "https://templestein.com/",
  ]);
});

test.each<{ case: string; reading?: Partial<FaultReading>; hostStatus: number; pages: boolean }>([
  { case: "a quiet new version whose hosts answer", hostStatus: 200, pages: false },
  { case: "a host that redirects still answers", hostStatus: 302, pages: false },
  { case: "a host's own 404 is the site's answer", hostStatus: 404, pages: false },
  // 2026-09-23 after #2888: every project host answered 421 while /version was fine
  { case: "a host that answers 421", hostStatus: 421, pages: true },
  { case: "a host that answers 500", hostStatus: 500, pages: true },
  { case: "a host that does not answer", hostStatus: 0, pages: true },
  {
    case: "one error on the new version",
    reading: { errors: [["boom", 1]] },
    hostStatus: 200,
    pages: true,
  },
  {
    case: "one 5xx on the new version",
    reading: { serverErrors: [["https://os.iterate.com/api", 1]] },
    hostStatus: 200,
    pages: true,
  },
  // the alarm's own bar: a lone blip heals a call or three
  {
    case: "three platform-failure heals",
    reading: { heals: [["project", 3]] },
    hostStatus: 200,
    pages: false,
  },
  {
    case: "ten platform-failure heals",
    reading: { heals: [["project", 10]] },
    hostStatus: 200,
    pages: true,
  },
])("$case → pages: $pages", ({ reading, hostStatus, pages }) => {
  const page = renderPostDeployPage({
    reading: { ...quiet, ...reading },
    versionId: "2f631a17-6d1e-46bd-9754-0db5850edb75",
    since: new Date("2026-09-23T16:20:00Z"),
    until: new Date("2026-09-23T16:25:00Z"),
    hosts: hostsAnswering(hostStatus),
  });
  expect(Boolean(page)).toBe(pages);
});

test("the page names the version, the window, each host that is down and the faults", () => {
  expect(
    renderPostDeployPage({
      reading: { ...quiet, errors: [["ProjectDurableObject.jsrpc", 2]] },
      versionId: "2f631a17-6d1e-46bd-9754-0db5850edb75",
      since: new Date("2026-09-23T16:20:00Z"),
      until: new Date("2026-09-23T16:25:00Z"),
      hosts: [
        { url: "https://iterate.com/", status: 421 },
        { url: "https://garple.com/", status: 200 },
        { url: "https://lispwoso.com/", status: 0 },
      ],
    }),
  ).toMatchInlineSnapshot(`
    "🚨 prd post-deploy check: os-next-prd version \`2f631a17\`, 16:20–16:25 UTC <@U067G4QRFK2>
    • the project host https://iterate.com/ answered 421
    • the project host https://lispwoso.com/ did not answer
    • 2 errors: ProjectDurableObject.jsrpc 2
    <https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>"
  `);
});

test("every prd deploy that succeeded is checked five minutes later, read-only", () => {
  const workflow = parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/deploy-os-next.yml"), "utf8"),
  ) as { jobs: Record<string, { needs?: string[]; if?: string; steps?: { run?: string }[] }> };
  expect(workflow.jobs.verify).toMatchObject({
    needs: ["deploy"],
    if: "needs.deploy.result == 'success'",
  });
  expect(workflow.jobs.verify?.steps?.at(-1)?.run).toBe(
    'doppler run --project project-worker --config prd -- pnpm tsx scripts/ci/prd-post-deploy-check.ts check --deployed-at "${{ needs.deploy.outputs.deployed_at }}"',
  );
});

/** iterate.com answering `status`, garple.com answering 200. */
function hostsAnswering(status: number) {
  return [
    { url: "https://iterate.com/", status },
    { url: "https://garple.com/", status: 200 },
  ];
}
