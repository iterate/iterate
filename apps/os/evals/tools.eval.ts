import { evalite } from "evalite";
import { beforeAll } from "vitest";
// import { createTestHelper, getAuthedTrpcClient, multiTurnScorer } from "./helpers.ts";

// let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

// beforeAll(async () => {
//   trpcClient = await getAuthedTrpcClient();
// });

evalite("agent knows when to end their turn", {
  data: async () => {
    return [
      {
        input: {
          slug: "reverse-string",
          messages: [
            {
              message: "reverse the string 'supercalifragilisticexpialidocious'",
              expected: "supercalifragilisticexpialidocious",
            },
          ],
        },
      },
    ];
  },
  task: async (input) => {
    const scores: any[] = [];
    for (const message of input.messages) {
      scores.push({
        score: Math.round(100 - Math.random() * 15),
        reason: "dunno",
        messages: [`user: ${message.message}`, `assistant: lime`],
      });
    }
    return { scores };
    // const h = await createTestHelper(trpcClient, input.slug);
    // const scorer = multiTurnScorer();

    // for (const message of input.messages) {
    //   const userMessage = await h.sendUserMessage(message.message);
    //   const reply = await userMessage.waitForReply();

    //   scorer.scoreTurn([`user: ${message.message}`, `assistant: ${reply}`], message.expected);
    // }
    // return { scores: await scorer.getScores() };
  },
  scorers: [
    {
      name: "median",
      scorer: (result: { output: { scores: any[] } }) => ({
        score:
          result.output.scores
            .sort((a, b) => a.score - b.score)
            .at(Math.floor(result.output.scores.length / 2))?.score ?? 0,
        metadata: { allScores: result.output.scores },
      }),
    },
  ],
  // columns: multiTurnScorer.renderColumns,
});
