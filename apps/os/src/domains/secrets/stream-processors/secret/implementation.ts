// Implements the "secret" lifecycle processor (contract.ts). Pure fold plus
// one side effect: telling the host DO when a refreshable (derived,
// expiring) material version landed so it can arm its alarm.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { assertNever } from "@iterate-com/streams/shared/stream-processors";
import { SecretProcessorContract, type SecretProcessorState } from "./contract.ts";
export { SecretProcessorContract } from "./contract.ts";

export type SecretProcessorContract = typeof SecretProcessorContract;

export type SecretProcessorDeps = {
  /**
   * A derivable material version with an expiry became current (set or
   * rotated). The host Durable Object owns the clock: it arms an alarm at
   * expiry minus leeway and re-derives when it fires. Inline re-derivation on
   * a stale use happens regardless; the alarm just keeps hot secrets fresh
   * proactively.
   */
  onRefreshableMaterial?(input: { expiresAt: string; refreshLeewaySeconds: number }): void;
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
      event.type !== "events.iterate.com/secret/set" &&
      event.type !== "events.iterate.com/secret/rotated"
    ) {
      return;
    }
    if (state.derivation == null || state.expiresAt == null) return;
    this.deps.onRefreshableMaterial?.({
      expiresAt: state.expiresAt,
      refreshLeewaySeconds: state.derivation.refreshLeewaySeconds,
    });
  }
}
