import { evalite } from "evalite";
import { beforeAll } from "vitest";
import { createTestHelper, getAuthedTrpcClient, multiTurnScorer } from "./helpers.ts";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

evalite("multi-turn", {
  data: async () => {
    return [
      {
        input: {
          slug: "fruit-naming",
          messages: [
            { message: "name a green fruit", expected: "a green fruit. penalize emojis by 10%" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            { message: "name another", expected: "a green fruit, not the same as the 1st or 2nd" },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);
    const scorer = multiTurnScorer();

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      scorer.scoreTurn([`user: ${message.message}`, `assistant: ${reply}`], message.expected);
    }
    return { scores: await scorer.getScores() };
  },
  scorers: [
    multiTurnScorer.mean, //
    multiTurnScorer.median,
    multiTurnScorer.min,
  ],
  columns: multiTurnScorer.renderColumns,
});
