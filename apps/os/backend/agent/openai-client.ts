import { OpenAI } from "openai";
import invariant from "tiny-invariant";
import { waitUntil } from "../../env.ts";
import { PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import { getBraintrustLogger } from "../utils/braintrust-client.ts";
import { posthogOpenAIWrapper } from "./posthog-openai-wrapper.ts";
import { braintrustOpenAIWrapper } from "./braintrust-wrapper.ts";
import { createRecordReplayFetch, type RecordReplayMode } from "./openai-record-replay-fetch.ts";

export type { RecordReplayMode };

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
    projectName: string;
    traceId: string;
  };
  braintrust?: {
    projectName?: string;
    getBraintrustParentSpanExportedId: () => Promise<string>;
  };
  estateName: string;
  /**
   * Optional record/replay configuration for e2e tests.
   * When set, the OpenAI client will use a custom fetch that either:
   * - 'record': Makes real requests and saves responses to the fixture server
   * - 'replay': Serves responses from the fixture server without hitting OpenAI
   * - 'passthrough': Normal behavior (no recording/replaying)
   */
  recordReplay?: {
    mode: RecordReplayMode;
    fixtureServerUrl: string;
    testName: string;
  };
}): Promise<OpenAI> {
  const { env } = opts;

  const openAIKey = env.OPENAI_API_KEY;
  invariant(openAIKey, "OPENAI_API_KEY is missing from environment");

  // Create custom fetch if record/replay is enabled
  const customFetch =
    opts.recordReplay && opts.recordReplay.mode !== "passthrough"
      ? createRecordReplayFetch(opts.recordReplay)
      : undefined;

  let openai = new OpenAI({
    apiKey: openAIKey,
    fetch: customFetch,
  });

  if (opts.posthog) {
    invariant(env.POSTHOG_PUBLIC_KEY, "POSTHOG_PUBLIC_KEY is missing from environment");
    const posthogClient = new PosthogCloudflare(
      { waitUntil },
      { estateName: opts.estateName, projectName: opts.posthog.projectName },
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
