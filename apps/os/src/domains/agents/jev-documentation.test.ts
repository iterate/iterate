import { expect, test } from "vitest";
import { prepareDocumentation } from "../../../../../configs/jev-docs/documentation.ts";

test("one Jev batch selects at most three relevant sources and fetches only those docs", async () => {
  const fetched: string[] = [];
  const requests: any[] = [];
  const result = await prepareDocumentation(
    {
      docs: {
        search: async () =>
          ["Files", "Scheduler", "Email", "Streams", "Unrelated"].map((name) => ({
            name,
            kind: "type",
            summary: name,
            fetchCall: "unused",
          })),
        get: async ({ name }) => {
          fetched.push(name);
          return `API documentation: ${name}`;
        },
      },
    },
    {
      run: async (...args: any[]) => {
        requests.push(args);
        return {
          state: "Completed",
          result: {
            model: "jev-1.13.0",
            usage: { input_tokens: 200, output_tokens: 20 },
            answers: Object.fromEntries(
              [2, 1.9, 1.8, 1.7, 0.1].map((score, i) => [
                `d${i}`,
                { type: "score", score, confidence: 0.9 },
              ]),
            ),
          },
        } as any;
      },
    },
    [{ role: "user", content: "Upload files, email their links, and schedule a reminder" }],
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject([
    "typesafe/jev",
    { questions: { d0: { type: "score" }, d4: { type: "score" } } },
  ]);
  expect(fetched).toEqual(["Files", "Scheduler", "Email"]);
  expect(result.metadata).toMatchObject({ selected: fetched, model: "jev-1.13.0" });
  expect(result.content).toContain("API documentation: Files");
  expect(result.content).not.toContain("Unrelated");
});

test("no search matches means no classification request and no invented docs", async () => {
  const result = await prepareDocumentation(
    {
      docs: {
        search: async () => [],
        get: async () => {
          throw new Error("must not fetch");
        },
      },
    },
    {
      run: async () => {
        throw new Error("must not classify");
      },
    },
    [{ role: "user", content: "hello" }],
  );
  expect(result).toMatchObject({ content: "", metadata: { selected: [], candidates: 0 } });
});
