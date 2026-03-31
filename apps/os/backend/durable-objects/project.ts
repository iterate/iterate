import { DurableObject } from "cloudflare:workers";
import type { DeploymentDurableObject, DeploymentSummary } from "./deployment.ts";

export type ProjectDeploymentSummary = DeploymentSummary & {
  isPrimary: boolean;
};

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
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          destroyed_at TEXT,
          ingress_host TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS deployments_created_at_idx
        ON deployments(created_at DESC)
      `);
    });
  }

  async listDeployments(): Promise<ProjectDeploymentSummary[]> {
    await this.initialized;

    return this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        state: DeploymentSummary["state"];
        created_at: string;
        updated_at: string;
        destroyed_at: string | null;
        ingress_host: string;
        is_primary: number;
      }>(
        `
          SELECT id, name, state, created_at, updated_at, destroyed_at, ingress_host, is_primary
          FROM deployments
          ORDER BY created_at DESC
        `,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.name,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        destroyedAt: row.destroyed_at,
        ingressHost: row.ingress_host,
        isPrimary: row.is_primary === 1,
      }));
  }

  async createDeployment(input: {
    projectId: string;
    name: string;
    primaryIngressHost: string;
  }): Promise<ProjectDeploymentSummary[]> {
    await this.initialized;

    const createdAt = new Date().toISOString();
    const deploymentId = `dep_${crypto.randomUUID().replaceAll("-", "")}`;

    const deployment = await this.deploymentDo(deploymentId).initialize({
      deploymentId,
      projectId: input.projectId,
      name: input.name,
      createdAt,
      ingressHost: `${deploymentId}.jonasland.local`,
    });
    this.syncDeploymentSummary({ ...deployment, isPrimary: false });

    await this.setPrimaryDeployment({
      deploymentId,
      primaryIngressHost: input.primaryIngressHost,
    });
    this.syncDeploymentSummary({
      ...(await this.deploymentDo(deploymentId).start()),
      isPrimary: true,
    });

    return this.listDeployments();
  }

  async setPrimaryDeployment(input: {
    deploymentId: string;
    primaryIngressHost: string;
  }): Promise<ProjectDeploymentSummary[]> {
    await this.initialized;

    this.assertDeploymentExists(input.deploymentId);

    const primaryDeploymentId = this.readPrimaryDeploymentId();
    if (primaryDeploymentId === input.deploymentId) {
      return this.listDeployments();
    }

    if (primaryDeploymentId) {
      this.assertDeploymentExists(primaryDeploymentId);
      this.syncDeploymentSummary({
        ...(await this.deploymentDo(primaryDeploymentId).detachPrimary()),
        isPrimary: false,
      });
    }

    this.ctx.storage.sql.exec(`UPDATE deployments SET is_primary = 0`);
    this.syncDeploymentSummary({
      ...(await this.deploymentDo(input.deploymentId).attachPrimary({
        primaryIngressHost: input.primaryIngressHost,
      })),
      isPrimary: true,
    });

    return this.listDeployments();
  }

  async syncDeployment(input: DeploymentSummary): Promise<void> {
    await this.initialized;

    this.syncDeploymentSummary({
      ...input,
      isPrimary: this.readPrimaryDeploymentId() === input.id,
    });
  }

  async getPrimaryDeploymentId(): Promise<string | null> {
    await this.initialized;
    return this.readPrimaryDeploymentId();
  }

  async hasDeployment(input: { deploymentId: string }): Promise<boolean> {
    await this.initialized;
    return this.readDeploymentIndex(input.deploymentId) !== null;
  }

  private deploymentDo(deploymentId: string) {
    return this.env.DEPLOYMENT_DURABLE_OBJECT.getByName(`deployment:${deploymentId}`);
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

  private readPrimaryDeploymentId() {
    return (
      this.ctx.storage.sql
        .exec<{ id: string }>(
          `
            SELECT id
            FROM deployments
            WHERE is_primary = 1
            LIMIT 1
          `,
        )
        .toArray()[0]?.id ?? null
    );
  }

  private syncDeploymentSummary(input: ProjectDeploymentSummary) {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO deployments (
          id,
          name,
          state,
          created_at,
          updated_at,
          destroyed_at,
          ingress_host,
          is_primary
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          state = excluded.state,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          destroyed_at = excluded.destroyed_at,
          ingress_host = excluded.ingress_host,
          is_primary = excluded.is_primary
      `,
      input.id,
      input.name,
      input.state,
      input.createdAt,
      input.updatedAt,
      input.destroyedAt,
      input.ingressHost,
      input.isPrimary ? 1 : 0,
    );
  }

  private assertDeploymentExists(deploymentId: string) {
    if (!this.readDeploymentIndex(deploymentId)) {
      throw new Error(`Deployment ${deploymentId} does not belong to this project`);
    }
  }
}
