import { defineAppCliConfig } from "@iterate-com/shared/apps/cli";

export default defineAppCliConfig({
  remote: {
    baseUrlEnvVar: "SEMAPHORE_BASE_URL",
    defaultBaseUrl: "https://semaphore.iterate.com",
    resolveHeaders: ({ env }) => {
      const token =
        env.SEMAPHORE_API_KEY?.trim() ||
        env.SEMAPHORE_API_TOKEN?.trim() ||
        env.APP_CONFIG_SHARED_API_SECRET?.trim() ||
        readSharedApiSecretFromAppConfig(env.APP_CONFIG);

      if (!token) {
        throw new Error(
          "Semaphore rpc commands require SEMAPHORE_API_KEY, SEMAPHORE_API_TOKEN, APP_CONFIG_SHARED_API_SECRET, or APP_CONFIG.sharedApiSecret.",
        );
      }

      return {
        authorization: `Bearer ${token}`,
      };
    },
  },
});

function readSharedApiSecretFromAppConfig(rawValue: string | undefined) {
  if (!rawValue?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawValue) as { sharedApiSecret?: unknown };
    return typeof parsed.sharedApiSecret === "string" ? parsed.sharedApiSecret.trim() : undefined;
  } catch {
    return undefined;
  }
}
