import { evalite } from "evalite";
import { Levenshtein } from "autoevals";

evalite("My Eval", {
  // A function that returns an array of test data
  // - TODO: Replace with your test data
  data: async () => {
    return [{ input: "Hello", expected: "Hello World!" }];
  },
  // The task to perform
  // - TODO: Replace with your LLM call
  task: async (input) => {
    return input + " World";
  },
  // The scoring methods for the eval
  scorers: [
    Levenshtein,
    {
      name: "exact_match",
      scorer: ({ output, expected }) => {
        return {
          score: output === expected ? 1 : 0,
          metadata: {
            description: "only the best will do",
            foo: "bar;",
            nested: {
              more: {
                deeply: {
                  x: 123,
                },
              },
            },
          },
        };
      },
      description: "Exact match",
    },
  ],
});
