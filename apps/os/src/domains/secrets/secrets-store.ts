import type { Client } from "sqlfu";
import { typeid } from "@iterate-com/shared/typeid";

export type ProjectSecret = {
  id: string;
  key: string;
  material: string;
  metadata: Record<string, unknown>;
  projectId: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSecretSummary = Omit<ProjectSecret, "material"> & {
  hasMaterial: boolean;
};

export type ProjectConnection = {
  id: string;
  externalId: string;
  projectId: string;
  provider: "google" | "slack" | string;
  providerData: Record<string, unknown>;
  scopes: string | null;
  webhookProviderIdentifier: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProjectSecretRow = {
  id: string;
  project_id: string;
  key: string;
  material: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type ProjectConnectionRow = {
  id: string;
  project_id: string;
  provider: string;
  external_id: string;
  webhook_provider_identifier: string | null;
  provider_data: string;
  scopes: string | null;
  created_at: string;
  updated_at: string;
};

export function projectSecretId(input: { typeIdPrefix: string }) {
  return typeid({
    env: { TYPEID_PREFIX: input.typeIdPrefix },
    prefix: "sec",
  });
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function toSecret(row: ProjectSecretRow): ProjectSecret {
  return {
    id: row.id,
    key: row.key,
    material: row.material,
    metadata: parseMetadata(row.metadata),
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSecretSummary(secret: ProjectSecret): ProjectSecretSummary {
  const { material: _material, ...rest } = secret;
  return {
    ...rest,
    hasMaterial: secret.material.length > 0,
  };
}

function toConnection(row: ProjectConnectionRow): ProjectConnection {
  return {
    id: row.id,
    externalId: row.external_id,
    projectId: row.project_id,
    provider: row.provider,
    providerData: parseMetadata(row.provider_data),
    scopes: row.scopes,
    webhookProviderIdentifier: row.webhook_provider_identifier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getProjectSecret(
  db: Client,
  input: { key: string; projectId: string },
): Promise<ProjectSecret | null> {
  const rows = await db.all<ProjectSecretRow>({
    name: "getProjectSecret",
    sql: `
      select id, project_id, key, material, metadata, created_at, updated_at
      from project_secrets
      where project_id = ? and key = ?
      limit 1
    `,
    args: [input.projectId, input.key],
  });
  return rows[0] ? toSecret(rows[0]) : null;
}

export async function getProjectSecretById(
  db: Client,
  input: { id: string; projectId: string },
): Promise<ProjectSecret | null> {
  const rows = await db.all<ProjectSecretRow>({
    name: "getProjectSecretById",
    sql: `
      select id, project_id, key, material, metadata, created_at, updated_at
      from project_secrets
      where project_id = ? and id = ?
      limit 1
    `,
    args: [input.projectId, input.id],
  });
  return rows[0] ? toSecret(rows[0]) : null;
}

export async function getProjectSecretSummaryById(
  db: Client,
  input: { id: string; projectId: string },
): Promise<ProjectSecretSummary | null> {
  const secret = await getProjectSecretById(db, input);
  return secret ? toSecretSummary(secret) : null;
}

export async function getProjectSecretSummaryByKey(
  db: Client,
  input: { key: string; projectId: string },
): Promise<ProjectSecretSummary | null> {
  const secret = await getProjectSecret(db, input);
  return secret ? toSecretSummary(secret) : null;
}

export async function listProjectSecrets(
  db: Client,
  input: { projectId: string },
): Promise<ProjectSecretSummary[]> {
  const rows = await db.all<ProjectSecretRow>({
    name: "listProjectSecrets",
    sql: `
      select id, project_id, key, material, metadata, created_at, updated_at
      from project_secrets
      where project_id = ?
      order by key asc
    `,
    args: [input.projectId],
  });
  return rows.map((row) => toSecretSummary(toSecret(row)));
}

export async function upsertProjectSecret(
  db: Client,
  input: {
    id: string;
    key: string;
    material: string;
    metadata?: Record<string, unknown>;
    projectId: string;
  },
): Promise<ProjectSecret> {
  const metadata = JSON.stringify(input.metadata ?? {});
  const rows = await db.all<ProjectSecretRow>({
    name: "upsertProjectSecret",
    sql: `
      insert into project_secrets (id, project_id, key, material, metadata, updated_at)
      values (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
      on conflict(project_id, key) do update set
        material = excluded.material,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
      returning id, project_id, key, material, metadata, created_at, updated_at
    `,
    args: [input.id, input.projectId, input.key, input.material, metadata],
  });
  const row = rows[0];
  if (!row) throw new Error(`Failed to upsert project secret ${input.key}.`);
  return toSecret(row);
}

export async function upsertProjectSecretSummary(
  db: Client,
  input: {
    id: string;
    key: string;
    material: string;
    metadata?: Record<string, unknown>;
    projectId: string;
  },
): Promise<ProjectSecretSummary> {
  return toSecretSummary(await upsertProjectSecret(db, input));
}

export async function deleteProjectSecret(
  db: Client,
  input: { key: string; projectId: string },
): Promise<{ deleted: boolean }> {
  const result = await db.run({
    name: "deleteProjectSecret",
    sql: "delete from project_secrets where project_id = ? and key = ?",
    args: [input.projectId, input.key],
  });
  return { deleted: (result.rowsAffected ?? 0) > 0 };
}

export async function deleteProjectSecretById(
  db: Client,
  input: { id: string; projectId: string },
): Promise<{ deleted: boolean }> {
  const result = await db.run({
    name: "deleteProjectSecretById",
    sql: "delete from project_secrets where project_id = ? and id = ?",
    args: [input.projectId, input.id],
  });
  return { deleted: (result.rowsAffected ?? 0) > 0 };
}

export async function getProjectConnection(
  db: Client,
  input: { projectId: string; provider: string },
): Promise<ProjectConnection | null> {
  const rows = await db.all<ProjectConnectionRow>({
    name: "getProjectConnection",
    sql: `
      select id, project_id, provider, external_id, webhook_provider_identifier, provider_data,
        scopes, created_at, updated_at
      from project_connections
      where project_id = ? and provider = ?
      limit 1
    `,
    args: [input.projectId, input.provider],
  });
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function getProjectConnectionByWebhookIdentifier(
  db: Client,
  input: { provider: string; webhookProviderIdentifier: string },
): Promise<ProjectConnection | null> {
  const rows = await db.all<ProjectConnectionRow>({
    name: "getProjectConnectionByWebhookIdentifier",
    sql: `
      select id, project_id, provider, external_id, webhook_provider_identifier, provider_data,
        scopes, created_at, updated_at
      from project_connections
      where provider = ? and webhook_provider_identifier = ?
      limit 1
    `,
    args: [input.provider, input.webhookProviderIdentifier],
  });
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function upsertProjectConnection(
  db: Client,
  input: {
    externalId: string;
    projectId: string;
    provider: string;
    providerData?: Record<string, unknown>;
    scopes?: string | null;
    webhookProviderIdentifier?: string | null;
  },
): Promise<ProjectConnection> {
  const connectionId = `conn_${crypto.randomUUID().replaceAll("-", "")}`;
  const rows = await db.all<ProjectConnectionRow>({
    name: "upsertProjectConnection",
    sql: `
      insert into project_connections (
        id, project_id, provider, external_id, webhook_provider_identifier, provider_data, scopes,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
      on conflict(project_id, provider) do update set
        external_id = excluded.external_id,
        project_id = excluded.project_id,
        webhook_provider_identifier = excluded.webhook_provider_identifier,
        provider_data = excluded.provider_data,
        scopes = excluded.scopes,
        updated_at = excluded.updated_at
      returning id, project_id, provider, external_id, webhook_provider_identifier, provider_data,
        scopes, created_at, updated_at
    `,
    args: [
      connectionId,
      input.projectId,
      input.provider,
      input.externalId,
      input.webhookProviderIdentifier ?? null,
      JSON.stringify(input.providerData ?? {}),
      input.scopes ?? null,
    ],
  });
  const row = rows[0];
  if (!row) throw new Error(`Failed to upsert ${input.provider} connection.`);
  return toConnection(row);
}

export async function deleteProjectConnection(
  db: Client,
  input: { projectId: string; provider: string },
): Promise<{ deleted: boolean }> {
  const result = await db.run({
    name: "deleteProjectConnection",
    sql: "delete from project_connections where project_id = ? and provider = ?",
    args: [input.projectId, input.provider],
  });
  return { deleted: (result.rowsAffected ?? 0) > 0 };
}

export async function createOAuthState(
  db: Client,
  input: {
    callbackUrl?: string;
    codeVerifier?: string;
    projectId: string;
    provider: string;
    userId: string;
  },
): Promise<string> {
  const state = crypto.randomUUID();
  await db.run({
    name: "createOAuthState",
    sql: `
      insert into oauth_states (
        state, provider, project_id, user_id, callback_url, code_verifier, expires_at
      )
      values (?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))
    `,
    args: [
      state,
      input.provider,
      input.projectId,
      input.userId,
      input.callbackUrl ?? null,
      input.codeVerifier ?? null,
    ],
  });
  return state;
}

export async function consumeOAuthState(
  db: Client,
  input: { provider: string; state: string },
): Promise<{
  callbackUrl: string | null;
  codeVerifier: string | null;
  projectId: string;
  userId: string;
} | null> {
  const rows = await db.all<{
    callback_url: string | null;
    code_verifier: string | null;
    expires_at: string;
    project_id: string;
    user_id: string;
  }>({
    name: "consumeOAuthState.select",
    sql: `
      select project_id, user_id, callback_url, code_verifier, expires_at
      from oauth_states
      where state = ? and provider = ?
      limit 1
    `,
    args: [input.state, input.provider],
  });

  await db.run({
    name: "consumeOAuthState.delete",
    sql: "delete from oauth_states where state = ? and provider = ?",
    args: [input.state, input.provider],
  });

  const row = rows[0];
  if (!row || Date.parse(`${row.expires_at}Z`) < Date.now()) return null;
  return {
    callbackUrl: row.callback_url,
    codeVerifier: row.code_verifier,
    projectId: row.project_id,
    userId: row.user_id,
  };
}
