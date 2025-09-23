import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  buildDirectory: "dist",
  appDirectory: "backend",
  future: {
    unstable_viteEnvironmentApi: true,
  },
} satisfies Config;
