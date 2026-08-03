import { DurableObject } from "cloudflare:workers";
import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceRuntimeResult,
  type WorkspaceStub,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { z } from "zod";
import type { StreamProcessorWakeRequest, StreamProcessorWakeResponse } from "iterate/processors";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { ComputerProcessorContract, type ComputerConfig } from "./computer-processor-contract.ts";
import { ComputerProcessor } from "./computer-processor-implementation.ts";
import type { ComputerExecInput as ComputerExecInputData, ComputerExecResult } from "./types.ts";

const PROCESSOR_SLUG = ComputerProcessorContract.slug;
const INGEST_WAIT_TIMEOUT_MS = 15_000;

const ComputerExecInput = z.strictObject({
  command: z.string().min(1),
  cwd: z.string().startsWith("/").optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

const WorkspaceNotFoundError = z.object({ code: z.literal("ENOENT") });

/**
 * Spike host for one agent-owned Cloudflare Computer.
 *
 * The Cloudflare package calls its abstraction a Workspace; OS deliberately
 * exposes it as a Computer because the identity belongs to the agent and the
 * filesystem is the computer's durable disk, not a repo-overlay checkout.
 * The Worker shell backend is useful locally and keeps this spike deployable without
 * adding another container fleet. A Linux backend can be added to this same
 * object later without changing paths, streams, or app links.
 */
export class ComputerDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #incarnationId = crypto.randomUUID();
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
  readonly #computerProcessor = this.#registry.register(
    new ComputerProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  readonly #reads = this.#registry.reads(this.#computerProcessor);
  readonly #workspace = new Workspace({
    // The package intentionally accepts only the Durable Object SQL subset;
    // the runtime object is the exact storage implementation it consumes,
    // though Workers' wider concrete declaration is not structurally provable.
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: this.ctx.id.toString(),
    git: createGitClient(),
    artifacts: {
      binding: this.env.ARTIFACTS,
      sessionId: this.ctx.id.toString(),
    },
    backends: [
      new WorkerShellBackend({
        ctx: this.ctx,
        loader: this.env.LOADER,
        workspace: {
          // WorkspaceServiceProxy indexes its environment by the Wrangler
          // namespace binding, not by the exported Durable Object class name.
          binding: "COMPUTER",
          id: this.ctx.id.toString(),
        },
      }),
    ],
  });

  #executionChain: Promise<void> = Promise.resolve();

  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  whoami(): string {
    return `computer ${this.#name.projectId}:${this.#name.path} (agent-owned Cloudflare Computer)`;
  }

  /** Read the upstream flag inside its owning isolate instead of forwarding a promise capability. */
  workspaceUseThink(): boolean {
    return this.#workspace.useThink;
  }

  kill(): void {
    this.ctx.abort("kill requested");
  }

  /** Called by Cloudflare Computer's same-worker WorkspaceServiceProxy. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#assertCreated();
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  async prepare(): Promise<void> {
    await this.#assertCreated();
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(this.#reads.currentState.config.workingDirectory, {
      recursive: true,
    });
  }

  async getConfig(): Promise<ComputerConfig> {
    await this.#assertCreated();
    return this.#reads.currentState.config;
  }

  async configure(input: { config: ComputerConfig }): Promise<ComputerConfig> {
    await this.#assertCreated();
    const config = ComputerProcessorContract.stateSchema.shape.config.parse(input.config);
    const [event] = await this.#stream.append(
      ComputerProcessorContract.buildEvent({
        type: "events.iterate.com/computer/configured",
        payload: { config },
      }),
    );
    await this.#reads.waitUntilEvent({
      offset: event!.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
    await this.#workspace.fs.mkdir(config.workingDirectory, { recursive: true });
    return this.#reads.currentState.config;
  }

  exec(input: ComputerExecInputData): Promise<ComputerExecResult> {
    const operation = this.#executionChain.then(() => this.#exec(input));
    this.#executionChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #exec(rawInput: ComputerExecInputData): Promise<ComputerExecResult> {
    const input = ComputerExecInput.parse(rawInput);
    await this.#assertCreated();
    const config = this.#reads.currentState.config;
    await this.#workspace.ready(config.defaultBackend);
    await this.#workspace.fs.mkdir(config.workingDirectory, { recursive: true });

    const active = this.#reads.currentState.activeExecution;
    if (active !== null) {
      const reason =
        active.incarnationId === this.#incarnationId
          ? "The previous execution returned without recording a terminal outcome"
          : "Durable Object restarted before the command recorded a terminal outcome";
      const [abandoned] = await this.#stream.append(
        ComputerProcessorContract.buildEvent({
          type: "events.iterate.com/computer/execution-abandoned",
          idempotencyKey: `computer-execution-abandoned:${active.executionId}`,
          payload: {
            executionId: active.executionId,
            reason,
          },
        }),
      );
      await this.#reads.waitUntilEvent({
        offset: abandoned!.offset,
        timeoutMs: INGEST_WAIT_TIMEOUT_MS,
      });
    }

    const executionId = crypto.randomUUID();
    const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
    const [requested] = await this.#stream.append(
      ComputerProcessorContract.buildEvent({
        type: "events.iterate.com/computer/execution-requested",
        idempotencyKey: `computer-execution-requested:${executionId}`,
        payload: {
          backend: config.defaultBackend,
          command: input.command,
          executionId,
          incarnationId: this.#incarnationId,
          timeoutMs,
        },
      }),
    );
    await this.#reads.waitUntilEvent({
      offset: requested!.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });

    let result: WorkspaceRuntimeResult<"utf8">;
    try {
      const handle = await this.#workspace.runtime.exec(input.command, {
        backend: config.defaultBackend,
        cwd: input.cwd ?? config.workingDirectory,
        encoding: "utf8",
        id: executionId,
        timeoutMs,
      });
      result = await handle.result();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [failed] = await this.#stream.append(
        ComputerProcessorContract.buildEvent({
          type: "events.iterate.com/computer/execution-failed",
          idempotencyKey: `computer-execution-failed:${executionId}`,
          payload: { error: message, executionId },
        }),
      );
      await this.#reads.waitUntilEvent({
        offset: failed!.offset,
        timeoutMs: INGEST_WAIT_TIMEOUT_MS,
      });
      throw error;
    }

    // Only the shell/result call is classified as execution failure above.
    // A stream persistence or ingestion failure here must not create a false,
    // contradictory command-failed event; a later incarnation will instead
    // durably classify the still-active request as abandoned.
    const [completed] = await this.#stream.append(
      ComputerProcessorContract.buildEvent({
        type: "events.iterate.com/computer/execution-completed",
        idempotencyKey: `computer-execution-completed:${executionId}`,
        payload: {
          executionId,
          exitCode: result.exitCode,
          syncStatus: result.sync.status,
        },
      }),
    );
    await this.#reads.waitUntilEvent({
      offset: completed!.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
    if (result.sync.status === "pending") {
      throw new Error(
        `computer execution ${executionId} exited, but filesystem synchronization is pending: ${result.sync.error}`,
      );
    }
    return {
      executionId,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      syncStatus: result.sync.status,
    };
  }

  async readFile(path: string): Promise<string | null> {
    await this.#assertCreated();
    try {
      return await this.#workspace.fs.readFile(this.#resolvePath(path), "utf8");
    } catch (error) {
      if (WorkspaceNotFoundError.safeParse(error).success) return null;
      throw error;
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    await this.#assertCreated();
    try {
      const stream = await this.#workspace.fs.readFile(this.#resolvePath(path));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      if (WorkspaceNotFoundError.safeParse(error).success) return null;
      throw error;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#assertCreated();
    await this.#workspace.fs.writeFile(this.#resolvePath(path), content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.#assertCreated();
    await this.#workspace.fs.writeFile(this.#resolvePath(path), content);
  }

  async deleteFile(path: string): Promise<void> {
    await this.#assertCreated();
    await this.#workspace.fs.rm(this.#resolvePath(path), { force: true, recursive: true });
  }

  async listAllFiles(): Promise<string[]> {
    await this.#assertCreated();
    const entries = await this.#workspace.fs.find(this.#reads.currentState.config.workingDirectory);
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path)
      .sort();
  }

  #resolvePath(path: string): string {
    return path.startsWith("/")
      ? path
      : `${this.#reads.currentState.config.workingDirectory}/${path}`;
  }

  async #assertCreated(): Promise<void> {
    await this.#reads.catchUp();
    if (this.#reads.currentState.birthCertificate !== null) return;
    throw new Error(`computer "${this.#name.path}" does not exist; it is born with its agent`);
  }

  wakeStreamProcessor(args: StreamProcessorWakeRequest): Promise<StreamProcessorWakeResponse> {
    return this.#registry.wakeStreamProcessor(args);
  }

  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(PROCESSOR_SLUG),
    });
  }
}
