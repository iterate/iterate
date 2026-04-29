import { useQuery } from "@tanstack/react-query";
import {
  AgentLoopProcessorContract,
  reduceAgentLoopEvents,
} from "./frontend-reducer-poc.contract.ts";
import type { StreamEvent } from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * Frontend usage sketch for the agents UI.
 *
 * The important property is that this component imports the contract/reducer
 * module, not the backend processor implementation. In the real app the query
 * function would call an oRPC procedure or the events client to read committed
 * stream events for the agent stream.
 */

export function AgentLoopStatusPanel(args: {
  streamPath: string;
  readStreamEvents: (args: { streamPath: string }) => Promise<StreamEvent[]>;
}) {
  const agentLoopState = useQuery({
    queryKey: ["agent-loop-state", args.streamPath, AgentLoopProcessorContract.version],
    queryFn: async () =>
      reduceAgentLoopEvents({
        events: await args.readStreamEvents({ streamPath: args.streamPath }),
      }),
  });

  if (agentLoopState.isPending) {
    return <div data-label="agent-loop-state">Loading agent state</div>;
  }

  if (agentLoopState.isError) {
    return <div data-label="agent-loop-state">Unable to load agent state</div>;
  }

  return (
    <section data-label="agent-loop-state">
      <div data-label="agent-computing">{agentLoopState.data.computing ? "Computing" : "Idle"}</div>
      <div data-label="agent-queued-messages">
        Queued messages: {agentLoopState.data.queuedMessageCount}
      </div>
      <div data-label="agent-transcript-count">
        Transcript messages: {agentLoopState.data.transcript.length}
      </div>
    </section>
  );
}
