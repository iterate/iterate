import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { StreamEvent } from "../../types.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { SlackAgentProcessor } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi, storeSlackFilesForAgent } from "../integrations/slack-api.ts";
import { slackConnectionFromAgentPath } from "../integrations/utils.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { CloudflareAiProcessor } from "./cloudflare-ai-processor-implementation.ts";
import { OpenAiWsProcessor } from "./openai-ws-processor-implementation.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { parseAgentDurableObjectName, readOpenAiApiKeyFromAppConfig } from "./utils.ts";

const AGENT_PROMPT_EVENT_PAGE_SIZE = 500;

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = parseAgentDurableObjectName(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: this.#stream,
  });
  readonly #agentProcessor = this.#processorHost.add((deps) => new AgentProcessor(deps));
  readonly cloudflareAiProcessor = this.#processorHost.add(
    (deps) =>
      new CloudflareAiProcessor({
        ...deps,
        ai: this.env.AI,
        readStreamEvents: () => this.#readAgentPromptEvents(),
      }),
  );
  // Registered even without an OpenAI key: the processor then fails requests
  // with a clear llm-request-completed error instead of crashing the host.
  readonly openAiWsProcessor = this.#processorHost.add(
    (deps) =>
      new OpenAiWsProcessor({
        ...deps,
        apiKey: readOpenAiApiKeyFromAppConfig(this.env),
        readStreamEvents: () => this.#readAgentPromptEvents(),
      }),
  );

  // Registered on every agent host; it only wakes on routed Slack agent
  // streams (`/agents/slack/**`) where the project processor configured its
  // subscription. Slack-facing side effects are best effort: a failed status
  // update or reaction must not wedge the processor checkpoint.
  readonly slackAgentProcessor = this.#processorHost.add(
    (deps) =>
      new SlackAgentProcessor({
        ...deps,
        callSlackApi: async (method, body) => {
          // Only best-effort UX side effects (reactions, thread status) ride
          // this dep — the agent's actual REPLY goes through
          // itx.integrations.slack in its script, which fails loudly on its
          // own. The agent path carries the named connection
          // (/agents/slack/{connection}/{channel}/ts-{ts}); without it there
          // is no bot token, so skip rather than wedge the checkpoint.
          const connection = slackConnectionFromAgentPath(this.#name.path);
          if (connection === null) {
            console.error("[slack-agent] agent path carries no connection; skipping Slack call", {
              method,
              path: this.#name.path,
            });
            return;
          }
          try {
            await callProjectSlackWebApi({
              body,
              connection,
              method,
              projectId: this.#name.projectId,
            });
          } catch (error) {
            console.error("[slack-agent] Slack side effect failed", {
              error,
              method,
              path: this.#name.path,
            });
          }
        },
        storeSlackFiles: (input) => {
          // Downloads ride the named connection's bot-token secret, exactly
          // like the side-effect calls above — same no-connection skip rule.
          const connection = slackConnectionFromAgentPath(this.#name.path);
          if (connection === null) {
            throw new Error(`agent path carries no Slack connection: ${this.#name.path}`);
          }
          return storeSlackFilesForAgent({
            agentPath: this.#name.path,
            connection,
            files: input.files,
            projectId: this.#name.projectId,
            storageKey: input.storageKey,
          });
        },
      }),
  );

  async #readAgentPromptEvents(): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    using pager = this.#stream.readEvents({
      afterOffset: 0,
      eventTypes: AgentProcessorContract.consumes,
      limit: AGENT_PROMPT_EVENT_PAGE_SIZE,
    });
    for (;;) {
      const page = await pager.next();
      events.push(...page);
      if (page.length < AGENT_PROMPT_EVENT_PAGE_SIZE) return events;
    }
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#agentProcessor);
  }
}
