import { os } from "@orpc/server";
import { z } from "zod/v4";
import {
  DurableIteratorObject,
  type DurableIteratorWebsocket,
} from "@orpc/experimental-durable-iterator/durable-object";
import type { DeploymentDurableObject, DeploymentSummary } from "./deployment.ts";

type Env = {
  ENCRYPTION_SECRET: string;
  DEPLOYMENT_DURABLE_OBJECT: DurableObjectNamespace<DeploymentDurableObject>;
};

const rpc = os.$context<Record<string, never>>();

export class ProjectDurableObject extends DurableIteratorObject<
  { deployments: DeploymentSummary[] },
  Env,
  unknown
> {
  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      signingKey: env.ENCRYPTION_SECRET,
      onSubscribed: (websocket) => {
        void this.publishSnapshot({ targets: [websocket] });
      },
    });
    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          destroyed_at TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS deployments_updated_at_idx
        ON deployments(updated_at DESC)
      `);
    });
  }

  async listDeployments(): Promise<DeploymentSummary[]> {
    await this.initialized;

    return this.ctx.storage.sql
      .exec<{
        id: string;
        project_id: string;
        name: string;
        state: DeploymentSummary["state"];
        created_at: string;
        updated_at: string;
        destroyed_at: string | null;
      }>(`
        SELECT id, project_id, name, state, created_at, updated_at, destroyed_at
        FROM deployments
        ORDER BY updated_at DESC
      `)
      .toArray()
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        destroyedAt: row.destroyed_at,
      }));
  }

  async createDeployment(input: { projectId: string; name: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const createdAt = new Date().toISOString();
    const deploymentId = `dep_${crypto.randomUUID().replaceAll("-", "")}`;
    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${deploymentId}`,
    ).create({
      deploymentId,
      projectId: input.projectId,
      name: input.name,
      createdAt,
    });

    this.upsertDeployment(deployment);
    await this.publishSnapshot();
    return deployment;
  }

  async startDeployment(input: { deploymentId: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${input.deploymentId}`,
    ).start();

    this.upsertDeployment(deployment);
    await this.publishSnapshot();
    return deployment;
  }

  async stopDeployment(input: { deploymentId: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${input.deploymentId}`,
    ).stop();

    this.upsertDeployment(deployment);
    await this.publishSnapshot();
    return deployment;
  }

  async destroyDeployment(input: { deploymentId: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${input.deploymentId}`,
    ).destroy();

    this.upsertDeployment(deployment);
    await this.publishSnapshot();
    return deployment;
  }

  deployments(_ws: DurableIteratorWebsocket) {
    return {
      create: rpc
        .input(
          z.object({
            name: z.string().min(1).max(100),
          }),
        )
        .handler(({ input }) =>
          this.createDeployment({
            projectId: _ws["~orpc"].deserializeTokenPayload().chn.replace(/^project:/, ""),
            name: input.name,
          }),
        )
        .callable(),

      start: rpc
        .input(
          z.object({
            deploymentId: z.string(),
          }),
        )
        .handler(({ input }) => this.startDeployment(input))
        .callable(),

      stop: rpc
        .input(
          z.object({
            deploymentId: z.string(),
          }),
        )
        .handler(({ input }) => this.stopDeployment(input))
        .callable(),

      destroy: rpc
        .input(
          z.object({
            deploymentId: z.string(),
          }),
        )
        .handler(({ input }) => this.destroyDeployment(input))
        .callable(),
    };
  }

  private upsertDeployment(deployment: DeploymentSummary) {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO deployments (id, project_id, name, state, created_at, updated_at, destroyed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          name = excluded.name,
          state = excluded.state,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          destroyed_at = excluded.destroyed_at
      `,
      deployment.id,
      deployment.projectId,
      deployment.name,
      deployment.state,
      deployment.createdAt,
      deployment.updatedAt,
      deployment.destroyedAt,
    );
  }

  private async publishSnapshot(options?: { targets?: DurableIteratorWebsocket[] }) {
    this.publishEvent(
      {
        deployments: await this.listDeployments(),
      },
      options,
    );
  }
}
