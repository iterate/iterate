import { OpenAI } from "openai";
import invariant from "tiny-invariant";
import { waitUntil } from "cloudflare:workers";
import { PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import { getBraintrustLogger } from "../utils/braintrust-client.ts";
import { posthogOpenAIWrapper } from "./posthog-openai-wrapper.ts";
import { braintrustOpenAIWrapper } from "./braintrust-wrapper.ts";

/**
 * Return an OpenAI client wrapped in Braintrust and PostHog.
 */
export async function openAIProvider(opts: {
  env: {
    OPENAI_API_KEY: string;
    BRAINTRUST_API_KEY?: string;
    POSTHOG_PUBLIC_KEY?: string;
  };
  posthog?: {
    estateName: string;
    environmentName: string;
    traceId: string;
  };
  braintrust?: {
    projectName?: string;
    getBraintrustParentSpanExportedId: () => Promise<string>;
  };
}): Promise<OpenAI> {
  const { env } = opts;

  const openAIKey = env.OPENAI_API_KEY;
  invariant(openAIKey, "OPENAI_API_KEY is missing from environment");

  let openai = new OpenAI({
    apiKey: openAIKey,
  });

  if (opts.posthog) {
    invariant(env.POSTHOG_PUBLIC_KEY, "POSTHOG_PUBLIC_KEY is missing from environment");
    const posthogClient = new PosthogCloudflare(
      { waitUntil },
      { estate: opts.posthog.estateName, environment: opts.posthog.environmentName },
    );
    openai = posthogOpenAIWrapper(openai, posthogClient, opts.posthog);
  }

  if (opts.braintrust) {
    invariant(env.BRAINTRUST_API_KEY, "BRAINTRUST_API_KEY is missing from environment");
    getBraintrustLogger({
      braintrustKey: env.BRAINTRUST_API_KEY,
      projectName: opts.braintrust.projectName,
    });
    openai = braintrustOpenAIWrapper({
      openai,
      getBraintrustParentSpanExportedId: opts.braintrust.getBraintrustParentSpanExportedId,
      waitUntil,
    });
  }

  return openai;
}
