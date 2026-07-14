import type { StreamPushEventBatch } from "./rpc-types.ts";

export const ACKNOWLEDGED_IDEMPOTENCY_OFFSET_CAPACITY = 128;
const MAX_CROSS_POST_DELIVERIES = 128;
const MAX_KEY_CODE_UNITS = 512;
const MAX_DELIVERY_IDENTITY_CODE_UNITS = 2_048;

/**
 * Activation-local offsets for durable events committed through acknowledgement-only append.
 * Misses always fall back to SQLite; only a complete batch hit bypasses it.
 */
export class AcknowledgedIdempotencyOffsetCache {
  readonly #offsets = new Map<string, number>();

  get(idempotencyKey: string): number | undefined {
    return this.#offsets.get(idempotencyKey);
  }

  getAll(idempotencyKeys: ReadonlySet<string>): Map<string, number> | undefined {
    const offsets = new Map<string, number>();
    for (const idempotencyKey of idempotencyKeys) {
      const offset = this.#offsets.get(idempotencyKey);
      if (offset === undefined) return undefined;
      offsets.set(idempotencyKey, offset);
    }
    return offsets;
  }

  remember(idempotencyKey: string, offset: number): void {
    if (idempotencyKey.length > MAX_KEY_CODE_UNITS || this.#offsets.has(idempotencyKey)) return;
    if (this.#offsets.size === ACKNOWLEDGED_IDEMPOTENCY_OFFSET_CAPACITY) {
      const oldest = this.#offsets.keys().next().value;
      if (oldest !== undefined) this.#offsets.delete(oldest);
    }
    this.#offsets.set(idempotencyKey, offset);
  }
}

type CrossPostDeliveryIdentity = Pick<
  StreamPushEventBatch,
  "deliveryId" | "path" | "projectId" | "subscriptionKey"
> & {
  configuredEvent: Pick<StreamPushEventBatch["configuredEvent"], "offset">;
};

/**
 * Activation-local acknowledgement of complete cross-post delivery frames.
 * Misses always rebuild the append and use its durable per-event idempotency.
 */
export class AcknowledgedCrossPostDeliveryCache {
  readonly #identities = new Set<string>();

  has(batch: CrossPostDeliveryIdentity): boolean {
    const identity = this.#identity(batch);
    return identity !== undefined && this.#identities.has(identity);
  }

  remember(batch: CrossPostDeliveryIdentity): void {
    const identity = this.#identity(batch);
    if (identity === undefined || this.#identities.has(identity)) return;
    if (this.#identities.size === MAX_CROSS_POST_DELIVERIES) {
      const oldest = this.#identities.values().next().value;
      if (oldest !== undefined) this.#identities.delete(oldest);
    }
    this.#identities.add(identity);
  }

  #identity(batch: CrossPostDeliveryIdentity): string | undefined {
    const codeUnits =
      (batch.projectId?.length ?? 0) +
      batch.path.length +
      batch.subscriptionKey.length +
      batch.deliveryId.length;
    if (codeUnits > MAX_DELIVERY_IDENTITY_CODE_UNITS) return undefined;
    return JSON.stringify([
      batch.projectId,
      batch.path,
      batch.subscriptionKey,
      batch.configuredEvent.offset,
      batch.deliveryId,
    ]);
  }
}
