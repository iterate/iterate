import { startSpan } from "braintrust/browser";
import type OpenAI from "openai";

export interface OpenAIResponse {
  messages: OpenAI.Responses.ResponseOutputMessage[];
  functionCalls: OpenAI.Responses.ResponseFunctionToolCall[];
  metadata: Record<string, unknown>;
  // Add usage information from OpenAI
  usage?: OpenAI.Responses.ResponseUsage;
  // Track timing information
  timingMetrics: {
    startTime: number;
    timeToFirstToken: number;
  };
}

interface BraintrustMessage {
  role: "assistant" | "user" | "system" | "tool";
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface BraintrustOutput {
  output: string;
  messages?: BraintrustMessage[];
  metadata?: Record<string, unknown>;
  metrics?: {
    tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cached_tokens?: number;
    // estimated cost is calculated on braintrust using the model and token counts!
    time_to_first_token?: number;
  };
}

function convertOpenAIResponseToBraintrustOutput(response: OpenAIResponse): BraintrustOutput {
  // Extract the final output text (for the top-level output field)
  const assistantMessages = response.messages.filter((msg) => msg.role === "assistant");
  const finalMessage = assistantMessages
    .filter((msg) => {
      const hasContent = msg.content.some(
        (c) => c.type === "output_text" && c.text && c.text.trim().length > 0,
      );
      return hasContent && (msg.status === "completed" || !msg.status);
    })
    .pop(); // Get the last one for the output field

  const outputText =
    finalMessage?.content
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("")
      .trim() || "";

  // Convert ALL messages to Braintrust format (preserving the full conversation)
  const messages: BraintrustMessage[] = [];

  // Process all unique assistant messages
  const processedIds = new Set<string>();

  for (const msg of response.messages) {
    if (msg.type === "message" && msg.role === "assistant") {
      // Skip if we've already processed this ID with content
      if (msg.id && processedIds.has(msg.id)) {
        continue;
      }

      const content = msg.content
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("")
        .trim();

      // Only add messages with content
      if (content) {
        messages.push({
          role: "assistant",
          content,
        });
        if (msg.id) {
          processedIds.add(msg.id);
        }
      }
    }
  }

  // Add ALL function calls in order
  if (response.functionCalls && response.functionCalls.length > 0) {
    // Group function calls by their position in the conversation
    // For now, add them all as a single assistant message with tool_calls
    const toolCalls = response.functionCalls.map((fc) => ({
      id: fc.call_id,
      type: "function" as const,
      function: {
        name: fc.name,
        arguments: fc.arguments,
      },
    }));

    // Add assistant message with tool calls
    // @ts-expect-error - content is optional
    messages.push({
      role: "assistant",
      content: undefined,
      tool_calls: toolCalls,
    });
  }

  // Build the output object
  const output: BraintrustOutput = {
    output: outputText,
  };

  // Always include messages to preserve the full conversation
  if (messages.length > 0) {
    output.messages = messages;
  }

  // Add metadata if present
  if (response.metadata && Object.keys(response.metadata).length > 0) {
    output.metadata = response.metadata;
  }

  // Use actual OpenAI usage data if available, otherwise fallback to estimation
  if (response.usage) {
    const usage = response.usage;

    output.metrics = {
      tokens: usage.total_tokens,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      prompt_cached_tokens: usage.input_tokens_details.cached_tokens,
    };

    // Add cost estimation if model is provided
    // if (model) {
    //   output.metrics.estimated_cost = calculateEstimatedCost(usage, model);
    // }

    // Add timing metrics if available
    if (response.timingMetrics) {
      if (response.timingMetrics.timeToFirstToken) {
        output.metrics.time_to_first_token = response.timingMetrics.timeToFirstToken;
      }
    }
  }

  return output;
}

function formatContent(
  content:
    | string
    | OpenAI.Responses.ResponseInputMessageContentList
    | (OpenAI.Responses.ResponseOutputText | OpenAI.Responses.ResponseOutputRefusal)[],
) {
  return typeof content === "string"
    ? content
    : content
        .map(
          (
            // for some reason typescript can't figure this out
            c:
              | OpenAI.Responses.ResponseInputContent
              | OpenAI.Responses.ResponseOutputText
              | OpenAI.Responses.ResponseOutputRefusal,
          ) =>
            c.type === "input_text"
              ? c.text
              : c.type === "input_file"
                ? `File: ${c.file_id}`
                : c.type === "input_image"
                  ? `Image: ${c.file_id}`
                  : c.type === "output_text"
                    ? c.text
                    : c.type === "refusal"
                      ? `Refusal: ${c.refusal}`
                      : "",
        )
        .join("\n");
}

/**
 * Format OpenAI response for better Braintrust rendering
 */
function formatOpenAIInputForBraintrust(input: OpenAI.Responses.ResponseCreateParamsStreaming): {
  input: BraintrustMessage[];
  metadata: Record<string, unknown>;
} {
  // Handle complex OpenAI function calling format
  const messages: BraintrustMessage[] = [];

  // Add system message from instructions if present
  if (input.instructions) {
    messages.push({
      role: "system",
      content: input.instructions,
    });
  }

  // Process the input array
  for (const item of input.input || []) {
    if (typeof item === "string") {
      continue;
    }

    switch (item.type) {
      case "message":
        if (item.role === "developer") {
          messages.push({
            role: "system",
            content: `Developer message: ${formatContent(item.content)}`,
          });
        } else {
          messages.push({
            role: item.role,
            content: formatContent(item.content),
          });
        }
        break;
      case "function_call":
        messages.push({
          role: "assistant",
          content: "Assistant used TRPC procedure",
          tool_calls: [
            {
              id: item.call_id,
              type: "function",
              function: {
                name: item.name,
                arguments: item.arguments,
              },
            },
          ],
        });
        break;
      case "function_call_output":
        messages.push({
          role: "tool",
          content: item.output,
          tool_call_id: item.call_id,
        });
        break;
      // ...can add all the other cases here
    }
  }

  return {
    input: messages,
    metadata: {
      model: input.model,
    },
  };
}

export async function logLLMRequestToBraintrust(
  input: OpenAI.Responses.ResponseCreateParamsStreaming,
  response: OpenAIResponse,
  braintrustParentSpanExportedId: string | undefined,
  spanName = "LLM Request",
) {
  const span = startSpan({
    name: spanName,
    type: "llm",
    startTime: response.timingMetrics.startTime,
    ...(braintrustParentSpanExportedId ? { parent: braintrustParentSpanExportedId } : {}),
  });

  const formattedInput = formatOpenAIInputForBraintrust(input);
  const formattedOutput = convertOpenAIResponseToBraintrustOutput(response);

  span.log({
    input: formattedInput.input,
    output:
      formattedOutput.messages && formattedOutput.messages.length > 0
        ? formattedOutput.messages
        : formattedOutput.output,
    metadata: {
      ...formattedInput.metadata,
      ...formattedOutput.metadata,
    },
    metrics: {
      end: Date.now() / 1000,
      ...formattedOutput.metrics,
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
export function braintrustOpenAIWrapper(openai: OpenAI, braintrustParentSpanExportedId?: string) {
  // proxy the openai.responses.stream method
  return new Proxy(openai, {
    get(target, prop) {
      if (prop !== "responses") {
        // @ts-expect-error - prop is a string
        return target[prop];
      }
      return new Proxy(target.responses, {
        get(target, prop) {
          if (prop !== "stream") {
            // @ts-expect-error - prop is a string
            return target[prop];
          }
          const _stream = target[prop];
          return <T extends OpenAI.Responses.ResponseCreateParamsStreaming>(
            ...args: Parameters<typeof _stream<T>>
          ): ReturnType<typeof _stream<T>> => {
            const res = target[prop](...args);

            // return a new generator which yields the original chunks
            const wrappedGen = () => {
              const it = res[Symbol.asyncIterator]();
              const messages: OpenAI.Responses.ResponseOutputMessage[] = [];
              const functionCalls: OpenAI.Responses.ResponseFunctionToolCall[] = [];
              let startTime: number | undefined;
              let timeToFirstToken: number | undefined;
              const input = args[0];
              async function braintrustLog() {
                const options = await res.finalResponse();
                const { model, metadata, usage } = options;

                await logLLMRequestToBraintrust(
                  input,
                  // @ts-expect-error - prop is a string

                  {
                    messages,
                    functionCalls,
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
                  braintrustParentSpanExportedId,
                );
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
                        await braintrustLog();

                        return { done: true, value: undefined };
                      }

                      const chunk = value as OpenAI.Responses.ResponseStreamEvent;

                      switch (chunk.type) {
                        case "response.content_part.added": {
                          switch (chunk.part.type) {
                            case "output_text": {
                              messages.push({
                                id: chunk.item_id,
                                type: "message",
                                role: "assistant",
                                content: [
                                  {
                                    type: "output_text",
                                    text: chunk.part.text,
                                    annotations: chunk.part.annotations,
                                  },
                                ],
                                status: "completed",
                              } satisfies OpenAI.Responses.ResponseOutputMessage);
                              break;
                            }
                            case "refusal": {
                              messages.push({
                                id: chunk.item_id,
                                type: "message",
                                role: "assistant",
                                content: [
                                  {
                                    type: "refusal",
                                    refusal: chunk.part.refusal,
                                  },
                                ],
                                status: "completed",
                              } satisfies OpenAI.Responses.ResponseOutputMessage);
                              break;
                            }
                          }
                          break;
                        }
                        case "response.output_item.done": {
                          switch (chunk.item.type) {
                            case "function_call":
                              if (!chunk.item.call_id) {
                                throw new Error("Function call ID is required");
                              }
                              functionCalls.push({
                                ...chunk.item,
                              } satisfies OpenAI.Responses.ResponseFunctionToolCall);
                              break;
                            case "message": {
                              messages.push(
                                chunk.item satisfies OpenAI.Responses.ResponseOutputMessage,
                              );
                              break;
                            }
                          }
                          break;
                        }
                        // can add more cases later
                      }
                      return { done: false, value: chunk };
                    };
                  }
                  // @ts-expect-error - prop is a string
                  return target[prop];
                },
              });
            };

            // attach wrapped generator onto the result and return it
            return new Proxy(res, {
              get(target, prop) {
                if (prop === Symbol.asyncIterator) {
                  return wrappedGen;
                }
                // @ts-expect-error - prop is a string
                return target[prop];
              },
            });
          };
        },
      });
    },
  });
}
