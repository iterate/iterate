// The stream-processor runtime is published in the SDK (`iterate/sdk`) so
// userspace project workers can define processors on the exact machinery the
// platform's own processors run on. This module re-exports the slice the
// platform imports under its historical path.
export {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
  type StreamProcessorContract,
  type StreamProcessorRuntimeState,
  type StreamProcessorSnapshot,
  type StreamProcessorStateStorage,
} from "iterate/sdk";
