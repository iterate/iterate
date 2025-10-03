import * as R from "remeda";
import { beforeAll } from "vitest";
import { evalite } from "evalite";
import dedent from "dedent";
import * as YAML from "yaml";
import {
  createTestHelper,
  getAuthedTrpcClient,
  multiTurnScorer,
  evaliterate,
  type MultiTrialScorerOutput,
} from "./helpers.ts";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
});

const minBy = <T>(arr: T[], fn: (t: T) => number) => arr.map(fn).sort().at(0);

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
      name: "meanMean",
      scorer: ({ output }) => {
        const a = analyseTrials(output);
        return {
          score: a.aggregates.meanOfMeans,
          metadata: fmt({
            aggregates: a.aggregates,
            trials: a.trials,
          }),
        };
      },
    },
  ],
  columns: (x) => {
    const a = analyseTrials(x.output);
    return a.turns.map((turn) => ({
      label: turn.name,
      value: fmt(turn),
    }));
  },
});

const analyseTrials = (output: MultiTrialScorerOutput) => {
  const turns = R.uniqueBy(
    output.trials.flatMap((t) =>
      t.result.scores.map((_s, i) => ({ index: i, name: `turn ${i + 1}` })),
    ),
    (t) => t.name,
  ).map((turn) => {
    const resultsAcrossTrials = output.trials.map((t) => t.result.scores[turn.index]);
    return {
      name: turn.name,
      index: turn.index,
      resultsAcrossTrials: Object.fromEntries(
        resultsAcrossTrials.map((s, i) => [output.trials[i].trialName, s]),
      ),
      mean: R.meanBy(resultsAcrossTrials, (s) => s.score) || 0,
      min: minBy(resultsAcrossTrials, (s) => s.score) || 0,
      median: R.median(resultsAcrossTrials.map((s) => s.score)) || 0,
    };
  });

  const trials = output.trials.map((trial) => {
    return {
      name: trial.trialName,
      scores: trial.result.scores,
      mean: R.meanBy(trial.result.scores, (s) => s.score) || 0,
      min: minBy(trial.result.scores, (s) => s.score) || 0,
      median: R.median(trial.result.scores.map((s) => s.score)) || 0,
    };
  });

  const aggregates = {
    meanOfMeans: R.meanBy(turns, (t) => t.mean) || 0,
    medianOfMedians: R.median(trials.map((t) => t.median)) || 0,
    minOfMins: minBy(trials, (t) => t.min) || 0,
  };

  return {
    turns,
    trials,
    aggregates,
  };
};

const fmt = (x: any) => "```yaml\n" + YAML.stringify(JSON.parse(JSON.stringify(x))) + "\n```";
