import { defineAppCliConfig } from "@iterate-com/shared/apps/cli";

export default defineAppCliConfig({
  remote: {
    baseUrlEnvVar: "EXAMPLE_BASE_URL",
    defaultBaseUrl: "https://example.iterate.com",
  },
});
