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

// Caddy's catch-all blocks already rewrite Host from X-Forwarded-Host
// (via iterate_rewrite_xfh_to_host), so fragments only need host matchers.
function renderReverseProxyBlock(params: {
  route: ManagedRoute;
  matcherIdBase: string;
  hostToMatch: string;
}): string[] {
  const lines: string[] = [];
  const matcherId = `${params.matcherIdBase}_host`;

  lines.push(`@${matcherId} host ${params.hostToMatch}`);
  lines.push(`handle @${matcherId} {`);

  if (params.route.cors) {
    lines.push("    import iterate_cors_openapi");
  }

  if (params.route.streamCloseDelay) {
    lines.push(`    reverse_proxy ${params.route.target} {`);
    lines.push(`        stream_close_delay ${params.route.streamCloseDelay}`);
    lines.push(`        header_up Host ${params.route.host}`);
    lines.push("    }");
  } else {
    lines.push(`    reverse_proxy ${params.route.target} {`);
    lines.push(`        header_up Host ${params.route.host}`);
    lines.push("    }");
  }

  lines.push("}");
  return lines;
}

function renderRouteFragment(params: {
  route: ManagedRoute;
  iteratePublicBaseUrl?: string;
  iteratePublicBaseUrlType?: string;
}): string {
  const matcherBase = toMatcherId(`route_${params.route.slug}`);
  const lines: string[] = [];

  lines.push(`# managed by registry-service (dynamic routes only)`);
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

function normalizeImportGlobPath(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/\/+$/g, "");
}

function rewriteRootCaddyImportForStage(params: {
  rootCaddyfileContent: string;
  caddyConfigDir: string;
  stageDir: string;
}): string {
  const primaryImport = `${normalizeImportGlobPath(params.caddyConfigDir)}/*.caddy`;
  const defaultImport = "/home/iterate/.iterate/caddy/*.caddy";
  const stagedImport = `${normalizeImportGlobPath(params.stageDir)}/*.caddy`;
  return params.rootCaddyfileContent
    .replaceAll(primaryImport, stagedImport)
    .replaceAll(defaultImport, stagedImport);
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
  const desiredByName = new Map<string, string>();

  for (const route of managedRoutes) {
    const fileName = `${route.slug}.caddy`;
    const filePath = join(input.caddyConfigDir, fileName);
    const content = renderRouteFragment({
      route,
      iteratePublicBaseUrl: input.iteratePublicBaseUrl,
      iteratePublicBaseUrlType: input.iteratePublicBaseUrlType,
    });
    desiredFiles.set(filePath, content);
    desiredByName.set(fileName, content);
  }

  const existingFiles = (await readdir(input.caddyConfigDir))
    .filter((entry) => entry.endsWith(".caddy"))
    .map((entry) => join(input.caddyConfigDir, entry));

  const changedFiles: string[] = [];
  const previousContents = new Map<string, string | undefined>();
  for (const [filePath, content] of desiredFiles.entries()) {
    let current = "";
    try {
      current = await readFile(filePath, "utf8");
    } catch {
      current = "";
    }

    if (current === content) continue;
    previousContents.set(filePath, current.length > 0 ? current : undefined);
    changedFiles.push(filePath);
  }

  const removedFiles: string[] = [];
  for (const filePath of existingFiles) {
    if (desiredFiles.has(filePath)) continue;
    const previous = await readFile(filePath, "utf8").catch(() => "");
    previousContents.set(filePath, previous.length > 0 ? previous : undefined);
    removedFiles.push(filePath);
  }

  const shouldReload =
    input.forceReload === true || changedFiles.length > 0 || removedFiles.length > 0;
  if (!shouldReload) {
    return {
      reloaded: false,
      changedFiles,
      removedFiles,
      renderedFiles: [...desiredFiles.keys()],
    };
  }

  const stageDir = join(
    input.caddyConfigDir,
    `.registry-stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    await mkdir(stageDir, { recursive: true });
    for (const [fileName, content] of desiredByName.entries()) {
      await writeFile(join(stageDir, fileName), content, "utf8");
    }

    const rootContent = await readFile(input.rootCaddyfilePath, "utf8");
    const stagedRootPath = join(stageDir, "Caddyfile.staged");
    const stagedRootContent = rewriteRootCaddyImportForStage({
      rootCaddyfileContent: rootContent,
      caddyConfigDir: input.caddyConfigDir,
      stageDir,
    });
    await writeFile(stagedRootPath, stagedRootContent, "utf8");

    await execFile(input.caddyBinPath, [
      "validate",
      "--config",
      stagedRootPath,
      "--adapter",
      "caddyfile",
    ]);

    for (const [filePath, content] of desiredFiles.entries()) {
      if (!changedFiles.includes(filePath)) continue;
      const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, filePath);
    }

    for (const filePath of removedFiles) {
      await rm(filePath, { force: true });
    }

    await runCaddyValidateAndReload({
      caddyBinPath: input.caddyBinPath,
      rootCaddyfilePath: input.rootCaddyfilePath,
    });
  } catch (error) {
    // Best-effort rollback of touched files if validate/reload fails post-promotion.
    for (const [filePath, previous] of previousContents.entries()) {
      if (previous === undefined) {
        await rm(filePath, { force: true }).catch(() => {});
        continue;
      }
      await writeFile(filePath, previous, "utf8").catch(() => {});
    }
    throw error;
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    reloaded: true,
    changedFiles,
    removedFiles,
    renderedFiles: [...desiredFiles.keys()],
  };
}
