import { eq, and, isNull, or } from "drizzle-orm";
import { logger } from "../tag-logger.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { parseMagicString, type ParsedSecret } from "../egress-proxy/egress-proxy.ts";

export type { ParsedSecret };

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
  | { type: "user"; envVarId: string }
  | { type: "recommended"; provider: "google"; userEmail: string };

export type UnifiedEnvVar = {
  key: string;
  value: string;
  /** Parsed secret info if value is a getIterateSecret() magic string, null otherwise */
  secret: ParsedSecret | null;
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
  if (secretKey === "slack.access_token") {
    return ["SLACK_BOT_TOKEN"];
  }
  if (secretKey === "replicate.api_token") {
    return ["REPLICATE_API_TOKEN"];
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
    // Include user relation for user-scoped secrets (e.g., Google OAuth)
    db.query.secret.findMany({
      columns: {
        key: true,
        description: true,
        egressProxyRule: true,
        projectId: true,
        userId: true,
      },
      where: or(eq(schema.secret.projectId, projectId), isNull(schema.secret.projectId)),
      with: {
        user: { columns: { email: true } },
      },
    }),
  ]);

  // Separate secrets by type
  const globalSecrets = secrets.filter((s) => s.projectId === null);
  const projectSecrets = secrets.filter((s) => s.projectId !== null && !s.userId);
  const userScopedSecrets = secrets.filter((s) => s.projectId !== null && s.userId);

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
      const magicString = `getIterateSecret({secretKey: '${secret.key}'})`;
      result.push({
        key: envVarName,
        value: magicString,
        secret: parseMagicString(magicString),
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
      const magicString = `getIterateSecret({secretKey: '${secret.key}'})`;
      result.push({
        key: envVarName,
        value: magicString,
        secret: parseMagicString(magicString),
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
      secret: parseMagicString(envVar.value),
      description: envVar.description,
      egressProxyRule: null,
      source: { type: "user", envVarId: envVar.id },
      createdAt: envVar.createdAt,
    });
  }

  // 4. Recommended env vars (user-scoped secrets like Google OAuth)
  // These appear last so agents can see them as options, but they're not active
  // unless explicitly added as user env vars
  const existingKeys = new Set(result.map((r) => r.key));
  for (const secret of userScopedSecrets) {
    // Only user-scoped secrets (have userId and user relation)
    if (!secret.userId || !secret.user) continue;

    let provider: "google" | undefined;
    if (secret.key.startsWith("google.")) {
      provider = "google";
    }
    if (!provider) continue; // Only support known providers

    const envVarNames = secretKeyToEnvVarNames(secret.key);
    for (const envVarName of envVarNames) {
      // Skip if already exists as an active env var
      if (existingKeys.has(envVarName)) continue;

      const magicString = `getIterateSecret({secretKey: '${secret.key}', userEmail: '${secret.user.email}'})`;
      result.push({
        key: envVarName,
        value: magicString,
        secret: parseMagicString(magicString),
        description: `Scoped to ${secret.user.email}`,
        egressProxyRule: secret.egressProxyRule,
        source: { type: "recommended", provider, userEmail: secret.user.email },
        createdAt: null,
      });
    }
  }

  return result;
}
