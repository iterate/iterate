// The posts scripts/ci/notify.ts makes: which channel each goes to, what it says, how a page is
// edited and resolved, and the dashboard row each sets. A page to #error-pulse is a reply in today's
// dashboard thread and mentions Jonas and Misha; a routine post to #ci mentions nobody.
import { expect, test, vi } from "vitest";
import { DASHBOARD_EVENT, PAGE_CLOSED_EVENT } from "./dashboard.ts";
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
import { slackChannelIds } from "./slack.ts";

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

test("the merge's line behind 358 older lines in the 6 h is found on the first read", async () => {
  // 358 lines in 6 h, #ci's count on 2026-09-28: more than one page of history
  const slack = fakeSlack({ now });
  for (let index = 0; index < 358; index++)
    slack.seed("#ci", "🟢 PR opened", { ageHours: 5.9 - index / 100 });
  slack.seed("#ci", mergeLine(fix));
  const clock = testClock();

  await announceDeploy(slack.client, { ...deploy("OS"), pushed: true, clock });

  const merge = slack.channel("#ci").at(-1);
  expect(merge?.replies.map((reply) => reply.text)).toEqual([
    "🚀 OS live · <https://depot.dev/OS|run>",
  ]);
  expect(clock.waited()).toBe(0);
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

test("a test run replies 🧪 in the merge's thread, and a real deploy after it is no re-run", async () => {
  const slack = fakeSlack({ now });
  slack.seed("#ci", mergeLine(fix));
  const clock = testClock();

  await announceDeploy(slack.client, { ...deploy("OS"), pushed: true, clock, testRun: true });
  await announceDeploy(slack.client, { ...deploy("OS"), pushed: true, clock });

  expect(slack.channel("#ci")[0]?.replies.map((reply) => reply.text)).toEqual([
    "🧪 TEST RUN — 🚀 OS live · <https://depot.dev/OS|run>",
    "🚀 OS live · <https://depot.dev/OS|run>",
  ]);
  expect(clock.waited()).toBe(0);
});

test("a test run with no merge's line reads once and posts 🧪 top-level, logging nothing", async () => {
  const slack = fakeSlack({ now });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const clock = testClock();

  await announceDeploy(slack.client, { ...deploy("OS"), pushed: true, clock, testRun: true });

  expect(clock.waited()).toBe(0);
  expect(slack.channel("#ci").map((message) => message.text)).toEqual([
    "🧪 TEST RUN — 🚀 OS live at 89abcde · <https://depot.dev/OS|run>",
  ]);
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
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

test("a failed deploy pages in today's dashboard thread, sent to the channel too, and turns the prd deploys row red", async () => {
  const slack = fakeSlack({ now });

  await pageDeployFailure(slack.client, failure("OS"));

  expect({ errorPulse: shape(slack), rows: rows(slack) }).toEqual({
    errorPulse: [
      "📟 error-pulse · Mon 28 Sep · 12:00 UTC",
      `  ↳ 🚨 prd deploy failed at 0123456 (A change &amp; more): OS ${mention} (also sent to the channel)`,
    ],
    rows: ["🔴 prd deploys: OS failed at 0123456"],
  });
});

test("two apps failing on one commit are one page, the second edited into it", async () => {
  const slack = fakeSlack({ now });

  await pageDeployFailure(slack.client, failure("OS"));
  await pageDeployFailure(slack.client, failure("Agents", true));

  expect({
    channel: slack.channel("#error-pulse").length,
    // "failed too" is an edit: nobody is pinged twice for one commit
    pages: slack.channel("#error-pulse")[0]!.replies.map((reply) => reply.text),
    rows: rows(slack),
  }).toEqual({
    channel: 1,
    pages: [
      [
        `🚨 prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
        "Impact: prd still serves the previous OS; Agents uploaded, then the deploy job failed",
        "Do: open the run: re-run it if Cloudflare or the network failed, else fix forward or revert 0123456",
        "<https://depot.dev/OS|run>",
      ].join("\n"),
    ],
    rows: ["🔴 prd deploys: OS, Agents failed at 0123456"],
  });
});

test("two apps' pages posted for one commit at once: the younger deletes itself into the older", async () => {
  const slack = fakeSlack({ now });
  // Agents' whole deploy-failure step runs between OS's read of the open pages and its page's post
  const post = slack.client.chat.postMessage.bind(slack.client.chat);
  let raced = false;
  slack.client.chat.postMessage = (async (args: Parameters<typeof post>[0]) => {
    if (!raced && "thread_ts" in args && args.thread_ts) {
      raced = true;
      await pageDeployFailure(slack.client, failure("Agents"));
    }
    return await post(args);
  }) as typeof post; // the fake's own method, wrapped

  await pageDeployFailure(slack.client, failure("OS"));

  expect({
    errorPulse: shape(slack),
    rows: rows(slack),
    deletes: slack.calls.filter((call) => call.method === "chat.delete").length,
  }).toEqual({
    errorPulse: [
      "📟 error-pulse · Mon 28 Sep · 12:00 UTC",
      `  ↳ 🚨 prd deploy failed at 0123456 (A change &amp; more): Agents, OS ${mention} (also sent to the channel)`,
    ],
    rows: ["🔴 prd deploys: Agents, OS failed at 0123456"],
    deletes: 1,
  });
});

test("each app live again is an edit; the page resolves when the last app is back, and the row turns green", async () => {
  const slack = fakeSlack({ now });
  await pageDeployFailure(slack.client, failure("OS"));
  await pageDeployFailure(slack.client, failure("Agents"));
  const descends = async () => true;
  const [page] = slack.channel("#error-pulse")[0]!.replies;

  await resolveDeployPages(slack.client, { app: "OS", sha: fix, now: new Date(now), descends });
  expect({ page: page!.text.split("\n").slice(0, 2), rows: rows(slack) }).toEqual({
    page: [
      `🚨 prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
      "Impact: prd still serves the previous Agents; live again: OS at 89abcde",
    ],
    rows: ["🔴 prd deploys: Agents failed at 0123456"],
  });

  await resolveDeployPages(slack.client, { app: "Agents", sha: fix, now: new Date(now), descends });
  expect({
    page: page!.text.split("\n").slice(0, 2),
    rows: rows(slack),
    // the resolution is the edit alone: no reply, so it notifies nobody
    replies: slack.channel("#error-pulse")[0]!.replies.length,
  }).toEqual({
    page: [
      `✅ resolved: prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
      "✅ every app is live again: OS at 89abcde, Agents at 89abcde",
    ],
    rows: ["🟢 prd deploys: Agents live at 89abcde"],
    replies: 1,
  });
});

test("a re-run of an older commit resolves nothing, and the row stays red", async () => {
  const slack = fakeSlack({ now });
  await pageDeployFailure(slack.client, failure("OS"));
  const [page] = slack.channel("#error-pulse")[0]!.replies;
  const before = page!.text;

  await resolveDeployPages(slack.client, {
    app: "OS",
    sha: fix,
    now: new Date(now),
    descends: async () => false,
  });

  expect({ page: page!.text, rows: rows(slack) }).toEqual({
    page: before,
    rows: ["🔴 prd deploys: OS failed at 0123456"],
  });
});

test.for(["edit_window_closed", "cant_update_message"])(
  "a deploy page Slack answers %s to moves once and is resolved once, however often it is read",
  async (updateError) => {
    const slack = fakeSlack({ now });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await pageDeployFailure(slack.client, failure("OS"));
    const [stuck] = slack.channel("#error-pulse")[0]!.replies;
    stuck!.updateError = updateError;
    await pageDeployFailure(slack.client, failure("Agents"));
    for (const app of ["OS", "OS", "Agents", "Agents", "Agents"])
      await resolveDeployPages(slack.client, {
        app,
        sha: fix,
        now: new Date(now),
        descends: async () => true,
      });

    const [, moved] = slack.channel("#error-pulse")[0]!.replies;
    expect({
      errorPulse: shape(slack),
      resolved: moved!.text.split("\n")[1],
      rows: rows(slack),
    }).toEqual({
      errorPulse: [
        "📟 error-pulse · Mon 28 Sep · 12:00 UTC",
        `  ↳ 🚨 prd deploy failed at 0123456 (A change &amp; more): OS ${mention} (also sent to the channel)`,
        `  ↳ ✅ resolved: prd deploy failed at 0123456 (A change &amp; more): OS, Agents ${mention}`,
        `  ↳ ✅ resolved: this page moved to a new message, which Slack lets this bot edit (closes ${stuck!.ts})`,
      ],
      resolved: "✅ every app is live again: OS at 89abcde, Agents at 89abcde",
      rows: ["🟢 prd deploys: Agents live at 89abcde"],
    });
  },
);

test("a page that cannot be read leaves the others to resolve, then fails the step", async () => {
  const slack = fakeSlack({ now });
  await pageDeployFailure(slack.client, failure("OS"));
  // a top-level page from before the dashboard
  slack.seed("#error-pulse", `🚨 prd deploy failed at ??? (x): OS ${mention}`, { ageHours: 0.001 });

  await expect(
    resolveDeployPages(slack.client, {
      app: "OS",
      sha: fix,
      now: new Date(now),
      descends: async () => true,
    }),
  ).rejects.toThrow("1 update(s) of the deploy's pages and row failed");

  expect({ errorPulse: shape(slack), rows: rows(slack) }).toEqual({
    errorPulse: [
      `🚨 prd deploy failed at ??? (x): OS ${mention}`,
      "📟 error-pulse · Mon 28 Sep · 12:00 UTC",
      `  ↳ ✅ resolved: prd deploy failed at 0123456 (A change &amp; more): OS ${mention} (also sent to the channel)`,
    ],
    // the page this run could not update is still open as far as anyone knows
    rows: ["🔴 prd deploys: 1 page(s) not read"],
  });
});

test("a failure on a later commit keeps the earlier commit's apps still down on the row", async () => {
  const slack = fakeSlack({ now });
  await pageDeployFailure(slack.client, failure("OS"));
  await pageDeployFailure(slack.client, { ...failure("Agents"), sha: "fedcba9876543210" });
  expect(rows(slack)).toEqual(["🔴 prd deploys: Agents failed at fedcba9; OS failed at 0123456"]);
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

test("a red workflow pages in today's dashboard thread, not sent to the channel; repeats edit the page, other failing jobs reply, green resolves; its row follows", async () => {
  const slack = fakeSlack({ now });
  const run = (jobs: string[], sha: string) =>
    pageWorkflowFailure(slack.client, {
      workflow: "OS crash hunt",
      jobs,
      sha,
      runUrl: `https://depot.dev/${sha}`,
      now: new Date(now),
      testRun: false,
    });
  const green = (workflow: string, sha: string) =>
    resolveWorkflowPage(slack.client, { workflow, sha, now: new Date(now), testRun: false });

  await run(["crash-hunt"], "aaaaaaa1");
  await run(["crash-hunt"], "bbbbbbb2");
  const [page] = slack.channel("#error-pulse")[0]!.replies;
  expect({ errorPulse: shape(slack), page: page!.text, rows: rows(slack) }).toEqual({
    errorPulse: [
      "📟 error-pulse · Mon 28 Sep · 12:00 UTC",
      `  ↳ 🚨 OS crash hunt failed: crash-hunt ${mention}`,
    ],
    page: [
      `🚨 OS crash hunt failed: crash-hunt ${mention}`,
      "Impact: OS crash hunt is red since aaaaaaa, 2 runs",
      "Do: open the run and read the failed job's log",
      "<https://depot.dev/bbbbbbb2|run>",
    ].join("\n"),
    rows: ["🔴 OS crash hunt: failed in crash-hunt"],
  });

  await run(["plan", "crash-hunt"], "ccccccc3");
  await green("OS crash hunt", "ddddddd4");
  expect({
    errorPulse: shape(slack),
    resolved: page!.text.split("\n")[1],
    rows: rows(slack),
  }).toEqual({
    errorPulse: [
      "📟 error-pulse · Mon 28 Sep · 12:00 UTC",
      `  ↳ ✅ resolved: OS crash hunt failed: plan, crash-hunt ${mention}`,
      // the escalation is the one reply besides the page: the resolution only edits the page
      `  ↳ 🚨 OS crash hunt now fails in plan, crash-hunt ${mention}`,
    ],
    resolved: "✅ OS crash hunt green again at ddddddd",
    rows: ["🟢 OS crash hunt: green at ddddddd"],
  });

  // the next red run is a new incident; another workflow's green run resolves nothing of it
  await run(["crash-hunt"], "eeeeeee5");
  await green("Kit Firmware", "fffffff6");
  expect({ errorPulse: shape(slack).slice(3), rows: rows(slack) }).toEqual({
    errorPulse: [`  ↳ 🚨 OS crash hunt failed: crash-hunt ${mention}`],
    rows: ["🟢 Kit Firmware: green at fffffff", "🔴 OS crash hunt: failed in crash-hunt"],
  });
});

test("a test run posts its page or resolution to #ci alone, marked 🧪: #error-pulse is neither read nor written", async () => {
  const slack = fakeSlack({ now });

  await pageDeployFailure(slack.client, { ...failure("OS"), testRun: true });
  await pageWorkflowFailure(slack.client, {
    workflow: "OS crash hunt",
    jobs: ["crash-hunt"],
    sha: "aaaaaaa1",
    runUrl: "https://depot.dev/aaaaaaa1",
    now: new Date(now),
    testRun: true,
  });
  await resolveWorkflowPage(slack.client, {
    workflow: "OS crash hunt",
    sha: "bbbbbbb2",
    now: new Date(now),
    testRun: true,
  });

  expect({
    errorPulse: slack.calls.filter((call) => call.channel === slackChannelIds["#error-pulse"]),
    ci: slack.channel("#ci").map((message) => message.text.split("\n")[0]),
  }).toEqual({
    errorPulse: [],
    ci: [
      "🧪 TEST RUN — 🚨 prd deploy failed at 0123456 (A change &amp; more): OS",
      "🧪 TEST RUN — 🚨 OS crash hunt failed: crash-hunt",
      "🧪 TEST RUN — ✅ resolved: OS crash hunt green again at bbbbbbb",
    ],
  });
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
    testRun: false,
  };
}

/** #error-pulse as a reader sees it: each top-level message's first line, each reply's first line
 *  indented under it, marked when it was sent to the channel too, and a reply that closes a page by
 *  its metadata naming the page's ts. */
function shape(slack: ReturnType<typeof fakeSlack>) {
  return slack
    .channel("#error-pulse")
    .flatMap((message) => [
      message.text.split("\n")[0],
      ...message.replies.map((reply) =>
        [
          `  ↳ ${reply.text.split("\n")[0]}`,
          reply.reply_broadcast ? " (also sent to the channel)" : "",
          reply.metadata?.event_type === PAGE_CLOSED_EVENT
            ? ` (closes ${String(reply.metadata.event_payload.ts)})`
            : "",
        ].join(""),
      ),
    ]);
}

/** The newest dashboard's rows, as its text shows them. */
function rows(slack: ReturnType<typeof fakeSlack>) {
  const dashboards = slack
    .channel("#error-pulse")
    .filter((message) => message.metadata?.event_type === DASHBOARD_EVENT);
  return dashboards.at(-1)!.text.split("\n").slice(1);
}
