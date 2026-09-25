import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import repl from "node:repl";
import { RpcTarget } from "capnweb";
import * as prompts from "@clack/prompts";
import { os } from "@orpc/server";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";
import { connectIterate } from "iterate/node";
import type { SessionCredentials } from "iterate/api";
import { isCodingAgent } from "./coding-agent.ts";
import { launchMenubarApp } from "./menubar-app.ts";
import { oauthLogin, refreshOAuthSession } from "./oauth.ts";
import { runTunnel } from "./tunnel.ts";
import { shareMyComputer } from "./use-my-computer.ts";
import {
  CONFIG_PATH,
  Config,
  DEFAULT_CONFIG_NAME,
  readConfig,
  readConfigFile,
  removeConfigSession,
  updateConfigSession,
  writeConfigFile,
  type StoredSession,
} from "./config.ts";

const isAgent = isCodingAgent(process.env);
let configFlagOverride: string | undefined;
const consumeCliStringFlag = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) return undefined;
  const value = args[flagIndex + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flagName} requires a value`);
  process.argv.splice(flagIndex + 2, 2);
  return value;
};
const hasConfig = (configFile: ReturnType<typeof readConfigFile>, name: string) =>
  name === DEFAULT_CONFIG_NAME || Boolean(configFile.configs?.[name]);

/**
 * Resolve which config name to use.
 * Priority: --config flag > workspace match (walk up from cwd) > default > single-config auto > built-in prd
 */
const resolveConfigName = (workspacePath: string): string | Error => {
  const configFile = readConfigFile();

  if (configFlagOverride) {
    if (!hasConfig(configFile, configFlagOverride)) {
      return new Error(
        `Config "${configFlagOverride}" not found. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
      );
    }
    return configFlagOverride;
  }

  let dir = workspacePath;
  while (dir && dir !== "/") {
    const match = configFile.workspaces?.[dir];
    if (match) {
      if (!hasConfig(configFile, match)) {
        return new Error(`Workspace "${dir}" maps to config "${match}" which doesn't exist.`);
      }
      return match;
    }
    dir = dirname(dir);
  }

  if (configFile.default) {
    if (!hasConfig(configFile, configFile.default)) {
      return new Error(
        `Default config "${configFile.default}" doesn't exist. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
      );
    }
    return configFile.default;
  }

  const configNames = Object.keys(configFile.configs || {});
  if (configNames.length === 1) return configNames[0];

  return DEFAULT_CONFIG_NAME;
};

function resolveConfig(workspacePath: string): { name: string; config: Config } | Error;
function resolveConfig(
  workspacePath: string,
  options: { throw: true },
): { name: string; config: Config };
function resolveConfig(
  workspacePath: string,
  options?: { throw: true },
): { name: string; config: Config } | Error {
  const result = ((): { name: string; config: Config } | Error => {
    const name = resolveConfigName(workspacePath);
    if (name instanceof Error) return name;
    const config = readConfig(name);
    if (config instanceof Error) return config;
    return { name, config };
  })();
  if (result instanceof Error && options?.throw) throw result;
  return result;
}

/**
 * Resolve the config's OAuth credentials before connecting.
 * OAuth sessions are refreshed when possible.
 */
const storedCredentials = async (
  config: Config,
  configName: string,
): Promise<SessionCredentials> => {
  let session = config.session;
  if (!session) {
    throw new Error(`Not logged in to ${config.osBaseUrl}. Run \`iterate login\` first.`);
  }
  if (sessionNeedsRefresh(session)) {
    session = await refreshOAuthSession({ issuer: config.osBaseUrl, session });
    config.session = session;
    updateConfigSession(configName, session);
  }
  if (session.token) {
    return { type: "bearer", token: session.token };
  }
  throw new Error(`No bearer token for ${config.osBaseUrl}. Run \`iterate login\` again.`);
};

const sessionNeedsRefresh = (session: StoredSession) => {
  if (!session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
};

const credentialsForConfig = async (config: Config, name: string): Promise<SessionCredentials> => {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (secret) return { type: "admin-secret", secret };
  const token = process.env.ITERATE_BEARER_TOKEN?.trim();
  if (token) return { type: "bearer", token };
  return await storedCredentials(config, name);
};
/** THE `tokens` COMMANDS' OWN SIGN-IN, a step up from the stored login: a person's keys are managed
 *  only with the `account` scope, which `iterate login` does not ask for, so the refresh token a
 *  config file keeps on disk mints nothing. Each `tokens` command signs in in the browser asking for
 *  `account`, holds that session in memory for its one call, and ends it before it returns (the key
 *  it minted outlives it, and lists it as `mintedBy`). Whatever the environment holds is not used: a
 *  key in `ITERATE_BEARER_TOKEN` has `iterate` alone, and the operator's bearer names no person. */
const withAccountSession = async <T>(
  run: (session: Awaited<ReturnType<typeof connectIterate>>["session"]) => Promise<T>,
): Promise<T> => {
  const { config } = resolveConfig(process.cwd(), { throw: true });
  console.error(`Signing in to ${config.osBaseUrl} to manage your personal access tokens...`);
  const stepUp = await oauthLogin({
    issuer: config.osBaseUrl,
    openBrowser: openBrowserForLogin,
    scopes: ["iterate", "account"],
  });
  using connection = await connectIterate({
    baseUrl: config.osBaseUrl,
    auth: { type: "bearer", token: stepUp.token },
  });
  try {
    return await run(connection.session);
  } finally {
    // A failed sign-out must not hide what the call answered (a minted key is printed once): the
    // session held no refresh token on disk, and its access token lapses within the hour.
    await connection.session.logout().catch((error: unknown) => {
      console.error(
        `Could not end this sign-in (${error instanceof Error ? error.message : String(error)}); end it from the Dash's Sessions page.`,
      );
    });
  }
};
const connectConfigured = async () => {
  const resolved = resolveConfig(process.cwd(), { throw: true });
  const connection = await connectIterate({
    baseUrl: resolved.config.osBaseUrl,
    auth: await credentialsForConfig(resolved.config, resolved.name),
  });
  return { resolved, connection };
};
const selectProject = async (
  connection: Awaited<ReturnType<typeof connectIterate>>,
  configured?: string,
) => {
  if (configured) return configured;
  const projects = await connection.session.projects.list();
  if (projects.length === 1) return projects[0].id;
  throw new Error(
    `Pass --project or set defaultProject in ${CONFIG_PATH}. Accessible projects: ${projects.map((p) => `${p.slug} (${p.id})`).join(", ") || "none"}.`,
  );
};
const openUrlInBrowser = async (url: string) => {
  const { execFile } = await import("node:child_process");
  const { command, args } =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  execFile(command, args, (error) => {
    if (error)
      console.error(`Could not open a browser: ${error.message}. Open the URL above manually.`);
  });
};

const readErrorBody = async (response: Response) => {
  const text = await response.text();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
};

/** The authorization URL, printed (an agent, or `ITERATE_SKIP_BROWSER_OPEN=1`, opens it itself)
 *  and opened in the person's browser. */
const openBrowserForLogin = async (url: URL) => {
  console.error(`\nOpening browser to authenticate with Iterate:\n`);
  console.error(`  ${url.href}\n`);
  if (!isAgent && process.env.ITERATE_SKIP_BROWSER_OPEN !== "1") await openUrlInBrowser(url.href);
};

const loginToResolvedConfig = async (resolved: { name: string; config: Config }) => {
  const { config } = resolved;

  console.error(`Logging in to ${config.osBaseUrl}...`);
  const oauthResult = await oauthLogin({
    issuer: config.osBaseUrl,
    openBrowser: openBrowserForLogin,
  });

  // Update in-memory config so subsequent verification and calls see the token.
  config.session = oauthResult;

  using connection = await connectIterate({
    baseUrl: config.osBaseUrl,
    auth: { type: "bearer", token: oauthResult.token },
  });
  await connection.session.whoami();

  updateConfigSession(resolved.name, oauthResult);
  return oauthResult;
};

const launcherProcedures = {
  ping: os.input(z.object({})).handler(async () => {
    const { connection } = await connectConfigured();
    using owned = connection;
    return { message: "Iterate session valid", principal: await owned.session.whoami() };
  }),
  login: os
    .input(z.object({}))
    .meta({ description: "Authenticate with Iterate via browser OAuth" })
    .handler(async () => {
      const session = await loginToResolvedConfig(resolveConfig(process.cwd(), { throw: true }));
      return {
        message: "Logged in successfully",
        expiresAt: session.expiresAt,
        scope: session.scope,
      };
    }),
  logout: os
    .input(z.object({}))
    .meta({ description: "Remove the current config's stored session" })
    .handler(async () => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      removeConfigSession(resolved.name);
      return { message: `Logged out from ${resolved.name}` };
    }),
  orgs: {
    list: os.input(z.object({})).handler(async () => {
      const { connection } = await connectConfigured();
      using owned = connection;
      return await owned.session.organizations.list();
    }),
  },
  projects: {
    list: os.input(z.object({})).handler(async () => {
      const { connection } = await connectConfigured();
      using owned = connection;
      return await owned.session.projects.list();
    }),
  },
  repl: os
    .input(
      z.object({
        project: z.string().optional().describe("Project id or slug"),
        context: z.string().default("/").describe("Context path within the project"),
      }),
    )
    .meta({ description: "Open a local Node REPL with itx and RpcTarget in scope" })
    .handler(async ({ input }) => {
      const { resolved, connection } = await connectConfigured();
      using owned = connection;
      const project = input.project || resolved.config.defaultProject;
      if (!project && input.context !== "/")
        throw new Error("--context requires --project or a configured defaultProject.");
      using root = project ? await owned.session.projects.get(project) : null;
      using context = root ? await root.cd(input.context) : null;
      console.error(
        `Connected to ${resolved.config.osBaseUrl}, ${project ? `project ${project}, context ${input.context}` : "session"}. Use .exit to quit.`,
      );
      // capnweb identifies built-ins by prototype. Evaluate in this process's
      // realm so objects and argument arrays use the transport's constructors.
      const server = repl.start({ prompt: "itx> ", useGlobal: true });
      const initialize = () => {
        server.context.itx = context || owned.session;
        server.context.RpcTarget = RpcTarget;
      };
      initialize();
      server.on("reset", initialize);
      try {
        const outcome = await Promise.race([
          new Promise<"exit">((resolve) => server.once("exit", () => resolve("exit"))),
          owned.closed,
        ]);
        if (outcome !== "exit") {
          throw new Error(
            `REPL disconnected (${outcome.code}: ${outcome.reason || "connection closed"}). Start a new REPL to reconnect.`,
          );
        }
      } finally {
        server.close();
      }
    }),
  itx: {
    run: os
      .input(
        z
          .object({
            project: z
              .string()
              .optional()
              .describe("Project id or slug; defaults to config.defaultProject"),
            context: z.string().default("/").describe("Context path within the project"),
            eval: z
              .string()
              .optional()
              .describe("Script body with itx in scope; use return for the result"),
            file: z
              .string()
              .optional()
              .describe("Read the script from a UTF-8 file; - reads stdin"),
          })
          .refine(
            (input) => Boolean(input.eval) !== Boolean(input.file),
            "Specify exactly one of --eval or --file",
          ),
      )
      .meta({ description: "Run an itx script once on Iterate" })
      .handler(async ({ input }) => {
        let script = input.eval;
        if (input.file === "-") {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          script = Buffer.concat(chunks).toString("utf8");
        } else if (input.file) script = await readFile(input.file, "utf8");
        const { resolved, connection } = await connectConfigured();
        using owned = connection;
        const project = await selectProject(owned, input.project || resolved.config.defaultProject);
        using root = await owned.session.projects.get(project);
        using context = await root.cd(input.context);
        return await context.run(`async (itx) => {\n${script}\n}`);
      }),
  },
  tokens: {
    create: os
      .input(
        z.object({
          name: z
            .string()
            .trim()
            .min(1)
            .describe("What the token is for, as the sessions list shows it"),
          project: z
            .array(z.string())
            .min(1)
            .describe("The projects the token may reach, by id or slug"),
          expiresInDays: z
            .number()
            .int()
            .positive()
            .default(30)
            .describe("Days until the token expires"),
          neverExpires: z
            .boolean()
            .optional()
            .describe("A token that ends only when it is revoked"),
        }),
      )
      .meta({
        description:
          "Mint a personal access token: your bearer at /api, at /mcp and on the projects' hosts, printed once (signs in with the account scope for this one call)",
      })
      .handler(async ({ input }) =>
        withAccountSession(async (session) => {
          const reachable = await session.projects.list();
          const projects = input.project.map((ref) => {
            const project = reachable.find((row) => row.id === ref || row.slug === ref);
            if (!project)
              throw new Error(
                `No project ${JSON.stringify(ref)} in this session. Accessible projects: ${reachable.map((row) => row.slug).join(", ") || "none"}.`,
              );
            return project.id;
          });
          return await session.grants.mint({
            name: input.name,
            projects,
            expiresAt: input.neverExpires
              ? undefined
              : Date.now() + input.expiresInDays * 24 * 3600_000,
          });
        }),
      ),
    list: os
      .input(z.object({}))
      .meta({
        description:
          "List your personal access tokens, never their bearers (signs in with the account scope for this one call)",
      })
      .handler(async () =>
        withAccountSession(async (session) => {
          const { items } = await session.grants.list();
          return items
            .filter((item) => item.kind === "personal" || item.kind === "device")
            .map(({ id, name, projects, expiresAt, lastUsedAt, mintedBy }) => ({
              id,
              name,
              projects: projects?.join(", "),
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "never",
              lastUsedAt: lastUsedAt ? new Date(lastUsedAt).toISOString() : null,
              mintedBy:
                items.find((item) => item.id === mintedBy)?.name ??
                `${mintedBy} (no longer listed)`,
            }));
        }),
      ),
    revoke: os
      .input(
        z.object({ id: z.string().meta({ positional: true }).describe("The token's id, pat_…") }),
      )
      .meta({
        description:
          "Revoke a personal access token: refused everywhere at once (signs in with the account scope for this one call)",
      })
      .handler(async ({ input }) =>
        withAccountSession(async (session) => {
          await session.grants.end(input.id);
          return { revoked: input.id };
        }),
      ),
  },
  mcp: {
    claude: os
      .input(
        z.object({
          exec: z
            .boolean()
            .optional()
            .describe("Run Claude Code in this terminal instead of printing its command"),
        }),
      )
      .meta({
        description:
          "Claude Code against the config's /mcp with a personal access token (ITERATE_BEARER_TOKEN): checks tools/list, then prints or runs the command",
      })
      .handler(async ({ input }) => {
        const token = process.env.ITERATE_BEARER_TOKEN?.trim();
        if (!token)
          throw new Error(
            "iterate mcp claude needs ITERATE_BEARER_TOKEN, a personal access token of the deployment the config names: `iterate tokens create --name claude --project <slug>` mints one.",
          );
        const resolved = resolveConfig(process.cwd(), { throw: true });
        const { mcpUrl, tools } = await preflightMcp(resolved.config.osBaseUrl, token);
        console.error(`${mcpUrl} accepted the bearer; tools: ${tools.join(", ")}`);
        if (!input.exec) {
          // stdout carries the command alone, so `eval "$(iterate mcp claude)"` runs it; the key
          // stays in the environment, never in a transcript
          console.log(claudeMcpCommand(mcpUrl));
          return;
        }
        const claude = spawnSync("claude", claudeMcpArgs({ mcpUrl, token }), { stdio: "inherit" });
        if (claude.error)
          throw new Error(`Could not start claude: ${claude.error.message}`, {
            cause: claude.error,
          });
        process.exit(claude.status ?? 1);
      }),
  },
  menubar: os
    .input(z.object({ project: z.string().optional().describe("Project id or slug") }))
    .meta({ description: "Launch the macOS menu bar for sign-in and computer sharing" })
    .handler(async ({ input }) => {
      const resolved = resolveConfig(process.cwd(), { throw: true });
      const project = input.project || resolved.config.defaultProject;
      if (!project) throw new Error("menubar needs --project or a configured defaultProject.");
      await launchMenubarApp({ configName: resolved.name, project, log: console.error });
    }),
  useMyComputer: os
    .input(
      z.object({
        project: z.string().optional().describe("Project id or slug"),
        json: z.boolean().optional().describe("Emit menu-bar events as NDJSON; stop on stdin EOF"),
        name: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
          .optional()
          .describe("Computer capability name, e.g. jonasComputer"),
      }),
    )
    .meta({ description: "Share this Mac with a project until Ctrl-C" })
    .handler(async ({ input }) => {
      if (process.platform !== "darwin")
        throw new Error("use-my-computer requires macOS (AppleScript and Swift).");
      const { resolved, connection } = await connectConfigured();
      using owned = connection;
      const project = await selectProject(owned, input.project || resolved.config.defaultProject);
      await shareMyComputer({ connection: owned, project, name: input.name, json: input.json });
    }),
  tunnel: os
    .input(
      z.object({
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .meta({ positional: true })
          .describe("The local port to serve, e.g. Vite's 5173"),
        name: z
          .string()
          .optional()
          .describe("Routing slug: the tunnel is <name>--<project> (default: a random one)"),
        public: z
          .boolean()
          .optional()
          .describe("Anyone may use it (default: signed-in project members only)"),
        project: z.string().optional().describe("Project id or slug"),
      }),
    )
    .meta({
      description: "Serve a local port on a project host until Ctrl-C, WebSockets included",
    })
    .handler(async ({ input }) => {
      const { resolved, connection } = await connectConfigured();
      using owned = connection;
      const project = await selectProject(owned, input.project || resolved.config.defaultProject);
      await runTunnel({
        connection: owned,
        project,
        port: input.port,
        routingSlug: input.name,
        public: input.public,
      });
    }),
  config: {
    get: os
      .input(z.object({}))
      .meta({ default: true, description: "Show config, resolved target, and session status" })
      .handler(async () => {
        const configFile = readConfigFile();
        const resolved = resolveConfig(process.cwd());

        const configs = configFile.configs || {};
        const sessions = Object.fromEntries(
          Object.entries(configs).map(([name, cfg]) => {
            if (!cfg.session) return [name, null];
            return [
              name,
              {
                hasToken: Boolean(cfg.session?.token),
                expiresAt: cfg.session?.expiresAt,
                expired: cfg.session?.expiresAt
                  ? new Date(cfg.session.expiresAt) < new Date()
                  : false,
              },
            ];
          }),
        );

        if (resolved instanceof Error) {
          return { configPath: CONFIG_PATH, error: resolved.message };
        }

        return {
          configPath: CONFIG_PATH,
          config: resolved.name,
          ...resolved.config,
          session: sessions[resolved.name],
        };
      }),
    list: os
      .input(z.object({}))
      .meta({ description: "List all named configs" })
      .handler(async () => {
        const configFile = readConfigFile();
        const currentName = resolveConfigName(process.cwd());
        const configs = { [DEFAULT_CONFIG_NAME]: {}, ...(configFile.configs || {}) };
        return {
          configs: Object.fromEntries(
            Object.entries(configs).map(([name, cfg]) => [
              name,
              {
                osBaseUrl: Config.parse(cfg).osBaseUrl,
                active: name === currentName ? true : undefined,
              },
            ]),
          ),
          default: configFile.default,
        };
      }),

    set: os
      .input(
        z.object({
          name: z.string().describe("Config name (e.g. dev, prd, preview)"),
          osBaseUrl: z
            .string()
            .optional()
            .describe("Base URL for OS API (e.g. https://os.iterate.com)"),
          defaultProject: z.string().optional().describe("Default project id or slug"),
          setDefault: z.boolean().optional().describe("Set as the default config"),
          setWorkspace: z.boolean().optional().describe("Map current directory to this config"),
        }),
      )
      .meta({ description: "Create or update a named config" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        configFile.configs ||= {};

        configFile.configs[input.name] ||= Config.parse({});
        if (input.osBaseUrl && input.osBaseUrl !== configFile.configs[input.name].osBaseUrl) {
          configFile.configs[input.name].osBaseUrl = input.osBaseUrl;
          delete configFile.configs[input.name].session;
        }
        if (input.defaultProject)
          configFile.configs[input.name].defaultProject = input.defaultProject;

        if (input.setDefault) {
          configFile.default = input.name;
        }
        if (input.setWorkspace) {
          configFile.workspaces ||= {};
          configFile.workspaces[process.cwd()] = input.name;
        }

        writeConfigFile(configFile);
        return {
          configPath: CONFIG_PATH,
          config: { ...configFile.configs[input.name], session: undefined },
        };
      }),

    use: os
      .input(
        z.object({
          name: z.string().meta({ positional: true }).describe("Config name to set as default"),
        }),
      )
      .meta({ description: "Set the default config" })
      .handler(async ({ input }) => {
        const configFile = readConfigFile();
        if (input.name !== DEFAULT_CONFIG_NAME && !configFile.configs?.[input.name]) {
          throw new Error(
            `Config "${input.name}" not found. Available: ${Object.keys(configFile.configs || {}).join(", ") || "(none)"}`,
          );
        }
        configFile.default = input.name;
        writeConfigFile(configFile);
        return { default: input.name };
      }),

    current: os
      .input(z.object({}))
      .meta({ description: "Show which config is active and why" })
      .handler(async () => {
        const resolved = resolveConfig(process.cwd(), { throw: true });
        return {
          name: resolved.name,
          config: {
            ...resolved.config,
            session: resolved.config.session ? { loggedIn: true } : undefined,
          },
          resolvedVia: configFlagOverride ? "--config flag" : "workspace mapping or default",
        };
      }),
  },
};
const getCli = async () => {
  configFlagOverride = consumeCliStringFlag("--config");
  if (process.argv.length === 2) process.argv.push("--help");
  const cli = createCli({
    router: launcherProcedures,
    name: "iterate",
    description: "Iterate CLI. Run itx scripts, authenticate, and share your computer.",
  });
  return {
    cli,
    prompts: isAgent || !process.stdin.isTTY || !process.stdout.isTTY ? undefined : prompts,
  };
};
export const runCli = async () => {
  const { cli, prompts: cliPrompts } = await getCli();
  await cli.run({ prompts: cliPrompts, logger: yamlTableConsoleLogger });
};

/**
 * The deployment's MCP endpoint, proven to accept `token` by a `tools/list`, which the platform's
 * stateless handler (apps/os/src/mcp.ts) answers without an `initialize` first.
 *
 * Starts at `<osBaseUrl>/mcp`. A deployment with its own MCP origin answers there with a 308 to it
 * (apps/os/src/worker.ts: os.iterate.com/mcp → https://mcp.iterate.com/). The redirect is followed
 * here, bearer kept, because fetch drops `Authorization` on a cross-origin redirect
 * (https://fetch.spec.whatwg.org/#http-redirect-fetch), which would read as a rejected bearer; the
 * returned URL is the final one, so Claude Code never meets the redirect.
 */
export const preflightMcp = async (osBaseUrl: string, token: string) => {
  let mcpUrl = new URL("/mcp", osBaseUrl).href;
  let response = await postToolsList(mcpUrl, token);
  const location = response.headers.get("location");
  if ((response.status === 307 || response.status === 308) && location) {
    mcpUrl = new URL(location, mcpUrl).href;
    response = await postToolsList(mcpUrl, token);
  }
  if (response.status === 401)
    throw new Error(
      `${mcpUrl} rejected the bearer (401). ITERATE_BEARER_TOKEN must be a live personal access token of the deployment at ${osBaseUrl}.`,
    );
  if (!response.ok)
    throw new Error(
      `tools/list on ${mcpUrl} failed (${response.status}): ${await readErrorBody(response)}`,
    );
  // Streamable HTTP answers a request with JSON or with an SSE stream whose `data:` lines carry the
  // JSON-RPC response: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#sending-messages-to-the-server
  const body = await response.text();
  const json = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n")
    : body;
  const parsed = z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
    .safeParse(JSON.parse(json));
  if (!parsed.success)
    throw new Error(`tools/list on ${mcpUrl} answered no tool list: ${json.slice(0, 300)}`);
  return { mcpUrl, tools: parsed.data.result.tools.map((tool) => tool.name) };
};

const postToolsList = (mcpUrl: string, token: string) =>
  fetch(mcpUrl, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

/**
 * Claude Code's arguments for one HTTP MCP server named `iterate` and no other: `--mcp-config`
 * takes the JSON inline, `--strict-mcp-config` ignores the user's own MCP servers
 * (https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/mcp).
 */
export const claudeMcpArgs = (input: { mcpUrl: string; token: string }) => [
  "--mcp-config",
  JSON.stringify({
    mcpServers: {
      iterate: {
        type: "http",
        url: input.mcpUrl,
        headers: { Authorization: `Bearer ${input.token}` },
      },
    },
  }),
  "--strict-mcp-config",
];

/** `claude` with `claudeMcpArgs` as a shell command that reads the key from `$ITERATE_BEARER_TOKEN`
 *  when it runs: printed, it carries no key. */
export const claudeMcpCommand = (mcpUrl: string) => {
  const placeholder = "ITERATE_BEARER_TOKEN_PLACEHOLDER";
  // the argument holding it is single-quoted JSON; the variable is spliced in double quotes
  return shellCommand(["claude", ...claudeMcpArgs({ mcpUrl, token: placeholder })]).replace(
    placeholder,
    `'"$ITERATE_BEARER_TOKEN"'`,
  );
};

/** POSIX-shell-quoted: plain words bare, anything else single-quoted with `'` spelled `'\''`. */
export const shellCommand = (argv: string[]) =>
  argv
    .map((arg) => (/^[\w./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ");
