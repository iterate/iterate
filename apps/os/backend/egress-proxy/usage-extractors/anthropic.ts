/**
 * Anthropic Usage Extractor
 */

import { logger } from "../../tag-logger.ts";
import type { ExtractedUsage, MeterDefinition, StreamProcessor, UsageExtractor } from "./types.ts";

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

class AnthropicProcessor implements StreamProcessor {
  private buffer = "";
  private isSSE: boolean;
  private model: string | undefined;
  private requestId: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;

  constructor(contentType: string) {
    this.isSSE = contentType.includes("text/event-stream");
  }

  write(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    this.buffer += text;

    if (this.isSSE) {
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();

        try {
          const event = JSON.parse(data) as {
            type: string;
            message?: { id: string; model: string; usage: { input_tokens: number } };
            usage?: { output_tokens: number };
          };

          if (event.type === "message_start" && event.message) {
            this.requestId = event.message.id;
            this.model = event.message.model;
            this.inputTokens = event.message.usage.input_tokens;
          }

          if (event.type === "message_delta" && event.usage) {
            this.outputTokens = event.usage.output_tokens;
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  end(): ExtractedUsage | null {
    if (!this.isSSE && this.buffer) {
      try {
        const response = JSON.parse(this.buffer) as {
          id: string;
          model: string;
          usage: AnthropicUsage;
        };
        if (response.usage) {
          return {
            provider: "anthropic",
            model: response.model,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            requestId: response.id,
          };
        }
      } catch (err) {
        logger.warn("Failed to parse Anthropic response", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.inputTokens !== undefined) {
      return {
        provider: "anthropic",
        model: this.model ?? "unknown",
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens ?? 0,
        requestId: this.requestId ?? `anthropic-${Date.now()}`,
      };
    }

    return null;
  }
}

export class AnthropicExtractor implements UsageExtractor {
  readonly provider = "anthropic";
  readonly meters: MeterDefinition[] = [
    {
      eventName: "llm_input_tokens",
      displayName: "LLM Input Tokens",
      unit: "tokens",
      direction: "input",
      costPerUnit: 0.000003,
    },
    {
      eventName: "llm_output_tokens",
      displayName: "LLM Output Tokens",
      unit: "tokens",
      direction: "output",
      costPerUnit: 0.000015,
    },
  ];

  // TODO make url + headers
  matches(url: URL): boolean {
    return url.hostname === "api.anthropic.com";
  }

  createProcessor(contentType: string): StreamProcessor {
    return new AnthropicProcessor(contentType);
  }
}
