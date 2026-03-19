import { os } from "@orpc/server";
import { z } from "zod/v4";
import {
  DurableIteratorObject,
  type DurableIteratorWebsocket,
} from "@orpc/experimental-durable-iterator/durable-object";
import type { DeploymentDurableObject, DeploymentSummary } from "./deployment.ts";

export type ProjectDeploymentSummary = DeploymentSummary & {
  isPrimary: boolean;
};

type Env = {
  ENCRYPTION_SECRET: string;
  DEPLOYMENT_DURABLE_OBJECT: DurableObjectNamespace<DeploymentDurableObject>;
};

const rpc = os.$context<Record<string, never>>();

export class ProjectDurableObject extends DurableIteratorObject<
  { deployments: ProjectDeploymentSummary[]; primaryDeploymentId: string | null },
  Env,
  unknown
> {
  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      signingKey: env.ENCRYPTION_SECRET,
      resumeRetentionSeconds: 60,
      onSubscribed: (websocket) => {
        void this.publishSnapshot({ targets: [websocket] });
      },
    });

    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS project_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          project_id TEXT NOT NULL,
          primary_ingress_host TEXT NOT NULL,
          primary_deployment_id TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS deployments_created_at_idx
        ON deployments(created_at DESC)
      `);
    });
  }

  async initialize(input: { projectId: string; primaryIngressHost: string }) {
    await this.initialized;

    const existing = this.readMeta();
    if (existing) {
      if (existing.projectId !== input.projectId) {
        throw new Error("Project durable object already initialized with a different project");
      }

      this.ctx.storage.sql.exec(
        `
          UPDATE project_meta
          SET primary_ingress_host = ?
          WHERE singleton = 1
        `,
        input.primaryIngressHost,
      );
      return;
    }

    this.ctx.storage.sql.exec(
      `
        INSERT INTO project_meta (singleton, project_id, primary_ingress_host, primary_deployment_id)
        VALUES (1, ?, ?, NULL)
      `,
      input.projectId,
      input.primaryIngressHost,
    );
  }

  async listDeployments(): Promise<ProjectDeploymentSummary[]> {
    await this.initialized;

    const meta = this.mustReadMeta();
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(
        `
          SELECT id
          FROM deployments
          ORDER BY created_at DESC
        `,
      )
      .toArray();

    const deployments = await Promise.all(
      rows.map(async (row) => {
        const summary = await this.getDeploymentStub(row.id).getSummary();
        return {
          ...summary,
          isPrimary: summary.id === meta.primaryDeploymentId,
        };
      }),
    );

    return deployments;
  }

  async createDeployment(input: { name: string }): Promise<ProjectDeploymentSummary[]> {
    await this.initialized;

    const meta = this.mustReadMeta();
    const createdAt = new Date().toISOString();
    const deploymentId = `dep_${crypto.randomUUID().replaceAll("-", "")}`;

    await this.getDeploymentStub(deploymentId).initialize({
      deploymentId,
      projectId: meta.projectId,
      name: input.name,
      createdAt,
      uniqueIngressHost: `${deploymentId}.jonasland.local`,
      primaryIngressHost: meta.primaryIngressHost,
      isPrimary: false,
    });

    this.ctx.storage.sql.exec(
      `
        INSERT INTO deployments (id, created_at)
        VALUES (?, ?)
      `,
      deploymentId,
      createdAt,
    );

    await this.setPrimaryDeployment({ deploymentId });
    await this.getDeploymentStub(deploymentId).start();

    return this.listDeployments();
  }

  async setPrimaryDeployment(input: { deploymentId: string }): Promise<ProjectDeploymentSummary[]> {
    await this.initialized;

    const meta = this.mustReadMeta();
    this.assertDeploymentExists(input.deploymentId);

    if (meta.primaryDeploymentId === input.deploymentId) {
      return this.listDeployments();
    }

    if (meta.primaryDeploymentId) {
      this.assertDeploymentExists(meta.primaryDeploymentId);
      await this.getDeploymentStub(meta.primaryDeploymentId).detachPrimary();
    }

    await this.getDeploymentStub(input.deploymentId).attachPrimary();
    this.ctx.storage.sql.exec(
      `
        UPDATE project_meta
        SET primary_deployment_id = ?
        WHERE singleton = 1
      `,
      input.deploymentId,
    );

    await this.publishSnapshot();
    return this.listDeployments();
  }

  async getPrimaryDeploymentId(): Promise<string | null> {
    await this.initialized;
    return this.mustReadMeta().primaryDeploymentId;
  }

  async hasDeployment(input: { deploymentId: string }): Promise<boolean> {
    await this.initialized;
    return this.readDeploymentIndex(input.deploymentId) !== null;
  }

  async deploymentStateChanged() {
    await this.initialized;
    await this.publishSnapshot();
  }

  deployments(_ws: DurableIteratorWebsocket) {
    return {
      create: rpc
        .input(
          z.object({
            name: z.string().min(1).max(100),
          }),
        )
        .handler(({ input }) => this.createDeployment(input))
        .callable(),

      makePrimary: rpc
        .input(
          z.object({
            deploymentId: z.string(),
          }),
        )
        .handler(({ input }) => this.setPrimaryDeployment(input))
        .callable(),
    };
  }

  private async publishSnapshot(options?: { targets?: DurableIteratorWebsocket[] }) {
    this.publishEvent(
      {
        deployments: await this.listDeployments(),
        primaryDeploymentId: this.mustReadMeta().primaryDeploymentId,
      },
      options,
    );
  }

  private getDeploymentStub(deploymentId: string) {
    return this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(`deployment:${deploymentId}`);
  }

  private mustReadMeta() {
    const meta = this.readMeta();
    if (!meta) {
      throw new Error("Project durable object not initialized");
    }
    return meta;
  }

  private readMeta() {
    const row = this.ctx.storage.sql
      .exec<{
        project_id: string;
        primary_ingress_host: string;
        primary_deployment_id: string | null;
      }>(
        `
          SELECT project_id, primary_ingress_host, primary_deployment_id
          FROM project_meta
          WHERE singleton = 1
        `,
      )
      .toArray()[0];

    if (!row) {
      return null;
    }

    return {
      projectId: row.project_id,
      primaryIngressHost: row.primary_ingress_host,
      primaryDeploymentId: row.primary_deployment_id,
    };
  }

  private readDeploymentIndex(deploymentId: string) {
    return (
      this.ctx.storage.sql
        .exec<{ id: string }>(
          `
            SELECT id
            FROM deployments
            WHERE id = ?
          `,
          deploymentId,
        )
        .toArray()[0] ?? null
    );
  }

  private assertDeploymentExists(deploymentId: string) {
    if (!this.readDeploymentIndex(deploymentId)) {
      throw new Error(`Deployment ${deploymentId} does not belong to this project`);
    }
  }
}
