// ---------------------------------------------------------------------------
// SCRIPT EXECUTION + DYNAMIC CAPABILITIES — the two things Jonas said "we DO need to make".
//
//  • execScriptInProject — run an ARBITRARY code string against a project's ITX tree, CONFINED, via the
//    same Worker Loader that runs the config worker. This is the kernel's `exec_typescript` (apps/os): a
//    user/agent hands `itx => …` and it runs with only `env.ITX` + the egress door. Dynamic workers +
//    script execution fall straight out of the loader we already have.
//  • provide/invokeCapability — DYNAMIC CAPABILITIES: userspace registers a named script capability at
//    runtime (`provideCapability("greet", "async (itx,args)=>…")`) and later invokes it. Stored per
//    project. **Event-shadowing rule (ADR): a dynamic capability can NEVER shadow a builtin name** —
//    provide rejects any name in the builtin set. (Config-shadowing a builtin is a separate, trusted path.)
// ---------------------------------------------------------------------------

// Names the ITX tree already owns — a dynamic capability may not take one (builtins always win). These
// are the top-level members of the ONE capability tree (D-A): whoami + the egress door + the capability
// getters (streams/secrets/ai). A dynamic capability mounts a NEW name, never one of these.
export const BUILTIN_CAPABILITY_NAMES = new Set(["whoami", "fetch", "streams", "secrets", "ai"]);

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Wrap a user code string (an async `itx => …` / `(itx,args) => …` function expression) into a
// confined worker module that runs it with the project's ITX and returns JSON.
function wrap(code: string): string {
  return `export default { async fetch(request, env) {
    try {
      const itx = env.ITX;
      const args = request.headers.get("x-args") ? JSON.parse(request.headers.get("x-args")) : undefined;
      const fn = (${code});
      const out = typeof fn === "function" ? await fn(itx, args) : await fn;
      return Response.json({ ok: true, out: out ?? null });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message ? e.message : e) }, { status: 500 });
    }
  }};`;
}

export type LoaderLike = {
  get(key: string, factory: () => unknown): { getEntrypoint(): Fetcher };
};

// Run `code` against the project's ITX, confined (only env.ITX + the egress door, exactly like the
// config worker). `makeEntry` is `ctx.exports.ProjectEntrypoint` from the kernel fetch handler.
export async function execScriptInProject(opts: {
  code: string;
  projectId: string;
  args?: unknown;
  loader: LoaderLike;
  makeEntry: (o: { props: { projectId: string } }) => Fetcher;
}): Promise<unknown> {
  const entry = opts.makeEntry({ props: { projectId: opts.projectId } });
  // Cache key includes code LENGTH + djb2 (review R7 #5b: 32-bit djb2 alone risks collisions → a
  // different same-project script running from cache; length+hash makes a collision far less likely. A
  // real content digest is the proper fix — noted for follow-up).
  const worker = opts.loader.get(
    `exec:${opts.projectId}:${opts.code.length}:${hash(opts.code)}`,
    () => ({
      compatibilityDate: "2026-07-01",
      mainModule: "exec.js",
      modules: { "exec.js": wrap(opts.code) },
      env: { ITX: entry }, // ONLY the ITX capability — same confinement as the config worker
      globalOutbound: entry, // the egress door
    }),
  );
  const res = await worker.getEntrypoint().fetch(
    new Request("https://exec.local/", {
      headers: opts.args !== undefined ? { "x-args": JSON.stringify(opts.args) } : {},
    }),
  );
  return res.json();
}

// A dynamic-capability registry over a KV namespace (`capability:<projectId>:<name>` -> code string).
export type CapabilityKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
};
export function capabilityRegistry(kv: CapabilityKV | undefined, projectId: string) {
  const key = (name: string) => `capability:${projectId}:${name}`;
  const prefix = `capability:${projectId}:`;
  return {
    async provide(name: string, code: string): Promise<void> {
      if (BUILTIN_CAPABILITY_NAMES.has(name))
        throw new Error(`'${name}' is a builtin — a dynamic capability can never shadow a builtin`);
      if (!kv) throw new Error("no capability store bound");
      await kv.put(key(name), code);
    },
    async code(name: string): Promise<string | null> {
      return kv ? kv.get(key(name)) : null;
    },
    async list(): Promise<string[]> {
      if (!kv) return [];
      return (await kv.list({ prefix })).keys.map((k) => k.name.slice(prefix.length));
    },
  };
}
