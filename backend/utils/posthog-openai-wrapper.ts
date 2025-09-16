import type OpenAI from "openai";
import { match } from "ts-pattern";
import { SELF_AGENT_DISTINCT_ID, type PosthogCloudflare } from "./posthog-cloudflare.ts";

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
  const sendPostHogEventWithFullData = (
    input: OpenAI.Responses.ResponseCreateParamsStreaming,
    messages: OpenAI.Responses.ResponseOutputMessage[],
    functionCalls: OpenAI.Responses.ResponseFunctionToolCall[],
    usage: OpenAI.Responses.ResponseUsage | null,
    model: string,
    metadata: Record<string, unknown>,
    timingMetrics: { startTime: number; timeToFirstToken: number },
  ) => {
    // Use PostHog-specific input formatting (preserves original roles)
    const formattedInput = formatOpenAIInputForPostHog(input);

    // Convert output messages to PostHog format - aggregate all text from assistant messages
    const allAssistantMessages = messages.filter(
      (msg) => msg.type === "message" && msg.role === "assistant",
    );

    // Combine all assistant message content into a single response
    const combinedContent = allAssistantMessages
      .flatMap((msg) => msg.content)
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("")
      .trim();

    // If we have direct text content, use that. Otherwise, extract from function calls
    let outputMessages: Array<{ role: string; content: string }> = [];
    if (combinedContent) {
      outputMessages = [
        {
          role: "assistant",
          content: combinedContent,
        },
      ];
    } else if (functionCalls.length > 0) {
      // Extract meaningful content from function calls for display
      const functionCallContent = functionCalls
        .map((fc) => {
          try {
            const args = JSON.parse(fc.arguments);
            // For sendSlackMessage, extract the text being sent
            if (fc.name === "sendSlackMessage" && args.text) {
              return args.text;
            }
            // For other function calls, show function name and key arguments
            return `${fc.name}(${Object.keys(args).join(", ")})`;
          } catch {
            return `${fc.name}()`;
          }
        })
        .join("; ");

      if (functionCallContent) {
        outputMessages = [
          {
            role: "assistant",
            content: functionCallContent,
          },
        ];
      }
    }

    // We don't use the posthog/ai sdk while an issue is being fixed: https://github.com/PostHog/posthog/issues/36507
    posthog.track("$ai_generation", SELF_AGENT_DISTINCT_ID, {
      // Standard PostHog LLM fields
      $ai_model: model,
      $ai_provider: "openai",
      $ai_base_url: "https://api.openai.com/v1/responses",
      $ai_trace_id: traceId,

      // Input data (same as Braintrust)
      $ai_input: formattedInput.input,

      // Output data (format as choices array like target)
      $ai_output_choices: outputMessages,

      // Function calls (format to match target structure)
      $ai_function_calls: functionCalls.map((fc) => ({
        id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        call_id: fc.call_id,
        name: fc.name,
        arguments: fc.arguments,
        status: "completed",
        type: "function_call",
      })),

      // Usage metrics (same as Braintrust)
      $ai_input_tokens: usage?.input_tokens,
      $ai_output_tokens: usage?.output_tokens,
      $ai_total_tokens: usage?.total_tokens,
      $ai_cached_tokens: usage?.input_tokens_details?.cached_tokens,

      // Timing metrics (same as Braintrust)
      $ai_latency: timingMetrics.timeToFirstToken,
      $ai_start_time: timingMetrics.startTime,

      // Additional metadata
      trace_id: traceId,
      message_format: "comprehensive_braintrust_compatible",
      model_metadata: metadata,

      // Generation metadata for debugging
      generation_number: (() => {
        for (const trace of Array.from(_traceStorage.values())) {
          if (trace.traceId === traceId) {
            return trace.generationCount;
          }
        }
        return 1;
      })(),

      // PostHog parent_id for proper trace nesting (if this is a continuation)
      ...(() => {
        for (const trace of Array.from(_traceStorage.values())) {
          if (trace.traceId === traceId && trace.generationCount > 1) {
            return { parent_id: `${traceId}_gen_${trace.generationCount - 1}` };
          }
        }
        return {};
      })(),
    });
  };

  // Format input messages for PostHog (preserving original roles unlike Braintrust)
  const formatOpenAIInputForPostHog = (input: OpenAI.Responses.ResponseCreateParamsStreaming) => {
    const messages: Array<{
      role: string;
      content?: string;
      tool_calls?: any[];
      tool_call_id?: string;
    }> = [];

    // Add system message from instructions if present
    if (input.instructions) {
      messages.push({
        role: "system",
        content: input.instructions,
      });
    }

    // Process the input array (preserving original message roles for PostHog display)
    for (const item of input.input || []) {
      if (typeof item === "string") {
        continue;
      }

      switch (item.type) {
        case "message": {
          // Preserve original roles for PostHog display (including developer role)
          const displayRole = item.role; // Keep all roles as-is
          messages.push({
            role: displayRole,
            content: formatContent(item.content),
          });
          break;
        }
        case "function_call":
          // Add function call as assistant message with tool_calls
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
          // Add function result as tool message
          messages.push({
            role: "tool",
            content: item.output,
            tool_call_id: item.call_id,
          });
          break;
      }
    }

    return {
      input: messages,
      metadata: {
        model: input.model,
      },
    };
  };

  // Content formatting function (same as Braintrust)
  const formatContent = (
    content: (
      | OpenAI.Responses.ResponseOutputMessage
      | OpenAI.Responses.EasyInputMessage
      | OpenAI.Responses.ResponseInputItem.Message
    )["content"],
  ) => {
    if (typeof content === "string") {
      return content;
    }

    return content
      .map((c: (typeof content)[number]) =>
        match(c)
          .with({ type: "input_text" }, (item) => item.text)
          .with({ type: "input_file" }, (item) => `File: ${item.file_id}`)
          .with({ type: "input_image" }, (item) => `Image: ${item.file_id}`)
          .with({ type: "output_text" }, (item) => item.text)
          .with({ type: "refusal" }, (item) => `Refusal: ${item.refusal}`)
          .otherwise(() => ""),
      )
      .join("\n");
  };

  // Use the same proxy pattern as Braintrust to avoid conflicts
  return new Proxy(openai, {
    get(target, prop) {
      if (prop !== "responses") {
        // @ts-ignore - string / symbol index signature
        return target[prop];
      }

      return new Proxy(target.responses, {
        get(target, prop) {
          if (prop !== "stream") {
          // @ts-ignore - string / symbol index signature
            return target[prop];
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
              const messages: OpenAI.Responses.ResponseOutputMessage[] = [];
              const functionCalls: OpenAI.Responses.ResponseFunctionToolCall[] = [];
              let startTime: number | undefined;
              let timeToFirstToken: number | undefined;
              let streamCompleted = false;

              async function posthogLog() {
                let model: string;
                let metadata: Record<string, unknown> | null;
                let usage: any;

                try {
                  const options = await res.finalResponse();
                  ({ model, metadata, usage } = options);
                } catch (error) {
                  if (process.env.DEBUG_POSTHOG) {
                    console.error("[PostHog] Error accessing finalResponse:", error);
                  }
                  // Use fallback values when finalResponse fails
                  model = "unknown";
                  metadata = { error: "finalResponse_access_failed" };
                  usage = null;
                }

                if (process.env.DEBUG_POSTHOG) {
                  console.log(
                    `[PostHog] Logging trace ${traceId}: ${messages.length} messages, ${functionCalls.length} calls`,
                  );
                }

                sendPostHogEventWithFullData(
                  params,
                  messages,
                  functionCalls,
                  usage ?? null,
                  model,
                  metadata ?? {},
                  {
                    startTime: startTime ?? 0,
                    timeToFirstToken: timeToFirstToken ?? 0,
                  },
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
                        if (!streamCompleted) {
                          streamCompleted = true;
                          try {
                            await posthogLog();
                          } catch (error) {
                            if (process.env.DEBUG_POSTHOG) {
                              console.error("[PostHog] Error in posthogLog:", error);
                            }
                          }
                        }
                        return { done: true, value: undefined };
                      }

                      const chunk = value;

                      // Process chunks EXACTLY like Braintrust
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
                              });
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
                              });
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
                              });
                              break;
                            case "message": {
                              messages.push(chunk.item);
                              break;
                            }
                          }
                          break;
                        }
                      }
                      return { done: false, value: chunk };
                    };
                  }
                // @ts-ignore - string / symbol index signature
                  return target[prop];
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
                // @ts-ignore - string / symbol index signature
                const value = target[prop];
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
