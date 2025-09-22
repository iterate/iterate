import { defineConfig } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [
    {
      key: "sample-pirate",
      prompt: "You must always talk like a space privateer on meth.",
    },
  ],
});
export default config;
