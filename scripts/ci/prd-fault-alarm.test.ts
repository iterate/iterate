import type { WebClient } from "@slack/web-api";
import { expect, test, vi } from "vitest";
import { alarm, type FaultReading, renderFaultPage } from "./prd-fault-alarm.ts";
import { slackChannelIds } from "./slack.ts";

const quiet: FaultReading = {
  serverErrors: [],
  heals: [],
  errors: [],
};
const now = new Date("2026-09-23T07:30:00Z");

test("the 2026-09-23 fault window pages with hosts, healed facets and collapsed references", () => {
  // A sample of 07:00–07:30Z that day (`run --at 2026-09-23T07:30:00Z --dry-run`).
  expect(
    page({
      serverErrors: [
        ["https://garple.com/", 4],
        ["https://lispwoso.com/", 4],
        ["https://garple.com/d/ferovo.com", 3],
        ["http://lispwoso.com/", 2],
      ],
      heals: [
        ["project", 1279],
        ["repo", 536],
      ],
      errors: [
        ["ProjectDurableObject.jsrpc", 1199],
        ["internal error; reference = m6mc1rpui1cli5qkt7sqpp87", 1],
        ["internal error; reference = c1k0cg2egm9c43toh6sfipct", 1],
      ],
    }),
  ).toMatchInlineSnapshot(`
    "🚨 prd fault page: os-next-prd, 30 min to 07:30 UTC <@U067G4QRFK2>
    • 13 5xx responses: garple.com 7, lispwoso.com 6
    • 1815 platform-failure heals: project 1279, repo 536
    • 1201 errors: ProjectDurableObject.jsrpc 1199, internal error; reference = … 2
    <https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>"
  `);
});

test.each([
  ["a quiet prd", {}, false],
  ["one 5xx", { serverErrors: [["https://lispwoso.com/", 1]] }, true],
  ["9 heals", { heals: [["repo", 9]] }, false],
  ["10 heals", { heals: [["repo", 10]] }, true],
  ["one error", { errors: [["boom", 1]] }, true],
] satisfies [string, Partial<FaultReading>, boolean][])(
  "%s pages: %s",
  (_label, reading, pages) => {
    expect(page(reading) !== null).toBe(pages);
  },
);

// A run that could not read prd must fail, never pass as a quiet prd.
test.for([
  {
    name: "a failed Workers Logs query",
    token: "token",
    queries: 4,
    error: 'Workers Logs query failed: [{"code":10000,"message":"Authentication error"}]',
  },
  {
    name: "no Cloudflare credentials",
    token: "",
    queries: 0,
    error: "run under doppler --project project-worker --config prd",
  },
])("a run that cannot read prd fails: $name", async (row) => {
  await using cloudflare = workersLogs(row.token, () => ({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  }));
  const slack = fakeSlack([]);
  await expect(alarm({ now, windowEnd: now, slack: () => slack.client })).rejects.toThrow(
    row.error,
  );
  expect(cloudflare.fetch).toHaveBeenCalledTimes(row.queries);
  expect(slack).toMatchObject({ posts: [] });
});

// A page is the alarm and the run ends green; the page repeats at most hourly.
test.for([
  { name: "a quiet prd: no page", serverErrors: 0, history: [], posted: false },
  { name: "no page in the last hour: pages", serverErrors: 1, history: [], posted: true },
  {
    name: "paged half an hour ago: stays quiet",
    serverErrors: 1,
    history: [{ at: "2026-09-23T07:00:05Z", bot_id: "B1" }],
    posted: false,
  },
  {
    name: "paged over an hour ago: pages again",
    serverErrors: 1,
    history: [{ at: "2026-09-23T06:25:05Z", bot_id: "B1" }],
    posted: true,
  },
  {
    name: "a person quoting a page is not one",
    serverErrors: 1,
    history: [{ at: "2026-09-23T07:00:05Z", bot_id: undefined }],
    posted: true,
  },
])("a run that reads prd resolves: $name", async (row) => {
  await using _cloudflare = workersLogs("token", serverErrorsOnly(row.serverErrors));
  const slack = fakeSlack(
    row.history.map((message) => ({
      ts: String(Date.parse(message.at) / 1000),
      bot_id: message.bot_id,
      text: ":rotating_light: prd fault page: os-next-prd, 30 min to 07:00 UTC",
    })),
  );
  const expected = row.serverErrors
    ? page({ serverErrors: [["https://lispwoso.com/", row.serverErrors]] })
    : "os-next-prd is quiet";
  await expect(alarm({ now, windowEnd: now, slack: () => slack.client })).resolves.toBe(expected);
  expect(slack).toMatchObject({
    posts: row.posted ? [{ channel: slackChannelIds["#error-pulse"], text: expected }] : [],
  });
});

test("a dry run (no Slack client) resolves to the page it would post", async () => {
  await using _cloudflare = workersLogs("token", serverErrorsOnly(1));
  await expect(alarm({ now, windowEnd: now, slack: null })).resolves.toBe(
    page({ serverErrors: [["https://lispwoso.com/", 1]] }),
  );
});

/** The page for `reading` (quiet elsewhere) in the half hour to `now`. */
function page(reading: Partial<FaultReading>) {
  return renderFaultPage({ ...quiet, ...reading }, now);
}

/** Cloudflare credentials (none when `token` is empty) and a Workers Logs API that answers each
 *  query with `answer(the field it groups by)`. */
function workersLogs(token: string, answer: (groupBy: string) => unknown) {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", token && "account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", token);
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    const query = JSON.parse(init.body) as { parameters: { groupBys: { value: string }[] } };
    return new Response(JSON.stringify(answer(query.parameters.groupBys[0]!.value)));
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    async [Symbol.asyncDispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  };
}

/** A prd whose only signal is `count` 5xx responses from lispwoso.com. */
function serverErrorsOnly(count: number) {
  return (groupBy: string) => ({
    success: true,
    result: {
      calculations: [
        {
          aggregates:
            groupBy === "$workers.event.request.url" && count
              ? [{ groupKey: "https://lispwoso.com/", count }]
              : [],
        },
      ],
    },
  });
}

/** A WebClient stand-in: serves `messages` as the channel history (honouring `oldest`, as Slack
 *  does) and records every post. */
function fakeSlack(messages: Array<{ ts: string; bot_id: string | undefined; text: string }>) {
  const posts: unknown[] = [];
  const client = {
    conversations: {
      history: async (args: { oldest: string }) => ({
        messages: messages.filter((message) => Number(message.ts) >= Number(args.oldest)),
      }),
    },
    chat: {
      postMessage: async (args: unknown) => {
        posts.push(args);
        return { ok: true, ts: "999.0" };
      },
    },
  } as unknown as WebClient;
  return { client, posts };
}
