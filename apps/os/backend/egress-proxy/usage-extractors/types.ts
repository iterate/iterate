/**
 * Usage Extractor Types
 *
 * Defines the interfaces for extracting usage/billing data from API responses.
 * Each provider implements their own processing logic.
 */

/**
 * Meter definition for a provider.
 */
export interface MeterDefinition {
  eventName: string;
  displayName: string;
  unit: "tokens" | "seconds";
  direction?: "input" | "output";
  costPerUnit: number;
}

/**
 * Extracted usage data from an API response.
 */
export interface ExtractedUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  computeSeconds?: number;
  requestId: string;
}

/**
 * Stream processor - receives raw bytes, produces usage when complete.
 *
 * NOTE: The bytes passed to write() are arbitrary chunks from the HTTP response -
 * they have no semantic meaning. Each processor is responsible for buffering
 * and parsing appropriately (e.g., accumulating until newlines for SSE,
 * or buffering everything for JSON).
 */
export interface StreamProcessor {
  /** Receive bytes from the response stream. Called multiple times with arbitrary chunks. */
  write(bytes: Uint8Array): void;

  /** Stream ended. Return extracted usage or null if extraction failed. */
  end(): ExtractedUsage | null;
}

/**
 * Usage extractor for a provider.
 */
export interface UsageExtractor {
  readonly provider: string;
  readonly meters: MeterDefinition[];

  matches(url: URL): boolean;
  createProcessor(contentType: string): StreamProcessor;
}
