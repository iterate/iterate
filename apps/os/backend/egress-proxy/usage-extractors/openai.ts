/**
 * OpenAI Usage Extractor
 */

import { logger } from "../../tag-logger.ts";
import type { ExtractedUsage, MeterDefinition, StreamProcessor, UsageExtractor } from "./types.ts";

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

class OpenAIProcessor implements StreamProcessor {
  private buffer = "";
  private isSSE: boolean;
  private usage: ExtractedUsage | null = null;
  private model: string | undefined;
  private requestId: string | undefined;

  constructor(contentType: string) {
    this.isSSE = contentType.includes("text/event-stream");
  }

  write(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    this.buffer += text;

    if (this.isSSE) {
      // Parse SSE events as complete lines arrive
      const lines = this.buffer.split("\n");
      // Keep incomplete last line in buffer
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as { id?: string; model?: string; usage?: OpenAIUsage };
          if (event.model) this.model = event.model;
          if (event.id) this.requestId = event.id;
          if (event.usage) {
            this.usage = {
              provider: "openai",
              model: this.model ?? "unknown",
              inputTokens: event.usage.prompt_tokens,
              outputTokens: event.usage.completion_tokens,
              requestId: this.requestId ?? `openai-${Date.now()}`,
            };
          }
        } catch {
          // Skip malformed events
        }
      }
    }
    // For non-SSE, we just accumulate in buffer and parse in end()
  }

  end(): ExtractedUsage | null {
    // For non-SSE JSON responses, parse the complete buffer
    if (!this.isSSE && this.buffer) {
      try {
        const response = JSON.parse(this.buffer) as {
          id: string;
          model: string;
          usage?: OpenAIUsage;
        };
        if (response.usage) {
          return {
            provider: "openai",
            model: response.model,
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            requestId: response.id,
          };
        }
      } catch (err) {
        logger.warn("Failed to parse OpenAI response", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // For SSE, return whatever we accumulated during streaming
    return this.usage;
  }
}

export class OpenAIExtractor implements UsageExtractor {
  readonly provider = "openai";
  readonly meters: MeterDefinition[] = [
    {
      eventName: "llm_input_tokens",
      displayName: "LLM Input Tokens",
      unit: "tokens",
      direction: "input",
      costPerUnit: 0.0000025,
    },
    {
      eventName: "llm_output_tokens",
      displayName: "LLM Output Tokens",
      unit: "tokens",
      direction: "output",
      costPerUnit: 0.00001,
    },
  ];

  matches(url: URL): boolean {
    return url.hostname === "api.openai.com";
  }

  createProcessor(contentType: string): StreamProcessor {
    return new OpenAIProcessor(contentType);
  }
}
