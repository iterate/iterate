import { RpcTarget } from "cloudflare:workers";

export type DocsAppOptions = {
  auth: { policy: "project-member" };
  proxy: {
    origin: string;
    originOverrideKvKey: string;
  };
};

/**
 * One link capability, three lenses — the input shape picks the view:
 * `path` mints the document view, `repo` (+ optional `task`) mints the
 * task-board view, `notes` (+ optional `note`) mints the notes view.
 * Exactly one of the three.
 */
export type DocsLinkInput =
  | {
      /**
       * Document to review: relative to the workspace, or a fully qualified
       * stream path. Must end in .md, .markdown, .html, or .htm.
       */
      path: string;
      /** Absolute /workspaces/** stream path of the reviewing workspace. */
      workspace: string;
    }
  | {
      /** Absolute /workspaces/** stream path of the workspace the board renders. */
      workspace: string;
      /** Absolute /repos/** path of the repo whose task files the board shows. */
      repo: string;
      /** Repo-relative task file to open (a .md file under a `tasks/` folder). */
      task?: string;
    }
  | {
      /**
       * Absolute /repos/** path of the repo whose `notes/` folder the view
       * shows. Notes are scoped to a repo alone — the app keeps its own
       * notes workspace per repo, so no `workspace` here.
       */
      notes: string;
      /** Repo-relative note to open (a .md file under the `notes/` folder). */
      note?: string;
    };

type DocsProject = {
  [Symbol.dispose](): void;
  appUrl(appSlug: string): Promise<string>;
  auth: {
    get(policy: { policy: "project-member" }): {
      fetch(request: Request): Promise<Response | null>;
    };
  };
  kv: {
    get(key: string): Promise<unknown>;
  };
};

type DocsEnv = { ITX: { get(): Promise<DocsProject> } };

/** Project-side capability exposed by config workers as `itx.worker.docs`. */
export class DocsAppRpcTarget extends RpcTarget {
  readonly #env: DocsEnv;

  constructor(env: DocsEnv) {
    super();
    this.#env = env;
  }

  /**
   * Build a URL into the app: the document view when the input carries
   * `path`, the task-board view when it carries `repo` (+ optional `task`),
   * the notes view when it carries `notes` (+ optional `note`). Validation
   * mirrors what each view applies on open, so a minted link can only
   * address something the UI will accept.
   */
  async link(input: DocsLinkInput): Promise<string> {
    // Discriminate by VALUE, not key presence: capnweb callers are loose
    // JSON, and a key that exists holding undefined must not pick a lens.
    const loose = input as {
      path?: string;
      repo?: string;
      task?: string;
      notes?: string;
      note?: string;
      workspace?: string;
    };
    const wantsDocument = typeof loose.path === "string";
    const wantsBoard = typeof loose.repo === "string";
    const wantsNotes = typeof loose.notes === "string";
    if ([wantsDocument, wantsBoard, wantsNotes].filter(Boolean).length !== 1) {
      throw new Error(
        "pass exactly one of path (document view), repo (board view), or notes (notes view)",
      );
    }
    // The document and board views render inside ONE workspace; the notes
    // view is scoped to a repo alone (the app keeps its own notes workspace
    // per repo), so it neither needs nor reads a workspace.
    if (!wantsNotes && typeof loose.workspace !== "string") {
      throw new Error("the document and board views need a workspace");
    }
    const workspace = wantsNotes ? undefined : requireWorkspacePath(loose.workspace!);
    const path = wantsDocument ? requireDocumentPath(loose.path!) : undefined;
    const repo = wantsBoard ? requireRepoPath(loose.repo!) : undefined;
    // task belongs to the board lens alone — a document link ignores it
    // rather than failing board-path checks for a view that never reads it.
    const task = wantsBoard && loose.task !== undefined ? requireTaskPath(loose.task) : undefined;
    // Same for note and the notes lens.
    const notes = wantsNotes ? requireRepoPath(loose.notes!) : undefined;
    const note = wantsNotes && loose.note !== undefined ? requireNotePath(loose.note) : undefined;
    const itx = await this.#env.ITX.get();
    try {
      const url = new URL(await itx.appUrl("docs"));
      if (notes !== undefined) {
        url.pathname = "/notes";
        url.searchParams.set("repo", notes);
        if (note !== undefined) url.searchParams.set("note", note);
        return url.href;
      }
      url.searchParams.set("workspace", workspace!);
      if (path !== undefined) {
        url.searchParams.set("path", path);
        return url.href;
      }
      url.pathname = "/w";
      url.searchParams.set("repo", repo!);
      if (task !== undefined) url.searchParams.set("task", task);
      return url.href;
    } finally {
      itx[Symbol.dispose]();
    }
  }
}

export const DocsApp = {
  create(env: DocsEnv, options: DocsAppOptions) {
    const configuredOrigin = parseHttpsOrigin(options.proxy.origin, "Docs app proxy origin");
    return {
      rpc: new DocsAppRpcTarget(env),
      async fetch(request: Request): Promise<Response> {
        const itx = await env.ITX.get();
        try {
          const authRequest =
            request.method === "POST" && new URL(request.url).pathname === "/_iterate/auth/callback"
              ? request
              : new Request(request.url, {
                  headers: request.headers,
                  method: request.method,
                });
          const denied = await itx.auth.get(options.auth).fetch(authRequest);
          if (denied !== null) return denied;
          const override = await itx.kv.get(options.proxy.originOverrideKvKey);
          const origin =
            override === null || override === undefined || override === ""
              ? configuredOrigin
              : parseOverride(override, options.proxy.originOverrideKvKey);
          const target = new URL(request.url);
          target.protocol = origin.protocol;
          // hostname + port, never `host`: the URL host setter keeps the
          // request's own port when the new value carries none, and local
          // project hosts always carry one (docs--slug.localhost:<port>) —
          // that port would ride along to the vessel and dead-end there.
          target.hostname = origin.hostname;
          target.port = origin.port;
          return fetch(new Request(new Request(target, request), { redirect: "manual" }));
        } finally {
          itx[Symbol.dispose]();
        }
      },
    };
  },
};

export function requireWorkspacePath(value: string): string {
  if (!value.startsWith("/workspaces/")) {
    throw new Error(`invalid workspace path: ${JSON.stringify(value)}`);
  }
  return requireCanonicalPath(value, "workspace path");
}

/**
 * A document path is either relative (resolved against a workspace when the
 * document opens) or a fully qualified stream path (e.g.
 * "/workspaces/agents/you/review.md", "/repos/config/docs/plan.md").
 */
export function requireDocumentPath(value: string): string {
  const path = requireCanonicalPath(value, "document path");
  if (!/\.(?:html?|markdown|md)$/i.test(path)) {
    throw new Error("document path must end in .md, .markdown, .html, or .htm");
  }
  // An ABSOLUTE document path must be a fully qualified stream path — the
  // only places a workspace can actually read or write. A bare "/review.md"
  // would validate here and then dead-end on the workspace's write guard.
  if (path.startsWith("/") && !path.startsWith("/workspaces/") && !path.startsWith("/repos/")) {
    throw new Error(
      'an absolute document path must be fully qualified (under "/workspaces/" or "/repos/"); use a relative path to target the workspace\'s own directory',
    );
  }
  return path;
}

/** A board's repo path is a fully qualified /repos/** mount path — the SAME
 * rule the board applies on open (normalizeRepoPath), so a minted link can
 * never carry a repo the route would reject. */
export function requireRepoPath(value: string): string {
  const path = requireCanonicalPath(value, "repo path");
  const segments = path.startsWith("/repos/") ? path.slice(1).split("/") : [];
  if (
    segments.length < 2 ||
    segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new Error(`repo path must name a repo under "/repos/": ${JSON.stringify(value)}`);
  }
  return path;
}

/** A task path is repo-relative: a Markdown file below a `tasks/` folder. */
export function requireTaskPath(value: string): string {
  const path = requireCanonicalPath(value, "task path");
  if (path.startsWith("/")) {
    throw new Error(`task path must be repo-relative: ${JSON.stringify(value)}`);
  }
  const segments = path.split("/");
  if (!/\.(?:md|markdown)$/i.test(segments.at(-1) ?? "") || !segments.includes("tasks")) {
    throw new Error(
      `task path must be a .md file below a "tasks" folder: ${JSON.stringify(value)}`,
    );
  }
  return path;
}

/** A note path is repo-relative: a Markdown file below the top-level
 * `notes/` folder — the SAME folder the notes view lists and writes. */
export function requireNotePath(value: string): string {
  const path = requireCanonicalPath(value, "note path");
  if (!path.startsWith("notes/") || !/\.(?:md|markdown)$/i.test(path)) {
    throw new Error(`note path must be a .md file under "notes/": ${JSON.stringify(value)}`);
  }
  return path;
}

function requireCanonicalPath(value: string, description: string): string {
  const segments = (value.startsWith("/") ? value.slice(1) : value).split("/");
  if (
    value.length > 2048 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.endsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid ${description}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseOverride(value: unknown, key: string): URL {
  const description = `Docs app proxy override from "${key}"`;
  if (typeof value !== "string") {
    throw new Error(`${description} must be one complete HTTPS origin: ${JSON.stringify(value)}`);
  }
  return parseHttpsOrigin(value, description);
}

function parseHttpsOrigin(value: string, description: string): URL {
  const invalidMessage = `${description} must be one complete HTTPS origin: ${value}`;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(invalidMessage);
  }
  if (origin.protocol !== "https:" || origin.origin !== value) throw new Error(invalidMessage);
  return origin;
}
