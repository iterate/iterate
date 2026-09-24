import { expect, test, vi } from "vitest";
import { depotCiApi } from "./depot.ts";

const noDelays = [0, 0, 0];

// Preview OS trace, PR #2970, attempt 144gszhm0r: "Error: Depot GetJobAttemptLogs returned HTTP 500".
test("a read Depot answers with one 500 is asked again, with a warn, and succeeds", async () => {
  using depot = depotAnswering(500, 200);

  await expect(
    depotCiApi("GetJobAttemptLogs", { attemptId: "a" }, "token", {
      fetch: depot.fetch,
      delaysMs: noDelays,
    }),
  ).resolves.toEqual({ lines: [] });

  expect(depot).toMatchObject({ calls: ["GetJobAttemptLogs", "GetJobAttemptLogs"] });
  expect(depot.warn).toHaveBeenCalledOnce();
  expect(depot.warn).toHaveBeenCalledWith({
    event: "depot.platform-failure-retry",
    method: "GetJobAttemptLogs",
    status: 500,
    message: "Depot GetJobAttemptLogs returned HTTP 500",
    attempt: 1,
    retryInMs: 0,
  });
});

test("a read whose connection fails is asked again", async () => {
  using depot = depotAnswering("reset", 200);

  await expect(
    depotCiApi("ListArtifacts", { runId: "r" }, "token", {
      fetch: depot.fetch,
      delaysMs: noDelays,
    }),
  ).resolves.toEqual({ lines: [] });

  expect(depot.calls).toHaveLength(2);
  expect(depot.warn).toHaveBeenCalledWith(
    expect.objectContaining({ status: "network", message: "fetch failed" }),
  );
});

test.for([
  { method: "GetWorkflow", answer: 404, error: "Depot GetWorkflow returned HTTP 404" },
  { method: "GetWorkflow", answer: 401, error: "Depot GetWorkflow returned HTTP 401" },
  { method: "DispatchWorkflow", answer: 500, error: "Depot DispatchWorkflow returned HTTP 500" },
  { method: "RetryJob", answer: "reset" as const, error: "fetch failed" },
])("$method answered $answer fails at once", async ({ method, answer, error }) => {
  using depot = depotAnswering(answer, 200);

  await expect(
    depotCiApi(method, {}, "token", { fetch: depot.fetch, delaysMs: noDelays }),
  ).rejects.toThrow(error);

  expect(depot.calls).toHaveLength(1);
  expect(depot.warn).not.toHaveBeenCalled();
});

/** A Depot API answering each call with the next of `answers`: a status, or "reset" for a
 *  connection that fails the way undici's fetch does; `warn` spies on console.warn. */
function depotAnswering(...answers: (number | "reset")[]) {
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
  return {
    fetch,
    calls,
    warn,
    [Symbol.dispose]() {
      warn.mockRestore();
    },
  };
}
