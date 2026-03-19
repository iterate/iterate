import { DurableObject } from "cloudflare:workers";

export type DeploymentState = "created" | "running" | "stopped" | "destroyed";

export type DeploymentSummary = {
  id: string;
  projectId: string;
  name: string;
  state: DeploymentState;
  createdAt: string;
  updatedAt: string;
  destroyedAt: string | null;
};

export class DeploymentDurableObject extends DurableObject<Record<string, never>> {
  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployment (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          destroyed_at TEXT
        )
      `);
    });
  }

  async create(input: {
    deploymentId: string;
    projectId: string;
    name: string;
    createdAt: string;
  }): Promise<DeploymentSummary> {
    await this.initialized;

    const existing = this.readDeployment();
    if (existing) {
      return existing;
    }

    this.ctx.storage.sql.exec(
      `
        INSERT INTO deployment (id, project_id, name, state, created_at, updated_at, destroyed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      input.deploymentId,
      input.projectId,
      input.name,
      "created",
      input.createdAt,
      input.createdAt,
      null,
    );

    return this.mustReadDeployment();
  }

  async start(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      throw new Error("Cannot start a destroyed deployment");
    }

    if (deployment.state === "running") {
      return deployment;
    }

    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?
        WHERE id = ?
      `,
      "running",
      updatedAt,
      deployment.id,
    );

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

    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?
        WHERE id = ?
      `,
      "stopped",
      updatedAt,
      deployment.id,
    );

    return this.mustReadDeployment();
  }

  async destroy(): Promise<DeploymentSummary> {
    await this.initialized;

    const deployment = this.mustReadDeployment();
    if (deployment.state === "destroyed") {
      return deployment;
    }

    const destroyedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
        UPDATE deployment
        SET state = ?, updated_at = ?, destroyed_at = ?
        WHERE id = ?
      `,
      "destroyed",
      destroyedAt,
      destroyedAt,
      deployment.id,
    );

    return this.mustReadDeployment();
  }

  async get(): Promise<DeploymentSummary> {
    await this.initialized;
    return this.mustReadDeployment();
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
      }>(
        `
          SELECT id, project_id, name, state, created_at, updated_at, destroyed_at
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
    };
  }
}
