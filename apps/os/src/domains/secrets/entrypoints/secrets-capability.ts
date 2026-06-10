import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import type { ExecuteCodemodeFunctionCallInput } from "~/domains/codemode/stream-processors/codemode/implementation.ts";
import { parseConfig } from "~/config.ts";
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

type SecretsCapabilityEnv = {
  APP_CONFIG?: string;
  DB?: D1Database;
};

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
  SecretsCapabilityEnv,
  SecretsCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const [request] = input.args as [Record<string, unknown> | undefined];
    const body = request ?? {};
    switch (input.functionPath.join(".")) {
      case "getSecret":
      case "get":
        return await this.getSecret({ key: readKey(body) });
      case "create":
      case "update":
      case "set":
        return await this.setSecret({
          key: readKey(body),
          material: readMaterial(body),
          metadata: readMetadata(body),
        });
      case "delete":
        return await this.deleteSecret({ key: readKey(body) });
      case "list":
        return await listProjectSecrets(this.db(), { projectId: this.projectId() });
      default:
        throw new Error(`SecretsCapability does not implement ${input.functionPath.join(".")}`);
    }
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

function readKey(input: Record<string, unknown>) {
  const key = input.key;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("Secret key is required.");
  }
  return key.trim();
}

function readMaterial(input: Record<string, unknown>) {
  const material = input.material ?? input.value;
  if (typeof material !== "string" || material.length === 0) {
    throw new Error("Secret material is required.");
  }
  return material;
}

function readMetadata(input: Record<string, unknown>) {
  const metadata = input.metadata;
  if (metadata == null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Secret metadata must be an object.");
  }
  return metadata as Record<string, unknown>;
}
