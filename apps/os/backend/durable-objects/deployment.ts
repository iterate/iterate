import { os } from "@orpc/server";
import { z } from "zod/v4";
import {
  DurableIteratorObject,
  type DurableIteratorWebsocket,
} from "@orpc/experimental-durable-iterator/durable-object";
import type { ProjectDurableObject } from "./project.ts";

export type DeploymentState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "destroyed";

export type DeploymentSummary = {
  id: string;
  projectId: string;
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

export type DeploymentSnapshot = {
  deployment: DeploymentSummary;
  logs: DeploymentLog[];
};

export type DeploymentEvent =
  | {
      type: "snapshot";
      snapshot: {
        deployment: DeploymentSummary;
        isPrimary: boolean;
      };
    }
  | {
      type: "log";
      log: DeploymentLog;
    };

type Env = {
  ENCRYPTION_SECRET: string;
  PROJECT_DURABLE_OBJECT: DurableObjectNamespace<ProjectDurableObject>;
};

const rpc = os.$context<Record<string, never>>();

export class DeploymentDurableObject extends DurableIteratorObject<DeploymentEvent, Env, unknown> {
  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      signingKey: env.ENCRYPTION_SECRET,
      resumeRetentionSeconds: 60,
      onSubscribed: (websocket) => {
        void this.publishSnapshotEvent({ targets: [websocket] });
      },
    });

    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployment (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          destroyed_at TEXT,
          ingress_host TEXT NOT NULL,
          unique_ingress_host TEXT NOT NULL,
          primary_ingress_host TEXT NOT NULL,
          boot_step INTEGER NOT NULL DEFAULT 0
        )
      `);
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
    uniqueIngressHost: string;
    primaryIngressHost: string;
    isPrimary: boolean;
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
          ingress_host,
          unique_ingress_host,
          primary_ingress_host,
          boot_step
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.deploymentId,
      input.projectId,
      input.name,
      "created",
      input.createdAt,
      input.createdAt,
      null,
      input.isPrimary ? input.primaryIngressHost : input.uniqueIngressHost,
      input.uniqueIngressHost,
      input.primaryIngressHost,
      0,
    );

    this.insertLog("info", `Deployment ${input.name} created`);
    if (input.isPrimary) {
      this.insertLog("info", `Attached primary ingress host ${input.primaryIngressHost}`);
    } else {
      this.insertLog("info", `Using detached ingress host ${input.uniqueIngressHost}`);
    }

    await this.publishSnapshotEvent();
    return this.mustReadDeployment();
  }

  async attachPrimary(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      throw new Error("Cannot attach a destroyed deployment");
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET ingress_host = primary_ingress_host, updated_at = ?
        WHERE id = ?
      `,
      now,
      deployment.id,
    );
    this.insertLog(
      "info",
      `Attached primary ingress host ${this.mustReadConfig().primaryIngressHost}`,
    );

    await this.publishSnapshotEvent();
    return this.mustReadDeployment();
  }

  async detachPrimary(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      return deployment;
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET ingress_host = unique_ingress_host, updated_at = ?
        WHERE id = ?
      `,
      now,
      deployment.id,
    );
    this.insertLog(
      "info",
      `Detached from primary ingress host; using ${this.mustReadConfig().uniqueIngressHost}`,
    );

    await this.publishSnapshotEvent();
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

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?, boot_step = 0
        WHERE id = ?
      `,
      "starting",
      now,
      deployment.id,
    );
    this.insertLog("info", `Starting deployment on ${deployment.ingressHost}`);
    await this.scheduleAlarm(400);

    const updated = this.mustReadDeployment();
    await this.publishSnapshotEvent();
    await this.notifyProject();
    return updated;
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

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?
        WHERE id = ?
      `,
      "stopping",
      now,
      deployment.id,
    );
    this.insertLog("warn", "Stopping deployment");
    await this.scheduleAlarm(400);

    const updated = this.mustReadDeployment();
    await this.publishSnapshotEvent();
    await this.notifyProject();
    return updated;
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

    const updated = this.mustReadDeployment();
    await this.publishSnapshotEvent();
    await this.notifyProject();
    return updated;
  }

  async getSummary(): Promise<DeploymentSummary> {
    await this.initialized;
    return this.mustReadDeployment();
  }

  async getSnapshot(): Promise<DeploymentSnapshot> {
    await this.initialized;
    return this.readSnapshot();
  }

  api(_ws: DurableIteratorWebsocket) {
    // This is oRPC method RPC inside the Durable Iterator websocket, not Cloudflare's
    // server-side-only DO RPC. Keeping the imperative surface here lets the DO define its
    // own client contract while the outer app router decides which pieces to expose as
    // ordinary top-level query/mutation/stream procedures.
    return {
      getSnapshot: rpc
        .input(z.object({}))
        .handler(() => this.getSnapshot())
        .callable(),

      start: rpc
        .input(z.object({}))
        .handler(() => this.start())
        .callable(),
      stop: rpc
        .input(z.object({}))
        .handler(() => this.stop())
        .callable(),
      destroy: rpc
        .input(z.object({}))
        .handler(() => this.destroy())
        .callable(),
    };
  }

  async alarm() {
    await this.initialized;

    const deployment = this.readDeployment();
    if (!deployment) {
      return;
    }

    if (deployment.state === "destroyed") {
      return;
    }

    if (deployment.state === "starting") {
      const bootStep = this.mustReadConfig().bootStep;

      if (bootStep === 0) {
        this.updateBootStep(1);
        this.insertLog("info", "Booting runtime");
        await this.scheduleAlarm(400);
      } else if (bootStep === 1) {
        this.updateBootStep(2);
        this.insertLog("info", `Binding ingress host ${deployment.ingressHost}`);
        await this.scheduleAlarm(400);
      } else {
        this.setState("running");
        this.updateBootStep(0);
        this.insertLog("info", "Deployment is now running");
        await this.scheduleAlarm(2_000);
      }
    } else if (deployment.state === "running") {
      this.insertLog("info", "Heartbeat OK");
      await this.scheduleAlarm(2_000);
    } else if (deployment.state === "stopping") {
      this.setState("stopped");
      this.insertLog("warn", "Deployment stopped");
    } else {
      return;
    }

    await this.publishSnapshotEvent();
    await this.notifyProject();
  }

  private readSnapshot(): DeploymentSnapshot {
    return {
      deployment: this.mustReadDeployment(),
      logs: this.readLogs(),
    };
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
        project_id: string;
        name: string;
        state: DeploymentState;
        created_at: string;
        updated_at: string;
        destroyed_at: string | null;
        ingress_host: string;
      }>(
        `
          SELECT id, project_id, name, state, created_at, updated_at, destroyed_at, ingress_host
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
      projectId: row.project_id,
      name: row.name,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      destroyedAt: row.destroyed_at,
      ingressHost: row.ingress_host,
    };
  }

  private mustReadConfig() {
    const row = this.ctx.storage.sql
      .exec<{
        project_id: string;
        unique_ingress_host: string;
        primary_ingress_host: string;
        boot_step: number;
      }>(
        `
          SELECT project_id, unique_ingress_host, primary_ingress_host, boot_step
          FROM deployment
          LIMIT 1
        `,
      )
      .toArray()[0];

    if (!row) {
      throw new Error("Deployment not initialized");
    }

    return {
      projectId: row.project_id,
      uniqueIngressHost: row.unique_ingress_host,
      primaryIngressHost: row.primary_ingress_host,
      bootStep: row.boot_step,
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

    const log = this.ctx.storage.sql
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

    if (!log) {
      throw new Error("Expected deployment log to exist after insert");
    }

    // The root durable iterator stream carries a small event union. That keeps one durable
    // iterator connection useful for both TanStack streamed queries and direct websocket
    // consumers: snapshots replace route state, while logs append to the terminal view.
    this.publishEvent({
      type: "log",
      log: {
        id: log.id,
        createdAt: log.created_at,
        level: log.level,
        message: log.message,
      },
    });
  }

  private setState(state: DeploymentState) {
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?
      `,
      state,
      new Date().toISOString(),
    );
  }

  private updateBootStep(step: number) {
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET boot_step = ?, updated_at = ?
      `,
      step,
      new Date().toISOString(),
    );
  }

  private async scheduleAlarm(delayMs: number) {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private async notifyProject() {
    const { projectId } = this.mustReadConfig();
    await this.env.PROJECT_DURABLE_OBJECT.getByName(
      `project:${projectId}`,
    ).deploymentStateChanged();
  }

  private async publishSnapshotEvent(options?: { targets?: DurableIteratorWebsocket[] }) {
    const deployment = this.mustReadDeployment();
    const isPrimary =
      (await this.env.PROJECT_DURABLE_OBJECT.getByName(
        `project:${deployment.projectId}`,
      ).getPrimaryDeploymentId()) === deployment.id;

    this.publishEvent(
      {
        type: "snapshot",
        snapshot: {
          deployment,
          isPrimary,
        },
      },
      options,
    );
  }
}
