import { expect, onTestFinished, test, vi } from "vitest";
import { buildStanding, pinPkgPrNewVersion } from "./pkg-pr-new.ts";

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
  ["a URL of another package (an alias)", "@iterate-com/voice", agentsAt("main")],
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

const older = "1".repeat(40);
const newer = "2".repeat(40);
const earlier = "Mon, 28 Sep 2026 13:20:32 GMT";
const later = "Tue, 29 Sep 2026 09:28:04 GMT";

test.for([
  {
    name: "a build main published before its newest is behind: an upgrade to the newest",
    installed: older,
    answers: {
      [agentsAt("main")]: served(`iterate:iterate:${newer}`, 200, later),
      [agentsAt(older)]: served(`iterate:iterate:${older}`, 200, earlier),
    },
    standing: { kind: "behind", installed: older, newest: newer, version: agentsAt(newer) },
  },
  {
    name: "main's newest build is the newest",
    installed: newer,
    answers: {
      [agentsAt("main")]: served(`iterate:iterate:${newer}`, 200, later),
      [agentsAt(newer)]: served(`iterate:iterate:${newer}`, 200, later),
    },
    standing: { kind: "newest", installed: newer },
  },
  {
    name: "a build published after main's newest (a pull request's) is ahead, with no upgrade",
    installed: older,
    answers: {
      [agentsAt("main")]: served(`iterate:iterate:${newer}`, 200, earlier),
      [agentsAt(older)]: served(`iterate:iterate:${older}`, 200, later),
    },
    standing: { kind: "ahead", installed: older, newest: newer },
  },
  {
    name: "a build pkg.pr.new no longer serves is behind",
    installed: older,
    answers: {
      [agentsAt("main")]: served(`iterate:iterate:${newer}`, 200, later),
      [agentsAt(older)]: served(`iterate:iterate:${older}`, 404),
    },
    standing: { kind: "behind", installed: older, newest: newer, version: agentsAt(newer) },
  },
])("$name", async ({ installed, answers, standing }) => {
  const head = vi.fn(async (url: string | URL | Request) => answers[String(url)]!);
  expect(await buildStanding("@iterate-com/agents", agentsAt(installed), head)).toEqual(standing);
  expect(head.mock.calls.map(([url]) => url).sort()).toEqual(Object.keys(answers).sort());
});

test.for([
  ["an npm range", "^1.2.0"],
  ["a branch, which the loader refuses", agentsAt("main")],
  ["a fork's build", `https://pkg.pr.new/someone/fork/@iterate-com/agents@${older}`],
  ["another package's build", `https://pkg.pr.new/iterate/iterate/@iterate-com/voice@${older}`],
])("%s is the project's own, and pkg.pr.new is never asked", async ([, installed]) => {
  const head = vi.fn(async () => served(`iterate:iterate:${newer}`, 200, later));
  expect(await buildStanding("@iterate-com/agents", installed, head)).toEqual({
    kind: "own",
    installed,
  });
  expect(head).not.toHaveBeenCalled();
});

test.for([
  {
    name: "main's newest named without a publish time",
    main: served(`iterate:iterate:${newer}`),
    installed: served(`iterate:iterate:${older}`, 200, earlier),
    error: `${agentsAt("main")} answered 200 without naming the commit it serves and when it was published`,
  },
  {
    name: "main's newest not found",
    main: served("iterate:iterate:main", 404),
    installed: served(`iterate:iterate:${older}`, 200, earlier),
    error: `${agentsAt("main")} answered 404 without naming the commit it serves and when it was published`,
  },
  {
    name: "the installed build served without a publish time",
    main: served(`iterate:iterate:${newer}`, 200, later),
    installed: served(`iterate:iterate:${older}`),
    error: `${agentsAt(older)} answered 200 without saying when it was published`,
  },
])("a standing is never guessed: $name throws", async ({ main, installed, error }) => {
  await expect(
    buildStanding("@iterate-com/agents", agentsAt(older), async (url) =>
      String(url) === agentsAt("main") ? main : installed,
    ),
  ).rejects.toThrow(error);
});

test("pkg.pr.new failing main's HEAD twice fails the standing within its bound, naming the answer", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const head = vi.fn(async (url: string | URL | Request) =>
    String(url) === agentsAt("main")
      ? new Response("down", { status: 503 })
      : served(`iterate:iterate:${older}`, 200, earlier),
  );
  const standing = buildStanding("@iterate-com/agents", agentsAt(older), head);
  const settled = expect(standing).rejects.toThrow(`HEAD ${agentsAt("main")} answered HTTP 503`);
  await vi.runAllTimersAsync();
  await settled;
  expect(head.mock.calls.filter(([url]) => String(url) === agentsAt("main"))).toHaveLength(2);
});

function agentsAt(ref: string) {
  return `https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${ref}`;
}

/** pkg.pr.new's answer to a HEAD: `status`, naming `key` in `x-commit-key`, and the build's
 *  publish time in `last-modified` when given. */
function served(key: string, status = 200, lastModified?: string) {
  const headers = new Headers({ "x-commit-key": key });
  if (lastModified) headers.set("last-modified", lastModified);
  return new Response(null, { status, headers });
}
