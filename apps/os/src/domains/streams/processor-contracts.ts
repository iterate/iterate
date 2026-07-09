// The processor-contract machinery is published in the SDK (`iterate/sdk`) so
// userspace project workers can define contracts on the exact machinery the
// platform's own contracts use. This module re-exports the slice the platform
// imports under its historical path; everything else (event-schema helpers,
// catalog resolution) lives behind the SDK boundary.
export {
  buildEvent,
  defineProcessorContract,
  type EmittedInput,
  type ProcessorEvent,
  type ProcessorState,
} from "iterate/sdk";
