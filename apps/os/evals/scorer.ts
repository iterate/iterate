import * as YAML from "yaml";
import PQueue from "p-queue";
import * as R from "remeda";
import OpenAI from "openai";
import { z } from "zod";
import dedent from "dedent";
import { startSpan } from "../backend/crap/braintrust-shim.ts";
import type { MultiTrialScorerOutput } from "./helpers.ts";
import { zodTextFormat } from "./zod-openai.ts";

export const ScoreResult = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "A score between 0 and 100. Give 0 for a total failure and 100 for a perfect score. If you think a reasonable person could reasonably take the same meaning from the response, give a score of 80+.",
    ),
  reason: z.string().describe("A detailed explanation of why you gave this score."),
});
export const ExplainedScoreResult = ScoreResult.extend({
  messages: z.array(z.string()).describe("The messages that were used to score the turn."),
});
export type ScoreResult = z.infer<typeof ScoreResult>;
export type ExplainedScoreResult = z.infer<typeof ExplainedScoreResult>;

export type ScoreOutput = { scores: ScoreResult[] };

type ResponsesCreateParams = Parameters<OpenAI["responses"]["create"]>[0];
const multiTurnScorerParamsDefaults = {
  model: "gpt-5",
  instructions: `You are an eval assistant. Your job is to check if the last response matches the expectation. Respond with a score between 0 and 100.`,
  text: {
    // @ts-expect-error openai is broken
    format: zodTextFormat(ScoreResult, "ScoreResult"),
  },
} satisfies Omit<ResponsesCreateParams, "input">;
type MultiTurnScorerParams = Omit<ResponsesCreateParams, "input" | "text"> & {
  braintrustSpanExportedId?: string;
};

function _multiTurnScorer(params: MultiTurnScorerParams = {}) {
  const { braintrustSpanExportedId, ...openaiParams } = params;
  const scores: (ScoreResult & { messages: string[] })[] = [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const conversation: string[] = [];

  const scoringQueue = new PQueue({ concurrency: 3 });
  let scoringError: Error | null = null;
  scoringQueue.on("error", (err) => {
    scoringError = err;
  });

  const scoreManually = async (newMessages: string[], score: { score: number; reason: string }) => {
    conversation.push(...newMessages);
    scores.push({ ...score, messages: newMessages });
    const intermediateScoreSpan = startSpan({
      name: "intermediate-score",
      parent: params.braintrustSpanExportedId,
      type: "score",
    });
    intermediateScoreSpan.log({
      input: {
        conversation,
      },
      output: {
        score: score.score,
        reason: score.reason,
      },
    });
    intermediateScoreSpan.end();
    await intermediateScoreSpan.flush();
  };

  const scoreTurn = async (newMessages: string[], expectation: string) => {
    conversation.push(...newMessages);
    const score: ExplainedScoreResult = { messages: newMessages, score: 0, reason: "pending" };
    // push score immediately so the scores array is in the right order, we'll overwrite the pending props later
    scores.push(score);
    // start span immediately so it's in the right order
    const intermediateScoreSpan = startSpan({
      name: "intermediate-score",
      parent: params.braintrustSpanExportedId,
      type: "score",
    });
    intermediateScoreSpan.log({ input: { conversation, expectation } });

    const input = dedent`
      <conversation>
      ${conversation.join("\n")}
      </conversation>

      <expectation>
      ${expectation}
      </expectation>
    `;

    const openaiResponse = await openai.responses.parse({
      ...multiTurnScorerParamsDefaults,
      ...openaiParams,
      input,
    });
    if (!openaiResponse.output_parsed) {
      throw new Error(`Didn't get a valid output for input:\n${input}`);
    }
    // mutate the score that's already in the array to maintain ordering (sometimes the evaluation LLM call is slower than the production one)
    score.score = openaiResponse.output_parsed.score / 100; // openai returns a score between 0 and 100, we want it between 0 and 1
    score.reason = openaiResponse.output_parsed.reason;

    intermediateScoreSpan.log({ output: { score: score.score, reason: score.reason } });
    intermediateScoreSpan.end();
    await intermediateScoreSpan.flush();
  };

  return {
    /** Waits for all scores to come in and returns them as a list */
    getScores: async () => {
      if (scoringError) throw scoringError;
      await scoringQueue.onIdle();
      if (scoringError) throw scoringError;
      return scores;
    },
    /**
     * Pushes the new messages into the conversation history, and
     * enqueues a task to score a turn. This will be done in the background,
     * use `await getScores()` afterwards if you want to block until it's done.
     * */
    scoreTurn: (...args: Parameters<typeof scoreTurn>) => {
      if (scoringError) throw scoringError;
      scoringQueue.add(() => scoreTurn(...args));
    },
    scoreManually,
    conversation,
  };
}

const minBy = <T>(arr: T[], fn: (t: T) => number) => arr.map(fn).sort().at(0);

const meanOfMeansScorer = {
  name: "meanMean",
  scorer: ({ output }: { output: MultiTrialScorerOutput }) => {
    const a = analyseTrials(output);
    return {
      score: a.aggregates.meanOfMeans,
      metadata: fmt({
        aggregates: a.aggregates,
        trials: a.trials,
      }),
    };
  },
};

const turnSummaryColumnRenderer = ({ output }: { output: MultiTrialScorerOutput }) => {
  const a = analyseTrials(output);
  return a.turns.map((turn) => ({
    label: turn.name,
    value: fmt(turn),
  }));
};

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

const resultScorers = {
  meanOfMeansScorer,
};

export const multiTurnScorer = Object.assign(_multiTurnScorer, {
  ...resultScorers,
  turnSummaryColumnRenderer,
});
