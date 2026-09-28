import { expect, onTestFinished, test, vi } from "vitest";
import { pinPkgPrNewVersion, publishedCommit } from "./pkg-pr-new.ts";

const commit = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

test.for([
  ["a branch", "main"],
  ["a PR number", "3338"],
])("%s is pinned at the commit pkg.pr.new's HEAD names", async ([, ref]) => {
  const head = vi.fn(async () => served(`iterate:iterate:${commit}`));
  expect(await pinPkgPrNewVersion("@iterate-com/agents", agentsAt(ref), head)).toBe(
    agentsAt(commit),
  );
  expect(head).toHaveBeenCalledExactlyOnceWith(
    agentsAt(ref),
    expect.objectContaining({ method: "HEAD" }),
  );
});

test.for([
  ["a commit", "@iterate-com/agents", agentsAt(commit)],
  ["an npm range", "hono", "^4"],
  ["a dist-tag", "hono", "latest"],
  ["a URL of another package, which the loader refuses", "@iterate-com/voice", agentsAt("main")],
])("%s is written as it is, and pkg.pr.new is never asked", async ([, name, version]) => {
  const head = vi.fn(async () => served(`iterate:iterate:${commit}`));
  expect(await pinPkgPrNewVersion(name, version, head)).toBe(version);
  expect(head).not.toHaveBeenCalled();
});

test.for([
  ["a 404, which echoes the ref", served("iterate:iterate:main", 404), 404],
  ["a 200 naming a short sha", served("iterate:iterate:9f8e7d6"), 200],
  ["a 200 naming no commit", new Response(null), 200],
] as const)("%s cannot be pinned, and says so", async ([, answer, status]) => {
  await expect(
    pinPkgPrNewVersion("@iterate-com/agents", agentsAt("main"), async () => answer),
  ).rejects.toThrow(
    `${agentsAt("main")} answered ${status} without naming the commit it serves, so it cannot be pinned`,
  );
});

test("pkg.pr.new's 503 is asked once more a second later, and its next answer pins", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answers = [new Response("down", { status: 503 }), served(`iterate:iterate:${commit}`)];
  const head = vi.fn(async () => answers.shift()!);
  const pinned = pinPkgPrNewVersion("@iterate-com/agents", agentsAt("main"), head);
  await vi.runAllTimersAsync();
  expect(await pinned).toBe(agentsAt(commit));
  expect(head).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "pkg-pr-new.platform-failure-retry", kind: "disconnected", status: 503 },
  ]);
});

test("a HEAD pkg.pr.new never answers fails at its 10 s deadline, and is not sent again", async () => {
  // The fake clock cannot move AbortSignal.timeout's own timer, so the deadline is a fake
  // setTimeout that aborts as the real one does.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException("timed out", "TimeoutError")), ms);
    return deadline.signal;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const head = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve) => init!.signal!.addEventListener("abort", resolve));
    throw init!.signal!.reason;
  });
  const started = Date.now();
  await expect(pinPkgPrNewVersion("@iterate-com/agents", agentsAt("main"), head)).rejects.toThrow(
    `HEAD ${agentsAt("main")}: no answer within 10 s`,
  );
  expect(Date.now() - started).toBe(10_000);
  expect(head).toHaveBeenCalledOnce();
});

test.for([
  {
    name: "the app's own commit, when pkg.pr.new has published it",
    own: commit,
    answers: { [agentsAt(commit)]: served(`iterate:iterate:${commit}`) },
    at: commit,
  },
  {
    name: "main's commit now, when the app's own is not published",
    own: "a".repeat(40),
    answers: {
      [agentsAt("a".repeat(40))]: served(`iterate:iterate:${"a".repeat(40)}`, 404),
      [agentsAt("main")]: served(`iterate:iterate:${commit}`),
    },
    at: commit,
  },
  {
    name: "main's commit now, for an app built from no commit",
    own: "",
    answers: { [agentsAt("main")]: served(`iterate:iterate:${commit}`) },
    at: commit,
  },
])("an app installs at one commit: $name", async ({ own, answers, at }) => {
  const head = vi.fn(async (url: string | URL | Request) => answers[String(url)]!);
  expect(await publishedCommit("@iterate-com/agents", own, head)).toBe(at);
  expect(head.mock.calls.map(([url]) => url)).toEqual(Object.keys(answers));
});

function agentsAt(ref: string) {
  return `https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${ref}`;
}

/** pkg.pr.new's answer to a HEAD: `status`, naming `key` in `x-commit-key`. */
function served(key: string, status = 200) {
  return new Response(null, { status, headers: { "x-commit-key": key } });
}
