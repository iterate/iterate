// stream-schema.test-support.ts — TEST CODE: whether a row fits its Pipelines stream's schema, as
// apps/telemetry/schemas/*.json holds each. A stream drops a row that does not fit, so the tests of
// every row builder (otlp.ts here, apps/os platform-hook.ts) check their rows with this.

/** Why `row` does not fit `schema`, one line per column; none when it fits. An absent optional
 *  column is undefined or null. */
export function rowProblems(
  schema: { fields: { name: string; type: string; required: boolean }[] },
  row: Record<string, unknown>,
): string[] {
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
