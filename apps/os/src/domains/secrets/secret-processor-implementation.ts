import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { SecretProcessorContract } from "./secret-processor-contract.ts";

/**
 * The secret processor: the reduction behind one path-addressed secret
 * (`/secrets/<name>`).
 *
 * HOW IT WORKS, end to end:
 *
 * The SecretDurableObject (secret-durable-object.ts) is the write side and the
 * only code that ever touches plaintext. Its verbs — create(), update(), the
 * refresh strategies — encrypt material (crypto.ts, AES-GCM bound to
 * projectId + path + egress origins + the exact commit offset) and
 * compare-and-append `secret/created` / `secret/updated` events; the egress
 * door appends `secret/used` audit facts. This processor reduces those events
 * into the state every read goes through: the immutable birth certificate
 * (including `visibility`, which no later event can change), the egress pin in
 * force, the stored ciphertext with the offset it committed at, the configured
 * refresh strategy, and the usage audit trail.
 *
 * Two reduction decisions carry the security model:
 *
 * - An update is a COMPLETE material decision: a `secret/updated` without
 *   `encryptedMaterial` destroys the retained value (egress-only and
 *   refresh-only updates clear material on purpose — replacement material
 *   must always name its complete policy in the same event).
 * - `updatedOffset` tracks the newest created/updated fact as the secret's
 *   material/policy revision. The DO fences token refreshes and conditional
 *   clears on it, so a stale strategy or a late provider rejection cannot act
 *   on a credential that rotated in between — even when an attacker repeats
 *   an otherwise identical configuration.
 *
 * The ONE side effect: when `secret/created` is delivered, the processor
 * copies that event to the project root stream (`/`), where the project
 * processor reduces it into its secrets catalog. Everything else is pure
 * reduction — no background work, no at-head pass, nothing an eviction could
 * lose.
 *
 * Material never leaves: state carries ciphertext only, and even that is
 * projected down to a `hasMaterial` boolean (the DO's describeSecretState /
 * publicState) before anything crosses the RPC boundary.
 */
export class SecretProcessor extends StreamProcessor<SecretProcessorContract> {
  readonly contract = SecretProcessorContract;

  protected override processEvent({
    appendTo,
    blockProcessorWhile,
    event,
  }: ProcessEventArgs<SecretProcessorContract>): undefined {
    switch (event?.type) {
      case "events.iterate.com/secret/created":
        // Per-event consequence, so the cursor holds: secret/created is
        // delivered exactly once, and the copy body (the parsed payload)
        // is deterministic, so a redelivered frame dedupes on the key.
        blockProcessorWhile(() =>
          appendTo("/", {
            type: "events.iterate.com/secret/created",
            idempotencyKey: this.idempotencyKey("catalog-created", event),
            payload: event.payload,
          }),
        );
        break;
      // updated / used (and the event-less at-head pass): pure reduction, no
      // side effects.
    }
  }

  protected override reduce({ event, state }: ReduceArgs<SecretProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/secret/created":
        // The first created event wins; a duplicate is a no-op (the Secret DO
        // rejects conflicting births at the create door — a throwing reducer
        // would only wedge the frame).
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          egress: event.payload.config.egress,
          encryptedMaterial:
            event.payload.config.encryptedMaterial === undefined
              ? null
              : { ...event.payload.config.encryptedMaterial, offset: event.offset },
          refresh: event.payload.config.refresh,
          updatedOffset: event.offset,
        };
      case "events.iterate.com/secret/updated":
        return {
          ...state,
          ...(event.payload.egress === undefined ? {} : { egress: event.payload.egress }),
          // An update is a complete material decision: omission destroys the
          // retained value. The committed offset is reducer-owned context for
          // AES-GCM authentication, so replaying this blob at another offset
          // cannot make it decrypt.
          encryptedMaterial:
            event.payload.encryptedMaterial === undefined
              ? null
              : { ...event.payload.encryptedMaterial, offset: event.offset },
          updatedOffset: event.offset,
          // `refresh` present (incl. null-to-clear) replaces; omitted leaves it.
          ...(event.payload.refresh === undefined ? {} : { refresh: event.payload.refresh }),
        };
      case "events.iterate.com/secret/used":
        // The audit mirrors the NEWEST used fact exactly — an event without
        // usedBy/url clears the previous attribution rather than keeping a
        // stale one next to a fresh timestamp.
        return {
          ...state,
          audit: {
            usedCount: state.audit.usedCount + 1,
            lastUsedAt: event.payload.usedAt,
            ...(event.payload.usedBy === undefined ? {} : { lastUsedBy: event.payload.usedBy }),
            ...(event.payload.url === undefined ? {} : { lastUsedUrl: event.payload.url }),
          },
        };
      default:
        return state;
    }
  }
}
