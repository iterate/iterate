/**
 * Secret worker: one DO per secret slug — the journal-backed envelope holder.
 * Credential material never leaves this isolate; egress delegates INTO it so
 * the plaintext stays put (see domains/secrets).
 */
export { SecretDurableObject } from "~/domains/secrets/durable-objects/secret-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-secret" }, { status: 404 }),
};
