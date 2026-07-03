import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { SlackAgentProcessor } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi } from "../integrations/slack-api.ts";
import { slackConnectionFromAgentPath } from "../integrations/utils.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { CloudflareAiProcessor } from "./cloudflare-ai-processor-implementation.ts";
import { OpenAiWsProcessor } from "./openai-ws-processor-implementation.ts";
import { parseAgentDurableObjectName, readOpenAiApiKeyFromAppConfig } from "./utils.ts";

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
        readStreamEvents: () => this.#stream.getEvents(),
      }),
  );
  // Registered even without an OpenAI key: the processor then fails requests
  // with a clear llm-request-completed error instead of crashing the host.
  readonly openAiWsProcessor = this.#processorHost.add(
    (deps) =>
      new OpenAiWsProcessor({
        ...deps,
        apiKey: readOpenAiApiKeyFromAppConfig(this.env),
        readStreamEvents: () => this.#stream.getEvents(),
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
          // The agent path carries the named connection
          // (/agents/slack/{connection}/{channel}/ts-{ts}); without it there is
          // no bot token to call with.
          const connection = slackConnectionFromAgentPath(this.#name.path);
          if (connection === null) {
            console.error(
              "[slack-agent] no connection segment in agent path; skipping Slack call",
              {
                method,
                path: this.#name.path,
              },
            );
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
      }),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#agentProcessor);
  }
}
