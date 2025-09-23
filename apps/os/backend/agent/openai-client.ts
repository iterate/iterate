import { OpenAI } from "openai";
import invariant from "tiny-invariant";
import { PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import { getBraintrustLogger } from "../utils/braintrust-client.ts";
import { posthogOpenAIWrapper } from "./posthog-openai-wrapper.ts";
import { braintrustOpenAIWrapper } from "./braintrust-wrapper.ts";

/**
 * Return a singleton OpenAI client wrapped in Braintrust and PostHog.
 */
export async function openAIProvider(opts: {
  env: {
    BRAINTRUST_API_KEY: string | null;
    OPENAI_API_KEY: string;
    POSTHOG_PUBLIC_KEY?: string;
  };
  posthog: {
    estateName: string;
    environmentName: string;
    traceId: string;
  };
  braintrust?: {
    projectName?: string;
    getBraintrustParentSpanExportedId?: () => Promise<string>;
  };
}): Promise<OpenAI> {
  const { env } = opts;
  const braintrustKey = env.BRAINTRUST_API_KEY;
  invariant(
    braintrustKey ?? braintrustKey === null,
    "BRAINTRUST_API_KEY is missing from environment",
  );

  // Optional upstream OpenAI key: allow Braintrust proxy without it for now
  const openAIKey = env.OPENAI_API_KEY;
  invariant(openAIKey, "OPENAI_API_KEY is missing from environment");

  // Create standard OpenAI client
  let openai = new OpenAI({
    apiKey: openAIKey,
  });

  if (env.POSTHOG_PUBLIC_KEY) {
    const waitUntil = await import("cloudflare:workers")
      .then((m) => m.waitUntil)
      .catch(() => (_promise: Promise<void>) => {});
    const posthogClient = new PosthogCloudflare(
      { waitUntil },
      { estate: opts.posthog.estateName, environment: opts.posthog.environmentName },
    );
    openai = posthogOpenAIWrapper(openai, posthogClient, opts.posthog);
  }

  // Apply Braintrust wrapper on top
  if (braintrustKey && opts.braintrust) {
    // note: this second import is cached if the first one happened already
    const waitUntil = await import("cloudflare:workers")
      .then((m) => m.waitUntil)
      .catch(() => (_promise: Promise<void>) => {});
    getBraintrustLogger({
      braintrustKey,
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
