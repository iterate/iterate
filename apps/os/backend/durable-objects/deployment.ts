import { DurableObject } from "cloudflare:workers";
import type { ProjectDurableObject } from "./project.ts";

export type DeploymentState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "destroyed";

export type DeploymentSummary = {
  id: string;
  name: string;
  state: DeploymentState;
  createdAt: string;
  updatedAt: string;
  destroyedAt: string | null;
  ingressHost: string;
};

export type DeploymentLog = {
  id: number;
  createdAt: string;
  level: "info" | "warn" | "error";
  message: string;
};

type LogWaiter = {
  afterId: number;
  finish: (log: DeploymentLog | null) => void;
};

type Env = {
  PROJECT_DURABLE_OBJECT: DurableObjectNamespace<ProjectDurableObject>;
};

export class DeploymentDurableObject extends DurableObject<Env> {
  private initialized: Promise<void>;
  private logWaiters = new Set<LogWaiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployment (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          destroyed_at TEXT,
          ingress_host TEXT NOT NULL
        )
      `);
      try {
        this.ctx.storage.sql.exec(`ALTER TABLE deployment ADD COLUMN project_id TEXT`);
      } catch {}
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployment_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL
        )
      `);
    });
  }

  async initialize(input: {
    deploymentId: string;
    projectId: string;
    name: string;
    createdAt: string;
    ingressHost: string;
  }): Promise<DeploymentSummary> {
    await this.initialized;

    const existing = this.readDeployment();
    if (existing) {
      return existing;
    }

    this.ctx.storage.sql.exec(
      `
        INSERT INTO deployment (
          id,
          project_id,
          name,
          state,
          created_at,
          updated_at,
          destroyed_at,
          ingress_host
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.deploymentId,
      input.projectId,
      input.name,
      "created",
      input.createdAt,
      input.createdAt,
      null,
      input.ingressHost,
    );

    this.insertLog("info", `Deployment ${input.name} created`);
    this.insertLog("info", `Using detached ingress host ${input.ingressHost}`);

    return this.mustReadDeployment();
  }

  async attachPrimary(input: { primaryIngressHost: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      throw new Error("Cannot attach a destroyed deployment");
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET ingress_host = ?, updated_at = ?
        WHERE id = ?
      `,
      input.primaryIngressHost,
      now,
      deployment.id,
    );
    this.insertLog("info", `Attached primary ingress host ${input.primaryIngressHost}`);

    return this.mustReadDeployment();
  }

  async detachPrimary(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      return deployment;
    }

    const detachedIngressHost = `${deployment.id}.jonasland.local`;
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET ingress_host = ?, updated_at = ?
        WHERE id = ?
      `,
      detachedIngressHost,
      now,
      deployment.id,
    );
    this.insertLog("info", `Detached from primary ingress host; using ${detachedIngressHost}`);

    return this.mustReadDeployment();
  }

  async start(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      throw new Error("Cannot start a destroyed deployment");
    }

    if (deployment.state === "starting" || deployment.state === "running") {
      return deployment;
    }

    this.persistState(deployment.id, "starting");
    this.insertLog("info", `Starting deployment on ${deployment.ingressHost}`);
    this.insertLog("info", "Booting runtime");
    this.insertLog("info", `Binding ingress host ${deployment.ingressHost}`);
    await this.scheduleAlarm(400);

    return this.mustReadDeployment();
  }

  async stop(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      throw new Error("Cannot stop a destroyed deployment");
    }

    if (deployment.state === "created" || deployment.state === "stopped") {
      return deployment;
    }

    if (deployment.state === "stopping") {
      return deployment;
    }

    this.persistState(deployment.id, "stopping");
    this.insertLog("warn", "Stopping deployment");
    await this.scheduleAlarm(400);

    return this.mustReadDeployment();
  }

  async destroy(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      return deployment;
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?, destroyed_at = ?
        WHERE id = ?
      `,
      "destroyed",
      now,
      now,
      deployment.id,
    );
    this.insertLog("error", "Destroyed deployment resources");

    return this.mustReadDeployment();
  }

  async getSummary(): Promise<DeploymentSummary> {
    await this.initialized;
    return this.mustReadDeployment();
  }

  async listLogs(input?: { limit?: number }) {
    await this.initialized;
    return this.readLogs(input?.limit);
  }

  async waitForNextLog(input: { afterId: number; timeoutMs?: number }) {
    await this.initialized;

    const nextLog = this.readLogsAfter(input.afterId, 1)[0];
    if (nextLog) {
      return nextLog;
    }

    return new Promise<DeploymentLog | null>((resolve) => {
      const waiter: LogWaiter = {
        afterId: input.afterId,
        finish: (log) => {
          clearTimeout(timeoutId);
          this.logWaiters.delete(waiter);
          resolve(log);
        },
      };

      const timeoutId = setTimeout(() => {
        waiter.finish(null);
      }, input.timeoutMs ?? 30_000);

      this.logWaiters.add(waiter);
    });
  }

  async alarm() {
    await this.initialized;

    const deployment = this.readDeployment();
    if (!deployment || deployment.state === "destroyed") {
      return;
    }

    if (deployment.state === "starting") {
      await this.setStateAndSyncProject(deployment.id, "running");
      this.insertLog("info", "Deployment is now running");
      await this.scheduleAlarm(2_000);
      return;
    }

    if (deployment.state === "running") {
      await this.scheduleAlarm(2_000);
      return;
    }

    if (deployment.state === "stopping") {
      await this.setStateAndSyncProject(deployment.id, "stopped");
      this.insertLog("warn", "Deployment stopped");
    }
  }

  private mustReadDeployment(): DeploymentSummary {
    const deployment = this.readDeployment();
    if (!deployment) {
      throw new Error("Deployment not found");
    }
    return deployment;
  }

  private readDeployment(): DeploymentSummary | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        state: DeploymentState;
        created_at: string;
        updated_at: string;
        destroyed_at: string | null;
        ingress_host: string;
      }>(
        `
          SELECT id, name, state, created_at, updated_at, destroyed_at, ingress_host
          FROM deployment
          LIMIT 1
        `,
      )
      .toArray()[0];

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      destroyedAt: row.destroyed_at,
      ingressHost: row.ingress_host,
    };
  }

  private readLogs(limit = 40): DeploymentLog[] {
    return this.ctx.storage.sql
      .exec<{
        id: number;
        created_at: string;
        level: "info" | "warn" | "error";
        message: string;
      }>(
        `
          SELECT id, created_at, level, message
          FROM deployment_logs
          ORDER BY id DESC
          LIMIT ?
        `,
        limit,
      )
      .toArray()
      .reverse()
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        level: row.level,
        message: row.message,
      }));
  }

  private readLogsAfter(afterId: number, limit = 20): DeploymentLog[] {
    return this.ctx.storage.sql
      .exec<{
        id: number;
        created_at: string;
        level: "info" | "warn" | "error";
        message: string;
      }>(
        `
          SELECT id, created_at, level, message
          FROM deployment_logs
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?
        `,
        afterId,
        limit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        level: row.level,
        message: row.message,
      }));
  }

  private insertLog(level: DeploymentLog["level"], message: string) {
    const createdAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        INSERT INTO deployment_logs (created_at, level, message)
        VALUES (?, ?, ?)
      `,
      createdAt,
      level,
      message,
    );

    const row = this.ctx.storage.sql
      .exec<{
        id: number;
        created_at: string;
        level: DeploymentLog["level"];
        message: string;
      }>(
        `
          SELECT id, created_at, level, message
          FROM deployment_logs
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .toArray()[0];

    if (!row) {
      throw new Error("Expected deployment log to exist after insert");
    }

    const log = {
      id: row.id,
      createdAt: row.created_at,
      level: row.level,
      message: row.message,
    };

    for (const waiter of [...this.logWaiters]) {
      if (log.id > waiter.afterId) {
        waiter.finish(log);
      }
    }
  }

  private persistState(deploymentId: string, state: DeploymentState) {
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?
        WHERE id = ?
      `,
      state,
      new Date().toISOString(),
      deploymentId,
    );
  }

  private async setStateAndSyncProject(deploymentId: string, state: DeploymentState) {
    this.persistState(deploymentId, state);

    const projectId = this.readProjectId();
    if (!projectId) {
      return;
    }

    await this.env.PROJECT_DURABLE_OBJECT.getByName(`project:${projectId}`).syncDeployment(
      this.mustReadDeployment(),
    );
  }

  private async scheduleAlarm(delayMs: number) {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private readProjectId() {
    return (
      this.ctx.storage.sql
        .exec<{ project_id: string | null }>(
          `
            SELECT project_id
            FROM deployment
            LIMIT 1
          `,
        )
        .toArray()[0]?.project_id ?? null
    );
  }
}
