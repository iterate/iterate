import type OpenAI from "openai";
import { SELF_AGENT_DISTINCT_ID, type PosthogCloudflare } from "../utils/posthog-cloudflare.ts";
import { formatItemsForObservability } from "../utils/observability-formatter.ts";
import { logger } from "../tag-logger.ts";

// Global trace storage for conversation continuity
const _traceStorage = new Map<
  string,
  {
    traceId: string;
    generationCount: number;
  }
>();

/**
 * Wraps an OpenAI client with PostHog tracking.
 * This prevents conflicts when used together with the braintrust wrapper.
 */
export function posthogOpenAIWrapper(
  openai: OpenAI,
  posthog: PosthogCloudflare,
  opts: { traceId: string },
): OpenAI {
  const { traceId } = opts;

  // Helper function to send PostHog event with comprehensive data
  const sendPostHogGenerationEventWithFullData = ({
    input,
    output,
    usage,
    model,
    metadata,
    timingMetrics,
  }: {
    input: OpenAI.Responses.ResponseCreateParamsStreaming;
    output: OpenAI.Responses.ResponseOutputItem[];
    usage: OpenAI.Responses.ResponseUsage | null;
    model: string;
    metadata: Record<string, unknown>;
    timingMetrics: { startTime: number; timeToFirstToken: number };
  }) => {
    posthog.track({
      event: "$ai_generation",
      distinctId: SELF_AGENT_DISTINCT_ID(posthog.estateMeta.estateName),
      properties: {
        // standard posthog LLM fields
        $ai_model: model,
        $ai_provider: "openai",
        $ai_base_url: "https://api.openai.com/v1/responses",
        $ai_trace_id: traceId,

        // input/output data
        $ai_input:
          typeof input.input === "string"
            ? input.input
            : input.input
              ? formatItemsForObservability(input.input)
              : [],
        $ai_output_choices: [output],
        $ai_function_calls: output.filter((o) => o.type === "function_call"),
        $ai_tools: input.tools,

        // usage metrics
        $ai_input_tokens: usage?.input_tokens,
        $ai_output_tokens: usage?.output_tokens,
        $ai_total_tokens: usage?.total_tokens,
        $ai_cached_tokens: usage?.input_tokens_details?.cached_tokens,

        // timing metrics
        $ai_latency: timingMetrics.timeToFirstToken,
        $ai_start_time: timingMetrics.startTime,

        // additional metadata
        trace_id: traceId,
        model_metadata: metadata,

        // generation metadata for debugging
        generation_number: (() => {
          for (const trace of Array.from(_traceStorage.values())) {
            if (trace.traceId === traceId) {
              return trace.generationCount;
            }
          }
          return 1;
        })(),

        // posthog parent_id for proper trace nesting (if this is a continuation)
        ...(() => {
          for (const trace of Array.from(_traceStorage.values())) {
            if (trace.traceId === traceId && trace.generationCount > 1) {
              return { parent_id: `${traceId}_gen_${trace.generationCount - 1}` };
            }
          }
          return {};
        })(),
      },
    });
  };

  // Use the same proxy pattern as Braintrust to avoid conflicts
  return new Proxy(openai, {
    get(target, prop) {
      if (prop !== "responses") {
        return target[prop as keyof typeof target];
      }

      return new Proxy(target.responses, {
        get(target, prop) {
          if (prop !== "stream") {
            return target[prop as keyof typeof target];
          }

          // Intercept the stream method call (same pattern as Braintrust)
          const _stream = target[prop];
          return <T extends OpenAI.Responses.ResponseCreateParamsStreaming>(
            ...args: Parameters<typeof _stream<T>>
          ): ReturnType<typeof _stream<T>> => {
            const [params] = args;
            const res = target[prop](...args);

            // Create our own wrapped generator - SAME pattern as Braintrust
            const wrappedGen = () => {
              const it = res[Symbol.asyncIterator]();
              let startTime: number | undefined;
              let timeToFirstToken: number | undefined;

              async function posthogLog() {
                const { model, metadata, usage, output } = await res.finalResponse();

                if (process.env.DEBUG_POSTHOG) {
                  logger.log(`[PostHog] Logging trace ${traceId}: ${output.length} messages`);
                }

                sendPostHogGenerationEventWithFullData({
                  input: params,
                  output,
                  usage: usage ?? null,
                  model,
                  metadata: metadata ?? {},
                  timingMetrics: {
                    startTime: startTime ?? 0,
                    timeToFirstToken: timeToFirstToken ?? 0,
                  },
                });
              }

              return new Proxy(it, {
                get(target, prop) {
                  if (prop === "next") {
                    return async () => {
                      if (!startTime) {
                        startTime = Date.now() / 1000;
                      }
                      const { done, value } = await target.next();
                      if (!timeToFirstToken) {
                        timeToFirstToken = Date.now() / 1000 - startTime;
                      }
                      if (done) {
                        await posthogLog();
                      }
                      return { done, value };
                    };
                  }
                  return target[prop as keyof typeof target];
                },
              });
            };

            // Return the original response with our wrapped iterator
            // Make the proxy completely transparent for method calls to preserve 'this' binding
            return new Proxy(res, {
              get(target, prop) {
                if (prop === Symbol.asyncIterator) {
                  return wrappedGen;
                }
                // For method calls, ensure proper 'this' binding to avoid proxy interference
                const value = target[prop as keyof typeof target];
                if (typeof value === "function") {
                  // Bind the method to the original target to preserve private member access
                  return value.bind(target);
                }
                return value;
              },
            });
          };
        },
      });
    },
  });
}
