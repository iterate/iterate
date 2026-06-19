import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_BRANCH = "main";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(SCRIPT_DIR);
const WRANGLER_CONFIG = join(APP_DIR, "wrangler.jsonc");

type ArtifactRepo = {
  default_branch?: string;
  defaultBranch?: string;
  id: string;
  name: string;
  remote?: string;
};

type CloudflareEnvelope<T> = {
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ message?: string }>;
  result?: T;
  result_info?: {
    cursor?: string;
    next_cursor?: string;
  };
  success?: boolean;
};

type Flags = Record<string, string | boolean>;

class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: Array<{ code?: number; message?: string }>,
    message: string,
  ) {
    super(message);
  }

  hasCode(code: number) {
    return this.errors.some((error) => error.code === code);
  }
}

async function run(command: string | undefined, positional: string[], flags: Flags) {
  const options = {
    accountId:
      stringFlag(flags, "account-id") ??
      process.env.CLOUDFLARE_ACCOUNT_ID ??
      configValue("account_id"),
    json: booleanFlag(flags, "json"),
    namespace:
      stringFlag(flags, "namespace") ??
      process.env.ARTIFACTS_NAMESPACE ??
      configValue("ARTIFACTS_NAMESPACE") ??
      configValue("namespace"),
    token:
      process.env.ARTIFACTS_API_TOKEN?.trim() ||
      process.env.CLOUDFLARE_API_TOKEN?.trim() ||
      readWranglerAuthToken(),
  };

  if (!command || command === "help" || booleanFlag(flags, "help")) {
    printUsage();
    return;
  }
  if (!options.accountId)
    throw new Error("Missing account id. Pass --account-id or set it in wrangler.jsonc.");
  if (!options.namespace && !["fresh-namespace"].includes(command)) {
    throw new Error(
      "Missing namespace. Pass --namespace or set ARTIFACTS_NAMESPACE in wrangler.jsonc.",
    );
  }

  const client = new ArtifactsApi(options.accountId, options.token);

  if (command === "list") {
    const namespace = requireNamespace(options.namespace);
    const prefix = stringFlag(flags, "prefix");
    const repos = (await client.listRepos(namespace)).filter(
      (repo) => !prefix || repo.name.startsWith(prefix),
    );
    print(options.json, repos, repos.map((repo) => repo.name).join("\n"));
    return;
  }

  if (command === "get") {
    const namespace = requireNamespace(options.namespace);
    const name = requirePositional(positional, 0, "repo name");
    print(options.json, await client.getRepo(namespace, name));
    return;
  }

  if (command === "create") {
    const namespace = requireNamespace(options.namespace);
    const name = requirePositional(positional, 0, "repo name");
    const defaultBranch = stringFlag(flags, "default-branch") ?? DEFAULT_BRANCH;
    const repo = await client.createRepo({
      defaultBranch,
      name,
      namespace,
      strict: booleanFlag(flags, "strict"),
    });
    print(options.json, repo, `ready ${repo.name}`);
    return;
  }

  if (command === "delete") {
    const namespace = requireNamespace(options.namespace);
    const name = requirePositional(positional, 0, "repo name");
    const result = await client.deleteRepo({
      missingOk: booleanFlag(flags, "missing-ok") || !booleanFlag(flags, "strict"),
      name,
      namespace,
    });
    print(options.json, result, `${result.status} ${name}`);
    return;
  }

  if (command === "reset") {
    const namespace = requireNamespace(options.namespace);
    if (!booleanFlag(flags, "force")) {
      throw new Error("reset deletes repos; pass --force.");
    }
    const prefix = stringFlag(flags, "prefix");
    const repos = (await client.listRepos(namespace)).filter(
      (repo) => !prefix || repo.name.startsWith(prefix),
    );
    const deleted = [];
    for (const repo of repos) {
      deleted.push(await client.deleteRepo({ missingOk: true, name: repo.name, namespace }));
    }
    print(options.json, { deleted, namespace }, `deleted ${deleted.length} repos`);
    return;
  }

  if (command === "recreate-namespace") {
    const namespace = requireNamespace(options.namespace);
    if (!booleanFlag(flags, "force")) {
      throw new Error("recreate-namespace deletes repos; pass --force.");
    }
    const bootstrapName =
      stringFlag(flags, "bootstrap-name") ?? `namespace-bootstrap-${Date.now().toString(36)}`;
    const repos = await client.listRepos(namespace).catch((error: unknown) => {
      if (isNotFound(error)) return [] as ArtifactRepo[];
      throw error;
    });
    for (const repo of repos) {
      await client.deleteRepo({ missingOk: true, name: repo.name, namespace });
    }
    const bootstrap = await client.createRepo({
      defaultBranch: DEFAULT_BRANCH,
      name: bootstrapName,
      namespace,
    });
    print(
      options.json,
      { bootstrap, deleted: repos.length, namespace },
      `recreated ${namespace} with ${bootstrap.name}`,
    );
    return;
  }

  if (command === "fresh-namespace") {
    const base = stringFlag(flags, "base") ?? options.namespace ?? "minimal-itx-v2-repos";
    const namespace = `${base}-fresh-${new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/g, "")
      .slice(0, 14)}`;
    const bootstrapName =
      stringFlag(flags, "bootstrap-name") ?? `namespace-bootstrap-${Date.now().toString(36)}`;
    const bootstrap = await client.createRepo({
      defaultBranch: DEFAULT_BRANCH,
      name: bootstrapName,
      namespace,
    });
    print(options.json, { bootstrap, namespace }, `created ${namespace} with ${bootstrap.name}`);
    return;
  }

  throw new Error(`Unknown command "${command}".`);
}

class ArtifactsApi {
  constructor(
    readonly accountId: string,
    readonly token: string,
  ) {}

  async listRepos(namespace: string) {
    const repos: ArtifactRepo[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request<ArtifactRepo[]>(
        "GET",
        `/artifacts/namespaces/${namespace}/repos`,
        {
          cursor,
          limit: "200",
        },
      );
      repos.push(...response.result);
      cursor = response.cursor;
    } while (cursor);
    return repos;
  }

  async getRepo(namespace: string, name: string) {
    return (
      await this.request<ArtifactRepo>(
        "GET",
        `/artifacts/namespaces/${namespace}/repos/${encodeURIComponent(name)}`,
      )
    ).result;
  }

  async createRepo(input: {
    defaultBranch: string;
    name: string;
    namespace: string;
    strict?: boolean;
  }) {
    try {
      await this.request<ArtifactRepo>(
        "POST",
        `/artifacts/namespaces/${input.namespace}/repos`,
        undefined,
        {
          default_branch: input.defaultBranch,
          name: input.name,
        },
      );
    } catch (error) {
      if (input.strict || !isConflict(error)) throw error;
    }
    return await this.waitForRepo(input.namespace, input.name);
  }

  async deleteRepo(input: { missingOk: boolean; name: string; namespace: string }) {
    try {
      await this.request<unknown>(
        "DELETE",
        `/artifacts/namespaces/${input.namespace}/repos/${encodeURIComponent(input.name)}`,
      );
    } catch (error) {
      if (input.missingOk && isNotFound(error)) return { name: input.name, status: "missing" };
      throw error;
    }
    await this.waitForMissing(input.namespace, input.name);
    return { name: input.name, status: "deleted" };
  }

  private async waitForRepo(namespace: string, name: string) {
    return await retryState(`repo ${name} to exist`, async () => {
      try {
        return await this.getRepo(namespace, name);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  private async waitForMissing(namespace: string, name: string) {
    await retryState(`repo ${name} to be deleted`, async () => {
      try {
        await this.getRepo(namespace, name);
        return null;
      } catch (error) {
        if (isNotFound(error)) return true;
        throw error;
      }
    });
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string | undefined>,
    body?: Record<string, unknown>,
  ): Promise<{ cursor?: string; result: T }> {
    const url = new URL(`${API_BASE}/accounts/${this.accountId}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(url, {
          body: body ? JSON.stringify(dropUndefinedValues(body)) : undefined,
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          method,
        });
        const envelope = (await response.json()) as CloudflareEnvelope<T>;
        if (response.ok && envelope.success === true && envelope.result !== undefined) {
          return {
            cursor: envelope.result_info?.cursor ?? envelope.result_info?.next_cursor,
            result: envelope.result,
          };
        }
        const errors = envelope.errors ?? [];
        const message = cloudflareErrorMessage(envelope);
        const error = new CloudflareApiError(response.status, errors, message);
        if (isTransient(error) && attempt < 4) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw error;
      } catch (error) {
        if (isNetworkError(error) && attempt < 4) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Cloudflare Artifacts request did not complete: ${method} ${path}`);
  }
}

async function retryState<T>(description: string, check: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await check();
    if (value !== null) return value;
    await sleep(Math.min(2_000, 200 * 1.25 ** attempt));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function parseArgs(argv: string[]) {
  const flags: Flags = {};
  const positional: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("-")) {
      flags[rawKey] = next;
      index++;
    } else {
      flags[rawKey] = true;
    }
  }

  return { command, flags, positional };
}

function readWranglerAuthToken() {
  const result = spawnSync("wrangler", ["auth", "token", "--json"], {
    cwd: APP_DIR,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to read Wrangler auth token. Run wrangler login or set CLOUDFLARE_API_TOKEN.\n${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { token?: string };
  if (!parsed.token?.trim()) throw new Error("Wrangler auth token output did not include a token.");
  return parsed.token.trim();
}

function configValue(key: string) {
  const config = readFileSync(WRANGLER_CONFIG, "utf8");
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`).exec(config);
  return match?.[1];
}

function stringFlag(flags: Flags, name: string) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(flags: Flags, name: string) {
  return flags[name] === true;
}

function requirePositional(positional: string[], index: number, label: string) {
  const value = positional[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function requireNamespace(namespace: string | undefined) {
  if (!namespace)
    throw new Error("Missing namespace. Pass --namespace or set ARTIFACTS_NAMESPACE.");
  return namespace;
}

function isNotFound(error: unknown) {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 404 || error.hasCode(10200) || /not found/i.test(error.message))
  );
}

function isConflict(error: unknown) {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 409 || /already|exists/i.test(error.message))
  );
}

function isTransient(error: unknown) {
  return error instanceof CloudflareApiError && [429, 500, 502, 503, 504].includes(error.status);
}

function isNetworkError(error: unknown) {
  return error instanceof TypeError;
}

function cloudflareErrorMessage(payload: CloudflareEnvelope<unknown>) {
  const messages = [...(payload.errors ?? []), ...(payload.messages ?? [])]
    .map((entry) => entry.message)
    .filter((message) => typeof message === "string" && message.length > 0);
  return messages.length > 0 ? messages.join("; ") : JSON.stringify(payload);
}

function dropUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function print(json: boolean, value: unknown, text?: string) {
  console.log(json || !text ? JSON.stringify(value, null, 2) : text);
}

function printUsage() {
  console.log(`Usage:
  tsx scripts/artifacts.ts list [--namespace <name>] [--prefix <prefix>] [--json]
  tsx scripts/artifacts.ts get <repo> [--namespace <name>] [--json]
  tsx scripts/artifacts.ts create <repo> [--namespace <name>] [--default-branch main] [--strict] [--json]
  tsx scripts/artifacts.ts delete <repo> [--namespace <name>] [--missing-ok] [--strict] [--json]
  tsx scripts/artifacts.ts reset --force [--namespace <name>] [--prefix <prefix>] [--json]
  tsx scripts/artifacts.ts recreate-namespace --force [--namespace <name>] [--bootstrap-name <repo>] [--json]
  tsx scripts/artifacts.ts fresh-namespace [--base <namespace>] [--bootstrap-name <repo>] [--json]

Auth:
  Uses ARTIFACTS_API_TOKEN, CLOUDFLARE_API_TOKEN, or wrangler auth token --json.
`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const { command, flags, positional } = parseArgs(process.argv.slice(2));

try {
  await run(command, positional, flags);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
