import { Octokit } from "@octokit/rest";
import { expect, test, vi } from "vitest";

import { retryGithubPlatformFailures } from "./github.ts";

const repo = { owner: "iterate", repo: "iterate" };

test("asks a GET again after GitHub's 500 and returns the answer (the PR #2899 LOC report)", async () => {
  const fixture = githubAnswering(unexpectedError(), json(200, { number: 2899, body: "before" }));

  const { data } = await fixture.github.rest.pulls.get({ ...repo, pull_number: 2899 });

  expect(data).toMatchObject({ number: 2899, body: "before" });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.warn).toHaveBeenCalledOnce();
  expect(fixture.warn).toHaveBeenCalledWith({
    event: "github.platform-failure-retry",
    route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    status: 500,
    requestId: "BC32:2F0597:157166:45E4D9:6AB4315E",
    message: "Unexpected error\n",
    attempt: 1,
    retryInMs: 0,
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

test("throws GitHub's last failure once every delay is spent", async () => {
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
  expect(fixture.warn.mock.calls.map(([entry]) => entry.status)).toEqual([502, 503, 500]);
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
 * An Octokit whose `fetch` answers from `responses` in order, with no wait between attempts,
 * and the `console.warn` spy it logs to.
 */
function githubAnswering(...responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("the test ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const github = retryGithubPlatformFailures(
    new Octokit({ auth: "token", request: { fetch } }),
    [0, 0, 0],
  );
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
