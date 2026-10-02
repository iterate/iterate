import { z } from "zod";
import type { SecretMaterial } from "iterate/api";

/** Where every secret's path starts: `/secrets/<name>`, what `getSecret("/secrets/<name>")` spells. */
export const SECRETS_PREFIX = "/secrets/";

/** The name's grammar, mirroring `SECRET_NAME` in core/os/src/secrets.ts: `[a-zA-Z0-9._-]+`, never
 *  `.` or `..` — what `getSecret("/secrets/<name>")` can spell. Its source is the Secrets page's
 *  input `pattern`, so the browser says so before the platform has to. The hyphen is escaped because
 *  browsers compile `pattern` with the `v` flag, where a bare `-` in a class is invalid and silently
 *  disables the check (https://html.spec.whatwg.org/multipage/input.html#the-pattern-attribute). */
export const SECRET_NAME = /^(?!\.\.?$)[a-zA-Z0-9_\-.]+$/;

/** The typed value as material: text that parses as a JSON object is that object (its fields are
 *  what `{ field }` picks); anything else is the one string, as typed. The platform never parses a
 *  string (iterate/api `SecretMaterial`), so the form is where pasted JSON becomes fields. */
export function secretMaterialOf(value: string): SecretMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  // JSON.parse answers any JSON value; only an object (not null, an array, a number) has fields.
  const object = JSONObject.safeParse(parsed);
  return object.success ? object.data : value;
}

/** A JSON object: the one JSON value whose fields `{ field }` can pick. */
const JSONObject = z.record(z.string(), z.unknown());
