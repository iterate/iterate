import type { ItxCapabilityHost } from "../itx/types.ts";
import type { Stream, StreamEvent } from "../streams/types.ts";

export interface Agent extends ItxCapabilityHost {
  stream: Stream;
  create(): Promise<StreamEvent>;
  sendMessage(message: string): Promise<StreamEvent>;
  ask(input: { message: string }): Promise<StreamEvent>;
  whoami(): string;
}

export interface AgentCollection {
  create(input: { path: string }): Promise<StreamEvent>;
  get(path: string): Agent;
}
