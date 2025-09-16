import { initLogger } from "braintrust/browser";
import { OpenAI } from "openai";
import invariant from "tiny-invariant";
import { braintrustOpenAIWrapper } from "./braintrust-wrapper.ts";
import { PosthogCloudflare } from "./posthog-cloudflare.ts";
import { posthogOpenAIWrapper } from "./posthog-openai-wrapper.ts";

// need to keep an active reference to the logger...
let _braintrustLogger: ReturnType<typeof initLogger> | null = null;
let _posthogClient: PosthogCloudflare | null = null;

export function getBraintrustLogger(opts: { braintrustKey: string; projectName: string }) {
  const { braintrustKey, projectName } = opts;
  // for some reason, caching breaks this, so let's create a new logger every time
  return (_braintrustLogger = initLogger({
    projectName,
    apiKey: braintrustKey,
  }));
}

/**
 * Return a singleton OpenAI client wrapped in Braintrust and PostHog.
 *
 * @param opts.env – Environment object containing required secrets.
 * @param opts.projectName – Override project name (optional).
 * @param opts.braintrustParentSpanExportedId – Braintrust trace ID for correlation
 */
export async function openAIProvider(opts: {
  posthog: {
    traceId: string;
  };
  env: {
    BRAINTRUST_API_KEY: string | null;
    OPENAI_API_KEY: string;
    POSTHOG_PUBLIC_KEY?: string;
  };
  projectName?: string;
  braintrustParentSpanExportedId?: string;
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
    // TODO: How do we get the estate and environment?
    _posthogClient = new PosthogCloudflare({ waitUntil }, { estate: "TODO: Add estate", environment: "TODO: Add environment" });
    openai = posthogOpenAIWrapper(openai, _posthogClient!, opts.posthog);
  }

  // Apply Braintrust wrapper on top
  if (braintrustKey) {
    // Note: braintrustParentSpanExportedId is created and cached in agent state in apps/platform/backend/worker.ts
    // The Span is created with the Durable Object Name, just like trace.traceId, and so traceId is not needed here.
    getBraintrustLogger({ braintrustKey, projectName: opts.projectName || "iterate" }); // ensure logger is initialized
    openai = braintrustOpenAIWrapper(openai, opts.braintrustParentSpanExportedId);
  }

  return openai;
}
