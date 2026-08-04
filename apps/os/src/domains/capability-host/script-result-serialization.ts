import type { JsonValue } from "../workers/schemas.ts";

/**
 * What of an error is safe and useful to hand back to a script's caller.
 *
 * The message and the name, and nothing else. The message is the explanation —
 * it is what a capability chose to say about the refusal — while a stack names
 * internal files and line numbers, and the properties workerd attaches when an
 * error crosses an RPC boundary (`remote`, `durableObjectId`) identify
 * infrastructure rather than describing anything the caller can act on.
 */
interface SerializedError {
  name: string;
  message: string;
}

/**
 * An error, however it reached us.
 *
 * `instanceof Error` is not enough on its own: an error that crossed a
 * dynamic-worker or Durable Object boundary need not be an instance of THIS
 * realm's Error, and the object that arrives is a plain one wearing an error's
 * shape. So the shape is what is checked.
 */
function errorLike(value: unknown): { name?: unknown; message: string; stack?: unknown } | null {
  if (value instanceof Error) return value;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { message?: unknown; stack?: unknown; name?: unknown };
  if (typeof candidate.message !== "string") return null;
  /* A bare `{message}` is data, not an error. A stack or a name alongside it is
   * what distinguishes something thrown from something returned. */
  if (typeof candidate.stack !== "string" && typeof candidate.name !== "string") return null;
  return candidate as { name?: unknown; message: string; stack?: unknown };
}

/**
 * Serialize a script's return value for the settlement event.
 *
 * WHY THIS IS NOT A BARE `JSON.stringify`.
 *
 * `message` and `stack` are NON-ENUMERABLE on Error, so `JSON.stringify(error)`
 * returns `{}` — or, worse, whatever own enumerable properties happen to be
 * attached. Measured on deployed preview_3: a back-office agent ran two
 * overlapping `showImage` calls and its `Promise.allSettled` result came back as
 *
 *   [{"status":"fulfilled","value":true},
 *    {"status":"rejected","reason":{"remote":true,"durableObjectId":"ff5ced4c..."}}]
 *
 * The device had refused the second request with "an image request is already in
 * flight". The agent never saw that. It reported, accurately and uselessly, "No
 * additional refusal text was included in the returned result" — the two
 * properties it did receive are the ones workerd adds when an error crosses an
 * RPC boundary, and they describe infrastructure, not the refusal.
 *
 * An agent that cannot tell anyone WHY its request was refused cannot do
 * anything about it, and a failure that carries no meaningful explanation is
 * exactly what this codebase is built not to ship. So errors anywhere in the
 * result — top level, or nested inside an `allSettled` array, or deeper — are
 * converted to `{name, message}` on the way out.
 *
 * Everything else about this boundary is unchanged and deliberately so: it stays
 * JSON, with JSON's normalization (a Date becomes a string) and JSON's
 * rejection semantics (a cyclic or unsupported value throws here rather than
 * being quietly reshaped).
 */
export function serializeScriptResult(result: unknown): JsonValue | undefined {
  if (result === undefined) return undefined;
  const json = JSON.stringify(result, (_key, value: unknown) => {
    const error = errorLike(value);
    if (error === null) return value;
    const serialized: SerializedError = {
      message: error.message,
      name: typeof error.name === "string" ? error.name : "Error",
    };
    return serialized;
  });
  /*
   * A replacer cannot make a top-level `undefined` serializable, and
   * `JSON.stringify(undefined)` is itself undefined — reachable when a script
   * returns something that serializes away, such as a bare function.
   */
  return json === undefined ? undefined : (JSON.parse(json) as JsonValue);
}
