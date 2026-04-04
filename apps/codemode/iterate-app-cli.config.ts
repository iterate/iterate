import { defineAppCliConfig } from "@iterate-com/shared/apps/cli";

export default defineAppCliConfig({
  remote: {
    baseUrlEnvVar: "CODEMODE_BASE_URL",
  },
});
