import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  normalizePublicIngressUrlType,
  resolvePublicIngressUrl,
  type PublicIngressUrlTypeInput,
} from "@iterate-com/shared/jonasland/ingress-url";

const execFile = promisify(execFileCallback);

interface RouteRecord {
  host: string;
  target: string;
  metadata?: Record<string, string>;
  tags?: string[];
}

interface ManagedRoute {
  slug: string;
  host: string;
  target: string;
  cors: boolean;
  streamCloseDelay?: string;
}

export interface ReconcileCaddyConfigInput {
  routes: RouteRecord[];
  caddyConfigDir: string;
  rootCaddyfilePath: string;
  caddyBinPath: string;
  iteratePublicBaseUrl?: string;
  iteratePublicBaseUrlType?: string;
  forceReload?: boolean;
}

export interface ReconcileCaddyConfigResult {
  reloaded: boolean;
  changedFiles: string[];
  removedFiles: string[];
  renderedFiles: string[];
}

const BUILTIN_ROUTES: ManagedRoute[] = [
  {
    slug: "pidnap",
    host: "pidnap.iterate.localhost",
    target: "127.0.0.1:9876",
    cors: false,
  },
  {
    slug: "registry",
    host: "registry.iterate.localhost",
    target: "127.0.0.1:8777",
    cors: true,
  },
  {
    slug: "events",
    host: "events.iterate.localhost",
    target: "127.0.0.1:19010",
    cors: true,
  },
  {
    slug: "frp",
    host: "frp.iterate.localhost",
    target: "127.0.0.1:27000",
    cors: false,
    streamCloseDelay: "5m",
  },
  {
    slug: "caddy-admin",
    host: "caddy-admin.iterate.localhost",
    target: "127.0.0.1:2019",
    cors: false,
  },
];

function firstHostToken(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.split(".").find((part) => part.length > 0) ?? "";
}

function toSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "route";
}

function toMatcherId(value: string): string {
  return value.replaceAll(/[^a-z0-9_]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePublicHost(params: {
  internalHost: string;
  iteratePublicBaseUrl?: string;
  iteratePublicBaseUrlType?: string;
}): string | undefined {
  const baseUrl = params.iteratePublicBaseUrl?.trim();
  if (!baseUrl) return undefined;

  const mode = normalizePublicIngressUrlType(
    params.iteratePublicBaseUrlType as PublicIngressUrlTypeInput,
  );
  const resolved = resolvePublicIngressUrl({
    publicBaseUrl: baseUrl,
    publicBaseUrlType: mode,
    internalUrl: `http://${params.internalHost}`,
  });

  return new URL(resolved).hostname;
}

function renderReverseProxyBlock(params: {
  route: ManagedRoute;
  matcherIdBase: string;
  hostToMatch: string;
}): string[] {
  const lines: string[] = [];
  const escapedHost = escapeForRegex(params.hostToMatch.toLowerCase());

  const renderHandle = (matcherId: string): string[] => {
    const block: string[] = [];
    block.push(`handle @${matcherId} {`);

    if (params.route.cors) {
      block.push("    import iterate_cors_openapi");
    }

    if (params.route.streamCloseDelay) {
      block.push(`    reverse_proxy ${params.route.target} {`);
      block.push(`        stream_close_delay ${params.route.streamCloseDelay}`);
      block.push("    }");
    } else {
      block.push(`    reverse_proxy ${params.route.target} {`);
      block.push(`        header_up Host ${params.route.host}`);
      block.push("    }");
    }

    block.push("}");
    return block;
  };

  lines.push(`@${params.matcherIdBase}_host host ${params.hostToMatch}`);
  lines.push(
    `@${params.matcherIdBase}_forwarded header_regexp ${params.matcherIdBase}_forwarded Forwarded (?i)(^|[,;])\\s*host="?${escapedHost}(?::[0-9]+)?"?(\\s*[,;]|$)`,
  );
  lines.push(...renderHandle(`${params.matcherIdBase}_host`));
  lines.push(...renderHandle(`${params.matcherIdBase}_forwarded`));
  return lines;
}

function renderRouteFragment(params: {
  route: ManagedRoute;
  iteratePublicBaseUrl?: string;
  iteratePublicBaseUrlType?: string;
}): string {
  const matcherBase = toMatcherId(`route_${params.route.slug}`);
  const lines: string[] = [];

  lines.push(`# managed by registry-service`);
  lines.push(`# slug: ${params.route.slug}`);
  lines.push(
    ...renderReverseProxyBlock({
      route: params.route,
      matcherIdBase: `${matcherBase}_internal`,
      hostToMatch: params.route.host,
    }),
  );

  const publicHost = resolvePublicHost({
    internalHost: params.route.host,
    iteratePublicBaseUrl: params.iteratePublicBaseUrl,
    iteratePublicBaseUrlType: params.iteratePublicBaseUrlType,
  });

  if (publicHost && publicHost !== params.route.host) {
    lines.push("");
    lines.push(
      ...renderReverseProxyBlock({
        route: params.route,
        matcherIdBase: `${matcherBase}_public`,
        hostToMatch: publicHost,
      }),
    );
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

function buildManagedRoutes(routes: RouteRecord[]): ManagedRoute[] {
  const bySlug = new Map<string, ManagedRoute>();

  for (const route of BUILTIN_ROUTES) {
    bySlug.set(route.slug, route);
  }

  for (const route of routes) {
    const host = route.host.trim().toLowerCase();
    const token = firstHostToken(host);
    if (!host || !token) continue;
    const slug = toSlug(token);

    bySlug.set(slug, {
      slug,
      host,
      target: route.target.trim(),
      cors: true,
    });
  }

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function runCaddyValidateAndReload(params: {
  caddyBinPath: string;
  rootCaddyfilePath: string;
}): Promise<void> {
  await execFile(params.caddyBinPath, [
    "validate",
    "--config",
    params.rootCaddyfilePath,
    "--adapter",
    "caddyfile",
  ]);

  await execFile(params.caddyBinPath, [
    "reload",
    "--config",
    params.rootCaddyfilePath,
    "--adapter",
    "caddyfile",
  ]);
}

export async function reconcileCaddyConfig(
  input: ReconcileCaddyConfigInput,
): Promise<ReconcileCaddyConfigResult> {
  await mkdir(input.caddyConfigDir, { recursive: true });

  const managedRoutes = buildManagedRoutes(input.routes);
  const desiredFiles = new Map<string, string>();

  for (const route of managedRoutes) {
    const fileName = `${route.slug}.caddy`;
    const filePath = join(input.caddyConfigDir, fileName);
    const content = renderRouteFragment({
      route,
      iteratePublicBaseUrl: input.iteratePublicBaseUrl,
      iteratePublicBaseUrlType: input.iteratePublicBaseUrlType,
    });
    desiredFiles.set(filePath, content);
  }

  const existingFiles = (await readdir(input.caddyConfigDir))
    .filter((entry) => entry.endsWith(".caddy"))
    .map((entry) => join(input.caddyConfigDir, entry));

  const changedFiles: string[] = [];
  for (const [filePath, content] of desiredFiles.entries()) {
    let current = "";
    try {
      current = await readFile(filePath, "utf8");
    } catch {
      current = "";
    }

    if (current === content) continue;

    const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
    changedFiles.push(filePath);
  }

  const removedFiles: string[] = [];
  for (const filePath of existingFiles) {
    if (desiredFiles.has(filePath)) continue;
    await rm(filePath, { force: true });
    removedFiles.push(filePath);
  }

  const shouldReload =
    input.forceReload === true || changedFiles.length > 0 || removedFiles.length > 0;
  if (shouldReload) {
    await runCaddyValidateAndReload({
      caddyBinPath: input.caddyBinPath,
      rootCaddyfilePath: input.rootCaddyfilePath,
    });
  }

  return {
    reloaded: shouldReload,
    changedFiles,
    removedFiles,
    renderedFiles: [...desiredFiles.keys()],
  };
}
