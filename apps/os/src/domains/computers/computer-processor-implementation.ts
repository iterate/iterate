import { StreamProcessor, type ReduceArgs } from "iterate/processors";
import {
  ComputerProcessorContract,
  type ComputerProcessorState,
} from "./computer-processor-contract.ts";

/** Pure lifecycle/audit projection for one agent-owned Computer. */
export class ComputerProcessor extends StreamProcessor<ComputerProcessorContract> {
  readonly contract = ComputerProcessorContract;

  protected override reduce({
    event,
    state,
  }: ReduceArgs<ComputerProcessorContract>): ComputerProcessorState {
    switch (event.type) {
      case "events.iterate.com/computer/created":
        if (state.birthCertificate) return state;
        return { ...state, birthCertificate: event.payload, config: event.payload.config };
      case "events.iterate.com/computer/configured":
        return { ...state, config: event.payload.config };
      case "events.iterate.com/computer/execution-requested":
        return { ...state, activeExecution: event.payload };
      case "events.iterate.com/computer/execution-completed":
        if (state.activeExecution?.executionId !== event.payload.executionId) return state;
        return {
          ...state,
          activeExecution: null,
          lastExecution: { ...event.payload, status: "completed" },
        };
      case "events.iterate.com/computer/execution-failed":
        if (state.activeExecution?.executionId !== event.payload.executionId) return state;
        return {
          ...state,
          activeExecution: null,
          lastExecution: { ...event.payload, status: "failed" },
        };
      case "events.iterate.com/computer/execution-abandoned":
        if (state.activeExecution?.executionId !== event.payload.executionId) return state;
        return {
          ...state,
          activeExecution: null,
          lastExecution: { ...event.payload, status: "abandoned" },
        };
      default:
        return state;
    }
  }
}
