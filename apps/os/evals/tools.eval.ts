import { evalite } from "evalite";
import { beforeAll } from "vitest";
import { iterateAgentTools } from "../backend/agent/iterate-agent-tools.ts";
import { createDOToolFactory } from "../backend/agent/do-tools.ts";
import { createTestHelper, getAuthedTrpcClient, multiTurnScorer } from "./helpers.ts";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

evalite("tool usage", {
  data: async () => {
    return [
      {
        input: {
          slug: "reverse-string",
          messages: [
            {
              message: "reverse the string 'supercalifragilisticexpialidocious'",
              expected: "suoicodilaipxecitsiligarfilacrepus",
            },
          ],
        },
      },
      {
        input: {
          slug: "return-secret",
          messages: [
            {
              message:
                'use the flexibleTestTool tool with behaviour "return-secret" and secret "hello". Then tell me the value of serverSecret',
              expected: "rumplestiltskin",
            },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);
    const scorer = multiTurnScorer();

    await h.addToolSpec(createDOToolFactory(iterateAgentTools).flexibleTestTool());

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      const score = reply.includes(message.expected) ? 100 : 0;
      scorer.scoreManually([`user: ${message.message}`, `assistant: ${reply}`], {
        score,
        reason: `message ${score === 100 ? "had" : "did not have"} the phrase "${message.expected}"`,
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
          slug: "can-run-parallelly",
          messages: [
            {
              message: "reverse the string 'supercalifragilisticexpialidocious'",
              expected: "suoicodilaipxecitsiligarfilacrepus",
            },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);
    const scorer = multiTurnScorer();

    const longDelay = 10_000;
    const shortDelay = 5_000;

    const agentDOTools = createDOToolFactory(iterateAgentTools);
    await h.addToolSpec(
      agentDOTools.flexibleTestTool({
        overrideName: "slowlyGetAnimal",
        passThroughArgs: {
          behaviour: "slow-tool",
          recordStartTime: true,
          delay: longDelay,
          response: "dog",
        },
        overrideInputJSONSchema: {
          type: "object",
        },
      }),
      agentDOTools.flexibleTestTool({
        overrideName: "slowlyGetFood",
        passThroughArgs: {
          behaviour: "slow-tool",
          recordStartTime: true,
          delay: shortDelay,
          response: "banana",
        },
        overrideInputJSONSchema: {
          type: "object",
        },
      }),
    );

    const message = `Please use the slowlyGetAnimal to get an animal that barks after ${longDelay / 1000} seconds and in parallel use slowlyGetFood to get a bendy yellow fruit after a delay of ${shortDelay / 1000} seconds.`;
    const userMessage = await h.sendUserMessage(message);
    const reply = await userMessage.waitForReply({ timeout: longDelay + 5000 });

    let score = 0;
    if (reply.includes("dog")) score += 50;
    if (reply.includes("banana")) score += 50;

    scorer.scoreManually([`user: ${userMessage}`, `assistant: ${reply}`], {
      score,
      reason: `message should include both "dog" and "banana"`,
    });
    return { scores: await scorer.getScores(), debugURL: await h.getAgentDebugURL() };
  },
  scorers: [
    multiTurnScorer.mean, //
    multiTurnScorer.median,
    multiTurnScorer.min,
  ],
  columns: multiTurnScorer.renderColumns,
});
