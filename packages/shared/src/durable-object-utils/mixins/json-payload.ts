type PayloadSerializationErrorConstructor = new (cause: unknown) => Error;

/**
 * Persisted mixin payloads are stored as JSON strings in Durable Object SQLite.
 *
 * Several mixins need the same runtime rule: `undefined` means "no payload" and
 * is stored as JSON `null`, while failures that JSON.stringify actually reports
 * should be wrapped in the owning mixin's public error class. Passing the error
 * constructor keeps that public API specific without duplicating the
 * serialization logic.
 *
 * This is not a complete "plain JSON value" validator. JSON.stringify catches
 * circular data, BigInt, and top-level values that stringify to undefined, but
 * it can silently drop or coerce nested functions, Maps, and class instances.
 * Callers still need to treat persisted payloads as plain records/arrays/
 * primitives by convention.
 */
export function stringifyJsonPayload(
  payload: unknown,
  ErrorCtor: PayloadSerializationErrorConstructor,
): string {
  try {
    const json = JSON.stringify(payload ?? null);

    if (json === undefined) {
      throw new Error("JSON.stringify returned undefined.");
    }

    return json;
  } catch (error) {
    throw new ErrorCtor(error);
  }
}
