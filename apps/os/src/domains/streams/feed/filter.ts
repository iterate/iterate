import { AGENT_KIND_PREFIX, RAW_KIND_PREFIX } from "./projector.ts";
import type { StreamFeedFilter, StreamFeedRawFilter } from "./types.ts";
import type { StreamFeedSqlValue } from "./sql.ts";

type StreamFeedSqlFilter = { whereSql: string; params: StreamFeedSqlValue[] };

const STREAM_FEED_TYPE_EXPRESSION = `COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type'))`;

const AGENT_DEBUG_KINDS = ["agent.stream-woken"] as const;

function rawWhere(input: StreamFeedRawFilter): StreamFeedSqlFilter | null {
  const clauses: string[] = [];
  const params: StreamFeedSqlValue[] = [];
  if (input.eventTypes !== null && input.eventTypes.length > 0) {
    clauses.push(
      `${STREAM_FEED_TYPE_EXPRESSION} IN (${input.eventTypes.map(() => "?").join(", ")})`,
    );
    params.push(...input.eventTypes);
  }
  if (input.components !== null && input.components.length > 0) {
    clauses.push(`kind IN (${input.components.map(() => "?").join(", ")})`);
    params.push(...input.components);
  }
  if (input.searchQuery !== null) {
    clauses.push(`json(data) LIKE ?`);
    params.push(`%${input.searchQuery}%`);
  }
  if (input.offsetFrom !== null) {
    clauses.push(`last_offset >= ?`);
    params.push(input.offsetFrom);
  }
  if (input.offsetTo !== null) {
    clauses.push(`first_offset <= ?`);
    params.push(input.offsetTo);
  }
  return clauses.length === 0 ? null : { whereSql: clauses.join(" AND "), params };
}

export function buildStreamFeedWhere(input: StreamFeedFilter | undefined): StreamFeedSqlFilter {
  if (input === undefined) return { whereSql: "1", params: [] };
  const sides: StreamFeedSqlFilter[] = [];
  if (input.agent !== null) {
    const clauses = [`kind LIKE '${AGENT_KIND_PREFIX}%'`];
    const params: StreamFeedSqlValue[] = [];
    if (!input.agent.showDebug) {
      clauses.push(`kind NOT IN (${AGENT_DEBUG_KINDS.map(() => "?").join(", ")})`);
      params.push(...AGENT_DEBUG_KINDS);
    }
    if (input.agent.searchQuery !== null && input.agent.searchQuery !== "") {
      clauses.push(`json(data) LIKE ?`);
      params.push(`%${input.agent.searchQuery}%`);
    }
    sides.push({ whereSql: clauses.join(" AND "), params });
  }
  if (input.raw !== null) {
    const narrowed = rawWhere(input.raw);
    const clauses = [`kind LIKE '${RAW_KIND_PREFIX}%'`];
    const params: StreamFeedSqlValue[] = [];
    if (narrowed !== null) {
      clauses.push(narrowed.whereSql);
      params.push(...narrowed.params);
    }
    sides.push({ whereSql: clauses.join(" AND "), params });
  }
  if (sides.length === 0) return { whereSql: "0", params: [] };
  if (sides.length === 1) return sides[0]!;
  return {
    whereSql: sides.map((side) => `(${side.whereSql})`).join(" OR "),
    params: sides.flatMap((side) => side.params),
  };
}
