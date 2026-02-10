/**
 * File-backed secret store with hierarchy resolution and magic string replacement.
 *
 * Secrets are loaded from a JSON file and cached in memory. A file watcher
 * reloads on change. Lookup resolves most-specific scope first:
 *   users.<userId>.<key> → projects.<projectId>.<key> → orgs.<orgId>.<key> → <key>
 *
 * Magic string format:
 *   getIterateSecret({secretKey: "openai.api_key"})
 *   getIterateSecret({secretKey: "openai.api_key", userId: "usr_alice"})
 */

import fs from "node:fs";
import type { Logger } from "./utils.ts";

export type Secret = {
  key: string;
  value: string;
  egressRule?: string;
};

export type SecretsFile = {
  secrets: Secret[];
};

export type ParsedMagicString = {
  secretKey: string;
  userId?: string;
  projectId?: string;
  orgId?: string;
};

export type SecretContext = {
  userId?: string;
  projectId?: string;
  orgId?: string;
};

export type ReplaceMagicStringsResult =
  | { ok: true; result: string; usedSecrets: string[] }
  | { ok: false; error: string };

const MAGIC_PREFIX = "getIterateSecret";
const MAGIC_REGEX = /getIterateSecret\(\s*\{([^}]+)\}\s*\)/g;

export function needsMagicStringScan(input: string): boolean {
  return input.includes(MAGIC_PREFIX);
}

/**
 * Parse the inside of a magic string. Handles both JSON and simple key=value pairs
 * since agents may produce either format.
 */
export function parseMagicString(match: string): ParsedMagicString | null {
  const objectMatch = match.match(/\{([^}]+)\}/);
  if (!objectMatch) return null;

  const inner = objectMatch[1];

  // Try JSON parse first
  try {
    const parsed = JSON.parse(`{${inner}}`) as Record<string, string>;
    if (!parsed.secretKey) return null;
    return {
      secretKey: parsed.secretKey,
      userId: parsed.userId,
      projectId: parsed.projectId,
      orgId: parsed.orgId,
    };
  } catch {
    // Fall through to key-value parsing
  }

  // Parse key: 'value' or key: "value" pairs (JSON5-ish)
  const pairs: Record<string, string> = {};
  const pairRegex = /(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
  let pairMatch: RegExpExecArray | null;
  while ((pairMatch = pairRegex.exec(inner)) !== null) {
    pairs[pairMatch[1]] = pairMatch[2] ?? pairMatch[3] ?? "";
  }

  if (!pairs.secretKey) return null;
  return {
    secretKey: pairs.secretKey,
    userId: pairs.userId,
    projectId: pairs.projectId,
    orgId: pairs.orgId,
  };
}

export type SecretStore = {
  lookup: (secretKey: string, context?: SecretContext) => Secret | null;
  replaceMagicStrings: (
    input: string,
    context: SecretContext,
    egressRuleChecker?: (rule: string, url: string) => Promise<boolean>,
    url?: string,
  ) => Promise<ReplaceMagicStringsResult>;
  getKeys: () => string[];
  getCount: () => number;
};

export function createSecretStore(filePath: string, logger: Logger): SecretStore {
  let secretsMap = new Map<string, Secret>();

  function load(): void {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as SecretsFile;
      const newMap = new Map<string, Secret>();
      for (const secret of parsed.secrets) {
        newMap.set(secret.key, secret);
      }
      secretsMap = newMap;
      logger.appendLog(`SECRETS_LOAD count=${secretsMap.size} path=${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.appendLog(`SECRETS_LOAD path=${filePath} not_found (using empty store)`);
        secretsMap = new Map();
      } else {
        logger.appendLog(`SECRETS_LOAD_ERROR ${message} (keeping previous store)`);
      }
    }
  }

  // Initial load
  load();

  // Watch for changes
  fs.watchFile(filePath, { interval: 1000 }, () => {
    load();
  });

  function lookup(secretKey: string, context?: SecretContext): Secret | null {
    // Hierarchy: user > project > org > global
    if (context?.userId) {
      const userScoped = secretsMap.get(`users.${context.userId}.${secretKey}`);
      if (userScoped) return userScoped;
    }
    if (context?.projectId) {
      const projectScoped = secretsMap.get(`projects.${context.projectId}.${secretKey}`);
      if (projectScoped) return projectScoped;
    }
    if (context?.orgId) {
      const orgScoped = secretsMap.get(`orgs.${context.orgId}.${secretKey}`);
      if (orgScoped) return orgScoped;
    }
    return secretsMap.get(secretKey) ?? null;
  }

  async function replaceMagicStrings(
    input: string,
    context: SecretContext,
    egressRuleChecker?: (rule: string, url: string) => Promise<boolean>,
    url?: string,
  ): Promise<ReplaceMagicStringsResult> {
    if (!needsMagicStringScan(input)) {
      return { ok: true, result: input, usedSecrets: [] };
    }

    const matches = [...input.matchAll(new RegExp(MAGIC_REGEX.source, "g"))];
    if (matches.length === 0) {
      return { ok: true, result: input, usedSecrets: [] };
    }

    let result = input;
    const usedSecrets: string[] = [];

    for (const match of matches) {
      const fullMatch = match[0];
      const parsed = parseMagicString(fullMatch);
      if (!parsed) {
        logger.appendLog(`SECRET_PARSE_ERROR invalid magic string: ${fullMatch.slice(0, 80)}`);
        continue;
      }

      // Merge context from magic string args
      const lookupContext: SecretContext = {
        userId: parsed.userId ?? context.userId,
        projectId: parsed.projectId ?? context.projectId,
        orgId: parsed.orgId ?? context.orgId,
      };

      const secret = lookup(parsed.secretKey, lookupContext);
      if (!secret) {
        return {
          ok: false,
          error: `Secret '${parsed.secretKey}' not found`,
        };
      }

      // Check egress rule if present
      if (secret.egressRule && egressRuleChecker && url) {
        const allowed = await egressRuleChecker(secret.egressRule, url);
        if (!allowed) {
          return {
            ok: false,
            error: `Secret '${parsed.secretKey}' is not allowed for this URL`,
          };
        }
      }

      result = result.replace(fullMatch, secret.value);
      usedSecrets.push(secret.key);
    }

    return { ok: true, result, usedSecrets };
  }

  return {
    lookup,
    replaceMagicStrings,
    getKeys: () => [...secretsMap.keys()],
    getCount: () => secretsMap.size,
  };
}
