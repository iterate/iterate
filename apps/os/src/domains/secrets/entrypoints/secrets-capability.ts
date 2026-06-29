import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { resolveItxSecretsMethod } from "./secrets-capability-call.ts";
import { parseConfig } from "~/config.ts";
import type { PathCall } from "~/itx/itx.ts";
import {
  deleteProjectSecretById,
  deleteProjectSecret,
  getProjectSecretSummaryById,
  getProjectSecretSummaryByKey,
  getProjectSecret,
  listProjectSecrets,
  projectSecretId,
  upsertProjectSecretSummary,
} from "~/domains/secrets/secrets-store.ts";

type SecretsCapabilityProps = {
  projectId?: string;
};

type SecretsCapabilityClient = Pick<
  SecretsCapability,
  | "deleteSecretById"
  | "getSecret"
  | "getSecretOrNull"
  | "getSecretSummary"
  | "getSecretSummaryByKey"
  | "getSecretSummaryByKeyOrNull"
  | "listSecrets"
  | "setSecret"
>;

export class SecretsCapability extends WorkerEntrypoint<
  { APP_CONFIG?: string; DB?: D1Database },
  SecretsCapabilityProps
> {
  /**
   * The itx calling convention (dial.ts dispatches loopback caps as
   * `call({ path, args })`). Only the write-and-summary surface is reachable
   * this way — see secrets-capability-call.ts for the allowlist and why the
   * material-returning methods are not on it. The full method set below
   * stays for platform code (egress substitution, the oRPC/admin surface).
   */
  async call(input: PathCall): Promise<unknown> {
    const method = resolveItxSecretsMethod(input.path);
    return await (this[method] as (arg?: unknown) => Promise<unknown>).call(this, input.args[0]);
  }

  async getSecret(input: { key: string }) {
    const secret = await getProjectSecret(this.db(), {
      key: input.key,
      projectId: this.projectId(),
    });
    if (!secret) {
      throw new Error(`Secret ${input.key} was not found for this project.`);
    }
    return secret;
  }

  async getSecretOrNull(input: { key: string }) {
    return await getProjectSecret(this.db(), {
      key: input.key,
      projectId: this.projectId(),
    });
  }

  async setSecret(input: { key: string; material: string; metadata?: Record<string, unknown> }) {
    return await upsertProjectSecretSummary(this.db(), {
      id: this.createSecretId(),
      key: input.key,
      material: input.material,
      metadata: input.metadata,
      projectId: this.projectId(),
    });
  }

  async listSecrets() {
    return await listProjectSecrets(this.db(), { projectId: this.projectId() });
  }

  async getSecretSummary(input: { id: string }) {
    const secret = await getProjectSecretSummaryById(this.db(), {
      id: input.id,
      projectId: this.projectId(),
    });
    if (!secret) {
      throw new Error(`Secret ${input.id} was not found for this project.`);
    }
    return secret;
  }

  async getSecretSummaryByKey(input: { key: string }) {
    const secret = await getProjectSecretSummaryByKey(this.db(), {
      key: input.key,
      projectId: this.projectId(),
    });
    if (!secret) {
      throw new Error(`Secret ${input.key} was not found for this project.`);
    }
    return secret;
  }

  async getSecretSummaryByKeyOrNull(input: { key: string }) {
    return await getProjectSecretSummaryByKey(this.db(), {
      key: input.key,
      projectId: this.projectId(),
    });
  }

  async deleteSecret(input: { key: string }) {
    return await deleteProjectSecret(this.db(), {
      key: input.key,
      projectId: this.projectId(),
    });
  }

  async deleteSecretById(input: { id: string }) {
    return await deleteProjectSecretById(this.db(), {
      id: input.id,
      projectId: this.projectId(),
    });
  }

  private db() {
    if (!this.env.DB) {
      throw new Error("SecretsCapability requires a DB binding.");
    }
    return createD1Client(this.env.DB);
  }

  private projectId() {
    const projectId = this.ctx.props.projectId;
    if (!projectId) throw new Error("SecretsCapability requires ctx.props.projectId.");
    return projectId;
  }

  private createSecretId() {
    const config = parseConfig(this.env);
    return projectSecretId({ typeIdPrefix: config.typeIdPrefix });
  }
}

export function getSecretsCapability(input: {
  exports: Pick<Cloudflare.Exports, "SecretsCapability"> | undefined;
  props: SecretsCapabilityProps;
}): SecretsCapabilityClient {
  if (!input.exports) {
    throw new Error("SecretsCapability export is not available.");
  }

  const secretsCapability = input.exports.SecretsCapability as unknown as (options: {
    props: SecretsCapabilityProps;
  }) => SecretsCapabilityClient;

  return secretsCapability({ props: input.props });
}
