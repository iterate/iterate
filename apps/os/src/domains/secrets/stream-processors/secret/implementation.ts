// Implements the "secret" lifecycle processor (contract.ts) — where the
// secret's LOGIC lives. The Durable Object is just the host: it folds this
// processor, supplies the capabilities only it has (the encryption key,
// sibling-secret resolution), and exposes request/response verbs that do
// nothing but append facts and read the fold.
//
// Derivation is event-driven: anyone needing fresh material appends
// `secret/derive-requested` (a stale inline use, the expiry alarm) and THIS
// processor reacts — runs the journaled http-exchange and appends
// `secret/rotated`. Because requests are idempotency-keyed by the stale
// version and the reaction checks the fold before running, N concurrent
// stale uses collapse into exactly one derivation run; replays after a
// re-handshake dedupe on the emitted event's processor-derived key.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import { SecretProcessorContract, type SecretProcessorState } from "./contract.ts";
import type { EncryptedMaterial } from "~/domains/secrets/secret-crypto.ts";
import { deriveViaHttpExchange } from "~/domains/secrets/secret-derivation.ts";
export { SecretProcessorContract } from "./contract.ts";

export type SecretProcessorContract = typeof SecretProcessorContract;

export type SecretProcessorDeps = {
  /**
   * A derivable material version with an expiry became current (set or
   * rotated). The host Durable Object owns the clock: it arms an alarm at
   * expiry minus leeway, and the alarm appends `secret/derive-requested`.
   */
  onRefreshableMaterial?(input: { expiresAt: string; refreshLeewaySeconds: number }): void;
  /** Envelope crypto, bound to the deployment key only the host holds. */
  encryptMaterial?(material: string): Promise<EncryptedMaterial>;
  /** Resolve a derivation source — a SIBLING secret's material, via its own
   * domain object (which ensures its own freshness first: chains compose). */
  resolveSecretKey?(key: string): Promise<string>;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export class SecretProcessor extends StreamProcessor<SecretProcessorContract, SecretProcessorDeps> {
  readonly contract = SecretProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<SecretProcessorContract>["reduce"]>[0],
  ): SecretProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/secret/set":
        return {
          ...state,
          slug: event.payload.slug,
          status: "set",
          version: event.payload.encryptedMaterial == null ? state.version : state.version + 1,
          ...(event.payload.encryptedMaterial == null
            ? {}
            : { encryptedMaterial: event.payload.encryptedMaterial }),
          metadata: event.payload.metadata ?? state.metadata,
          tier: event.payload.tier ?? state.tier,
          sensitivity: event.payload.sensitivity ?? state.sensitivity,
          ...(event.payload.derivation == null ? {} : { derivation: event.payload.derivation }),
          ...(event.payload.expiresAt == null ? {} : { expiresAt: event.payload.expiresAt }),
        };
      case "events.iterate.com/secret/derive-requested":
        return state;
      case "events.iterate.com/secret/rotated":
        return {
          ...state,
          status: "set",
          version: state.version + 1,
          encryptedMaterial: event.payload.encryptedMaterial,
          ...(event.payload.expiresAt == null ? {} : { expiresAt: event.payload.expiresAt }),
        };
      case "events.iterate.com/secret/used":
        return {
          ...state,
          audit: {
            uses: state.audit.uses + 1,
            lastUsedAt: event.payload.at,
            lastUsedBy: event.payload.usedBy,
          },
        };
      case "events.iterate.com/secret/deleted": {
        const {
          encryptedMaterial: _dropped,
          derivation: _droppedDerivation,
          expiresAt: _droppedExpiresAt,
          ...rest
        } = state;
        return { ...rest, status: "deleted" };
      }
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<SecretProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;

    if (
      event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/rotated"
    ) {
      if (state.derivation == null || state.expiresAt == null) return;
      this.deps.onRefreshableMaterial?.({
        expiresAt: state.expiresAt,
        refreshLeewaySeconds: state.derivation.refreshLeewaySeconds,
      });
      return;
    }

    if (event.type !== "events.iterate.com/secret/derive-requested") return;

    // The fold is the gate: if material already advanced past the version the
    // requester saw (another request won the race, or a replay), the request
    // is satisfied — do nothing. This is what collapses concurrent stale
    // uses into one derivation run.
    if (state.status !== "set" || state.derivation == null) return;
    if (event.payload.staleVersion < state.version) return;
    if (state.derivation.kind === "script") {
      console.warn("[secret] script derivations are not executable in this spike", {
        slug: state.slug,
      });
      return;
    }
    const derivation = state.derivation;
    const { encryptMaterial, resolveSecretKey } = this.deps;
    if (encryptMaterial == null || resolveSecretKey == null) {
      throw new Error("SecretProcessor needs encryptMaterial/resolveSecretKey deps to derive.");
    }

    // Block the processor: the rotated fact must fold before later events
    // (and the waiting use polling the fold) proceed.
    args.blockProcessorWhile(async () => {
      const derived = await deriveViaHttpExchange({
        derivation,
        resolveSecretKey,
        ...(this.deps.fetchImpl == null ? {} : { fetchImpl: this.deps.fetchImpl }),
        nowMs: Date.now(),
      });
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/secret/rotated",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: this.contract,
            key: "derive",
            sourceEvent: event,
          }),
          payload: {
            slug: event.payload.slug,
            encryptedMaterial: await encryptMaterial(derived.material),
            ...(derived.expiresAt == null ? {} : { expiresAt: derived.expiresAt }),
            reason: event.payload.reason,
          },
        },
      });
    });
  }
}
