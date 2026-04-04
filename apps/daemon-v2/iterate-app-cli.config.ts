import { defineAppCliConfig } from "@iterate-com/shared/apps/cli";

export default defineAppCliConfig({
  remote: {
    baseUrlEnvVar: "DAEMON_V2_BASE_URL",
  },
});
