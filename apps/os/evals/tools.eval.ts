import { evalite } from "evalite";
import { beforeAll } from "vitest";
import { iterateAgentTools } from "../backend/agent/iterate-agent-tools.ts";
import { createDOToolFactory } from "../backend/agent/do-tools.ts";
import type { AgentDurableObjectToolSpec } from "../backend/agent/tool-schemas.ts";
import { createTestHelper, getAuthedTrpcClient, multiTurnScorer } from "./helpers.ts";
import z from "zod";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

evalite("tool usage", {
  data: async () => {
    return [
      {
        input: {
          slug: "return-secret",
          tools: [
            createDOToolFactory(iterateAgentTools).flexibleTestTool({
              overrideName: "getCharacterName",
              passThroughArgs: {
                params: { behaviour: "return-secret", secret: "rumplestiltskin" },
              },
            }),
          ],
          messages: [
            {
              message: "use the getCharacterName tool to tell me the character name",
              expected: ["rumplestiltskin"],
            },
          ],
        },
      },
      {
        input: {
          slug: "parallel-tool-calls",
          tools: [
            createDOToolFactory(iterateAgentTools).flexibleTestTool({
              overrideName: "slowlyGetAnimal",
              passThroughArgs: {
                params: {
                  behaviour: "slow-tool",
                  delay: 10_000,
                  response: "capybara",
                  recordStartTime: true,
                },
              },
            }),
            createDOToolFactory(iterateAgentTools).flexibleTestTool({
              overrideName: "slowlyGetFood",
              passThroughArgs: {
                params: {
                  behaviour: "slow-tool",
                  delay: 5_000,
                  response: "couscous",
                  recordStartTime: true,
                },
              },
            }),
          ],
          messages: [
            {
              message: "use the slowlyGetAnimal tool and in parallel use slowlyGetFood.",
              expected: ["couscous", "capybara"],
            },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);
    const scorer = multiTurnScorer();

    await h.addToolSpec(...input.tools);

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      const { score, reasons } = message.expected.reduce(
        (acc, expected) => {
          if (reply.includes(expected)) {
            acc.score += 100 / message.expected.length;
            acc.reasons.push(`message had the phrase "${expected}"`);
          } else {
            acc.reasons.push(`message did not have the phrase "${expected}"`);
          }
          return acc;
        },
        { score: 0, reasons: [] as string[] },
      );
      // const score = reply.includes(message.expected) ? 100 : 0;
      scorer.scoreManually([`user: ${message.message}`, `assistant: ${reply}`], {
        score,
        reason: reasons.join("\n"),
      });
    }
    return { scores: await scorer.getScores(), debugURL: await h.getAgentDebugURL() };
  },
  scorers: [
    multiTurnScorer.mean, //
    multiTurnScorer.median,
    multiTurnScorer.min,
  ],
  columns: multiTurnScorer.renderColumns,
});

evalite("parallel tool calls", {
  data: async () => {
    return [
      {
        input: {
          slug: "parallel-tool-calls",
          tools: [
            createDOToolFactory(iterateAgentTools).flexibleTestTool({
              overrideName: "slowlyGetAnimal",
              passThroughArgs: {
                params: {
                  behaviour: "slow-tool",
                  delay: 10_000,
                  response: "capybara",
                  recordStartTime: true,
                },
              },
            }),
            createDOToolFactory(iterateAgentTools).flexibleTestTool({
              overrideName: "slowlyGetFood",
              passThroughArgs: {
                params: {
                  behaviour: "slow-tool",
                  delay: 5_000,
                  response: "couscous",
                  recordStartTime: true,
                },
              },
            }),
          ],
          messages: [
            {
              message: "use the slowlyGetAnimal tool and in parallel use slowlyGetFood.",
              expected: ["couscous", "capybara"],
            },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);
    const scorer = multiTurnScorer();

    await h.addToolSpec(...input.tools);

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      let { score, reasons } = message.expected.reduce(
        (acc, expected) => {
          if (reply.includes(expected)) {
            acc.score += 100 / message.expected.length;
            acc.reasons.push(`message had the phrase "${expected}"`);
          } else {
            acc.reasons.push(`message did not have the phrase "${expected}"`);
          }
          return acc;
        },
        { score: 0, reasons: [] as string[] },
      );

      const animalCall = await h.waitForCompletedToolCall(
        z.object({ start: z.string() }),
        "slowlyGetAnimal",
        userMessage.events,
      );
      const foodCall = await h.waitForCompletedToolCall(
        z.object({ start: z.string() }),
        "slowlyGetFood",
        userMessage.events,
      );

      const startTimeDiffSeconds =
        Math.abs(new Date(animalCall.start).getTime() - new Date(foodCall.start).getTime()) / 1000;

      score -= startTimeDiffSeconds * 20; // penalize per second - they should be called at the same time, +/- a short delay for chunk streaming latency
      reasons.push(`Calls started ${startTimeDiffSeconds}s apart`);

      scorer.scoreManually([`user: ${message.message}`, `assistant: ${reply}`], {
        score,
        reason: reasons.join("\n"),
      });
    }
    return { scores: await scorer.getScores(), debugURL: await h.getAgentDebugURL() };
  },
  scorers: [
    multiTurnScorer.mean, //
    multiTurnScorer.median,
    multiTurnScorer.min,
  ],
  columns: multiTurnScorer.renderColumns,
});
