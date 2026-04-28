type PayloadSerializationErrorConstructor = new (cause: unknown) => Error;

/**
 * Persisted mixin payloads are stored as JSON strings in Durable Object SQLite.
 *
 * Several mixins need the same runtime rule: `undefined` means "no payload" and
 * is stored as JSON `null`, while circular objects, functions-at-top-level, and
 * other non-JSON values should fail at schedule time with the owning mixin's
 * public error class. Passing the error constructor keeps that public API
 * specific without duplicating the serialization logic.
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
