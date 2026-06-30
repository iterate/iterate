import { StreamProcessor } from "../streams/stream-processor.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

const FAUX_LLM_DEBOUNCE_MS = 1_000;

export class AgentProcessor extends StreamProcessor<typeof AgentProcessorContract> {
  readonly contract = AgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/agent/input-added":
        return {
          ...state,
          inputs: [
            ...state.inputs,
            {
              content: event.payload.content,
              offset: event.offset,
            },
          ],
        };
      case "events.iterate.com/agent/llm-request-scheduled":
        return {
          ...state,
          scheduledRequests: {
            ...state.scheduledRequests,
            [event.payload.requestId]: event.payload.inputOffset,
          },
        };
      case "events.iterate.com/agent/llm-request-requested": {
        const scheduledRequests = { ...state.scheduledRequests };
        delete scheduledRequests[event.payload.requestId];
        return { ...state, scheduledRequests };
      }
      case "events.iterate.com/agent/output-added":
        return {
          ...state,
          outputs: [...state.outputs, { content: event.payload.content, offset: event.offset }],
        };
      case "events.iterate.com/itx/script-execution-completed":
        return {
          ...state,
          scriptExecutionsCompleted: [
            ...state.scriptExecutionsCompleted,
            event.payload.executionId,
          ],
        };
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    runInBackground,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/agent/user-message-received":
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `agent/input-added@${event.offset}`,
            payload: {
              content: event.payload.content,
              origin: event.payload.origin,
              sourceOffset: event.offset,
            },
          });
        });
        return;
      case "events.iterate.com/agent/input-added":
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/llm-request-scheduled",
            idempotencyKey: `agent/llm-request-scheduled@${event.offset}`,
            payload: {
              debounceMs: FAUX_LLM_DEBOUNCE_MS,
              inputOffset: event.offset,
              requestId: `faux-llm-request:${event.offset}`,
            },
          });
        });
        return;
      case "events.iterate.com/agent/llm-request-scheduled":
        runInBackground(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, event.payload.debounceMs));
          await this.#appendFauxLlmOutput({
            append,
            inputOffset: event.payload.inputOffset,
            requestId: event.payload.requestId,
          });
        });
        return;
      case "events.iterate.com/agent/output-added":
        blockProcessorWhile(async () => {
          const code = extractAsyncJsSnippet(event.payload.content);
          if (code === null) return;
          await append({
            type: "events.iterate.com/itx/script-execution-requested",
            idempotencyKey: `itx/script-execution-requested@${event.offset}`,
            payload: {
              code,
              executionId: `agent-output:${event.offset}`,
            },
          });
        });
        return;
      default:
        return;
    }
  }

  async #appendFauxLlmOutput(input: {
    append: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEvent"]>[0]["append"];
    inputOffset: number;
    requestId: string;
  }) {
    const inputEvent = await this.stream.getEvent({ offset: input.inputOffset });
    const userInput =
      inputEvent?.type === "events.iterate.com/agent/input-added" &&
      typeof inputEvent.payload?.content === "string"
        ? inputEvent.payload.content
        : "";
    const code = fauxResponseScript(userInput);
    await input.append(
      {
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: `agent/llm-request-requested@${input.inputOffset}`,
        payload: input,
      },
      {
        type: "events.iterate.com/agent/output-added",
        idempotencyKey: `agent/output-added@${input.inputOffset}`,
        payload: {
          content: ["```js", code, "```"].join("\n"),
          inputOffset: input.inputOffset,
          requestId: input.requestId,
        },
      },
    );
  }
}

function fauxResponseScript(input: string): string {
  const response = `This is the response to '${input}'`;
  return `
    async (itx) => {
      await itx.agent.stream.append({
        type: "events.iterate.com/agent/web-message-sent",
        payload: { message: ${JSON.stringify(response)} },
      });
    }
  `.trim();
}

function extractAsyncJsSnippet(content: string): string | null {
  const fenced = content.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  const code = (fenced?.[1] ?? content).trim();
  return /^async\s*(?:function|\()/.test(code) || /^\(?async\s*\(/.test(code) ? code : null;
}
