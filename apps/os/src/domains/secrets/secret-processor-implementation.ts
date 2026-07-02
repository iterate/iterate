import { StreamProcessor } from "../streams/stream-processor.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";

export class SecretProcessor extends StreamProcessor<typeof SecretProcessorContract> {
  readonly contract = SecretProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof SecretProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/secret/updated":
        return {
          ...state,
          ...(event.payload.egress === undefined ? {} : { egress: event.payload.egress }),
          ...(event.payload.encryptedMaterial === undefined
            ? {}
            : { encryptedMaterial: event.payload.encryptedMaterial }),
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
}
