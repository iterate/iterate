// durable-object-names.ts — the ONE place a Durable Object name is formatted and
// parsed. Every domain Durable Object name is `{projectId}.iterate{path}` with
// optional query props, parsed as a URL:
//
//   prj_123.iterate/repos/repo_123
//   prj_123.iterate/repos/repo_123?branch=main
//   global.iterate/repos/iterate-config-base
//
// Because the projectId is always the hostname prefix, a name alone tells you
// which project the object belongs to — that is the whole basis of the access
// model.
//
// By default, parsed and stringified names must be project-scoped. Pass
// `allowNullProjectId: true` only for deployment-wide/shared resources. In that
// mode, `projectId: null` encodes as the reserved `global.iterate` host and
// parses back to null. This is used most importantly for streams that are shared
// across projects.

const MAX_DURABLE_OBJECT_NAME_BYTES = 256;
const GLOBAL_DURABLE_OBJECT_HOST = "global";
const DURABLE_OBJECT_HOST_SUFFIX = ".iterate";

export type ProjectDurableObjectNameParts = {
  projectId: string;
  path: string;
  props?: Record<string, string>;
};

export type DurableObjectNameParts = ProjectDurableObjectNameParts | SharedDurableObjectNameParts;

export type SharedDurableObjectNameParts = {
  projectId: string | null;
  path: string;
  props?: Record<string, string>;
};

export type ParsedDurableObjectName = {
  durableObjectName: string;
  projectId: string | null;
  path: string;
  props: Record<string, string>;
};

export type ProjectDurableObjectName = {
  durableObjectName: string;
  projectId: string;
  path: string;
  props: Record<string, string>;
};

type AllowNullProjectIdOptions = {
  /**
   * Allows deployment-wide/shared Durable Object names.
   *
   * When stringifying, `projectId: null` becomes `global.iterate`. When parsing,
   * `global.iterate` becomes `projectId: null`. Use this only for resources that
   * intentionally span projects, especially shared streams.
   */
  allowNullProjectId: true;
};

type DurableObjectNameCodecType = {
  /** Formats the project-scoped Durable Object name `{projectId}.iterate{path}`. */
  stringify(input: ProjectDurableObjectNameParts): string;
  /** Formats a name that may be shared across projects via `global.iterate`. */
  stringify(input: DurableObjectNameParts, options: AllowNullProjectIdOptions): string;
  /** Parses a project-scoped Durable Object name. `global.iterate` is rejected by default. */
  parse(name: string): ProjectDurableObjectName;
  /** Parses a name that may be shared across projects via `global.iterate`. */
  parse(name: string, options: AllowNullProjectIdOptions): ParsedDurableObjectName;
};

/** Normalizes a path to a leading-slash form (`""` → `"/"`, `"x"` → `"/x"`). */
export function normalizePath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

function assertLegalDurableObjectName(name: string): void {
  if (name.length === 0) {
    throw new Error("Durable Object name must be non-empty.");
  }
  const byteLength = new TextEncoder().encode(name).byteLength;
  if (byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error(
      `Durable Object name must be at most ${MAX_DURABLE_OBJECT_NAME_BYTES} bytes, got ${byteLength}.`,
    );
  }
}

function assertProjectId(projectId: string): void {
  if (projectId === "") {
    throw new Error(`Durable Object projectId must be non-empty, got "${projectId}".`);
  }
  if (projectId === GLOBAL_DURABLE_OBJECT_HOST) {
    throw new Error(
      `"${GLOBAL_DURABLE_OBJECT_HOST}" is reserved for deployment-wide Durable Objects; use projectId null instead.`,
    );
  }
  if (/[/:?#]/.test(projectId) || projectId.includes(".")) {
    throw new Error(
      `Durable Object projectId must not contain URL delimiter characters, got "${projectId}".`,
    );
  }
}

function parseAsDurableObjectUrl(name: string): URL {
  try {
    return new URL(name.includes("://") ? name : `https://${name}`);
  } catch {
    throw new Error(`Durable Object name must be a valid URL-shaped name, got "${name}".`);
  }
}

function stringifyDurableObjectName(input: ProjectDurableObjectNameParts): string;
function stringifyDurableObjectName(
  input: DurableObjectNameParts,
  options: AllowNullProjectIdOptions,
): string;
function stringifyDurableObjectName(
  { projectId, path, props = {} }: DurableObjectNameParts,
  options?: Partial<AllowNullProjectIdOptions>,
) {
  if (projectId === null && !options?.allowNullProjectId) {
    throw new Error(
      "Durable Object name must have a projectId; pass allowNullProjectId for shared resources.",
    );
  }

  const hostPrefix = projectId ?? GLOBAL_DURABLE_OBJECT_HOST;
  if (projectId !== null) assertProjectId(projectId);

  const base = `${hostPrefix}${DURABLE_OBJECT_HOST_SUFFIX}${normalizePath(path)}`;
  const query = new URLSearchParams(props).toString();
  const name = query ? `${base}?${query}` : base;
  assertLegalDurableObjectName(name);
  return name;
}

function parseDurableObjectName(name: string): ProjectDurableObjectName;
function parseDurableObjectName(
  name: string,
  options: AllowNullProjectIdOptions,
): ParsedDurableObjectName;
function parseDurableObjectName(
  name: string,
  options?: Partial<AllowNullProjectIdOptions>,
): ParsedDurableObjectName {
  assertLegalDurableObjectName(name);

  const url = parseAsDurableObjectUrl(name);
  const host = url.hostname;
  if (!host.endsWith(DURABLE_OBJECT_HOST_SUFFIX) || host === DURABLE_OBJECT_HOST_SUFFIX.slice(1)) {
    throw new Error(
      `Durable Object name host must be "{projectId}${DURABLE_OBJECT_HOST_SUFFIX}", got "${host}".`,
    );
  }

  const hostPrefix = host.slice(0, -DURABLE_OBJECT_HOST_SUFFIX.length);
  const projectId = hostPrefix === GLOBAL_DURABLE_OBJECT_HOST ? null : hostPrefix;
  if (projectId !== null) assertProjectId(projectId);
  if (projectId === null && !options?.allowNullProjectId) {
    throw new Error(
      `Durable Object name must have a projectId; pass allowNullProjectId for shared resources. Got global name "${name}".`,
    );
  }

  const props: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    props[key] = value;
  });

  return {
    durableObjectName: name,
    projectId,
    path: normalizePath(url.pathname),
    props,
  };
}

export const DurableObjectNameCodec: DurableObjectNameCodecType = {
  stringify: stringifyDurableObjectName,
  parse: parseDurableObjectName,
};
