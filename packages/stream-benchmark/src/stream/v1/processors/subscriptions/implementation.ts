import { implementBuiltinProcessor } from "@iterate-com/shared/stream-processors";
import { SubscriptionProcessorContract } from "./contract.js";

export function createSubscriptionProcessor() {
  return implementBuiltinProcessor(SubscriptionProcessorContract, {});
}
