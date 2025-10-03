import * as R from "remeda";
import { beforeAll } from "vitest";
import { evalite } from "evalite";
import dedent from "dedent";
import * as YAML from "yaml";
import { createTestHelper, getAuthedTrpcClient, multiTurnScorer, evaliterate } from "./helpers.ts";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

if (false)
  evalite("testing", {
    data: async () => [
      {
        input: {
          slug: "fruits",
          messages: [
            { message: "name a green fruit", expected: "a green fruit" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            { message: "name another", expected: "a green fruit, not the same as the 1st or 2nd" },
          ],
        },
      },
    ],
    task: async (input) => {
      return multiTrialTask(3, async () => {
        const convo: string[] = [];
        const scores: { score: number; reason: string }[] = [];
        for (const message of input.messages) {
          convo.push(`user: ${message.message}`);
          const fruit = ["kiwi", "lime", "green grape", "apple"];
          const selection = fruit[Math.floor(Math.random() * fruit.length)];
          convo.push(`assistant: ${selection}`);
          scores.push({ score: 1 - Math.random() * 0.1, reason: `${selection} is green i guess` });
        }
        return { convo, scores };
      });
    },
    scorers: [
      {
        name: "one",
        scorer: ({ output }) => ({
          score: 1,
          metadata: {
            output: JSON.stringify(output),
            reason: "uno",
          },
        }),
      },
    ],
    columns: (x) => {
      const turns = R.uniqueBy(
        x.output.trials.flatMap((t) =>
          t.result.scores.map((_s, i) => ({ index: i, name: `turn ${i + 1}` })),
        ),
        (t) => t.name,
      );
      return turns.map((turn) => {
        const resultsAcrossTrials = x.output.trials.map((t) => t.result.scores[turn.index]);
        return {
          label: turn.name,
          value: dedent`
            \`\`\`
            - mean: ${R.meanBy(resultsAcrossTrials, (s) => s.score)}
            - min: ${minBy(resultsAcrossTrials, (s) => s.score).score}
            - median: ${medianBy(resultsAcrossTrials, (s) => s.score)}
            - resultsAcrossTrials: ${JSON.stringify(resultsAcrossTrials)}
            \`\`\`
          `,
        };
      });
    },
  });

const multiTrialTask = async <T>(count: number, runTrial: (index: number) => Promise<T>) => {
  const results = await Promise.all(Array.from({ length: count }).map((_, i) => runTrial(i)));
  const trials = results.map((r, i) => ({ trialIndex: i, result: r }));
  return { trials };
};

const minBy = <T>(arr: T[], fn: (t: T) => number) => R.sortBy(arr, fn)[0];
const medianBy = <T>(arr: T[], fn: (t: T) => number) =>
  R.meanBy(
    R.sortBy(arr, fn).filter((_, i, { length }) => Math.abs(length / 2 - i) < 1),
    fn,
  );

evaliterate("agent knows when to end their turn", {
  trialCount: 2 || Number(process.env.EVAL_TRIAL_COUNT) || undefined,
  data: async () => {
    return [
      {
        input: {
          slug: "multi-turn-fruits-conversation",
          messages: [
            { message: "name a green fruit", expected: "a green fruit" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            {
              message: "name another",
              expected: "a green fruit, not the same as the 1st or 2nd",
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
  scorers: [
    {
      name: "one",
      scorer: ({ output }) => ({
        score: 1,
        metadata: {
          output,
          reason: "uno",
        },
      }),
    },
    {
      name: "meanMean",
      scorer: ({ output }) => {
        const turns = [
          ...new Set(
            output.trials.flatMap((t) =>
              t.result.scores.map((_s, i) => ({ index: i, name: `turn ${i + 1}` })),
            ),
          ),
        ];
        return {
          score: R.meanBy(output.trials, (t) => R.meanBy(t.result.scores, (s) => s.score)),
          metadata: fmt({
            trialCount: output.trials.length,
            turnMeans: Object.fromEntries(
              turns.map(({ index, name }) => [
                name,
                R.meanBy(output.trials, (t) => t.result.scores[index]?.score ?? 0),
              ]),
            ),
            trialMeans: Object.fromEntries(
              output.trials.map((t) => [
                `trial ${t.trialIndex}`,
                R.meanBy(t.result.scores, (s) => s.score),
              ]),
            ),
          }),
        };
      },
    },
  ],
  columns: (x) => {
    const turns = R.uniqueBy(
      x.output.trials.flatMap((t) =>
        t.result.scores.map((_s, i) => ({ index: i, name: `turn ${i + 1}` })),
      ),
      (t) => t.name,
    );
    return turns.map((turn) => {
      const resultsAcrossTrials = x.output.trials.map((t) => t.result.scores[turn.index]);
      return {
        label: turn.name,
        value: dedent`
          \`\`\`
          - mean: ${R.meanBy(resultsAcrossTrials, (s) => s.score)}
          - min: ${minBy(resultsAcrossTrials, (s) => s.score).score}
          - median: ${medianBy(resultsAcrossTrials, (s) => s.score)}
          - resultsAcrossTrials: ${JSON.stringify(resultsAcrossTrials)}
          \`\`\`
        `,
      };
    });
  },
  // columns: multiTurnScorer.renderColumns,
});

const fmt = (x: any) => "```yaml\n" + YAML.stringify(x) + "\n```";
