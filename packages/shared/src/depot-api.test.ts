import { expect, onTestFinished, test, vi } from "vitest";
import { HttpAnswerError } from "iterate/platform-retry";
import { depotCiApi } from "./depot-api.ts";

// A single 500 on GetJobAttemptLogs must not fail a trace job.
test("a read Depot answers with one 500 is asked again, with a warn, and succeeds", async () => {
  const depot = depotAnswering(500, 200);

  await expect(
    depotCiApi("GetJobAttemptLogs", { attemptId: "a" }, "token", { fetch: depot.fetch }),
  ).resolves.toEqual({ lines: [] });

  expect(depot).toMatchObject({ calls: ["GetJobAttemptLogs", "GetJobAttemptLogs"] });
  expect(depot.warn).toHaveBeenCalledOnce();
  expect(depot.warn).toHaveBeenCalledWith({
    event: "depot.platform-failure-retry",
    kind: "disconnected",
    request: "Depot GetJobAttemptLogs",
    status: 500,
    message: 'Depot GetJobAttemptLogs answered HTTP 500: {"code":"internal"}',
    attempt: 1,
    retryInMs: 2_000,
  });
});

test("a read whose connection fails is asked again", async () => {
  const depot = depotAnswering("reset", 200);

  await expect(
    depotCiApi("ListArtifacts", { runId: "r" }, "token", { fetch: depot.fetch }),
  ).resolves.toEqual({ lines: [] });

  expect(depot.calls).toHaveLength(2);
  expect(depot.warn).toHaveBeenCalledWith(
    expect.objectContaining({ status: "network", message: "Depot ListArtifacts: fetch failed" }),
  );
});

test.for([
  { method: "GetWorkflow", answer: 404, error: "Depot GetWorkflow answered HTTP 404" },
  { method: "GetWorkflow", answer: 401, error: "Depot GetWorkflow answered HTTP 401" },
  { method: "DispatchWorkflow", answer: 500, error: "Depot DispatchWorkflow answered HTTP 500" },
  { method: "RetryJob", answer: "reset" as const, error: "fetch failed" },
])("$method answered $answer fails at once", async ({ method, answer, error }) => {
  const depot = depotAnswering(answer, 200);

  await expect(depotCiApi(method, {}, "token", { fetch: depot.fetch })).rejects.toThrow(error);

  expect(depot.calls).toHaveLength(1);
  expect(depot.warn).not.toHaveBeenCalled();
});

// ci-reports reads a 404 as an artifact that expired (internal-packages/ci-reports/src/artifact.ts).
test("an answer about the request is an HttpAnswerError with its status", async () => {
  const depot = depotAnswering(404);

  const failure = depotCiApi("GetArtifactDownloadURL", {}, "token", { fetch: depot.fetch });

  await expect(failure).rejects.toBeInstanceOf(HttpAnswerError);
  await expect(failure).rejects.toMatchObject({ status: 404 });
});

/** A Depot API answering each call with the next of `answers`: a status, or "reset" for a
 *  connection that fails the way undici's fetch does; `warn` spies on console.warn. CI_HTTP's
 *  waits run on a fake clock that moves on whenever nothing else is left to run, each at its
 *  longest (`Math.random` at 1). */
function depotAnswering(...answers: (number | "reset")[]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(Math, "random").mockReturnValue(1);
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url).split("/").pop()!);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("the test's Depot has no more answers");
    if (answer === "reset") throw new TypeError("fetch failed");
    return new Response(answer === 200 ? '{"lines":[]}' : '{"code":"internal"}', {
      status: answer,
    });
  }) as unknown as typeof globalThis.fetch;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { fetch, calls, warn };
}
