import { defineAppCliConfig } from "@iterate-com/shared/apps/cli";

export default defineAppCliConfig({
  remote: {
    baseUrlEnvVar: "EVENTS_BASE_URL",
    defaultBaseUrl: "https://events.iterate.com",
  },
});
