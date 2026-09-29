import { expect, test } from "vitest";
import { committedEvent, reduceProcessor } from "iterate/stream/test-support";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { GithubSyncProcessor } from "./processor.ts";

const origin =
  'https://x-access-token:getSecret("/secrets/github-c1", { field: "accessToken" })@github.com/acme/config.git';

test("the latest install marker names the repo; one it cannot read, or none, syncs nothing", () => {
  const processor = new GithubSyncProcessor(() => {
    throw new Error("reduce reaches no itx");
  });
  expect(reduceProcessor(processor, [])).toEqual({ repo: null });
  expect(
    reduceProcessor(processor, [
      { type: "github-sync/installed", payload: { repo: "/repos/config" } },
      { type: "github-sync/installed", payload: { version: 2 } },
    ]),
  ).toEqual({ repo: "/repos/config" });
  expect(
    reduceProcessor(processor, [
      { type: "github-sync/installed", payload: { repo: "/repos/config" } },
      { type: "github-sync/installed", payload: { repo: "/repos/site" } },
    ]),
  ).toEqual({ repo: "/repos/site" });
});

test.for([
  {
    when: "a push to origin's main pulls",
    event: pushTo("acme/config"),
    calls: ["pull /repos/config"],
    synced: { repo: "/repos/config", pull: { status: "fast-forwarded" } },
  },
  {
    when: "a commit to the repo pushes",
    event: committedTo("/repos/config"),
    calls: ["push /repos/config"],
    synced: { repo: "/repos/config", push: { status: "fast-forwarded" } },
  },
  {
    when: "a push to another repository of the installation does nothing",
    event: pushTo("acme/website"),
    calls: [],
    synced: null,
  },
  {
    when: "a push to a branch that is not main does nothing",
    event: pushTo("acme/config", "refs/heads/feature"),
    calls: [],
    synced: null,
  },
  {
    when: "a commit to another repo does nothing",
    event: committedTo("/repos/notes"),
    calls: [],
    synced: null,
  },
  {
    when: "diverged mains are not-fast-forward, and nothing moves",
    event: committedTo("/repos/config"),
    refuse: "NOT_FAST_FORWARD",
    calls: ["push /repos/config"],
    synced: { repo: "/repos/config", push: "not-fast-forward", error: "diverged" },
  },
])("$when", async ({ event, calls, synced, refuse }) => {
  const repos = fakeRepos({ origin, refuse });
  const processor = new GithubSyncProcessor(() => fakeItx(repos));
  const appended = await processEvent(processor, event, { repo: "/repos/config" });
  expect(repos).toMatchObject({ calls });
  expect(appended.map((input) => input.payload)).toEqual(synced ? [{ ...synced, trigger: 5 }] : []);
});

test("before the install marker, and on a repo with no origin, nothing is synced", async () => {
  const repos = fakeRepos({ origin: null });
  const processor = new GithubSyncProcessor(() => fakeItx(repos));
  expect(await processEvent(processor, pushTo("acme/config"), { repo: null })).toEqual([]);
  expect(
    await processEvent(processor, committedTo("/repos/config"), { repo: "/repos/config" }),
  ).toEqual([]);
  expect(repos).toMatchObject({ calls: [] });
});

/** One event through `processEvent`, its blocking work awaited: what it appended. */
async function processEvent(
  processor: GithubSyncProcessor,
  event: StreamEvent,
  state: { repo: string | null },
) {
  const appended: StreamEventInput[] = [];
  const blocking: Promise<unknown>[] = [];
  processor.processEvent({
    event,
    state,
    previousState: state,
    append: async (...inputs) => {
      appended.push(...inputs);
      return [];
    },
    blockProcessorWhile: (work) => void blocking.push(work()),
    runInBackground: () => {},
    delivery: { caughtUp: true },
  });
  await Promise.all(blocking);
  return appended;
}

function pushTo(repository: string, ref = "refs/heads/main") {
  return committedEvent(5, "events.iterate.com/github/webhook-received", {
    delivery: { name: "push" },
    body: { ref, repository: { full_name: repository } },
  });
}

function committedTo(path: string) {
  return committedEvent(5, "events.iterate.com/repo/commit-completed", { path });
}

/** A scope whose only reach is `repos`, released by nothing. */
function fakeItx(repos: ReturnType<typeof fakeRepos>) {
  return { repos, [Symbol.dispose]: () => {} } as never;
}

/** `itx.repos` as the sync calls it: `get(path)`'s origin, pull and push, each call recorded. */
function fakeRepos(input: { origin: string | null; refuse?: string }) {
  const calls: string[] = [];
  const sync = (verb: string, path: string) => {
    calls.push(`${verb} ${path}`);
    if (input.refuse) throw Object.assign(new Error("diverged"), { code: input.refuse });
    return { status: "fast-forwarded" };
  };
  return {
    calls,
    get: (path: string) => ({
      origin: async () => input.origin,
      pull: async () => sync("pull", path),
      push: async () => sync("push", path),
    }),
  };
}
