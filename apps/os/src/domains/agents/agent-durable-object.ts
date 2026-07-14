import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { createStreamProcessorHost } from "../streams/stream-processor-host.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { SlackAgentProcessor } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi, storeSlackFilesForAgent } from "../integrations/slack-api.ts";
import { TelegramAgentProcessor } from "../integrations/telegram-agent-processor-implementation.ts";
import { callProjectTelegramBotApi } from "../integrations/telegram-api.ts";
import {
  slackConnectionFromAgentPath,
  telegramConnectionFromAgentPath,
} from "../integrations/utils.ts";
import { EmailAgentProcessor } from "../email/email-agent-processor-implementation.ts";
import { GithubAgentProcessor } from "../repos/github-agent-processor-implementation.ts";
import {
  ensureGithubReviewCheck,
  expireGithubReviewCheck,
  type GithubReviewCheckShell,
} from "../repos/github-review-check.ts";
import { connectionOctokit } from "../integrations/github-api.ts";
import { mintProjectFileUrl, MODEL_FILE_URL_TTL_SECONDS } from "../files/project-files.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { agentWorkspacePath } from "../workspaces/utils.ts";
import { parseConfig } from "../../config.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessorCheckpointStore } from "./agent-processor-checkpoint.ts";
import { parseAgentDurableObjectName } from "./utils.ts";

const GITHUB_REVIEW_WATCHDOG_STORAGE_KEY = "github-review-watchdogs";
const GITHUB_REVIEW_WATCHDOG_ALARM_SLICE = "github-review-watchdog";
const GITHUB_REVIEW_TIMEOUT_MS = 30 * 60_000;
const GITHUB_REVIEW_WATCHDOG_RETRY_MS = 60_000;
const GITHUB_REVIEW_WATCHDOG_MAX_ATTEMPTS = 3;

type PendingGithubReviewCheck = {
  appSlug: string;
  attempts: number;
  connection: string;
  expiresAt: number;
  externalId: string;
  headSha: string;
  owner: string;
  repo: string;
};

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = parseAgentDurableObjectName(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  readonly #agentCheckpoint = new AgentProcessorCheckpointStore(
    this.ctx.storage,
    AgentProcessorContract.version,
  );
  readonly #agentProcessor = this.#processorHost.add(
    (deps) =>
      new AgentProcessor({
        ...deps,
        readState: this.#agentCheckpoint.read,
        writeState: this.#agentCheckpoint.write,
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

  // Registered on every agent host; it only wakes on routed Telegram agent
  // streams (`/agents/telegram/**`) where the project processor configured its
  // subscription. Two Telegram lanes with opposite failure policies: the
  // typing chat action is best effort (a failure must never wedge the
  // processor checkpoint), while the journaled send THROWS on failure so the
  // send obligation holds the checkpoint and retries.
  readonly telegramAgentProcessor = this.#processorHost.add(
    (deps) =>
      new TelegramAgentProcessor({
        ...deps,
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
  // AgentFileAttachments so images are visible to the model.
  readonly emailAgentProcessor = this.#processorHost.add(
    (deps) =>
      new EmailAgentProcessor({
        ...deps,
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
  // itself. The platform supplies two best-effort pieces of immediate UI
  // before the LLM turn: a 👀 ack on a fresh mention and an idempotent
  // head-bound check shell whose useful output the review agent owns.
  readonly githubAgentProcessor = this.#processorHost.add(
    (deps) =>
      new GithubAgentProcessor({
        ...deps,
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
        addEyesReaction: async ({ commentId, connection, kind, owner, repo }) => {
          try {
            const reactions = connectionOctokit({
              connection,
              projectId: this.#name.projectId,
            }).rest.reactions;
            if (kind === "issue-comment") {
              await reactions.createForIssueComment({
                comment_id: commentId,
                content: "eyes",
                owner,
                repo,
              });
            } else {
              await reactions.createForPullRequestReviewComment({
                comment_id: commentId,
                content: "eyes",
                owner,
                repo,
              });
            }
          } catch (error) {
            // Acknowledgements are cosmetic. A failure must not prevent the
            // processor from committing and waking the real agent request.
            console.error("[github-agent] GitHub eyes reaction failed", {
              commentId,
              error,
              kind,
              path: this.#name.path,
            });
          }
        },
        beginReviewCheck: async ({
          connection,
          externalId,
          headSha,
          owner,
          repo,
          reviewKey,
          superseded,
        }) => {
          const appSlug = parseConfig(this.env).integrations.github?.appSlug;
          if (appSlug === undefined) {
            console.error(
              "[github-agent] GitHub review check skipped: integrations.github.appSlug is not configured",
              { path: this.#name.path, reviewKey },
            );
            return {
              externalId,
              ...(superseded === undefined ? {} : { superseded }),
            };
          }
          // A review-now comment can precede a PR snapshot. Preserve the
          // trusted App identity so the agent can fetch the live head and do
          // the same exact lookup-before-create flow itself.
          if (headSha === undefined) {
            return {
              appSlug,
              externalId,
              ...(superseded === undefined ? {} : { superseded }),
            };
          }
          let shell: GithubReviewCheckShell;
          try {
            const octokit = connectionOctokit({
              connection,
              projectId: this.#name.projectId,
            });
            const check = await ensureGithubReviewCheck({
              appSlug,
              checks: octokit.rest.checks,
              externalId,
              headSha,
              owner,
              repo,
              superseded,
            });
            shell = {
              ...check,
              appSlug,
              externalId,
              ...(superseded === undefined ? {} : { superseded }),
            };
          } catch (error) {
            // The review turn is the durable obligation. If GitHub cannot
            // create the cosmetic shell, the turn prompt tells the agent to
            // retry through its ordinary Octokit rather than losing review.
            console.error("[github-agent] GitHub review check failed", {
              error,
              headSha,
              path: this.#name.path,
              reviewKey,
            });
            shell = {
              appSlug,
              externalId,
              ...(superseded === undefined ? {} : { superseded }),
            };
          }
          try {
            await this.#trackGithubReviewCheck({
              appSlug,
              connection,
              externalId,
              headSha,
              owner,
              repo,
            });
          } catch (error) {
            // The shell prompt still owns normal completion; watchdog setup
            // is a final safety net and must not suppress the review turn.
            console.error("[github-agent] GitHub review watchdog setup failed", {
              error,
              externalId,
              path: this.#name.path,
            });
          }
          return shell;
        },
      }),
  );

  async #trackGithubReviewCheck(
    check: Omit<PendingGithubReviewCheck, "attempts" | "expiresAt">,
  ): Promise<void> {
    const pending =
      this.ctx.storage.kv.get<PendingGithubReviewCheck[]>(GITHUB_REVIEW_WATCHDOG_STORAGE_KEY) ?? [];
    const existing = pending.find((candidate) => candidate.externalId === check.externalId);
    const next = [
      ...pending.filter((candidate) => candidate.externalId !== check.externalId),
      {
        ...check,
        attempts: existing?.attempts ?? 0,
        expiresAt: existing?.expiresAt ?? Date.now() + GITHUB_REVIEW_TIMEOUT_MS,
      },
    ];
    this.ctx.storage.kv.put(GITHUB_REVIEW_WATCHDOG_STORAGE_KEY, next);
    await this.#processorHost.setAlarmSlice(
      GITHUB_REVIEW_WATCHDOG_ALARM_SLICE,
      Math.min(...next.map((candidate) => candidate.expiresAt)),
    );
  }

  async #runGithubReviewWatchdog(): Promise<void> {
    const pending =
      this.ctx.storage.kv.get<PendingGithubReviewCheck[]>(GITHUB_REVIEW_WATCHDOG_STORAGE_KEY) ?? [];
    const now = Date.now();
    const future = pending.filter((check) => check.expiresAt > now);
    const retried = (
      await Promise.all(
        pending
          .filter((check) => check.expiresAt <= now)
          .map(async (check) => {
            try {
              const octokit = connectionOctokit({
                connection: check.connection,
                projectId: this.#name.projectId,
              });
              await expireGithubReviewCheck({
                appSlug: check.appSlug,
                checks: octokit.rest.checks,
                externalId: check.externalId,
                headSha: check.headSha,
                owner: check.owner,
                repo: check.repo,
              });
              return null;
            } catch (error) {
              const attempts = (check.attempts ?? 0) + 1;
              console.error("[github-agent] GitHub review watchdog failed", {
                attempts,
                error,
                externalId: check.externalId,
                path: this.#name.path,
              });
              return attempts >= GITHUB_REVIEW_WATCHDOG_MAX_ATTEMPTS
                ? null
                : {
                    ...check,
                    attempts,
                    expiresAt: now + GITHUB_REVIEW_WATCHDOG_RETRY_MS,
                  };
            }
          }),
      )
    ).filter((check): check is PendingGithubReviewCheck => check !== null);
    const next = [...future, ...retried];
    if (next.length === 0) {
      this.ctx.storage.kv.delete(GITHUB_REVIEW_WATCHDOG_STORAGE_KEY);
    } else {
      this.ctx.storage.kv.put(GITHUB_REVIEW_WATCHDOG_STORAGE_KEY, next);
    }
    await this.#processorHost.setAlarmSlice(
      GITHUB_REVIEW_WATCHDOG_ALARM_SLICE,
      next.length === 0 ? null : Math.min(...next.map((check) => check.expiresAt)),
    );
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  /** The keepalive's revival alarm — see stream-processor-host.ts. */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#processorHost.handleAlarm(alarmInfo);
    await this.#runGithubReviewWatchdog();
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#agentProcessor, {
      catchUpBeforeSnapshot: () => this.#processorHost.catchUp(AgentProcessorContract.slug),
    });
  }
}
