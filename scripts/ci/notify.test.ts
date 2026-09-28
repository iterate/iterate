// The posts scripts/ci/notify.ts makes: which channel each goes to, what it says, and how a page is
// edited and resolved. A page to #error-pulse mentions Jonas and Misha; a routine post to #ci
// mentions nobody.
import { expect, test, vi } from "vitest";
import { fakeSlack } from "./fake-slack.ts";
import {
  announceDeploy,
  failedJobs,
  formatPullRequestUpdateMessage,
  MERGE_POST_READS_S,
  pageDeployFailure,
  pageWorkflowFailure,
  readDeployPage,
  resolveDeployPages,
  resolveWorkflowPage,
  type Clock,
} from "./notify.ts";

const now = Date.parse("2026-09-28T12:00:00Z");
const mention = "<@U067G4QRFK2> <@U099JH9TAF2>";
const failing = "0123456789abcdef0123456789abcdef01234567";
const fix = "89abcdef0123456789abcdef0123456789abcdef";
const pullRequest = {
  number: 7,
  title: "A change",
  html_url: "https://github.com/iterate/iterate/pull/7",
  user: { login: "mmkal" },
};

// ---- pull request events

test("a pull request event's post mentions nobody", () => {
  expect(
    formatPullRequestUpdateMessage({
      action: "opened",
      sender: { login: "mmkal" },
      pull_request: pullRequest,
    }),
  ).toBe("🟢 PR opened: <https://github.com/iterate/iterate/pull/7|#7 A change> by mmkal");
});

test.for([
  { base: "main", into: "" },
  { base: "codex/x", into: " into `codex/x`" },
])("a merge into $base names its base only when it is not the default branch", ({ base, into }) => {
  expect(
    formatPullRequestUpdateMessage({
      action: "closed",
      sender: { login: "mmkal" },
      repository: { default_branch: "main" },
      pull_request: {
        ...pullRequest,
        merged: true,
        merged_by: { login: "jonastemplestein" },
        merge_commit_sha: failing,
        base: { ref: base, sha: "b" },
      },
    }),
  ).toBe(
    `✅ PR merged: <https://github.com/iterate/iterate/pull/7|#7 A change>${into} by jonastemplestein (0123456) (author: mmkal)`,
  );
});

test("a title is cut to 80 characters before it is escaped", () => {
  expect(
    formatPullRequestUpdateMessage({
      action: "opened",
      sender: { login: "mmkal" },
      pull_request: { ...pullRequest, title: `${"x".repeat(78)} & more words after` },
    }),
  ).toBe(
    `🟢 PR opened: <https://github.com/iterate/iterate/pull/7|#7 ${"x".repeat(78)} &amp;…> by mmkal`,
  );
});

// ---- deploy success

test("the merge's line found on the third read gets the deploy as a thread reply", async () => {
  const slack = fakeSlack({ now });
  const clock = testClock((seconds) => {
    if (seconds === MERGE_POST_READS_S[2]) slack.seed("#ci", mergeLine(fix));
  });

  await announceDeploy(slack.client, { ...deploy("OS"), pushed: true, clock });

  const [merge] = slack.channel("#ci");
  expect(slack.channel("#ci")).toHaveLength(1);
  expect(merge?.replies.map((reply) => reply.text)).toEqual([
    "🚀 OS live · <https://depot.dev/OS|run>",
  ]);
  expect(slack.calls.filter((call) => call.method === "conversations.history")).toHaveLength(3);
  expect(clock.waited()).toBe(90);
});

test("a second deploy of the same commit is marked a re-run", async () => {
  const slack = fakeSlack({ now });
  slack.seed("#ci", mergeLine(fix));
  // a 🧪 line naming the same commit is not the merge's
  slack.seed("#ci", `🧪 TEST RUN — ${mergeLine(fix)}`);
  const run = (app: string) =>
    announceDeploy(slack.client, { ...deploy(app), pushed: true, clock: testClock() });

  await run("OS");
  await run("Agents");
  await run("OS");

  expect(slack.channel("#ci")[0]?.replies.map((reply) => reply.text)).toEqual([
    "🚀 OS live · <https://depot.dev/OS|run>",
    "🚀 Agents live · <https://depot.dev/Agents|run>",
    "🚀 OS live (re-run) · <https://depot.dev/OS|run>",
  ]);
});

test("no merge's line within 180 s: the deploy posts top-level with its sha, and logs it", async () => {
  const slack = fakeSlack({ now });
  slack.seed("#ci", mergeLine(failing));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const clock = testClock();

  await announceDeploy(slack.client, { ...deploy("OS"), pushed: true, clock });

  expect(clock.waited()).toBe(180);
  expect(slack.channel("#ci").map((message) => message.text)).toEqual([
    mergeLine(failing),
    "🚀 OS live at 89abcde · <https://depot.dev/OS|run>",
  ]);
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "deploy-notify.no-merge-post", sha: fix }),
  );
  log.mockRestore();
});

test("a dispatched redeploy has no merge's line: it posts top-level at once", async () => {
  const slack = fakeSlack({ now });
  const clock = testClock();

  await announceDeploy(slack.client, { ...deploy("OS"), pushed: false, clock });

  expect(clock.waited()).toBe(0);
  expect(slack.channel("#ci").map((message) => message.text)).toEqual([
    "🚀 OS live at 89abcde · <https://depot.dev/OS|run>",
  ]);
});

// ---- deploy failure and its resolution

test("two apps failing on one commit are one page, the second edited into it", async () => {
  const slack = fakeSlack({ now });

  await pageDeployFailure(slack.client, failure("OS"));
  await pageDeployFailure(slack.client, failure("Agents", true));

  expect(slack.channel("#error-pulse")).toHaveLength(1);
  const [page] = slack.channel("#error-pulse");
  expect(page?.text).toBe(
    [
      `🚨 prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
      "Impact: prd still serves the previous OS; Agents uploaded, then the deploy job failed",
      "Do: open the run: re-run it if Cloudflare or the network failed, else fix forward or revert 0123456",
      "<https://depot.dev/OS|run>",
    ].join("\n"),
  );
  // "failed too" is an edit: nobody is pinged twice for one commit
  expect(page?.replies).toEqual([]);
});

test("two pages posted for one commit at once: the younger deletes itself into the older", async () => {
  const slack = fakeSlack({ now });
  const history = slack.client.conversations.history.bind(slack.client.conversations);
  let reads = 0;
  // the other app's page lands between this app's read and its post
  const other = vi.spyOn(slack.client.conversations, "history").mockImplementation(async (args) => {
    if (++reads === 2)
      slack.seed(
        "#error-pulse",
        [
          `🚨 prd deploy failed at 0123456 (A change): Agents ${mention}`,
          "Impact: prd still serves the previous Agents",
          "Do: open the run",
          "<https://depot.dev/Agents|run>",
        ].join("\n"),
        0.001,
      );
    return history(args);
  });

  await pageDeployFailure(slack.client, failure("OS"));

  expect(slack.channel("#error-pulse").map((message) => message.text.split("\n")[0])).toEqual([
    `🚨 prd deploy failed at 0123456 (A change): Agents, OS ${mention}`,
  ]);
  expect(slack.calls.map((call) => call.method)).toContain("chat.delete");
  other.mockRestore();
});

test("each app live again is an edit; the page resolves when the last app is back", async () => {
  const slack = fakeSlack({ now });
  await pageDeployFailure(slack.client, failure("OS"));
  await pageDeployFailure(slack.client, failure("Agents"));
  const descends = async () => true;

  await resolveDeployPages(slack.client, { app: "OS", sha: fix, now: new Date(now), descends });
  const [page] = slack.channel("#error-pulse");
  expect(page?.text.split("\n").slice(0, 2)).toEqual([
    `🚨 prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
    "Impact: prd still serves the previous Agents; live again: OS at 89abcde",
  ]);
  expect(page?.replies).toEqual([]);

  await resolveDeployPages(slack.client, { app: "Agents", sha: fix, now: new Date(now), descends });
  expect(page?.text.split("\n")[0]).toBe(
    `✅ resolved: prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
  );
  expect(page?.replies.map((reply) => reply.text)).toEqual([
    `✅ resolved: every app is live again: OS at 89abcde, Agents at 89abcde ${mention}`,
  ]);
});

test("a re-run of an older commit resolves nothing", async () => {
  const slack = fakeSlack({ now });
  await pageDeployFailure(slack.client, failure("OS"));
  const before = slack.channel("#error-pulse")[0]?.text;

  await resolveDeployPages(slack.client, {
    app: "OS",
    sha: fix,
    now: new Date(now),
    descends: async () => false,
  });

  expect(slack.channel("#error-pulse")[0]?.text).toBe(before);
});

test("a deploy page reads back from Slack's history as it was rendered", () => {
  expect(
    readDeployPage(
      [
        `:rotating_light: prd deploy failed at 0123456 (fix(os): a (b) c): OS, Kit ${mention}`,
        "Impact: prd still serves the previous OS; Kit uploaded, then the deploy job failed; live again: Dash at 89abcde",
        "Do: …",
        "<https://depot.dev/w?job=j&amp;attempt=a|run>",
      ].join("\n"),
    ),
  ).toEqual({
    head: "prd deploy failed at 0123456 (fix(os): a (b) c)",
    sha: "0123456",
    failed: [
      { app: "OS", uploaded: false },
      { app: "Kit", uploaded: true },
    ],
    live: [{ app: "Dash", sha: "89abcde" }],
    runUrl: "https://depot.dev/w?job=j&amp;attempt=a",
  });
});

// ---- scheduled workflows

test("a red workflow pages, repeats edit the page, other failing jobs reply, green resolves", async () => {
  const slack = fakeSlack({ now });
  const run = (jobs: string[], sha: string) =>
    pageWorkflowFailure(slack.client, {
      workflow: "OS crash hunt",
      jobs,
      sha,
      runUrl: `https://depot.dev/${sha}`,
      now: new Date(now),
    });

  await run(["crash-hunt"], "aaaaaaa1");
  await run(["crash-hunt"], "bbbbbbb2");
  const [page] = slack.channel("#error-pulse");
  expect(slack.channel("#error-pulse")).toHaveLength(1);
  expect(page?.text).toBe(
    [
      `🚨 OS crash hunt failed: crash-hunt ${mention}`,
      "Impact: OS crash hunt is red since aaaaaaa, 2 runs",
      "Do: open the run and read the failed job's log",
      "<https://depot.dev/bbbbbbb2|run>",
    ].join("\n"),
  );
  expect(page?.replies).toEqual([]);

  await run(["plan", "crash-hunt"], "ccccccc3");
  expect(page?.replies.map((reply) => reply.text)).toEqual([
    `🚨 OS crash hunt now fails in plan, crash-hunt ${mention}`,
  ]);
  expect(page?.text).toContain("red since aaaaaaa, 3 runs");

  await resolveWorkflowPage(slack.client, {
    workflow: "OS crash hunt",
    sha: "ddddddd4",
    now: new Date(now),
  });
  expect(page?.text.split("\n")[0]).toBe(
    `✅ resolved: OS crash hunt failed: plan, crash-hunt ${mention}`,
  );
  expect(page?.replies.at(-1)?.text).toBe(
    `✅ resolved: OS crash hunt green again at ddddddd ${mention}`,
  );
  // the next red run is a new incident; another workflow's green run resolves nothing of it
  await run(["crash-hunt"], "eeeeeee5");
  await resolveWorkflowPage(slack.client, {
    workflow: "Kit firmware",
    sha: "fffffff6",
    now: new Date(now),
  });
  expect(slack.channel("#error-pulse").map((message) => message.text.split(" ")[0])).toEqual([
    "✅",
    "🚨",
  ]);
});

test("a workflow's failed jobs are those whose result is failure", () => {
  expect(failedJobs({ build: { result: "success" }, sweep: { result: "failure" } })).toEqual([
    "sweep",
  ]);
});

/** A clock that runs each wait at once, and calls `at` with the seconds passed after each. */
function testClock(at: (seconds: number) => void = () => {}): Clock & { waited: () => number } {
  let time = now;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      at((time - now) / 1000);
    },
    waited: () => (time - now) / 1000,
  };
}

/** The merge's line in #ci for `sha`, as pr-update posts it. */
function mergeLine(sha: string) {
  return `✅ PR merged: <https://github.com/iterate/iterate/pull/7|#7 A change> by mmkal (${sha.slice(0, 7)})`;
}

/** `app`'s deploy at the fixing commit. */
function deploy(app: string) {
  return { app, sha: fix, runUrl: `https://depot.dev/${app}` };
}

/** `app`'s failed deploy at the failing commit. */
function failure(app: string, uploaded = false) {
  return {
    app,
    uploaded,
    sha: failing,
    subject: "A change & more",
    runUrl: `https://depot.dev/${app}`,
    now: new Date(now),
  };
}
