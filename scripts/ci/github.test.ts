import { Octokit } from "@octokit/rest";
import { expect, onTestFinished, test, vi } from "vitest";

import { retryGithubPlatformFailures } from "./github.ts";

const repo = { owner: "iterate", repo: "iterate" };

test("asks a GET again after GitHub's 500 and returns the answer (the PR iterate/iterate#2899 LOC report)", async () => {
  const fixture = githubAnswering(unexpectedError(), json(200, { number: 2899, body: "before" }));

  const { data } = await fixture.github.rest.pulls.get({ ...repo, pull_number: 2899 });

  expect(data).toMatchObject({ number: 2899, body: "before" });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.warn).toHaveBeenCalledOnce();
  expect(fixture.warn).toHaveBeenCalledWith({
    event: "github.platform-failure-retry",
    kind: "disconnected",
    route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    status: 500,
    requestId: "BC32:2F0597:157166:45E4D9:6AB4315E",
    message: "Unexpected error\n",
    attempt: 1,
    retryInMs: 2_000,
  });
});

test("asks a PATCH again after the connection drops", async () => {
  const fixture = githubAnswering(
    new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    json(200, { number: 2899 }),
  );

  await fixture.github.rest.issues.update({ ...repo, issue_number: 2899, body: "after" });

  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.warn).toHaveBeenCalledWith(
    expect.objectContaining({ status: "network", message: "read ECONNRESET" }),
  );
});

test("throws GitHub's last failure once every wait is spent", async () => {
  const fixture = githubAnswering(
    json(502, { message: "Bad gateway" }),
    json(503, { message: "Unavailable" }),
    json(500, { message: "Server Error" }),
    json(504, { message: "Gateway timeout" }),
  );

  await expect(fixture.github.rest.pulls.get({ ...repo, pull_number: 2899 })).rejects.toMatchObject(
    {
      name: "HttpError",
      status: 504,
    },
  );
  expect(fixture.fetch).toHaveBeenCalledTimes(4);
  // three repeats on CI_HTTP's waits, then the one give-up
  expect(fixture.warn.mock.calls.map(([entry]) => entry)).toMatchObject([
    { event: "github.platform-failure-retry", status: 502, retryInMs: 2_000 },
    { event: "github.platform-failure-retry", status: 503, retryInMs: 5_000 },
    { event: "github.platform-failure-retry", status: 500, retryInMs: 10_000 },
    { event: "github.platform-failure-gave-up", status: 504, attempts: 4 },
  ]);
});

test("never asks a POST again: a 5xx may have landed, and a repeat would create a second one", async () => {
  const fixture = githubAnswering(unexpectedError());

  await expect(
    fixture.github.rest.issues.createComment({ ...repo, issue_number: 2899, body: "once" }),
  ).rejects.toMatchObject({ status: 500 });
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(fixture.warn).not.toHaveBeenCalled();
});

test("asks a commit status again after GitHub's 503: the latest status per context is what shows", async () => {
  const fixture = githubAnswering(
    json(503, { message: "No server is currently available to service your request." }),
    json(201, { state: "success", context: "CI trace" }),
  );

  const { data } = await fixture.github.rest.repos.createCommitStatus({
    ...repo,
    sha: "3d07bb2cd50ffc58baed40e590440ff6dd014fb9",
    state: "success",
    context: "CI trace",
  });

  expect(data).toMatchObject({ state: "success", context: "CI trace" });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      route: "POST /repos/{owner}/{repo}/statuses/{sha}",
      status: 503,
      attempt: 1,
    }),
  );
});

test("asks a GraphQL query again after GitHub's 502: it is a POST that only reads", async () => {
  const fixture = githubAnswering(
    json(502, { message: "Bad gateway" }),
    json(200, { data: { repository: { pullRequest: { body: "before" } } } }),
  );

  const data = await fixture.github.graphql(
    `query { repository(owner: "iterate", name: "iterate") { pullRequest(number: 2899) { body } } }`,
  );

  expect(data).toMatchObject({ repository: { pullRequest: { body: "before" } } });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.warn).toHaveBeenCalledWith(
    expect.objectContaining({ route: "POST /graphql", status: 502, attempt: 1 }),
  );
});

test("never asks a GraphQL mutation again: a 5xx may have landed", async () => {
  const fixture = githubAnswering(json(502, { message: "Bad gateway" }));

  await expect(
    fixture.github.graphql(
      `mutation { addComment(input: { subjectId: "PR_2899", body: "once" }) { clientMutationId } }`,
    ),
  ).rejects.toMatchObject({ status: 502 });
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(fixture.warn).not.toHaveBeenCalled();
});

test("asks a PATCH once when the caller says so: a PR body written from a read seconds earlier", async () => {
  const fixture = githubAnswering(unexpectedError());

  await expect(
    fixture.github.rest.pulls.update({
      ...repo,
      pull_number: 2899,
      body: "spliced",
      request: { askOnce: true },
    }),
  ).rejects.toMatchObject({ status: 500 });
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(fixture.warn).not.toHaveBeenCalled();
});

test("never asks again after a 4xx: it is GitHub's answer about the request", async () => {
  const fixture = githubAnswering(json(404, { message: "Not Found" }));

  await expect(fixture.github.rest.pulls.get({ ...repo, pull_number: 1 })).rejects.toMatchObject({
    status: 404,
  });
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(fixture.warn).not.toHaveBeenCalled();
});

test("never asks again after an abort: the caller chose to stop", async () => {
  const fixture = githubAnswering(new DOMException("aborted", "AbortError"));

  await expect(fixture.github.rest.pulls.get({ ...repo, pull_number: 1 })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(fixture.warn).not.toHaveBeenCalled();
});

/**
 * An Octokit whose `fetch` answers from `responses` in order, and the `console.warn` spy it logs
 * to. CI_HTTP's waits run on a fake clock that moves on whenever nothing else is left to run, each
 * at its longest (`Math.random` at 1).
 */
function githubAnswering(...responses: Array<Response | Error>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(Math, "random").mockReturnValue(1);
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("the test ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const github = retryGithubPlatformFailures(new Octokit({ auth: "token", request: { fetch } }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { github, fetch, warn };
}

function unexpectedError() {
  return new Response("Unexpected error\n", {
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-github-request-id": "BC32:2F0597:157166:45E4D9:6AB4315E",
    },
  });
}

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
