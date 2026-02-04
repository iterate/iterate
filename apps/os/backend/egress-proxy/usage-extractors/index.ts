/**
 * Usage Extractors Registry
 */

import { AnthropicExtractor } from "./anthropic.ts";
import { OpenAIExtractor } from "./openai.ts";
import { ReplicateExtractor } from "./replicate.ts";
import type { MeterDefinition, UsageExtractor } from "./types.ts";

export type { ExtractedUsage, MeterDefinition, StreamProcessor, UsageExtractor } from "./types.ts";

const extractors: UsageExtractor[] = [
  new OpenAIExtractor(),
  new AnthropicExtractor(),
  new ReplicateExtractor(),
];

export function getExtractorForUrl(url: URL): UsageExtractor | null {
  return extractors.find((e) => e.matches(url)) ?? null;
}

export function getAllMeterDefinitions(): MeterDefinition[] {
  // Dedupe by eventName
  const seen = new Set<string>();
  const meters: MeterDefinition[] = [];
  for (const extractor of extractors) {
    for (const meter of extractor.meters) {
      if (!seen.has(meter.eventName)) {
        seen.add(meter.eventName);
        meters.push(meter);
      }
    }
  }
  return meters;
}
