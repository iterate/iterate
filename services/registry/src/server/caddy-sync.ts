import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

interface RouteRecord {
  host: string;
  target: string;
  metadata?: Record<string, string>;
  tags?: string[];
  caddyDirectives?: string[];
}

interface RouteSpec {
  serviceSlug: string;
  internalHosts: string[];
  upstream: string;
  tags: string[];
  metadata: Record<string, string>;
  extraCaddyDirectives: string[];
}
type CompiledRouteSpec = RouteSpec;

export interface ReconcileCaddyConfigInput {
  routes: RouteRecord[];
  caddyConfigDir: string;
  rootCaddyfilePath: string;
  caddyBinPath: string;
  iterateIngressHost?: string;
  iterateIngressRoutingType?: string;
  iterateIngressDefaultService?: string;
  forceReload?: boolean;
}

export interface ReconcileCaddyConfigResult {
  reloaded: boolean;
  changedFiles: string[];
  removedFiles: string[];
  renderedFiles: string[];
}

const ROUTES_FRAGMENT_FILE_NAME = "registry-service-routes.caddy";

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

function toCaddyDirectives(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizePublicBaseHostForRouting(rawHost?: string): string | undefined {
  const trimmed = rawHost?.trim();
  if (!trimmed) return undefined;
  try {
    const asUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return asUrl.hostname;
  } catch {
    return undefined;
  }
}

function routeHostsForMatcher(params: {
  internalHosts: string[];
  publicBaseHostForRouting?: string;
  defaultIngressServiceSlug?: string;
}): string[] {
  const primaryInternalHost = params.internalHosts[0] ?? "";
  const service = firstHostToken(primaryInternalHost);
  const hosts = [...params.internalHosts];
  if (params.publicBaseHostForRouting && service.length > 0) {
    // We intentionally accept both forms even when URL generation selects one mode.
    hosts.push(`${service}.${params.publicBaseHostForRouting}`);
    hosts.push(`${service}__${params.publicBaseHostForRouting}`);
    if (params.defaultIngressServiceSlug?.trim().toLowerCase() === service) {
      hosts.push(params.publicBaseHostForRouting);
    }
  }
  return [...new Set(hosts)];
}

function renderRouteHandleBlock(params: {
  route: CompiledRouteSpec;
  publicBaseHostForRouting?: string;
  defaultIngressServiceSlug?: string;
}): string[] {
  const matcherId = `${toMatcherId(`route_${params.route.serviceSlug}`)}_hosts`;
  const matchHosts = routeHostsForMatcher({
    internalHosts: params.route.internalHosts,
    publicBaseHostForRouting: params.publicBaseHostForRouting,
    defaultIngressServiceSlug: params.defaultIngressServiceSlug,
  });
  const lines: string[] = [];

  lines.push(`# serviceSlug: ${params.route.serviceSlug}`);
  lines.push(`# upstream: ${params.route.upstream}`);
  if (params.route.tags.length > 0) {
    lines.push(`# tags: ${params.route.tags.join(", ")}`);
  }
  lines.push(`# internalHosts: ${params.route.internalHosts.join(", ")}`);
  if (Object.keys(params.route.metadata).length > 0) {
    lines.push(`# metadata: ${JSON.stringify(params.route.metadata)}`);
  }
  if (params.route.extraCaddyDirectives.length > 0) {
    lines.push(`# extraCaddyDirectives: ${JSON.stringify(params.route.extraCaddyDirectives)}`);
  }
  lines.push(`@${matcherId} host ${matchHosts.join(" ")}`);
  lines.push(`handle @${matcherId} {`);
  lines.push(`    vars {`);
  lines.push(`        iterate_service_slug ${params.route.serviceSlug}`);
  lines.push(`        iterate_upstream ${params.route.upstream}`);
  lines.push(`    }`);
  lines.push(`    import iterate_cors_openapi`);
  lines.push(`    reverse_proxy ${params.route.upstream} {`);
  lines.push(`        import iterate_ingress_upstream_headers`);
  for (const directive of params.route.extraCaddyDirectives) {
    lines.push(`        ${directive}`);
  }
  lines.push(`    }`);
  lines.push(`}`);
  return lines;
}

function renderCompiledRoutesFragment(params: {
  routes: CompiledRouteSpec[];
  iterateIngressHost?: string;
  iterateIngressDefaultService?: string;
}): string {
  const lines: string[] = [];
  const publicBaseHostForRouting = normalizePublicBaseHostForRouting(params.iterateIngressHost);
  const defaultIngressServiceSlug = params.iterateIngressDefaultService?.trim().toLowerCase();

  lines.push("# managed by registry-service (seeded + dynamic routes)");
  lines.push("# Each route renders its own ingress handle block.");
  lines.push("# The root Caddyfile only keeps the built-in bootstrap cache.");
  lines.push("# Keep both subdomain and dunder-prefix host forms routable even when URL");
  lines.push("# generation selects only one form.");

  for (const route of params.routes) {
    lines.push("");
    lines.push(
      ...renderRouteHandleBlock({
        route,
        publicBaseHostForRouting,
        defaultIngressServiceSlug,
      }),
    );
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

export function renderRegistryRoutesFragment(params: {
  routes: Array<{
    host: string;
    target: string;
    caddyDirectives?: string[];
    metadata?: Record<string, string>;
    tags?: string[];
  }>;
  iterateIngressHost?: string;
  iterateIngressDefaultService?: string;
}): string {
  const compiledRoutes = buildCompiledRouteSpecs(
    params.routes.map((route) => ({
      host: route.host,
      target: route.target,
      caddyDirectives: route.caddyDirectives,
      metadata: route.metadata ?? {},
      tags: route.tags ?? [],
    })),
  );
  return renderCompiledRoutesFragment({
    routes: compiledRoutes,
    iterateIngressHost: params.iterateIngressHost,
    iterateIngressDefaultService: params.iterateIngressDefaultService,
  });
}

export function renderRoutesFragmentForTest(params: {
  routes: Array<{
    host: string;
    target: string;
    caddyDirectives?: string[];
    metadata?: Record<string, string>;
    tags?: string[];
  }>;
  iterateIngressHost?: string;
  iterateIngressDefaultService?: string;
}): string {
  return renderRegistryRoutesFragment(params);
}

function buildCompiledRouteSpecs(routes: RouteRecord[]): CompiledRouteSpec[] {
  const bySlug = new Map<string, CompiledRouteSpec>();

  for (const route of routes) {
    const host = route.host.trim().toLowerCase();
    const token = firstHostToken(host);
    if (!host || !token) continue;
    const serviceSlug = toSlug(token);
    const extraCaddyDirectives = toCaddyDirectives(route.caddyDirectives);
    const existing = bySlug.get(serviceSlug);

    if (existing) {
      existing.internalHosts = [...new Set([...existing.internalHosts, host])];
      existing.upstream = route.target.trim();
      existing.tags = [...new Set([...(existing.tags ?? []), ...(route.tags ?? [])])];
      existing.metadata = { ...existing.metadata, ...(route.metadata ?? {}) };
      existing.extraCaddyDirectives = [
        ...new Set([...existing.extraCaddyDirectives, ...extraCaddyDirectives]),
      ];
      continue;
    }

    bySlug.set(serviceSlug, {
      serviceSlug,
      internalHosts: [host],
      upstream: route.target.trim(),
      tags: route.tags ?? [],
      metadata: route.metadata ?? {},
      extraCaddyDirectives,
    });
  }

  return [...bySlug.values()].sort((a, b) => a.serviceSlug.localeCompare(b.serviceSlug));
}

function normalizeImportGlobPath(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/\/+$/g, "");
}

function rewriteRootCaddyImportForStage(params: {
  rootCaddyfileContent: string;
  caddyConfigDir: string;
  stageDir: string;
}): string {
  const primaryImport = `${normalizeImportGlobPath(params.caddyConfigDir)}/${ROUTES_FRAGMENT_FILE_NAME}`;
  const defaultImport = `/home/iterate/.iterate/caddy/${ROUTES_FRAGMENT_FILE_NAME}`;
  const stagedImport = `${normalizeImportGlobPath(params.stageDir)}/${ROUTES_FRAGMENT_FILE_NAME}`;
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

  const compiledRoutes = buildCompiledRouteSpecs(input.routes);
  const routesFragmentPath = join(input.caddyConfigDir, ROUTES_FRAGMENT_FILE_NAME);
  const desiredContent = renderCompiledRoutesFragment({
    routes: compiledRoutes,
    iterateIngressHost: input.iterateIngressHost,
    iterateIngressDefaultService: input.iterateIngressDefaultService,
  });

  const existingFiles = (await readdir(input.caddyConfigDir))
    .filter((entry) => entry.endsWith(".caddy"))
    .map((entry) => join(input.caddyConfigDir, entry));

  const changedFiles: string[] = [];
  const previousContents = new Map<string, string | undefined>();
  let current = "";
  try {
    current = await readFile(routesFragmentPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== desiredContent) {
    previousContents.set(routesFragmentPath, current.length > 0 ? current : undefined);
    changedFiles.push(routesFragmentPath);
  }

  const removedFiles: string[] = [];
  for (const filePath of existingFiles) {
    if (filePath === routesFragmentPath) continue;
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
      renderedFiles: [routesFragmentPath],
    };
  }

  const stageDir = join(
    input.caddyConfigDir,
    `.registry-stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, ROUTES_FRAGMENT_FILE_NAME), desiredContent, "utf8");

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

    if (changedFiles.includes(routesFragmentPath)) {
      const tempPath = `${routesFragmentPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await writeFile(tempPath, desiredContent, "utf8");
      await rename(tempPath, routesFragmentPath);
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
    renderedFiles: [routesFragmentPath],
  };
}
