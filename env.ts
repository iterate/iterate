export type CloudflareEnv = Env & {
  BASE_URL: "https://platform.iterate.com";
  OPENAI_API_KEY: string;
  POSTHOG_API_KEY: string;
  BRAINTRUST_API_KEY: string;
  POSTHOG_PUBLIC_KEY: string;
}