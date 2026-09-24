import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  type FailureCause,
  PRD_PROJECT_HOST_URLS,
  readFailureCause,
  renderPostDeployPage,
} from "./prd-post-deploy-check.ts";

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
    'doppler run -- pnpm tsx scripts/ci/prd-post-deploy-check.ts check --previous-version "${{ steps.previous.outputs.version }}"',
  );
  // a failed, timed-out or cancelled deploy (or a failed check) still reports the deploy's own
  // result to #ci
  expect(steps.at(-1)).toMatchObject({
    if: "${{ always() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    run: "pnpm tsx scripts/ci/notify.ts deploy-${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}",
  });
});

// 2026-09-24: the CONTROL_PLANE Durable Object was unreachable from 13:22:48 UTC; #3018's version
// 71f709cf was uploaded at 13:23:46 into the outage, and the check found every host down. Trimmed
// from that window's Workers Logs.
const INCIDENT = {
  version: "71f709cf-100d-409e-89cb-61145e5e0865",
  uploadedAt: "2026-09-24T13:23:46.120964Z",
  checkedAt: Date.parse("2026-09-24T13:25:24.579Z"),
  stack:
    "    at async #call (assets/browser-client-C0Xhf0mk.js:17484:11)\n    at async ControlPlane.getProject (assets/browser-client-C0Xhf0mk.js:17495:19)\n    at async Object.fetch (index.js:15422:19)",
};

test("the page names the down hosts' failure in Workers Logs and that it began before the upload: 2026-09-24 in one line", async () => {
  const logs = stubCloudflare({
    // the down hosts, since ten minutes before the upload
    onHosts: [
      internalError("2026-09-24T13:25:25Z", "g9ivk6g1s9u1bjvmt34um3f2"),
      internalError("2026-09-24T13:24:53Z", "f0mrt0hfv5r5v1tmmnbjnlsv"),
      internalError("2026-09-24T13:24:09Z", "fo6p5lc47p8ils6fjhv84lkt"),
      {
        timestamp: Date.parse("2026-09-24T13:24:10Z"),
        source: { event: "facet.platform-failure-retry", name: "project" },
        $metadata: { level: "warn", type: "cf-worker" },
      },
    ],
    // the same message anywhere before the upload: the agents' hosts, on the previous version —
    // and one internal error thrown elsewhere, which is another failure
    beforeUpload: [
      internalError("2026-09-24T13:23:45Z", "cnfbns4l2pe7flu17vc8mpnr"),
      internalError("2026-09-24T13:23:36Z", "lldmpp4c3jjf73dat16q073d"),
      internalError("2026-09-24T13:22:53Z", "6it9ifmcovtnieq5idbjigsm"),
      internalError("2026-09-24T13:20:00Z", "unrelated", "    at async Other.thing (x.js:1:1)"),
    ],
  });
  const cause = await readFailureCause({
    cloudflare: { accountId: "account", apiToken: "token" },
    hosts: ["https://iterate.com/", "https://garple.com/"],
    newVersion: INCIDENT.version,
    now: INCIDENT.checkedAt,
  });

  const uploadedAt = Date.parse(INCIDENT.uploadedAt);
  expect(cause).toEqual({
    since: uploadedAt - 10 * 60_000,
    uploadedAt,
    dominant: {
      signature: "internal error; reference = … at #call < ControlPlane.getProject",
      count: 3,
      of: 4,
    },
    before: { count: 3, first: Date.parse("2026-09-24T13:22:53Z") },
  });
  // one read of the down hosts to the check, one of the whole worker up to the upload
  expect(logs.queries).toMatchObject([
    {
      timeframe: { from: uploadedAt - 10 * 60_000, to: INCIDENT.checkedAt },
      parameters: {
        filters: expect.arrayContaining([
          expect.objectContaining({ value: "^https?://(iterate\\.com|garple\\.com)([/?]|$)" }),
        ]),
      },
    },
    {
      timeframe: { from: uploadedAt - 10 * 60_000, to: uploadedAt },
      parameters: {
        filters: expect.arrayContaining([
          expect.objectContaining({ key: "$metadata.message", value: "internal error;" }),
        ]),
      },
    },
  ]);
  expect(
    renderPostDeployPage({
      previousVersion: "65c5274b-2e71-4de6-88ee-1b97ee429e63",
      liveVersion: INCIDENT.version,
      hosts: [
        { url: "https://iterate.com/", status: 0 },
        { url: "https://garple.com/", status: 0 },
      ],
      cause,
    }),
  ).toMatchInlineSnapshot(`
    "🚨 prd post-deploy check failed after the os-prd deploy <@U067G4QRFK2>
    • the project host https://iterate.com/ did not answer
    • the project host https://garple.com/ did not answer
    • Workers Logs: 3 of these hosts' 4 failures since 13:13:46 UTC are \`internal error; reference = … at #call < ControlPlane.getProject\`; it began BEFORE the new version's upload (13:23:46 UTC): first at 13:22:53, 53 s earlier, 3 times before the upload"
  `);
});

test.each<{ case: string; cause: FailureCause; line: string }>([
  {
    case: "the failure only began with the new version",
    cause: {
      since: Date.parse("2026-09-24T13:13:46Z"),
      uploadedAt: Date.parse("2026-09-24T13:23:46Z"),
      dominant: { signature: "TypeError: boom at Object.fetch", count: 100, of: 100 },
    },
    line: "• Workers Logs: 100 of these hosts' 100+ failures since 13:13:46 UTC are `TypeError: boom at Object.fetch`; none of it came before the new version's upload (13:23:46 UTC)",
  },
  {
    case: "nothing logged",
    cause: { since: Date.parse("2026-09-24T13:13:46Z") },
    line: "• Workers Logs holds no error or platform-failure warn on these hosts since 13:13:46 UTC",
  },
  {
    case: "Workers Logs unread",
    cause: { unread: "no Cloudflare credentials: run under doppler --project os --config prd" },
    line: "• Workers Logs could not say why: no Cloudflare credentials: run under doppler --project os --config prd",
  },
])("$case", ({ cause, line }) => {
  const page = renderPostDeployPage({
    previousVersion: "old",
    liveVersion: "new",
    hosts: [{ url: "https://iterate.com/", status: 503 }],
    cause,
  });
  expect(page?.split("\n")).toContain(line);
});

/** Cloudflare's API as readFailureCause reads it: the version's metadata, then the Workers Logs
 *  events queries in order — the down hosts', then the one up to the upload. */
function stubCloudflare(events: { onHosts: object[]; beforeUpload: object[] }) {
  const queries: { timeframe: object; parameters: object }[] = [];
  const answers = [events.onHosts, events.beforeUpload];
  const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes("/workers/scripts/os-prd/versions/"))
      return Response.json({ result: { metadata: { created_on: INCIDENT.uploadedAt } } });
    queries.push(JSON.parse(init!.body!));
    return Response.json({
      success: true,
      result: { events: { events: answers[queries.length - 1] } },
    });
  });
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => void vi.unstubAllGlobals());
  return { queries };
}

/** One of the outage's exceptions as Workers Logs holds it. */
const internalError = (at: string, reference: string, stack = INCIDENT.stack) => ({
  timestamp: Date.parse(at),
  source: {
    message: `internal error; reference = ${reference}`,
    exception: { name: "Error", stack },
  },
  $metadata: {
    level: "error",
    type: "cf-worker",
    message: `internal error; reference = ${reference}`,
  },
});
