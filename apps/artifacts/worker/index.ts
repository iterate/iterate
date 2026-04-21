import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs.ts";

interface Env {
  ARTIFACTS: {
    create(
      name: string,
      opts?: { description?: string },
    ): Promise<{ name: string; remote: string; token: string }>;
    get(
      name: string,
    ): Promise<{
      createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string }>;
    }>;
    list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: { name: string }[] }>;
    delete(name: string): Promise<boolean>;
  };
  ASSETS: { fetch(req: Request): Promise<Response> };
  CF_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
}

type RepoCtx = { fs: MemoryFS; dir: string; remote: string; token: string };

// Deduplicated clone cache — prevents race when parallel requests hit the same repo
const repoCache = new Map<string, RepoCtx>();
const cloneInFlight = new Map<string, Promise<RepoCtx>>();
const deepened = new Set<string>();

async function ensureCloned(env: Env, name: string): Promise<RepoCtx> {
  if (repoCache.has(name)) return repoCache.get(name)!;
  if (cloneInFlight.has(name)) return cloneInFlight.get(name)!;
  const promise = (async () => {
    const repo = await env.ARTIFACTS.get(name);
    const remote = `https://${env.CF_ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${name}.git`;
    const { plaintext: token } = await repo.createToken("write", 3600);
    const tokenSecret = token.split("?")[0];
    const fs = new MemoryFS();
    const dir = `/${name}`;
    await git.clone({
      fs: fs.promises,
      http,
      dir,
      url: remote,
      onAuth: () => ({ username: "x", password: tokenSecret }),
      singleBranch: true,
      depth: 1,
    });
    const ctx: RepoCtx = { fs, dir, remote, token: tokenSecret };
    repoCache.set(name, ctx);
    cloneInFlight.delete(name);
    return ctx;
  })();
  cloneInFlight.set(name, promise);
  return promise;
}

/** Deepen shallow clone once per isolate to get history. */
async function ensureDeepened(env: Env, name: string) {
  const ctx = await ensureCloned(env, name);
  if (!deepened.has(name)) {
    await git.fetch({
      fs: ctx.fs.promises,
      http,
      dir: ctx.dir,
      depth: 50,
      relative: true,
      onAuth: () => ({ username: "x", password: ctx.token }),
    });
    deepened.add(name);
  }
  return ctx;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const q = (k: string) => url.searchParams.get(k);

    try {
      // --- Repos CRUD ---
      if (p === "/api/repos" && req.method === "GET") {
        return json(await env.ARTIFACTS.list());
      }
      if (p === "/api/repos" && req.method === "POST") {
        const { name } = (await req.json()) as { name: string };
        const result = await env.ARTIFACTS.create(name);
        return json({ name: result.name, remote: result.remote });
      }
      if (p === "/api/repos" && req.method === "DELETE") {
        const { name } = (await req.json()) as { name: string };
        await env.ARTIFACTS.delete(name);
        repoCache.delete(name);
        return json({ ok: true });
      }

      // --- Tree at HEAD or specific commit ---
      if (p === "/api/tree") {
        const name = q("repo"),
          oid = q("oid") || "HEAD";
        if (!name) return json({ error: "repo param required" }, 400);
        // When requesting a specific commit, ensure we have history (not just depth=1)
        const { fs, dir } =
          oid !== "HEAD" ? await ensureDeepened(env, name) : await ensureCloned(env, name);
        const paths: string[] = [];
        await git.walk({
          fs: fs.promises,
          dir,
          trees: [git.TREE({ ref: oid })],
          map: async (filepath, [entry]) => {
            if (filepath !== "." && entry) paths.push(filepath);
            return filepath;
          },
        });
        return json({ paths: paths.sort() });
      }

      // --- Read file at HEAD (from working tree) ---
      if (p === "/api/file" && req.method === "GET") {
        const name = q("repo"),
          filepath = q("path");
        if (!name || !filepath) return json({ error: "repo and path params required" }, 400);
        const { fs, dir } = await ensureCloned(env, name);
        return json({
          content: await fs.promises.readFile(`${dir}/${filepath}`, { encoding: "utf8" }),
        });
      }

      // --- Read file at a specific commit ---
      if (p === "/api/blob") {
        const name = q("repo"),
          filepath = q("path"),
          oid = q("oid");
        if (!name || !filepath || !oid)
          return json({ error: "repo, path, and oid params required" }, 400);
        const { fs, dir } = await ensureCloned(env, name);
        const { blob } = await git.readBlob({ fs: fs.promises, dir, oid, filepath });
        return json({ content: new TextDecoder().decode(blob) });
      }

      // --- Git log (deepens clone lazily) ---
      if (p === "/api/log") {
        const name = q("repo");
        if (!name) return json({ error: "repo param required" }, 400);
        const { fs, dir } = await ensureDeepened(env, name);
        const commits = await git.log({ fs: fs.promises, dir, depth: 50 });
        return json(
          commits.map((c) => ({
            oid: c.oid,
            message: c.commit.message,
            author: c.commit.author.name,
            timestamp: c.commit.author.timestamp,
          })),
        );
      }

      // --- Commit and push local changes ---
      if (p === "/api/commit" && req.method === "POST") {
        const {
          repo: name,
          message,
          files,
        } = (await req.json()) as {
          repo: string;
          message: string;
          files: { path: string; content: string }[];
        };
        const { fs, dir, token } = await ensureCloned(env, name);
        for (const f of files) {
          await fs.promises.writeFile(`${dir}/${f.path}`, f.content);
          await git.add({ fs: fs.promises, dir, filepath: f.path });
        }
        await git.commit({
          fs: fs.promises,
          dir,
          message,
          author: { name: "Artifacts", email: "artifacts@iterate.com" },
        });
        await git.push({
          fs: fs.promises,
          http,
          dir,
          remote: "origin",
          onAuth: () => ({ username: "x", password: token }),
        });
        return json({ ok: true });
      }

      // --- Restore: create a new commit reusing the target commit's tree object (O(1)) ---
      // https://isomorphic-git.org/docs/en/commit — `tree` param reuses an existing tree OID
      if (p === "/api/restore" && req.method === "POST") {
        const { repo: name, oid } = (await req.json()) as { repo: string; oid: string };
        const { fs, dir, token } = await ensureDeepened(env, name);
        const { commit: target } = await git.readCommit({ fs: fs.promises, dir, oid });
        const headOid = await git.resolveRef({ fs: fs.promises, dir, ref: "HEAD" });
        await git.commit({
          fs: fs.promises,
          dir,
          message: `Restore to ${oid.slice(0, 7)}`,
          author: { name: "Artifacts", email: "artifacts@iterate.com" },
          tree: target.tree,
          parent: [headOid],
        });
        await git.push({
          fs: fs.promises,
          http,
          dir,
          remote: "origin",
          onAuth: () => ({ username: "x", password: token }),
        });
        // Sync working tree with the new HEAD
        await git.checkout({ fs: fs.promises, dir, ref: "HEAD", force: true });
        return json({ ok: true });
      }
    } catch (e: unknown) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
