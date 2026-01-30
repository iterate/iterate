import { eq, and, isNull, or } from "drizzle-orm";
import { logger } from "backend/tag-logger.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";

/**
 * Convert secret key to SHOUTING_SNAKE_CASE env var name
 * Example: "google.access_token" → "ITERATE_PROXY_SECRET_GOOGLE_ACCESS_TOKEN"
 */
export function secretKeyToEnvVar(key: string): string {
  return `ITERATE_PROXY_SECRET_${key.replace(/\./g, "_").toUpperCase()}`;
}

export type EnvVarSource =
  | { type: "global"; description: string }
  | { type: "connection"; provider: "github" | "slack" | "google" }
  | { type: "user"; envVarId: string };

export type UnifiedEnvVar = {
  key: string;
  value: string;
  isSecret: boolean;
  description: string | null;
  egressProxyRule: string | null;
  source: EnvVarSource;
  createdAt: Date | null;
};

/**
 * Derive env var names from a secret key.
 * - Global (iterate.*): OPENAI_API_KEY from iterate.openai_api_key
 * - Connector (github/slack/google.*): GITHUB_ACCESS_TOKEN, GH_ACCESS_TOKEN, etc.
 * - Custom (env.*): empty - relies on explicit projectEnvVar mappings
 */
function secretKeyToEnvVarNames(secretKey: string): string[] {
  if (secretKey.startsWith("env.")) {
    // Custom secrets (env.*) - no auto-generated env var names, but these will typically correspond to explicit projectEnvVar entries
    return [];
  }
  if (secretKey.startsWith("iterate.")) {
    // Global: iterate.openai_api_key -> OPENAI_API_KEY
    return [secretKey.replace("iterate.", "").toUpperCase()];
  }
  if (secretKey.startsWith("github.")) {
    // GitHub: github.access_token -> GITHUB_ACCESS_TOKEN, GH_TOKEN
    // GH_TOKEN is required by GitHub CLI and many tools
    const base = secretKey.replace(".", "_").toUpperCase();
    const names = [base];
    if (secretKey === "github.access_token") {
      names.push("GH_TOKEN");
    }
    return [...new Set(names)];
  }
  if (secretKey.startsWith("slack.") || secretKey.startsWith("resend.")) {
    // Slack and Resend are specifically for our bots to send replies to users - worth including "ITERATE_" prefix for clarity.
    return ["ITERATE_" + secretKey.replace(".", "_").toUpperCase()];
  }
  if (secretKey.startsWith("google.")) {
    return [
      secretKey.replace("google.", "GOOGLE_").replace(".", "_").toUpperCase(),
      secretKey.replace("google.", "GOG_").replace(".", "_").toUpperCase(), // for gogcli
    ];
  }
  logger.error("Unexpected secret key type", { secretKey });
  return [];
}

/**
 * Determine the source type for a secret based on its key and scope.
 */
function getSecretSource(secretKey: string, isGlobal: boolean): EnvVarSource | null {
  if (isGlobal && secretKey.startsWith("iterate.")) {
    return { type: "global", description: "Iterate-provided secret" };
  }
  if (secretKey.startsWith("github.")) {
    return { type: "connection", provider: "github" };
  }
  if (secretKey.startsWith("slack.")) {
    return { type: "connection", provider: "slack" };
  }
  if (secretKey.startsWith("google.")) {
    return { type: "connection", provider: "google" };
  }
  return null;
}

/**
 * Get a unified list of all environment variables for a project.
 * This includes global env vars, connection-based env vars, and user-defined env vars.
 *
 * Order: global first, then connections, then user-defined (oldest to newest)
 */
export async function getUnifiedEnvVars(db: DB, projectId: string): Promise<UnifiedEnvVar[]> {
  // Fetch all data in parallel
  const [connections, projectEnvVars, secrets] = await Promise.all([
    // Project connections
    db.query.projectConnection.findMany({
      where: eq(schema.projectConnection.projectId, projectId),
    }),
    // User-defined env vars (project-level only, no machine-specific)
    db.query.projectEnvVar.findMany({
      where: and(
        eq(schema.projectEnvVar.projectId, projectId),
        isNull(schema.projectEnvVar.machineId),
      ),
      orderBy: (v, { asc }) => [asc(v.createdAt)],
    }),
    // Get all secrets for this project OR global secrets
    // ONLY key, description, egressProxyRule - NEVER encryptedValue!
    db.query.secret.findMany({
      columns: { key: true, description: true, egressProxyRule: true, projectId: true },
      where: and(
        isNull(schema.secret.userId),
        or(eq(schema.secret.projectId, projectId), isNull(schema.secret.projectId)),
      ),
    }),
  ]);

  // Separate global vs project secrets
  const globalSecrets = secrets.filter((s) => s.projectId === null);
  const projectSecrets = secrets.filter((s) => s.projectId !== null);

  // Check which connections are active
  const hasGitHub = connections.some((c) => c.provider === "github-app");
  const hasSlack =
    connections.some((c) => c.provider === "slack") &&
    projectSecrets.some((s) => s.key === "slack.access_token");
  const hasGoogle = connections.some((c) => c.provider === "google");

  const result: UnifiedEnvVar[] = [];

  // 1. Global secrets (iterate.*)
  for (const secret of globalSecrets) {
    const envVarNames = secretKeyToEnvVarNames(secret.key);
    const source = getSecretSource(secret.key, true);
    if (!source || envVarNames.length === 0) continue;

    for (const envVarName of envVarNames) {
      result.push({
        key: envVarName,
        value: `getIterateSecret({secretKey: '${secret.key}'})`,
        isSecret: true,
        description: secret.description,
        egressProxyRule: secret.egressProxyRule,
        source,
        createdAt: null,
      });
    }
  }

  // 2. Connection secrets (github/slack/google.*)
  for (const secret of projectSecrets) {
    const source = getSecretSource(secret.key, false);
    if (!source || source.type !== "connection") continue;

    // Check if connection is active
    const isActive =
      (source.provider === "github" && hasGitHub) ||
      (source.provider === "slack" && hasSlack) ||
      (source.provider === "google" && hasGoogle);
    if (!isActive) continue;

    const envVarNames = secretKeyToEnvVarNames(secret.key);
    for (const envVarName of envVarNames) {
      result.push({
        key: envVarName,
        value: `getIterateSecret({secretKey: '${secret.key}'})`,
        isSecret: true,
        description: secret.description,
        egressProxyRule: secret.egressProxyRule,
        source,
        createdAt: null,
      });
    }
  }

  // 3. User-defined env vars (oldest to newest)
  for (const envVar of projectEnvVars) {
    result.push({
      key: envVar.key,
      value: envVar.value,
      isSecret: envVar.value.includes("getIterateSecret"),
      description: null,
      egressProxyRule: null,
      source: { type: "user", envVarId: envVar.id },
      createdAt: envVar.createdAt,
    });
  }

  return result;
}

/**
 * Build the final env vars record for a machine, applying overrides.
 * User-defined env vars override connection env vars, which override global env vars.
 */
export function buildEnvVarsRecord(envVars: UnifiedEnvVar[]): Record<string, string> {
  const result: Record<string, string> = {};

  // Apply in order - later values override earlier ones
  for (const envVar of envVars) {
    result[envVar.key] = envVar.value;
  }

  return result;
}
