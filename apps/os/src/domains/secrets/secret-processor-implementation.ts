import { StreamProcessor } from "../streams/stream-processor.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";

export class SecretProcessor extends StreamProcessor<SecretProcessorContract> {
  readonly contract = SecretProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<SecretProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/secret/created":
        if (state.birthCertificate !== null) {
          throw new Error("secret received more than one created event");
        }
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

  protected override processEvent({
    appendTo,
    blockProcessorWhile,
    event,
  }: Parameters<StreamProcessor<SecretProcessorContract>["processEvent"]>[0]): undefined {
    // Event-less at-head pass: this processor has no at-head work.
    if (event === null) return;
    if (event.type !== "events.iterate.com/secret/created") return;
    blockProcessorWhile(() =>
      appendTo("/", {
        type: "events.iterate.com/secret/created",
        idempotencyKey: this.idempotencyKey("catalog-created", event),
        payload: event.payload,
      }),
    );
  }
}
