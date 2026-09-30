/** A Pipelines stream's schema, as each of apps/telemetry/schemas/*.json holds one: the columns its
 *  stream was created with (scripts/ensure-resources.ts), and so its table's. */
export interface StreamSchema {
  fields: { name: string; type: string; required: boolean }[];
}

/** Why `row` does not fit `schema`, one line per column; none when it fits. A stream accepts a row
 *  that does not fit and drops it silently (docs/telemetry.md#failures), so every row is checked
 *  here before it is sent. An absent optional column is undefined or null. */
export function rowProblems(schema: StreamSchema, row: Record<string, unknown>): string[] {
  const columns = new Set(schema.fields.map((field) => field.name));
  const problems = Object.keys(row)
    .filter((key) => !columns.has(key))
    .map((key) => `${key}: no such column`);
  for (const field of schema.fields) {
    const value = row[field.name];
    if (value == null) {
      if (field.required) problems.push(`${field.name}: missing`);
    } else if (!fits(field.type, value)) {
      problems.push(`${field.name}: ${JSON.stringify(value).slice(0, 100)} is no ${field.type}`);
    }
  }
  return problems;
}

/** The types the four schemas use, as a row's JSON carries them: a timestamp is RFC 3339. */
function fits(type: string, value: unknown) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "timestamp":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "int32":
      return Number.isInteger(value) && Math.abs(Number(value)) < 2 ** 31;
    case "int64":
      return Number.isSafeInteger(value);
    case "float64":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}
