import { defineConfig, contextRulesFromFiles } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [...contextRulesFromFiles("rules/**/*.md")],
});
export default config;
