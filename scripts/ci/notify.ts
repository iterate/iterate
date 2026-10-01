// scripts/ci/notify.ts — THE CI WORKFLOWS' OWN SLACK POSTS, in the page shape ./slack.ts gives
// (docs/depot-ci.md#slack-channels). Each command posts what its job's environment names:
//
//   pr-update          pr-dashboard.yml's notify job: the pull request event (GITHUB_EVENT_PATH) as
//                      one top-level line in #ci.
//   deploy-success     a prd deploy job's step, once the job succeeded: `🚀 <App> live · run` in
//                      #ci, in the thread of the merge's line (a dispatched redeploy's, top-level).
//                      Then each open deploy page naming the app, for a commit this one descends
//                      from, is edited "live again", and resolved once every app on it is. The
//                      dashboard's "prd deploys" row turns green naming the app, or stays red while
//                      a deploy page is open.
//   deploy-failure     the same job's step when its deploy did not succeed (and, on OS, the host
//                      check did not page): one page per failing commit, in today's #error-pulse
//                      dashboard thread and sent to the channel too (prd is down), and the "prd
//                      deploys" row red. Another app failing on that commit is edited into its page.
//   workflow-failure   a scheduled workflow's notify job: one page per workflow while it is red, in
//                      today's dashboard thread, and the dashboard's row named by the workflow red.
//                      A repeat edits the page; a new set of failed jobs also replies in today's
//                      dashboard thread, naming the workflow.
//   workflow-resolved  the same job on a green run: resolves that page and turns the row green.
//
// A page's first line and impact are its state: a run reads them back from the open page and
// renders the page again. `--test-run` posts what the command would post, marked 🧪, to #ci, and
// reads and edits no page or row. deploy-success's reads #ci once and replies in the thread of
// GITHUB_SHA's merge line when it finds one, so a merged commit's sha proves the thread reply
// without a deploy.
//
// Two apps failing on one commit can post two pages in the same second. Each re-reads after it
// posts, and the younger page deletes itself and is edited into the older. Two younger pages folding
// into the older at once can lose one app from its list, and the row names the apps its last writer
// saw: those races are accepted.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { setRow, type RowState } from "./dashboard.ts";
import { depotWorkflowUrl } from "./depot.ts";
import { getOctokit, getRepo, readEventPayload, type GithubEventPayload } from "./github.ts";
import {
  cutText,
  editPage,
  escalationText,
  findOpenPages,
  getSlackClient,
  pageText,
  postPage,
  resolvePage,
  resolvedText,
  slackChannelIds,
  slackEscape,
} from "./slack.ts";

type PullRequestPayload = NonNullable<GithubEventPayload["pull_request"]>;

/** A clock the waits read, injected so a test runs them at once. */
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: Date.now, sleep: (ms) => sleep(ms) };

// ---- pull request events -------------------------------------------------------------------------

/** A pull request event's routine post for #ci, or null for an action it does not post. Pure. */
export function formatPullRequestUpdateMessage(payload: GithubEventPayload) {
  const pullRequest = payload.pull_request;
  if (!pullRequest) {
    throw new Error("pull_request payload is required");
  }

  const detail = formatPullRequestUpdateDetail(payload, pullRequest);
  if (!detail) return null;

  const actor = getPullRequestActionActor(payload, pullRequest);
  const author = pullRequest.user?.login;
  const authorSuffix = author && author !== actor ? ` (author: ${slackEscape(author)})` : "";
  const link = formatPullRequestLink(pullRequest);

  return `${detail.prefix}: ${link}${detail.afterLink || ""} by ${slackEscape(actor)}${detail.afterActor || ""}${authorSuffix}`;
}

function formatPullRequestUpdateDetail(
  payload: GithubEventPayload,
  pullRequest: PullRequestPayload,
) {
  switch (payload.action) {
    case "opened":
      return { prefix: `🟢 PR opened${pullRequest.draft ? " as draft" : ""}` };
    case "reopened":
      return { prefix: `🔁 PR reopened${pullRequest.draft ? " as draft" : ""}` };
    case "ready_for_review":
      return { prefix: "👀 PR marked ready for review" };
    case "converted_to_draft":
      return { prefix: "📝 PR converted to draft" };
    case "closed":
      if (pullRequest.merged) {
        const base = pullRequest.base?.ref;
        return {
          prefix: "✅ PR merged",
          // nearly every merge is into the default branch: only another base is worth the words
          afterLink:
            base && base !== payload.repository?.default_branch
              ? ` into \`${slackEscape(base)}\``
              : "",
          // the deploys' lines are replies to this one, found by the merge commit it names
          afterActor: pullRequest.merge_commit_sha
            ? ` (${pullRequest.merge_commit_sha.slice(0, 7)})`
            : "",
        };
      }
      return { prefix: "⚪ PR closed without merge" };
    default:
      return null;
  }
}

function getPullRequestActionActor(payload: GithubEventPayload, pullRequest: PullRequestPayload) {
  return (
    (payload.action === "closed" && pullRequest.merged
      ? pullRequest.merged_by?.login
      : undefined) ||
    payload.sender?.login ||
    process.env.GITHUB_ACTOR ||
    pullRequest.user?.login ||
    "unknown"
  );
}

/** `#<number> <title>`, the title cut to 80 characters so a line reads at a glance. */
function formatPullRequestLink(pullRequest: PullRequestPayload) {
  const title = pullRequest.title ? ` ${slackEscape(cutText(pullRequest.title, 80))}` : "";
  const label = `#${pullRequest.number}${title}`;
  return pullRequest.html_url ? `<${pullRequest.html_url}|${label}>` : label;
}

/** Posts the pull request event (GITHUB_EVENT_PATH) to #ci. */
export async function prUpdate(options: { testRun?: boolean } = {}) {
  const payload = readEventPayload();
  const message = formatPullRequestUpdateMessage(payload);
  if (!message) {
    console.log(`No #ci Slack PR update for pull_request action ${payload.action || "(missing)"}`);
    return;
  }
  await getSlackClient().chat.postMessage({
    channel: slackChannelIds["#ci"],
    text: options.testRun ? `🧪 TEST RUN — ${message}` : message,
  });
}

// ---- prd deploys ---------------------------------------------------------------------------------

/** A deploy's line in #ci: in its merge's thread, or top-level with its sha. Pure. */
export function deployLiveText(input: {
  app: string;
  runUrl: string;
  /** Named on a top-level line, which no merge's thread gives. */
  sha?: string;
  /** The thread already has this app's line: this is a second run of the same commit. */
  rerun: boolean;
}) {
  const at = input.sha ? ` at ${input.sha.slice(0, 7)}` : "";
  return `🚀 ${input.app} live${at}${input.rerun ? " (re-run)" : ""} · <${input.runUrl}|run>`;
}

/** When deploy-success reads #ci for the merge's line, in seconds after it starts. The line lands
 *  about a minute after the merge (p50 52 s, max 129 s, 09-07 → 09-28 2026), and a deploy can finish
 *  before it; four reads keep seven deploys after a burst of merges within Slack's history limit. */
export const MERGE_POST_READS_S = [0, 30, 90, 180];

/** The merge's line for `sha` in #ci (`✅ PR merged: … (<sha7>)`), read at `reads` seconds;
 *  undefined when none appeared. */
async function findMergePost(
  slack: WebClient,
  input: { sha: string; clock: Clock; reads: number[] },
) {
  const { bot_id: botId } = await slack.auth.test();
  const start = input.clock.now();
  for (const at of input.reads) {
    await input.clock.sleep(Math.max(0, start + at * 1000 - input.clock.now()));
    // #ci's newest 200 lines, newest first (no `oldest`, as in findOpenPages)
    const history = await slack.conversations.history({
      channel: slackChannelIds["#ci"],
      limit: 200,
    });
    const merge = (history.messages || []).find(
      ({ bot_id, text = "" }) =>
        bot_id === botId &&
        text.includes("PR merged: ") &&
        text.includes(`(${input.sha.slice(0, 7)})`) &&
        !text.includes("TEST RUN"),
    );
    if (merge?.ts) return merge.ts;
  }
  return undefined;
}

/** Posts `🚀 <App> live` in the thread of the merge's line in #ci, `(re-run)` when the thread has
 *  this app's line already; top-level with the sha when no merge's line appeared (with a log line),
 *  or at once for a dispatched redeploy, which has none. A 🧪 test run reads #ci once and posts
 *  where that read puts it, marked; a real run's re-run check skips 🧪 lines. */
export async function announceDeploy(
  slack: WebClient,
  input: {
    app: string;
    sha: string;
    runUrl: string;
    pushed: boolean;
    clock: Clock;
    testRun?: boolean;
  },
) {
  const channel = slackChannelIds["#ci"];
  const mark = (text: string) => (input.testRun ? `🧪 TEST RUN — ${text}` : text);
  const reads = input.testRun ? [0] : MERGE_POST_READS_S;
  const parent = input.pushed ? await findMergePost(slack, { ...input, reads }) : undefined;
  if (!parent) {
    if (input.pushed && !input.testRun)
      console.log(JSON.stringify({ event: "deploy-notify.no-merge-post", sha: input.sha }));
    await slack.chat.postMessage({
      channel,
      text: mark(deployLiveText({ ...input, rerun: false })),
    });
    return;
  }
  const thread = await slack.conversations.replies({ channel, ts: parent });
  const line = new RegExp(`(^|\\s)${input.app} live\\b`);
  const rerun = (thread.messages || []).some(
    ({ ts, text = "" }) => ts !== parent && line.test(text) && !text.includes("TEST RUN"),
  );
  await slack.chat.postMessage({
    channel,
    thread_ts: parent,
    text: mark(deployLiveText({ app: input.app, runUrl: input.runUrl, rerun })),
  });
}

/** A failed commit's page as a run reads it back: its first line up to the apps (`prd deploy failed
 *  at <sha7> (<subject>)`, already escaped), the apps that failed on it (and whether each had
 *  uploaded before its job failed), those live again since, and its link. */
export type DeployPage = {
  head: string;
  sha: string;
  failed: { app: string; uploaded: boolean }[];
  live: { app: string; sha: string }[];
  runUrl: string;
};

/** How long a deploy page stays open to its apps' next deploys. */
const DEPLOY_PAGE_HOURS = 168;
const DEPLOY_MARKER = "prd deploy failed at ";
/** The dashboard's row (./dashboard.ts) for prd deploys. */
const DEPLOY_SIGNAL = "prd deploys";

/** The apps that failed on a page's commit and are not live again since. Pure. */
function stillDown(page: DeployPage) {
  const back = new Set(page.live.map((entry) => entry.app));
  return page.failed.filter((entry) => !back.has(entry.app));
}

/** Apps' names as a page lists them, `OS, Agents`. Pure. */
const names = (entries: { app: string }[]) => entries.map((entry) => entry.app).join(", ");

/** The "prd deploys" row's text while deploy pages are open: each one's apps still down and its
 *  commit, `OS, Agents failed at 0123456`. Pure. */
function deployRowText(pages: DeployPage[]) {
  return pages.map((page) => `${names(stillDown(page))} failed at ${page.sha}`).join("; ");
}

/** A failed commit's page. Pure. */
export function deployPageText(page: DeployPage, testRun: boolean) {
  const down = stillDown(page);
  const notUploaded = down.filter((entry) => !entry.uploaded);
  const uploaded = down.filter((entry) => entry.uploaded);
  const impact = [
    notUploaded.length > 0 && `prd still serves the previous ${names(notUploaded)}`,
    uploaded.length > 0 && `${names(uploaded)} uploaded, then the deploy job failed`,
    page.live.length > 0 &&
      `live again: ${page.live.map((entry) => `${entry.app} at ${entry.sha.slice(0, 7)}`).join(", ")}`,
  ].filter(Boolean);
  return pageText({
    what: `${page.head}: ${names(page.failed)}`,
    impact: impact.join("; "),
    action: `open the run: re-run it if Cloudflare or the network failed, else fix forward or revert ${page.sha}`,
    link: page.runUrl,
    testRun,
  });
}

/** A new page's first line up to its apps. Pure. */
function deployPageHead(sha: string, subject: string) {
  return `${DEPLOY_MARKER}${sha.slice(0, 7)} (${slackEscape(cutText(subject, 80))})`;
}

/** Reads a deploy page back from its text, as posted or as Slack's history spells it. Pure. */
export function readDeployPage(text: string): DeployPage {
  const [first = "", impact = "", , link = ""] = text.split("\n");
  const what = first.replace(/^(🚨|:rotating_light:)\s*/, "").replace(/(\s*<@\w+>)+$/, "");
  const cut = what.lastIndexOf("): ");
  const segments = impact.replace(/^Impact: /, "").split("; ");
  const listed = (prefix: string, suffix = "") =>
    segments
      .filter((segment) => segment.startsWith(prefix) && segment.endsWith(suffix))
      .flatMap((segment) =>
        segment.slice(prefix.length, segment.length - suffix.length).split(", "),
      );
  const uploaded = new Set(listed("", " uploaded, then the deploy job failed"));
  return {
    head: what.slice(0, cut + 1),
    sha: z.string().parse(/prd deploy failed at (\w{7})/.exec(what)?.[1]),
    failed: what
      .slice(cut + 3)
      .split(", ")
      .map((app) => ({ app, uploaded: uploaded.has(app) })),
    live: listed("live again: ").map((entry) => {
      const [app = "", sha = ""] = entry.split(" at ");
      return { app, sha };
    }),
    runUrl: /^<(.+)\|run>$/.exec(link)?.[1] || "",
  };
}

/** `page`, with `app` failed on it (again). Pure. */
function withFailure(page: DeployPage, app: { app: string; uploaded: boolean }): DeployPage {
  return {
    ...page,
    failed: [...page.failed.filter((entry) => entry.app !== app.app), app],
    live: page.live.filter((entry) => entry.app !== app.app),
  };
}

/** A failed deploy's Slack side: `app`'s failure at `sha` paged (writeDeployPage), then the
 *  dashboard's "prd deploys" row red, naming the apps still down on every open deploy page, this
 *  commit's and any earlier one's (openDeployRow). A 🧪 test run posts the page it would post to #ci
 *  alone. */
export async function pageDeployFailure(
  slack: WebClient,
  input: {
    app: string;
    uploaded: boolean;
    sha: string;
    subject: string;
    runUrl: string;
    now: Date;
    testRun: boolean;
  },
) {
  if (input.testRun) {
    const text = deployPageText(newDeployPage(input), true);
    await slack.chat.postMessage({ channel: slackChannelIds["#ci"], text });
    return;
  }
  await writeDeployPage(slack, input);
  const channel = slackChannelIds["#error-pulse"];
  const open = await findOpenPages(slack, {
    channel,
    marker: DEPLOY_MARKER,
    sinceHours: DEPLOY_PAGE_HOURS,
    now: input.now,
  });
  await setRow(slack, {
    channel,
    now: input.now,
    signal: DEPLOY_SIGNAL,
    state: "red",
    text: openDeployRow(open.map((found) => found.text)),
  });
}

/** The "prd deploys" row's text for the open pages `texts`: each page's apps still down, and how many
 *  pages could not be read (a format from before), which are down too as far as anyone knows. Pure. */
function openDeployRow(texts: string[]) {
  const pages: DeployPage[] = [];
  let unread = 0;
  for (const text of texts) {
    try {
      pages.push(readDeployPage(text));
    } catch {
      unread += 1;
    }
  }
  return [pages.length > 0 && deployRowText(pages), unread > 0 && `${unread} page(s) not read`]
    .filter(Boolean)
    .join("; ");
}

/** A commit's first page, for `app` that failed on it. Pure. */
function newDeployPage(input: {
  app: string;
  uploaded: boolean;
  sha: string;
  subject: string;
  runUrl: string;
}): DeployPage {
  return {
    head: deployPageHead(input.sha, input.subject),
    sha: input.sha.slice(0, 7),
    failed: [{ app: input.app, uploaded: input.uploaded }],
    live: [],
    runUrl: input.runUrl,
  };
}

/** `app`'s failure at `sha` edited into that commit's open page when there is one, else a new page
 *  in today's dashboard thread, sent to the channel too (prd is down), which folds itself into an
 *  older one posted in the same moment. Resolves to the page as written. */
async function writeDeployPage(
  slack: WebClient,
  input: Parameters<typeof pageDeployFailure>[1],
): Promise<DeployPage> {
  const channel = slackChannelIds["#error-pulse"];
  const { now } = input;
  const failure = { app: input.app, uploaded: input.uploaded };
  const oldestFirst = async () =>
    (
      await findOpenPages(slack, {
        channel,
        marker: `${DEPLOY_MARKER}${input.sha.slice(0, 7)}`,
        sinceHours: DEPLOY_PAGE_HOURS,
        now,
      })
    ).reverse();
  const fold = async (found: { ts: string; text: string }) => {
    const folded = withFailure(readDeployPage(found.text), failure);
    await editPage(slack, { channel, ts: found.ts, text: deployPageText(folded, false), now });
    return folded;
  };
  const [existing] = await oldestFirst();
  if (existing) return await fold(existing);
  const page = newDeployPage(input);
  const ts = await postPage(slack, {
    channel,
    text: deployPageText(page, false),
    broadcast: true,
    now,
  });
  const [oldest] = await oldestFirst();
  if (!oldest || oldest.ts === ts) return page;
  await slack.chat.delete({ channel, ts });
  return await fold(oldest);
}

/** After `app` went live at `sha`: each open page it failed on, at a commit `sha` descends from, is
 *  edited "live again", and resolved once all its apps are. Then the dashboard's "prd deploys" row:
 *  red naming the pages this run left open, else green naming `app` at `sha`. */
export async function resolveDeployPages(
  slack: WebClient,
  input: {
    app: string;
    sha: string;
    now: Date;
    /** Whether `head` is `base` or descends from it: a re-run of an older commit resolves nothing. */
    descends: (base: string, head: string) => Promise<boolean>;
  },
) {
  const channel = slackChannelIds["#error-pulse"];
  const open = await findOpenPages(slack, {
    channel,
    marker: DEPLOY_MARKER,
    sinceHours: DEPLOY_PAGE_HOURS,
    now: input.now,
  });
  // one page that cannot be read or written leaves the others to resolve, and fails the step after
  const errors: unknown[] = [];
  const stillOpen: string[] = [];
  for (const found of open) {
    try {
      const page = await resolveDeployPage(slack, { ...input, channel, found });
      if (page) stillOpen.push(deployPageText(page, false));
    } catch (error) {
      errors.push(error);
      // its incident is still open as far as anyone knows: the row stays red for it
      stillOpen.push(found.text);
    }
  }
  const row: { state: RowState; text: string } =
    stillOpen.length > 0
      ? { state: "red", text: openDeployRow(stillOpen) }
      : { state: "green", text: `${input.app} live at ${input.sha.slice(0, 7)}` };
  await setRow(slack, { channel, now: input.now, signal: DEPLOY_SIGNAL, ...row }).catch(
    (error: unknown) => errors.push(error),
  );
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      `${errors.length} update(s) of the deploy's pages and row failed`,
    );
}

/** Edits or resolves one open deploy page for `app` live at `sha`. Resolves to the page as this run
 *  left it while it is still open, or undefined once it is resolved. */
async function resolveDeployPage(
  slack: WebClient,
  input: Parameters<typeof resolveDeployPages>[1] & {
    channel: string;
    found: { ts: string; text: string };
  },
): Promise<DeployPage | undefined> {
  const { channel, found, now } = input;
  const page = readDeployPage(found.text);
  const failed = page.failed.some((entry) => entry.app === input.app);
  const back = page.live.some((entry) => entry.app === input.app);
  if (!failed || back || !(await input.descends(page.sha, input.sha))) return page;
  const next = { ...page, live: [...page.live, { app: input.app, sha: input.sha.slice(0, 7) }] };
  const text = deployPageText(next, false);
  if (stillDown(next).length > 0) {
    await editPage(slack, { channel, ts: found.ts, text, now });
    return next;
  }
  await resolvePage(slack, {
    channel,
    ts: found.ts,
    text,
    why: `every app is live again: ${next.live.map((entry) => `${entry.app} at ${entry.sha}`).join(", ")}`,
    now,
  });
  return undefined;
}

/** The prd deploy its job's step reports: APP_DISPLAY_NAME at GITHUB_SHA, linking the job. */
function deployInput() {
  return {
    app: readOption("APP_DISPLAY_NAME"),
    sha: readOption("GITHUB_SHA"),
    runUrl: readOption("DEPOT_JOB_URL"),
  };
}

function readOption(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Whether `head` is `base` or descends from it, by GitHub's compare. */
async function descends(base: string, head: string) {
  const { data } = await getOctokit().rest.repos.compareCommitsWithBasehead({
    ...getRepo(),
    basehead: `${base}...${head}`,
  });
  return data.status === "ahead" || data.status === "identical";
}

/** Posts APP_DISPLAY_NAME's prd deploy at GITHUB_SHA to #ci and resolves the pages it ends. */
export async function deploySuccess(options: { testRun?: boolean } = {}) {
  const input = deployInput();
  const slack = getSlackClient();
  if (options.testRun) {
    await announceDeploy(slack, { ...input, pushed: true, clock: realClock, testRun: true });
    return;
  }
  // a failed #ci post still resolves the pages this deploy ends, and both failures fail the step
  const errors: unknown[] = [];
  await announceDeploy(slack, {
    ...input,
    pushed: readOption("GITHUB_EVENT_NAME") === "push",
    clock: realClock,
  }).catch((error: unknown) => errors.push(error));
  await resolveDeployPages(slack, {
    app: input.app,
    sha: input.sha,
    now: new Date(),
    descends,
  }).catch((error: unknown) => errors.push(error));
  if (errors.length > 0) throw new AggregateError(errors, "the deploy's Slack posts failed");
}

/** Pages #error-pulse with APP_DISPLAY_NAME's failed prd deploy at GITHUB_SHA; UPLOADED is the
 *  deploy step's outcome. */
export async function deployFailure(options: { testRun?: boolean } = {}) {
  const input = deployInput();
  const failure = {
    ...input,
    uploaded: process.env.UPLOADED === "success",
    subject: execFileSync("git", ["log", "-1", "--format=%s", input.sha], {
      encoding: "utf8",
    }).trim(),
  };
  await pageDeployFailure(getSlackClient(), {
    ...failure,
    now: new Date(),
    testRun: Boolean(options.testRun),
  });
}

// ---- scheduled workflows -------------------------------------------------------------------------

/** A workflow's `toJSON(needs)`: each job it waited on, with its result. */
const WorkflowNeeds = z.record(z.string(), z.object({ result: z.string().optional() }));

/** A red workflow's page as a run reads it back: its failed jobs, since which commit, how many runs
 *  in a row. */
export type WorkflowPage = {
  workflow: string;
  jobs: string[];
  since: string;
  runs: number;
  runUrl: string;
};

/** How long a workflow's page stays open to its next runs. */
const WORKFLOW_PAGE_HOURS = 168;

/** A red workflow's page. Pure. */
export function workflowPageText(page: WorkflowPage, testRun: boolean) {
  return pageText({
    what: `${page.workflow} failed: ${page.jobs.join(", ")}`,
    impact: `${page.workflow} is red since ${page.since.slice(0, 7)}, ${page.runs === 1 ? "1 run" : `${page.runs} runs`}`,
    action: "open the run and read the failed job's log",
    link: page.runUrl,
    testRun,
  });
}

/** Reads a workflow's page back from its text, as posted or as Slack's history spells it. Pure. */
function readWorkflowPage(workflow: string, text: string): WorkflowPage {
  const [first = "", impact = "", , link = ""] = text.split("\n");
  const marker = `${workflow} failed: `;
  const jobs = first.replace(/(\s*<@\w+>)+$/, "").slice(first.indexOf(marker) + marker.length);
  const [, since = "", runs = "1"] = / is red since (\w+), (\d+) runs?$/.exec(impact) || [];
  return {
    workflow,
    jobs: jobs.split(", "),
    since,
    runs: Number(runs),
    runUrl: /^<(.+)\|run>$/.exec(link)?.[1] || "",
  };
}

/** The failed jobs in `needs`. Pure. */
export function failedJobs(needs: z.infer<typeof WorkflowNeeds>) {
  return Object.entries(needs)
    .filter(([, value]) => value.result === "failure")
    .map(([name]) => name);
}

const workflowPages = (slack: WebClient, workflow: string, now: Date) =>
  findOpenPages(slack, {
    channel: slackChannelIds["#error-pulse"],
    marker: `${workflow} failed: `,
    sinceHours: WORKFLOW_PAGE_HOURS,
    now,
  });

/** Pages #error-pulse with `workflow`'s red run, not sent to the channel: its open page edited (and
 *  a reply in today's dashboard thread, naming the workflow, when other jobs fail now), or a new
 *  page in that thread. Then the dashboard's row named by the workflow turns red. A 🧪 test run
 *  posts the page it would post to #ci alone. */
export async function pageWorkflowFailure(
  slack: WebClient,
  input: {
    workflow: string;
    jobs: string[];
    sha: string;
    runUrl: string;
    now: Date;
    testRun: boolean;
  },
) {
  if (input.testRun) {
    const text = workflowPageText({ ...input, since: input.sha, runs: 1 }, true);
    await slack.chat.postMessage({ channel: slackChannelIds["#ci"], text });
    return;
  }
  const channel = slackChannelIds["#error-pulse"];
  const { now } = input;
  const [found] = await workflowPages(slack, input.workflow, now);
  if (found) {
    const page = readWorkflowPage(input.workflow, found.text);
    const next = { ...page, jobs: input.jobs, runs: page.runs + 1, runUrl: input.runUrl };
    await editPage(slack, { channel, ts: found.ts, text: workflowPageText(next, false), now });
    if ([...page.jobs].sort().join() !== [...input.jobs].sort().join())
      await postPage(slack, {
        channel,
        text: escalationText(`${input.workflow} now fails in ${input.jobs.join(", ")}`, false),
        broadcast: false,
        now,
      });
  } else {
    const page = { ...input, since: input.sha, runs: 1 };
    await postPage(slack, { channel, text: workflowPageText(page, false), broadcast: false, now });
  }
  await setRow(slack, {
    channel,
    now,
    signal: input.workflow,
    state: "red",
    text: `failed in ${input.jobs.join(", ")}`,
  });
}

/** Resolves `workflow`'s page after a green run, and turns its row on the dashboard green. A 🧪
 *  test run posts the resolution it would make to #ci alone. */
export async function resolveWorkflowPage(
  slack: WebClient,
  input: { workflow: string; sha: string; now: Date; testRun: boolean },
) {
  const why = `${input.workflow} green again at ${input.sha.slice(0, 7)}`;
  if (input.testRun) {
    await slack.chat.postMessage({
      channel: slackChannelIds["#ci"],
      text: resolvedText(why, true),
    });
    return;
  }
  const channel = slackChannelIds["#error-pulse"];
  const { now } = input;
  for (const found of await workflowPages(slack, input.workflow, now)) {
    await resolvePage(slack, {
      channel,
      ts: found.ts,
      text: workflowPageText(readWorkflowPage(input.workflow, found.text), false),
      why,
      now,
    });
  }
  await setRow(slack, {
    channel,
    now,
    signal: input.workflow,
    state: "green",
    text: `green at ${input.sha.slice(0, 7)}`,
  });
}

/** This run's workflow (GITHUB_WORKFLOW) at GITHUB_SHA, linking its page on Depot (DEPOT_JOB_URL
 *  names the notify job, in the same run). */
function workflowInput() {
  return {
    workflow: readOption("GITHUB_WORKFLOW"),
    sha: readOption("GITHUB_SHA"),
    runUrl: depotWorkflowUrl(new URL(readOption("DEPOT_JOB_URL")).pathname.split("/").at(-1)!),
  };
}

/** Pages #error-pulse with the workflow's failed jobs (NEEDS). */
export async function workflowFailure(options: { testRun?: boolean } = {}) {
  const input = {
    ...workflowInput(),
    jobs: failedJobs(WorkflowNeeds.parse(JSON.parse(readOption("NEEDS")))),
  };
  await pageWorkflowFailure(getSlackClient(), {
    ...input,
    now: new Date(),
    testRun: Boolean(options.testRun),
  });
}

/** Resolves the workflow's page, if one is open, after its green run. */
export async function workflowResolved(options: { testRun?: boolean } = {}) {
  await resolveWorkflowPage(getSlackClient(), {
    ...workflowInput(),
    now: new Date(),
    testRun: Boolean(options.testRun),
  });
}

void createCli(import.meta).run();
