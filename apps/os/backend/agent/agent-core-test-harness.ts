/**
 * Test Harness for Simplified AgentCore
 *
 * This harness provides deterministic control over the agent core for testing.
 */

import type { OpenAI } from "openai";
import { test as base, vi } from "vitest";
import { logger } from "../tag-logger.ts";
import type { AgentCoreEvent } from "./agent-core-schemas.ts";
import {
  AgentCore,
  type AgentCoreDeps,
  type AgentCoreSlice,
  type MergedDepsForSlices,
  type MergedEventForSlices,
} from "./agent-core.ts";
import type { LocalFunctionRuntimeTool, RuntimeTool, ToolSpec } from "./tool-schemas.ts";

// ID counters for deterministic testing
let messageIdCounter = 0;
let responseIdCounter = 0;
let callIdCounter = 0;

export function resetIdCounters(): void {
  messageIdCounter = 0;
  responseIdCounter = 0;
  callIdCounter = 0;
}

export function nextMessageId(): string {
  return `msg_${++messageIdCounter}`;
}

export function nextResponseId(): string {
  return `resp_${++responseIdCounter}`;
}

export function nextCallId(): string {
  return `call_${++callIdCounter}`;
}

// Mock OpenAI streaming controller
export class MockStreamController {
  private chunks: any[] = [];
  private resolvers: Array<(chunk: IteratorResult<any>) => void> = [];
  private done = false;

  streamChunks(chunks: any[]): void {
    this.chunks.push(...chunks);
    this.processQueue();
  }

  complete(): void {
    this.done = true;
    this.processQueue();
  }

  async *getIterator(): AsyncGenerator<any> {
    while (true) {
      if (this.chunks.length > 0) {
        yield this.chunks.shift()!;
      } else if (this.done) {
        return;
      } else {
        const chunk = await new Promise<IteratorResult<any>>((resolve) => {
          this.resolvers.push(resolve);
          Promise.resolve().then(() => this.processQueue());
        });
        if (chunk.done) {
          return;
        }
        yield chunk.value;
      }
    }
  }

  private processQueue(): void {
    while (this.resolvers.length > 0 && (this.chunks.length > 0 || this.done)) {
      const resolver = this.resolvers.shift()!;
      if (this.chunks.length > 0) {
        resolver({ value: this.chunks.shift()!, done: false });
      } else if (this.done) {
        resolver({ value: undefined, done: true });
      }
    }
  }
}

// Mock OpenAI client
class MockOpenAIClient {
  private streamQueue: MockStreamController[] = [];
  public streamMock = vi.fn();

  constructor() {
    this.streamMock.mockImplementation(() => {
      if (this.streamQueue.length === 0) {
        throw new Error("No stream enqueued for responses.stream()");
      }
      return this.streamQueue.shift()!.getIterator();
    });
  }

  enqueueStream(controller: MockStreamController): void {
    this.streamQueue.push(controller);
  }

  readonly responses = {
    stream: (opts: any) => this.streamMock(opts),
  };
}

// Main test harness
export class CoreTestHarness<Slices extends ReadonlyArray<AgentCoreSlice> = []> {
  private events: (AgentCoreEvent & { eventIndex: number; createdAt: string })[] = [];
  public openAIClient = new MockOpenAIClient();
  private mockedTools = new Map<string, LocalFunctionRuntimeTool<MergedEventForSlices<Slices>>>();
  private isInitialized = false;
  private backgroundPromises: Promise<void>[] = [];

  readonly storeEventsMock = vi.fn();
  readonly backgroundMock = vi.fn();
  readonly toolSpecToImplementationMock = vi.fn((_specs: ToolSpec[]): RuntimeTool[] => []);
  readonly getOpenAIClientMock = vi.fn();

  readonly agentCore: AgentCore<Slices>;

  constructor({
    streamingCallback,
    slices,
    extraDeps,
  }: {
    streamingCallback?: (chunk: any) => void;
    slices?: Slices;
    extraDeps?: Partial<MergedDepsForSlices<Slices>>;
  } = {}) {
    this.storeEventsMock.mockImplementation((events) => {
      this.events = [...events];
    });

    this.backgroundMock.mockImplementation((fn) => {
      const promise = fn(); // Execute immediately for testing
      this.backgroundPromises.push(promise);
    });

    this.getOpenAIClientMock.mockResolvedValue(this.openAIClient as any as OpenAI);

    this.toolSpecToImplementationMock.mockImplementation(
      (specs: ToolSpec[]): Array<RuntimeTool> => {
        const runtimeTools: RuntimeTool[] = [];

        for (const spec of specs) {
          // OpenAI builtin tools are returned directly without mocks
          if (spec.type === "openai_builtin") {
            runtimeTools.push(spec.openAITool);
            continue;
          }

          let name: string;
          if (spec.type === "agent_durable_object_tool") {
            name = spec.methodName;
          } else {
            name = "unknown";
          }

          const mockedTool = this.mockedTools.get(name);
          if (mockedTool) {
            runtimeTools.push(mockedTool);
          } else {
            throw new Error(`No mock registered for tool ${name}`);
          }
        }

        return runtimeTools;
      },
    );

    const coreDeps: AgentCoreDeps = {
      getRuleMatchData: (state) => ({ agentCoreState: state }),
      storeEvents: this.storeEventsMock,
      background: this.backgroundMock,
      getOpenAIClient: this.getOpenAIClientMock,
      toolSpecsToImplementations: this.toolSpecToImplementationMock,
      onLLMStreamResponseStreamingChunk: streamingCallback,
    };

    const combinedDeps = {
      ...coreDeps,
      // Allow override with extraDeps
      ...extraDeps,
    } as unknown as AgentCoreDeps & MergedDepsForSlices<Slices>;

    this.agentCore = new AgentCore({
      deps: combinedDeps,
      slices: (slices ?? []) as Slices,
    });
  }

  // Initialize with fake timers
  begin(startTime = "2024-01-01T00:00:00.000Z"): void {
    if (this.isInitialized) {
      throw new Error("Harness already initialized. Call end() before calling begin() again.");
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startTime));
    this.isInitialized = true;
  }

  end(): void {
    if (!this.isInitialized) {
      return;
    }
    vi.useRealTimers();
    this.isInitialized = false;
    // Reset mocks
    vi.clearAllMocks();
  }

  getEvents(): ReadonlyArray<AgentCoreEvent & { eventIndex: number; createdAt: string }> {
    return this.events;
  }

  // Initialize the agent with a spec
  async initializeAgent(prompt = "You are a helpful assistant."): Promise<void> {
    await this.agentCore.initializeWithEvents([]);
    // Set system prompt
    await this.agentCore.addEvents([
      {
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt },
      },
      {
        type: "CORE:SET_MODEL_OPTS",
        data: {
          model: "gpt-4.1-mini",
        },
      },
    ]);
  }

  // Stream control
  enqueueMockOpenAIStream(): MockStreamController {
    const controller = new MockStreamController();
    this.openAIClient.enqueueStream(controller);
    return controller;
  }

  // Tool management
  registerMockTool(
    name: string,
    execute: LocalFunctionRuntimeTool<MergedEventForSlices<Slices>>["execute"],
  ): void {
    const tool: LocalFunctionRuntimeTool<MergedEventForSlices<Slices>> = {
      type: "function",
      name,
      description: `Mock tool ${name}`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      strict: false,
      execute,
    };
    this.mockedTools.set(name, tool);
  }

  // Wait helpers
  async waitUntilThinking(): Promise<void> {
    await vi.waitFor(() => {
      const hasStart = this.events.some((e) => e.type === "CORE:LLM_REQUEST_START");
      if (!hasStart) {
        throw new Error("Not thinking yet");
      }
    });
  }

  async waitUntilNotThinking(): Promise<void> {
    await vi.waitFor(() => {
      const startEvents = this.events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
      const lastStart = startEvents[startEvents.length - 1];
      if (!lastStart) {
        return;
      }

      const endOrCancel = this.events.find(
        (e) =>
          (e.type === "CORE:LLM_REQUEST_END" || e.type === "CORE:LLM_REQUEST_CANCEL") &&
          e.eventIndex > lastStart.eventIndex,
      );

      if (!endOrCancel) {
        throw new Error("Still thinking");
      }
    });

    // Also wait for all background promises to complete
    await Promise.all(this.backgroundPromises);
  }

  // Check if computing (using the state)
  isComputing(): boolean {
    return this.agentCore.llmRequestInProgress();
  }

  // Create a new harness instance with streaming callback
  withStreamingCallback(callback: (chunk: any) => void): CoreTestHarness<Slices> {
    return new CoreTestHarness({
      streamingCallback: callback,
      slices: (this.agentCore as any).slices,
    });
  }

  // Static factory method for backward compatibility
  static create<Slices extends ReadonlyArray<AgentCoreSlice> = []>(options?: {
    streamingCallback?: (chunk: any) => void;
    slices?: Slices;
    extraDeps?: Partial<MergedDepsForSlices<Slices>>;
  }): CoreTestHarness<Slices> {
    return new CoreTestHarness(options);
  }
}

// Helper factory functions
export function makeUserInputTextEvent(text: string): AgentCoreEvent {
  return {
    type: "CORE:LLM_INPUT_ITEM",
    data: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: text,
        },
      ],
    },
    triggerLLMRequest: true,
  };
}

export function makeResponseChunks(text: string): any[] {
  const messageId = nextMessageId();
  const responseId = nextResponseId();
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        created_at: Date.now(),
        model: "gpt-4o-mini",
        object: "response",
        parallel_tool_calls: true,
        status: "in_progress",
        temperature: 0,
        top_p: 1,
        tools: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        id: messageId,
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    },
    { type: "response.completed" },
  ];
}

export function makeFunctionCallChunk(name: string, args: any): any {
  const callId = nextCallId();
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: callId, // Add the missing id field
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

export function makeResponseCreatedChunk(responseId: string): any {
  return {
    type: "response.created",
    response: {
      id: responseId,
      created_at: Date.now(),
      model: "gpt-4o-mini",
      object: "response",
      parallel_tool_calls: true,
      status: "in_progress",
      temperature: 0,
      top_p: 1,
      tools: [],
      usage: null,
    },
  };
}

export function createAgentCoreTest<Slices extends ReadonlyArray<AgentCoreSlice>>(
  slices: Slices,
  options?: {
    streamingCallback?: (chunk: any) => void;
    extraDeps?: Partial<MergedDepsForSlices<Slices>>;
  },
) {
  return base.extend<{ h: CoreTestHarness<Slices> }>({
    h: async ({ task }, playwrightUse) => {
      logger.defaultStore = { level: "info", tags: {}, logs: [] };
      // Reset ID counters for deterministic tests
      resetIdCounters();

      const harness = CoreTestHarness.create({
        slices,
        streamingCallback: options?.streamingCallback,
        extraDeps: options?.extraDeps,
      });

      // Begin with fake timers
      harness.begin("2024-01-01T00:00:00.000Z");

      try {
        // Run the test
        await playwrightUse(harness);
      } finally {
        // Check if test failed and print logs
        if (task.result?.state === "fail") {
          if (logger.context.logs.length) {
            console.log("\n--- Captured Console Output ---");
            logger.context.logs.forEach((log) => console[log.level](...log.args));
            console.log("--- End Console Output ---\n");
          }
        }
        // Cleanup
        harness.end();
      }
    },
  });
}
