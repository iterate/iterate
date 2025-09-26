import PQueue from "p-queue";
import * as R from "remeda";
import OpenAI from "openai";
import { z } from "zod";
import dedent from "dedent";
import { zodTextFormat } from "./zod-openai.ts";

const ScoreResult = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "A score between 0 and 100. Give 0 for a total failure and 100 for a perfect score. If you think a reasonable person could reasonably take the same meaning from the response, give a score of 80+.",
    ),
  reason: z.string().describe("A detailed explanation of why you gave this score."),
});

type ResponsesCreateParams = Parameters<OpenAI["responses"]["create"]>[0];
const multiTurnScorerParamsDefaults = {
  model: "gpt-5",
  instructions: `You are an eval assistant. Your job is to check if the last response matches the expectation. Respond with a score between 0 and 100.`,
  text: {
    format: zodTextFormat(ScoreResult, "ScoreResult"),
  },
} satisfies Omit<ResponsesCreateParams, "input">;
type MultiTurnScorerParams = Omit<ResponsesCreateParams, "input" | "text">;

function _multiTurnScorer(params: MultiTurnScorerParams = {}) {
  const scores: (ScoreResult & { messages: string[] })[] = [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const conversation: string[] = [];

  const scoringQueue = new PQueue({ concurrency: 3 });
  let scoringError: Error | null = null;
  scoringQueue.on("error", (err) => {
    scoringError = err;
  });

  const scoreTurn = async (newMessages: string[], expectation: string) => {
    conversation.push(...newMessages);
    const input = dedent`
      <conversation>
      ${conversation.join("\n")}
      </conversation>

      <expectation>
      ${expectation}
      </expectation>
    `;

    const openaResponse = await openai.responses.parse({
      ...multiTurnScorerParamsDefaults,
      ...params,
      input,
    });
    if (!openaResponse.output_parsed) {
      throw new Error(`Didn't get a valid output for input:\n${input}`);
    }
    scores.push({
      ...openaResponse.output_parsed,
      messages: newMessages,
    });
  };

  return {
    getScores: async () => {
      if (scoringError) throw scoringError;
      await scoringQueue.onIdle();
      if (scoringError) throw scoringError;
      return scores;
    },
    scoreTurn: (...args: Parameters<typeof scoreTurn>) => {
      if (scoringError) throw scoringError;
      scoringQueue.add(() => scoreTurn(...args));
    },
    conversation,
  };
}

type ScoreResult = { score: number; reason: string; messages: string[] };
type ScoreOutput = { scores: ScoreResult[] };

const resultScorers = {
  mean: {
    name: "mean",
    scorer: (result: { output: ScoreOutput }) => ({
      score: 0.01 * R.meanBy(result.output.scores, (s) => s.score),
      metadata: { allScores: result.output.scores },
    }),
  },
  median: {
    name: "median",
    scorer: (result: { output: ScoreOutput }) => ({
      score:
        0.01 *
        R.pipe(
          result.output.scores,
          R.sortBy((s) => s.score),
          R.filter((_, i, { length }) => Math.abs(length / 2 - i) < 1), // either one or two middle items
          R.meanBy((s) => s.score),
        ),
      metadata: { allScores: result.output.scores },
    }),
  },
  min: {
    name: "min",
    scorer: (result: { output: ScoreOutput }) => ({
      score: 0.01 * (R.firstBy(result.output.scores, (s) => s.score)?.score ?? 0),
      metadata: { allScores: result.output.scores },
    }),
  },
};

const renderColumns = (result: { output: ScoreOutput }) =>
  result.output.scores.map((s, i) => ({
    label: `turn ${i + 1}`,
    value: [...s.messages, `[${s.score}%] ${s.reason}`].join("\n\n"),
  }));

export const multiTurnScorer = Object.assign(_multiTurnScorer, {
  ...resultScorers,
  renderColumns,
});
