/**
 * Replicate Usage Extractor
 */

import { logger } from "../../tag-logger.ts";
import type { ExtractedUsage, MeterDefinition, StreamProcessor, UsageExtractor } from "./types.ts";

interface ReplicatePrediction {
  id: string;
  model: string;
  version: string;
  status: string;
  metrics?: { predict_time?: number };
}

class ReplicateProcessor implements StreamProcessor {
  private buffer = "";

  write(bytes: Uint8Array): void {
    // Replicate returns JSON, just accumulate bytes
    this.buffer += new TextDecoder().decode(bytes);
  }

  end(): ExtractedUsage | null {
    try {
      const prediction = JSON.parse(this.buffer) as ReplicatePrediction;

      if (prediction.status !== "succeeded" || !prediction.metrics?.predict_time) {
        return null;
      }

      return {
        provider: "replicate",
        model: prediction.model || prediction.version || "unknown",
        computeSeconds: prediction.metrics.predict_time,
        requestId: prediction.id,
      };
    } catch (err) {
      logger.warn("Failed to parse Replicate response", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export class ReplicateExtractor implements UsageExtractor {
  readonly provider = "replicate";
  readonly meters: MeterDefinition[] = [
    {
      eventName: "compute_seconds",
      displayName: "Compute Seconds",
      unit: "seconds",
      costPerUnit: 0.000225,
    },
  ];

  matches(url: URL): boolean {
    return url.hostname === "api.replicate.com";
  }

  createProcessor(_contentType: string): StreamProcessor {
    return new ReplicateProcessor();
  }
}
