import type { StreamFeedFilter, StreamFeedRawFilter, StreamFeedReadInput } from "./types.ts";

const MAX_FILTER_VALUES = 100;
const MAX_FILTER_VALUE_LENGTH = 500;
const MAX_SEARCH_LENGTH = 10_000;
const MAX_PAGE_LIMIT = 500;

/** Validate and copy the untrusted public `Stream.getFeedItems` input. */
export function validateStreamFeedReadInput(input: unknown): StreamFeedReadInput {
  if (!isRecord(input)) throw new Error("getFeedItems input must be an object");
  const offset = optionalNonNegativeInteger(input.offset, "offset");
  const beforeLocalIndex = optionalNonNegativeInteger(input.beforeLocalIndex, "beforeLocalIndex");
  if (offset !== undefined && beforeLocalIndex !== undefined) {
    throw new Error("getFeedItems accepts offset or beforeLocalIndex, not both");
  }
  const limit = input.limit;
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > MAX_PAGE_LIMIT)
  ) {
    throw new Error(`getFeedItems limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }
  const filter = input.filter === undefined ? undefined : validateFilter(input.filter);
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(beforeLocalIndex === undefined ? {} : { beforeLocalIndex }),
    ...(limit === undefined ? {} : { limit: limit as number }),
    ...(filter === undefined ? {} : { filter }),
  };
}

function validateFilter(value: unknown): StreamFeedFilter {
  if (!isRecord(value)) throw new Error("getFeedItems filter must be an object");
  const agent = value.agent;
  const raw = value.raw;
  if (agent !== null && !isRecord(agent)) {
    throw new Error("getFeedItems filter.agent must be an object or null");
  }
  if (raw !== null && !isRecord(raw)) {
    throw new Error("getFeedItems filter.raw must be an object or null");
  }
  return {
    agent:
      agent === null
        ? null
        : {
            showDebug: requiredBoolean(agent.showDebug, "filter.agent.showDebug"),
            searchQuery: nullableString(
              agent.searchQuery,
              "filter.agent.searchQuery",
              MAX_SEARCH_LENGTH,
            ),
          },
    raw: raw === null ? null : validateRawFilter(raw),
  };
}

function validateRawFilter(value: Record<string, unknown>): StreamFeedRawFilter {
  return {
    eventTypes: nullableStringArray(value.eventTypes, "filter.raw.eventTypes"),
    components: nullableStringArray(value.components, "filter.raw.components"),
    searchQuery: nullableString(value.searchQuery, "filter.raw.searchQuery", MAX_SEARCH_LENGTH),
    offsetFrom: nullableNonNegativeInteger(value.offsetFrom, "filter.raw.offsetFrom"),
    offsetTo: nullableNonNegativeInteger(value.offsetTo, "filter.raw.offsetTo"),
  };
}

function nullableStringArray(value: unknown, name: string): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error(`getFeedItems ${name} must be an array or null`);
  if (value.length > MAX_FILTER_VALUES) {
    throw new Error(`getFeedItems ${name} accepts at most ${MAX_FILTER_VALUES} values`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_FILTER_VALUE_LENGTH) {
      throw new Error(
        `getFeedItems ${name}[${index}] must be a non-empty string of at most ${MAX_FILTER_VALUE_LENGTH} characters`,
      );
    }
    return entry;
  });
}

function nullableString(value: unknown, name: string, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(
      `getFeedItems ${name} must be a string of at most ${maxLength} characters or null`,
    );
  }
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`getFeedItems ${name} must be a boolean`);
  return value;
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`getFeedItems ${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  const parsed = optionalNonNegativeInteger(value, name);
  if (parsed === undefined) {
    throw new Error(`getFeedItems ${name} must be a non-negative safe integer or null`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
