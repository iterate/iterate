import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { createStreamProcessorRegistry } from "../streams/stream-processor-registry.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { SlackAgentProcessor } from "../integrations/slack-agent-processor-implementation.ts";
import { SLACK_AGENT_REVIVED_EVENT_TYPE } from "../integrations/slack-agent-processor-contract.ts";
import { callProjectSlackWebApi, storeSlackFilesForAgent } from "../integrations/slack-api.ts";
import { TelegramAgentProcessor } from "../integrations/telegram-agent-processor-implementation.ts";
import { callProjectTelegramBotApi } from "../integrations/telegram-api.ts";
import {
  slackConnectionFromAgentPath,
  telegramConnectionFromAgentPath,
} from "../integrations/utils.ts";
import { EmailAgentProcessor } from "../email/email-agent-processor-implementation.ts";
import { GithubAgentProcessor } from "../repos/github-agent-processor-implementation.ts";
import { connectionOctokit } from "../integrations/github-api.ts";
import { mintProjectFileUrl, MODEL_FILE_URL_TTL_SECONDS } from "../files/project-files.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { agentWorkspacePath } from "../workspaces/utils.ts";
import { parseConfig } from "../../config.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { AGENT_REVIVED_EVENT_TYPE, AgentProcessorContract } from "./agent-processor-contract.ts";
import { parseAgentDurableObjectName } from "./utils.ts";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = parseAgentDurableObjectName(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  // The DO constructs its processors — no host-injected readState/writeState/
  // keepAliveWhile deps; the runner owns durable progress and keepalive.
  // Registered WITH recovery: LLM turns are consequential `runInBackground`
  // work (journaled requested/started obligations whose OUTCOME matters), and
  // the debounce timer is a droppable attempt whose loss must not strand a
  // scheduled turn. An incarnation that dies owing either must be revived —
  // the keepalive alarm appends `agent/revived`, whose ordinary delivery
  // drives the runner to head and `onCaughtUp` settles/re-drives the open
  // obligations (see the registry module doc's recovery rule).
  readonly #agentProcessor = this.#registry.register(
    new AgentProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      ai: this.env.AI,
      // Resolved per attempt (not at construction) so a config problem
      // fails the turn with a journaled error instead of bricking the DO.
      // The OpenAI prompt_cache_key is per agent stream: repeated turns
      // grow a shared prefix, and a stable key routes them to the same
      // provider-side prompt-cache shard.
      cloudflareAiGatewayTransport: () => {
        const gateway = parseConfig(this.env).cloudflareAiGateway;
        if (gateway.transport === "unified") return { kind: "unified" };
        return {
          kind: "byok",
          gatewayId: gateway.id,
          openaiApiKey: parseConfig(this.env).openAiApiKey.exposeSecret(),
          openaiPromptCacheKey: `${this.#name.projectId}:${this.#name.path}`,
          responseCacheTtlSeconds: gateway.responseCacheTtlSeconds,
        };
      },
      resolveModelFileUrl: (file) =>
        mintProjectFileUrl({
          config: parseConfig(this.env),
          expiresInSeconds: MODEL_FILE_URL_TTL_SECONDS,
          path: file.path,
          projectId: this.#name.projectId,
        }),
      // Oversized script results spill into the agent's OWN workspace (the
      // same checkout itx.workspace resolves to), so the model can page
      // through the file instead of blowing its context window. The first
      // write on a fresh workspace waits for the repo clone.
      writeWorkspaceFile: ({ content, path }) =>
        this.env.WORKSPACE.getByName(
          DurableObjectNameCodec.stringify({
            path: agentWorkspacePath(this.#name.path),
            projectId: this.#name.projectId,
          }),
        ).writeFile(path, content),
    }),
    { recovery: { revivedEventType: AGENT_REVIVED_EVENT_TYPE } },
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (the processor facade below) goes through the
  // runner's committed progress.
  readonly #agentReads = this.#registry.reads(this.#agentProcessor);

  // Registered on every agent host; it only wakes on routed Slack agent
  // streams (`/agents/slack/**`) where the project processor configured its
  // subscription. Slack-facing side effects are best effort: a failed status
  // update or reaction must not wedge the processor checkpoint. Registered
  // WITH recovery: the status-clear debounce timer is `runInBackground` work
  // whose outcome matters (the pendingStatusClear obligation in the fold) —
  // an incarnation that dies with the timer armed would otherwise leave the
  // thread showing "is thinking..." forever on a quiet stream.
  readonly slackAgentProcessor = this.#registry.register(
    new SlackAgentProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
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
    { recovery: { revivedEventType: SLACK_AGENT_REVIVED_EVENT_TYPE } },
  );

  // Registered on every agent host; it only wakes on routed Telegram agent
  // streams (`/agents/telegram/**`) where the project processor configured its
  // subscription. Two Telegram lanes with opposite failure policies: the
  // typing chat action is best effort (a failure must never wedge the
  // processor checkpoint), while the journaled send THROWS on failure so the
  // send obligation holds the checkpoint and retries. NO recovery on purpose:
  // its consequential work (the journaled send) runs under
  // `blockProcessorWhile`, which holds the cursor — a death mid-send leaves
  // the frame unacknowledged and the subscription spine redelivers; the
  // typing repaint is cosmetic, telemetry-grade loss.
  readonly telegramAgentProcessor = this.#registry.register(
    new TelegramAgentProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      agentPath: this.#name.path,
      callTelegramApi: async (method, body) => {
        // Only best-effort UX side effects (the typing chat action) ride
        // this dep. The agent path carries the named connection
        // (/agents/telegram/{connection}/chat-{chatId}); without it there
        // is no bot token, so skip rather than wedge the checkpoint.
        const connection = telegramConnectionFromAgentPath(this.#name.path);
        if (connection === null) {
          console.error(
            "[telegram-agent] agent path carries no connection; skipping Telegram call",
            { method, path: this.#name.path },
          );
          return;
        }
        try {
          await callProjectTelegramBotApi({
            body,
            connection,
            method,
            projectId: this.#name.projectId,
          });
        } catch (error) {
          console.error("[telegram-agent] Telegram side effect failed", {
            error,
            method,
            path: this.#name.path,
          });
        }
      },
      sendTelegramMessage: async (body) => {
        // The journaled send (telegram/send-requested): deliberately NO
        // catch — a failed delivery must reject the batch, hold the
        // checkpoint, and be retried until the message-sent marker exists.
        const connection = telegramConnectionFromAgentPath(this.#name.path);
        if (connection === null) {
          throw new Error(`agent path carries no Telegram connection: ${this.#name.path}`);
        }
        const result = await callProjectTelegramBotApi({
          body,
          connection,
          method: "sendMessage",
          projectId: this.#name.projectId,
        });
        const messageId = (result.result as { message_id?: unknown } | undefined)?.message_id;
        if (typeof messageId !== "number") {
          throw new Error("Telegram sendMessage returned no message_id");
        }
        return { messageId };
      },
    }),
  );

  // Registered on every agent host; it wakes on routed email agent streams
  // (`/agents/email/**`) and on any agent stream an agent-scoped email.send
  // bound. Replies leave through itx.email.reply, called by the agent itself;
  // the one dep turns door-stored inbound attachments into signed
  // AgentFileAttachments so images are visible to the model. NO recovery:
  // per-event `blockProcessorWhile` transcription only — a death mid-append
  // leaves the frame unacknowledged and the subscription spine redelivers.
  readonly emailAgentProcessor = this.#registry.register(
    new EmailAgentProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      resolveStoredAttachments: async (attachments) => {
        const config = parseConfig(this.env);
        return await Promise.all(
          attachments.map(async (attachment, index) => {
            const url = await mintProjectFileUrl({
              config,
              path: attachment.path,
              projectId: this.#name.projectId,
            });
            return {
              contentType: attachment.mimeType ?? "application/octet-stream",
              filename: attachment.filename ?? `attachment-${index}`,
              path: attachment.path,
              size: attachment.size,
              url,
            };
          }),
        );
      },
    }),
  );

  // Registered on every agent host; it wakes on routed PR agent streams
  // (`/agents/repos/<slug>/pull-requests/<n>`). Replies leave through the
  // linked connection's itx.integrations.github Octokit, called by the agent
  // itself. The platform supplies one best-effort immediate UI affordance:
  // a 👀 acknowledgement on a fresh trusted mention. Review automation and
  // its Check Run lifecycle belong to the project config worker. NO recovery:
  // its consequential work (collaborator verification + the message append)
  // runs under `blockProcessorWhile`, which holds the cursor for the spine's
  // redelivery; the eyes reaction is cosmetic.
  readonly githubAgentProcessor = this.#registry.register(
    new GithubAgentProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      isRepositoryCollaborator: async ({ connection, login, owner, repo }) => {
        try {
          await connectionOctokit({
            connection,
            projectId: this.#name.projectId,
          }).rest.repos.checkCollaborator({ owner, repo, username: login });
          return true;
        } catch (error) {
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? (error as { status?: unknown }).status
              : undefined;
          if (status === 404) return false;
          console.error("[github-agent] GitHub collaborator check failed", {
            error,
            login,
            owner,
            path: this.#name.path,
            repo,
          });
          throw error;
        }
      },
      addEyesReaction: async ({ connection, kind, owner, repo, targetId }) => {
        try {
          const reactions = connectionOctokit({
            connection,
            projectId: this.#name.projectId,
          }).rest.reactions;
          if (kind === "issue-comment") {
            await reactions.createForIssueComment({
              comment_id: targetId,
              content: "eyes",
              owner,
              repo,
            });
          } else if (kind === "pull-request-review-comment") {
            await reactions.createForPullRequestReviewComment({
              comment_id: targetId,
              content: "eyes",
              owner,
              repo,
            });
          } else {
            await reactions.createForIssue({
              content: "eyes",
              issue_number: targetId,
              owner,
              repo,
            });
          }
        } catch (error) {
          // Acknowledgements are cosmetic. A failure must not prevent the
          // processor from committing and waking the real agent request.
          console.error("[github-agent] GitHub eyes reaction failed", {
            error,
            kind,
            path: this.#name.path,
            targetId,
          });
        }
      },
    }),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /** The registry's shared DO alarm (runner keepalives) — see stream-processor-registry.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    // Runner-backed reads (#agentReads), never the processor instance — see
    // the field comment: instance reads are stale forever under runner drive.
    return new StreamProcessorRpcTarget(this.#agentReads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(AgentProcessorContract.slug),
    });
  }
}
