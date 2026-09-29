import { Octokit } from "@octokit/rest";
import { expect, onTestFinished, test, vi } from "vitest";

import { retryGithubPlatformFailures } from "./github.ts";
import { replaceMarkedSection } from "./markdown-annotator.ts";
import { githubPullRequestBody, writePullRequestBody } from "./pull-request-body.ts";

test.for<{
  name: string;
  body: string;
  saves: Save[];
  expected: { history: { editor: string; body: string }[]; warned: object[] };
}>([
  {
    name: "a body without the section gets it in one write",
    body: "Intro.",
    saves: [],
    expected: {
      history: [
        { editor: "mmkal", body: "Intro." },
        { editor: "depot-code-access", body: withLocReport("Intro.") },
      ],
      warned: [],
    },
  },
  {
    name: "a body that already carries the section is not written",
    body: withLocReport("Intro."),
    saves: [],
    expected: { history: [], warned: [] },
  },
  {
    name: "an edit saved between our read and our write is kept: the section is spliced onto it",
    body: "Intro.",
    saves: [{ landing: "before PATCH 1", editor: "mmkal", body: "Intro, edited." }],
    expected: {
      history: [
        { editor: "mmkal", body: "Intro." },
        { editor: "mmkal", body: "Intro, edited." },
        // our first PATCH was spliced onto "Intro.", and replaced the edit
        { editor: "depot-code-access", body: withLocReport("Intro.") },
        { editor: "depot-code-access", body: withLocReport("Intro, edited.") },
      ],
      warned: [{ event: "pull-request-body.edit-kept", editor: "mmkal", pullRequest: 3394 }],
    },
  },
  {
    name: "an edit saved over our write is kept, and the section spliced back onto it",
    body: "Intro.",
    saves: [{ landing: "after PATCH 1", editor: "mmkal", body: "Intro, edited." }],
    expected: {
      history: [
        { editor: "mmkal", body: "Intro." },
        { editor: "depot-code-access", body: withLocReport("Intro.") },
        { editor: "mmkal", body: "Intro, edited." },
        { editor: "depot-code-access", body: withLocReport("Intro, edited.") },
      ],
      warned: [{ event: "pull-request-body.edit-kept", editor: "mmkal" }],
    },
  },
  {
    name: "an edit saved over our write that kept the section is left as it is",
    body: "Intro.",
    saves: [{ landing: "after PATCH 1", editor: "mmkal", body: withLocReport("Intro, edited.") }],
    expected: {
      history: [
        { editor: "mmkal", body: "Intro." },
        { editor: "depot-code-access", body: withLocReport("Intro.") },
        { editor: "mmkal", body: withLocReport("Intro, edited.") },
      ],
      warned: [],
    },
  },
  {
    // both CI writers edit as depot-code-access: a write is ours by its body, not its editor
    name: "another CI writer's section saved between our read and our write stays beside ours",
    body: "Intro.",
    saves: [
      { landing: "before PATCH 1", editor: "depot-code-access", body: withPreview("Intro.") },
    ],
    expected: {
      history: [
        { editor: "mmkal", body: "Intro." },
        { editor: "depot-code-access", body: withPreview("Intro.") },
        { editor: "depot-code-access", body: withLocReport("Intro.") },
        { editor: "depot-code-access", body: withLocReport(withPreview("Intro.")) },
      ],
      warned: [{ event: "pull-request-body.edit-kept", editor: "depot-code-access" }],
    },
  },
  {
    // the other writer read our PATCH, not the edit it replaced; splicing onto the edit would
    // drop that writer's section, so the edit is logged and left in the PR's edit history
    name: "an edit our write replaced, then built over by a faster writer, is logged as overwritten",
    body: "Intro.",
    saves: [
      { landing: "before PATCH 1", editor: "mmkal", body: "Intro, edited." },
      {
        landing: "after PATCH 1",
        editor: "depot-code-access",
        body: withPreview(withLocReport("Intro.")),
      },
    ],
    expected: {
      history: [
        { editor: "mmkal", body: "Intro." },
        { editor: "mmkal", body: "Intro, edited." },
        { editor: "depot-code-access", body: withLocReport("Intro.") },
        { editor: "depot-code-access", body: withPreview(withLocReport("Intro.")) },
      ],
      warned: [{ event: "pull-request-body.edit-overwritten", editor: "mmkal" }],
    },
  },
])("$name", async ({ body, saves, expected }) => {
  const github = fakeGitHub({ body, saves });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await writePullRequestBody(github.pullRequest, "the LOC report", withLocReport);

  expect({
    history: github.history(),
    warned: warn.mock.calls.map(([line]) => JSON.parse(line)),
  }).toMatchObject(expected);
  // the body is the newest version, and it carries the section
  expect(withLocReport(github.body())).toBe(github.body());
});

test("gives up after three PATCHes when every one of them replaces a newer edit", async () => {
  const github = fakeGitHub({
    body: "Intro.",
    saves: [1, 2, 3].map((patch) => ({
      landing: `before PATCH ${patch}` as const,
      editor: "mmkal",
      body: `Intro, edit ${patch}.`,
    })),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await expect(
    writePullRequestBody(github.pullRequest, "the LOC report", withLocReport),
  ).rejects.toThrow(
    "could not write the LOC report into PR #3394's body in 3 rounds: its newest version not ours is mmkal's of 2026-09-28T22:27:35Z",
  );
  expect(github.requests()).toEqual([
    "query",
    "PATCH",
    "query",
    "PATCH",
    "query",
    "PATCH",
    "query",
  ]);
  // the last edit is in the PR's edit history, which the error names
  expect(github.history().at(-2)).toMatchObject({ editor: "mmkal", body: "Intro, edit 3." });
});

test.for<{ name: string; landed: boolean; requests: string[] }>([
  {
    name: "a PATCH that failed is not sent again from the old read: the next round reads anew 5 s later",
    landed: false,
    requests: ["query", "PATCH", "query", "PATCH", "query"],
  },
  {
    name: "a PATCH that failed after GitHub saved it is found by the next read, and not sent again",
    landed: true,
    requests: ["query", "PATCH", "query"],
  },
])("$name", async ({ landed, requests }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const github = fakeGitHub({ body: "Intro.", saves: [], failedPatch: { patch: 1, landed } });

  const written = writePullRequestBody(github.pullRequest, "the LOC report", withLocReport);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(github.requests()).toEqual(["query", "PATCH"]);
  await vi.advanceTimersByTimeAsync(1);
  await written;

  expect(github.requests()).toEqual(requests);
  expect(github.body()).toBe(withLocReport("Intro."));
});

/** Another editor's version, landing just before or just after one of our PATCHes. */
type Save = { landing: `${"before" | "after"} PATCH ${number}`; editor: string; body: string };

/**
 * GitHub holding iterate/iterate#3394, opened by mmkal with `body`, served to a real Octokit
 * (scripts/ci/github.ts's retries included) through its `fetch`. The GraphQL query answers as GitHub
 * does: the body, and the edit history newest first, which starts at the first edit with the
 * version the PR was opened with, an empty one as a null `diff`. Each REST PATCH saves a version
 * edited by `depot-code-access`, the CI token's login, with `saves` landing around it, one second
 * apart. `failedPatch` answers 502, having saved the body first when `landed`.
 */
function fakeGitHub(input: {
  body: string;
  saves: Save[];
  failedPatch?: { patch: number; landed: boolean };
}) {
  let body = input.body;
  const history: { body: string; editor: string; editedAt: string }[] = [];
  const requests: string[] = [];
  let seconds = 30;
  const now = () => `2026-09-28T22:27:${seconds}Z`;
  const opened = now();
  const save = (editor: string, next: string) => {
    if (!history.length) history.push({ body, editor: "mmkal", editedAt: opened });
    seconds++;
    body = next;
    history.push({ body, editor, editedAt: now() });
  };
  const savesLanding = (landing: Save["landing"]) =>
    input.saves
      .filter((saved) => saved.landing === landing)
      .forEach((saved) => save(saved.editor, saved.body));

  const fetch = async (url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (url === "https://api.github.com/graphql") {
      requests.push("query");
      expect(request).toMatchObject({
        variables: { owner: "iterate", repo: "iterate", number: 3394 },
      });
      const newest = history.at(-1);
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              body,
              createdAt: opened,
              lastEditedAt: newest?.editedAt || null,
              author: { login: "mmkal" },
              editor: newest ? { login: newest.editor } : null,
              userContentEdits: {
                nodes: history
                  .toReversed()
                  .slice(0, 20)
                  .map((version) => ({
                    diff: version.body || null,
                    editedAt: version.editedAt,
                    deletedAt: null,
                    editor: { login: version.editor },
                  })),
              },
            },
          },
        },
      });
    }
    expect(`${init.method} ${url}`).toBe(
      "PATCH https://api.github.com/repos/iterate/iterate/pulls/3394",
    );
    requests.push("PATCH");
    const patch = requests.filter((sent) => sent === "PATCH").length;
    savesLanding(`before PATCH ${patch}`);
    if (input.failedPatch?.patch === patch) {
      if (input.failedPatch.landed) save("depot-code-access", request.body);
      return json(502, { message: "Bad gateway" });
    }
    save("depot-code-access", request.body);
    savesLanding(`after PATCH ${patch}`);
    return json(200, { number: 3394, body });
  };

  const octokit = retryGithubPlatformFailures(new Octokit({ auth: "token", request: { fetch } }));
  return {
    pullRequest: githubPullRequestBody(octokit, { owner: "iterate", repo: "iterate" }, 3394),
    body: () => body,
    history: () => history.map((version) => ({ editor: version.editor, body: version.body })),
    requests: () => requests,
  };
}

function withLocReport(body: string) {
  return replaceMarkedSection(body, "loc-report", "| Total | +12 | -3 |");
}

function withPreview(body: string) {
  return replaceMarkedSection(body, "os-preview", "### Preview `pr3394-a1b2c3d`");
}

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
