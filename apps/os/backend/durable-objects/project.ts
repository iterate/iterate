import { DurableObject } from "cloudflare:workers";
import type { DeploymentDurableObject, DeploymentSummary } from "./deployment.ts";

type Env = {
  DEPLOYMENT_DURABLE_OBJECT: DurableObjectNamespace<DeploymentDurableObject>;
};

export class ProjectDurableObject extends DurableObject<Env> {
  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
    return deployment;
  }

  async startDeployment(input: { deploymentId: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${input.deploymentId}`,
    ).start();

    this.upsertDeployment(deployment);
    return deployment;
  }

  async stopDeployment(input: { deploymentId: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${input.deploymentId}`,
    ).stop();

    this.upsertDeployment(deployment);
    return deployment;
  }

  async destroyDeployment(input: { deploymentId: string }): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = await this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
      `deployment:${input.deploymentId}`,
    ).destroy();

    this.upsertDeployment(deployment);
    return deployment;
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
}
