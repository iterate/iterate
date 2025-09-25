import { evalite } from "evalite";
import * as autoevals from "autoevals";

evalite("deterministic hello world", {
  data: async () => {
    return [
      { input: "Hello", expected: "Hello world" },
      { input: "Goodbye", expected: "Goodbye world" },
      { input: "How are you", expected: "Huh?" },
      { input: "Bonjour", expected: "Bonjour tous le monde" }, // this will fail
    ];
  },
  task: async (input) => {
    if (input === "Hello") return "Hello world";
    if (input === "Goodbye") return "Goodbye world";
    return "Huh?";
  },
  scorers: [autoevals.Levenshtein],
});
