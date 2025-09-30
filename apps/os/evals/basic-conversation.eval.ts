import { beforeAll } from "vitest";
import { createTestHelper, getAuthedTrpcClient, multiTurnScorer } from "./helpers.ts";
import { IterateEval } from "./helpers.ts";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

IterateEval("agent knows when to end their turn", {
  data: async () => {
    return [
      {
        input: {
          slug: "multi-turn fruits conversation",
          messages: [
            { message: "name a green fruit", expected: "a green fruit" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            { message: "name another", expected: "a green fruit, not the same as the 1st or 2nd" },
          ].map((m, i) => {
            m.expected += `. penalize emojis by ${10 + i * 5}%`;
            return m;
          }),
        },
      },
      {
        input: {
          slug: "multi-turn vegetables conversation",
          messages: [
            { message: "name a green vegetable", expected: "a green vegetable" },
            { message: "name another", expected: "a green vegetable, not the same as the first" },
            {
              message: "name another",
              expected: "a green vegetable, not the same as the 1st or 2nd",
            },
          ].map((m, i) => {
            m.expected += `. penalize emojis by ${10 + i * 5}%`;
            return m;
          }),
        },
      },
    ];
  },
  task: async ({ braintrustSpanExportedId, input }) => {
    const h = await createTestHelper({
      trpcClient,
      inputSlug: input.slug,
      braintrustSpanExportedId,
    });
    const scorer = multiTurnScorer({ braintrustSpanExportedId });

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      scorer.scoreTurn([`user: ${message.message}`, `assistant: ${reply}`], message.expected);
    }

    return { scores: await scorer.getScores() };
  },
  scorers: [multiTurnScorer.mean, multiTurnScorer.median, multiTurnScorer.min],
  columns: multiTurnScorer.renderColumns,
});
