import { startSpan } from "braintrust/browser";
import type OpenAI from "openai";
import {
  formatInputForObservability,
  formatItemsForObservability,
} from "../utils/observability-formatter.ts";

export interface OpenAIResponse {
  messages: OpenAI.Responses.ResponseInputItem[];
  metadata: Record<string, unknown>;
  // Add usage information from OpenAI
  usage?: OpenAI.Responses.ResponseUsage;
  // Track timing information
  timingMetrics: {
    startTime: number;
    timeToFirstToken: number;
  };
}

export async function logLLMRequestToBraintrust(params: {
  input: OpenAI.Responses.ResponseCreateParamsStreaming;
  response: OpenAIResponse;
  braintrustParentSpanExportedId: string | undefined;
}) {
  const { input, response, braintrustParentSpanExportedId } = params;

  const span = startSpan({
    name: "LLM Request",
    type: "llm",
    startTime: response.timingMetrics.startTime,
    ...(braintrustParentSpanExportedId ? { parent: braintrustParentSpanExportedId } : {}),
  });

  const {
    input: _inputMessages,
    instructions: _includedInFormattedInput,
    ...inputMetadata
  } = input;

  span.log({
    input: formatInputForObservability(input),
    output: formatItemsForObservability(response.messages),
    metadata: {
      ...inputMetadata,
      ...response.metadata,
    },
    metrics: {
      end: Date.now() / 1000,
      tokens: response.usage?.total_tokens,
      prompt_tokens: response.usage?.input_tokens,
      completion_tokens: response.usage?.output_tokens,
      prompt_cached_tokens: response.usage?.input_tokens_details.cached_tokens,
      time_to_first_token: response.timingMetrics.timeToFirstToken,
    },
  });
}

/**
 *
 * Addresses two issues:
 * - Lets us put braintrust logs under a parent span
 * - Converts our agent core format into a format that braintrust can understand
 *
 * @param openai The openai client to wrap: if it's wrapped in braintrust already, we will get duplicate logs, so this is a replacement
 *
 * @param braintrustParentSpanExportedId The span export of the parent span (optional)
 *
 * @returns A new openai client that is wrapped in braintrust
 */
export function braintrustOpenAIWrapper({
  openai,
  getBraintrustParentSpanExportedId,
  waitUntil,
}: {
  openai: OpenAI;
  getBraintrustParentSpanExportedId: () => Promise<string>;
  waitUntil: (promise: Promise<void>) => void;
}) {
  // proxy the openai.responses.stream method
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
          const _stream = target[prop];
          return <T extends OpenAI.Responses.ResponseCreateParamsStreaming>(
            ...args: Parameters<typeof _stream<T>>
          ): ReturnType<typeof _stream<T>> => {
            const res = target[prop](...args);

            // return a new generator which yields the original chunks
            const wrappedGen = () => {
              const it = res[Symbol.asyncIterator]();
              const input = args[0];
              let startTime = 0,
                timeToFirstToken = 0;
              async function braintrustLog() {
                const options = await res.finalResponse();
                const { model, metadata, usage, output } = options;
                await logLLMRequestToBraintrust({
                  input,
                  response: {
                    messages: output,
                    metadata: {
                      ...metadata,
                      model,
                    },
                    usage,
                    timingMetrics: {
                      startTime: startTime ?? 0,
                      timeToFirstToken: timeToFirstToken ?? 0,
                    },
                  },
                  braintrustParentSpanExportedId: await getBraintrustParentSpanExportedId(),
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
                        waitUntil(braintrustLog());
                      }
                      return { done, value };
                    };
                  }
                  return target[prop as keyof typeof target];
                },
              });
            };

            // attach wrapped generator onto the result and return it
            return new Proxy(res, {
              get(target, prop) {
                if (prop === Symbol.asyncIterator) {
                  return wrappedGen;
                }
                return target[prop as keyof typeof target];
              },
            });
          };
        },
      });
    },
  });
}
