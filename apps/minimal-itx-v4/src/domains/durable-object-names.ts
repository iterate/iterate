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
// `projectId: null` is deployment-wide scope (integration webhooks, the project
// catalog, …). It encodes as the reserved `global.iterate` host. It is NOT a
// connectable context. The only door to global objects is an authenticated ITX
// with project-creation/admin authority.

const MAX_DURABLE_OBJECT_NAME_BYTES = 256;

type DurableObjectNameParts = {
  projectId: string | null;
  path: string;
  props?: Record<string, string>;
};

type ParsedDurableObjectName = {
  projectId: string | null;
  path: string;
  props: Record<string, string>;
};

function normalizePath(path: string): string {
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

function assertNonNullProjectId(projectId: string, globalHost: string): void {
  if (projectId === "") {
    throw new Error(`Durable Object projectId must be non-empty, got "${projectId}".`);
  }
  if (projectId === globalHost) {
    throw new Error(
      `"${globalHost}" is reserved for deployment-wide Durable Objects; use projectId null instead.`,
    );
  }
  if (/[/:?#]/.test(projectId) || projectId.includes(".")) {
    throw new Error(
      `Durable Object projectId must not contain URL delimiter characters, got "${projectId}".`,
    );
  }
}

function encodeProjectHost(projectId: string | null, globalHost: string): string {
  if (projectId === null) return globalHost;
  assertNonNullProjectId(projectId, globalHost);
  return projectId;
}

function decodeProjectHost(hostPrefix: string, globalHost: string): string | null {
  if (hostPrefix === globalHost) return null;
  assertNonNullProjectId(hostPrefix, globalHost);
  return hostPrefix;
}

function parseAsDurableObjectUrl(name: string): URL {
  try {
    return new URL(name.includes("://") ? name : `https://${name}`);
  } catch {
    throw new Error(`Durable Object name must be a valid URL-shaped name, got "${name}".`);
  }
}

export const DurableObjectNameCodec = {
  hostSuffix: ".iterate",
  globalHost: "global",

  stringify({ projectId, path, props = {} }: DurableObjectNameParts): string {
    const normalizedPath = normalizePath(path);
    const base = `${encodeProjectHost(projectId, this.globalHost)}${this.hostSuffix}${normalizedPath}`;
    const query = new URLSearchParams(props).toString();
    const name = query ? `${base}?${query}` : base;
    assertLegalDurableObjectName(name);
    return name;
  },

  parse(name: string): ParsedDurableObjectName {
    assertLegalDurableObjectName(name);

    const url = parseAsDurableObjectUrl(name);
    const host = url.hostname;
    const hostSuffixIndex = host.lastIndexOf(this.hostSuffix);
    if (hostSuffixIndex <= 0) {
      throw new Error(
        `Durable Object name host must be "{projectId}${this.hostSuffix}", got "${host}".`,
      );
    }

    const projectId = decodeProjectHost(host.slice(0, hostSuffixIndex), this.globalHost);

    const path = normalizePath(url.pathname);
    if (!path.startsWith("/")) {
      throw new Error(`Durable Object path must start with "/", got "${path}".`);
    }

    const props: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      props[key] = value;
    });

    return { projectId, path, props };
  },

  parseProjectScoped(name: string): ParsedDurableObjectName & { projectId: string } {
    const parsed = this.parse(name);
    if (parsed.projectId === null) {
      throw new Error(`Durable Object name must be project-scoped, got global name "${name}".`);
    }
    return { ...parsed, projectId: parsed.projectId };
  },
} as const;
