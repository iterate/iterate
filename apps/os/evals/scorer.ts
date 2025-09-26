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
  const scores: { reason: string; score: number }[] = [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const conversation: string[] = [];

  const scoreLatest = async (newMessages: string[], expectation: string) => {
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
    scores.push(openaResponse.output_parsed);
  };

  const addScore = async (conversation: string[], expectation: string) => {
    const input = dedent`
      ${conversation.join("\n")}

      expectation: ${expectation}
    `;
    const openaResponse = await openai.responses.parse({
      ...multiTurnScorerParamsDefaults,
      ...params,
      input,
    });
    if (!openaResponse.output_parsed) {
      throw new Error(`Didn't get a valid output for input:\n${input}`);
    }
    scores.push(openaResponse.output_parsed);
  };

  return {
    addScore,
    scores: {
      raw: scores,
      // precalculated useful aggregations
      aggregated: {
        mean: {
          score: 0.01 * (R.meanBy(scores, (s) => s.score) ?? 0),
          metadata: { allScores: scores },
        },
        median: {
          score:
            0.01 *
            R.pipe(
              scores,
              R.sortBy((s) => s.score),
              R.filter((_, i, { length }) => Math.abs(length / 2 - i) < 1), // either one or two middle items
              R.meanBy((s) => s.score),
            ),
          metadata: { allScores: scores },
        },
        min: {
          score: 0.01 * (R.firstBy(scores, (s) => s.score)?.score ?? 0),
          metadata: { allScores: scores },
        },
      },
    },
    scoreLatest,
    conversation,
  };
}

type MultiTurnScorer = ReturnType<typeof _multiTurnScorer>;
function getScorer<T extends keyof MultiTurnScorer["scores"]["aggregated"]>(name: T) {
  return {
    name,
    scorer: (result: { output: { scores: MultiTurnScorer["scores"] } }) =>
      result.output.scores.aggregated[name],
  };
}

export const multiTurnScorer = Object.assign(_multiTurnScorer, {
  mean: getScorer("mean"),
  median: getScorer("median"),
  min: getScorer("min"),
});
