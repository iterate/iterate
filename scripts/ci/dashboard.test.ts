// #error-pulse's daily dashboard over a fake Slack: today's message, its rows, and the pages from
// before it. Pages in its thread are ./slack.test.ts's.
import { expect, test } from "vitest";
import { renderDashboard, setRow, todaysDashboard } from "./dashboard.ts";
import { fakeSlack } from "./fake-slack.ts";
import { findOpenPages, keepPage, slackChannelIds } from "./slack.ts";

test("the day's first poster posts its dashboard with yesterday's rows; later posters edit the same message", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-09-30T23:50:00Z") });
  await setRow(slack.client, row("2026-09-30T23:50:00Z", "main e2e", "red", "red at `916a48f20`"));
  await setRow(slack.client, row("2026-09-30T23:55:00Z", "prd hosts", "green", "all answer"));
  slack.clock.now = Date.parse("2026-10-01T00:05:00Z");
  await setRow(slack.client, row("2026-10-01T00:05:00Z", "DO cost", "green", "$4.94/day"));
  await setRow(slack.client, row("2026-10-01T15:02:00Z", "main e2e", "green", "green again"));
  expect(slack.channel("#error-pulse").map((message) => message.text)).toEqual([
    [
      "📟 error-pulse · Wed 30 Sep · 23:55 UTC",
      "🟢 prd hosts: all answer",
      "🔴 main e2e: red at `916a48f20`",
    ].join("\n"),
    [
      "📟 error-pulse · Thu 1 Oct · 15:02 UTC",
      "🟢 prd hosts: all answer",
      "🟢 main e2e: green again",
      "🟢 DO cost: $4.94/day",
    ].join("\n"),
  ]);
});

test("a row that already says the same is not edited", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T09:00:00Z") });
  await setRow(slack.client, row("2026-10-01T09:00:00Z", "latency", "green", "under its lines"));
  await setRow(slack.client, row("2026-10-01T10:00:00Z", "latency", "green", "under its lines"));
  expect(slack.calls.filter((call) => call.method.startsWith("chat."))).toMatchObject([
    { method: "chat.postMessage" },
    { method: "chat.update" },
  ]);
});

test("a row another poster's edit dropped in the same second is written again", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T09:00:00Z") });
  await setRow(slack.client, row("2026-10-01T09:00:00Z", "prd hosts", "green", "all answer"));
  // another poster read the dashboard before this edit and writes its own row over it once
  const [dashboard] = slack.channel("#error-pulse");
  const stale = structuredClone(dashboard!.metadata);
  const update = slack.client.chat.update.bind(slack.client.chat);
  let raced = false;
  slack.client.chat.update = (async (args: Parameters<typeof update>[0]) => {
    const answer = await update(args);
    if (!raced) {
      raced = true;
      dashboard!.metadata = stale;
    }
    return answer;
  }) as typeof update; // the fake's own method, wrapped
  await setRow(slack.client, row("2026-10-01T09:01:00Z", "main e2e", "red", "red at `916a48f20`"));
  expect(dashboard!.text.split("\n").slice(1)).toEqual([
    "🟢 prd hosts: all answer",
    "🔴 main e2e: red at `916a48f20`",
  ]);
});

test("two posters setting the same row at once leave the newer write standing, and neither throws", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T09:00:00Z") });
  await setRow(
    slack.client,
    row("2026-10-01T09:00:00Z", "prd deploys", "green", "OS live at `aaa`"),
  );
  // a second deploy finishing in the same second sets the row right after this edit lands
  const [dashboard] = slack.channel("#error-pulse");
  const update = slack.client.chat.update.bind(slack.client.chat);
  let raced = false;
  slack.client.chat.update = (async (args: Parameters<typeof update>[0]) => {
    const answer = await update(args);
    if (!raced) {
      raced = true;
      await setRow(
        slack.client,
        row("2026-10-01T09:01:00Z", "prd deploys", "green", "Agents live at `bbb`"),
      );
    }
    return answer;
  }) as typeof update; // the fake's own method, wrapped
  await setRow(
    slack.client,
    row("2026-10-01T09:01:00Z", "prd deploys", "green", "Dash live at `bbb`"),
  );
  expect(dashboard!.text.split("\n").slice(1)).toEqual(["🟢 prd deploys: Agents live at `bbb`"]);
});

test("two posters posting today's dashboard at once keep the older one", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T00:01:00Z") });
  const channel = slackChannelIds["#error-pulse"];
  // another poster, which also found no dashboard, posts its own just before this one does
  const post = slack.client.chat.postMessage.bind(slack.client.chat);
  let raced = false;
  slack.client.chat.postMessage = (async (args: Parameters<typeof post>[0]) => {
    if (!raced) {
      raced = true;
      await post({ ...args, text: "📟 the other poster's" });
    }
    return await post(args);
  }) as typeof post; // the fake's own method, wrapped
  const kept = await todaysDashboard(slack.client, { channel, now: new Date(slack.clock.now) });
  expect({
    kept: kept.ts,
    channel: slack.channel("#error-pulse").map((message) => [message.ts, message.text]),
  }).toEqual({
    kept: slack.channel("#error-pulse")[0]!.ts,
    channel: [[kept.ts, "📟 the other poster's"]],
  });
});

test("a row is one line, cut short, in the signals' order with any other signal after them", () => {
  expect(
    renderDashboard(
      {
        day: "2026-10-01",
        rows: [
          { signal: "a new signal", state: "grey", text: "not judged", at: "2026-10-01T00:00:00Z" },
          {
            signal: "PR time to green",
            state: "amber",
            text: "p50 169 s",
            at: "2026-10-01T00:00:00Z",
          },
          { signal: "prd faults", state: "red", text: "x".repeat(200), at: "2026-10-01T00:00:00Z" },
        ],
      },
      new Date("2026-10-01T15:02:00Z"),
    ).split("\n"),
  ).toEqual([
    "📟 error-pulse · Thu 1 Oct · 15:02 UTC",
    `🔴 prd faults: ${"x".repeat(110)}…`,
    "🟡 PR time to green: p50 169 s",
    "⚪ a new signal: not judged",
  ]);
});

test("a page kept in the dashboard's thread is found open by the next run, and resolved by an edit", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T04:40:00Z") });
  const input = {
    marker: "preview sweep: stuck",
    sinceHours: 720,
    why: "deleted",
    broadcast: false,
  };
  await keepPage(slack.client, {
    ...input,
    now: new Date(slack.clock.now),
    render: async () => "🚨 preview sweep: stuck n=1",
  });
  slack.clock.now = Date.parse("2026-10-02T04:40:00Z");
  await keepPage(slack.client, {
    ...input,
    now: new Date(slack.clock.now),
    render: async (open) => open && "🚨 preview sweep: stuck n=2",
  });
  const [yesterday] = slack.channel("#error-pulse");
  expect(yesterday!.replies.map((reply) => reply.text)).toEqual(["🚨 preview sweep: stuck n=2"]);
  slack.clock.now = Date.parse("2026-10-03T04:40:00Z");
  await keepPage(slack.client, {
    ...input,
    now: new Date(slack.clock.now),
    render: async () => undefined,
  });
  expect({
    page: yesterday!.replies[0]!.text,
    open: await findOpenPages(slack.client, {
      ...input,
      channel: slackChannelIds["#error-pulse"],
      now: new Date(slack.clock.now),
    }),
    dashboards: slack.channel("#error-pulse").length,
  }).toEqual({
    page: "✅ resolved: preview sweep: stuck n=2\n✅ deleted",
    open: [],
    dashboards: 1,
  });
});

/** setRow's input for `signal` at `iso` in #error-pulse. */
function row(iso: string, signal: string, state: "red" | "amber" | "green" | "grey", text: string) {
  return { channel: slackChannelIds["#error-pulse"], now: new Date(iso), signal, state, text };
}
