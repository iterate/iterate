/**
 * THE CONTROL PLANE UNDER LOAD: N people, each with an organization and a project, born at once
 * against a deployed worker — `users.create`, `organizations.create` and `projects.create` over the
 * public `/api` as the operator, `--triples` of them in flight across `--sockets` websocket
 * sessions (each socket is one request to the edge, and a request has a 1000-subrequest budget:
 * one triple costs ~20). Prints the wall time and the latency distribution per verb, every refusal,
 * then reads back what the control plane knows: the people's reach (their organization, their
 * project), the operator's listings (every user, organization and project counted). A logic error shows as a mismatch; a bottleneck as a verb whose p95 grows with the
 * load. Nothing here is cleaned up: the preview's `pnpm preview reset` is.
 *
 *   doppler run --project project-worker --config preview -- sh -c 'ADMIN_API_SECRET="$(node -p "JSON.parse(process.env.APP_CONFIG).secrets.adminBearer")" pnpm control-plane-load --worker-base-url https://pr2828-control-plane-cleanup-os-preview.iterate-dev-preview.workers.dev --triples 1000 --sockets 50'
 */
import { newWebSocketRpcSession } from "capnweb";
import { createCli } from "trpc-cli";
import { WebSocket as UndiciWebSocket } from "undici";

const quantiles = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
};

export default async function controlPlaneLoad(options: {
  /** The deployed worker. Required. */
  workerBaseUrl: string;
  /** How many people, each with one organization and one project. */
  triples?: number;
  /** How many websocket sessions the triples are spread over (each is one edge request). */
  sockets?: number;
  /** A stamp for this run's names; defaults to the time. */
  stamp?: string;
}) {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) throw new Error("ADMIN_API_SECRET unset");
  const triples = options.triples || 100;
  const socketCount = options.sockets || Math.max(1, Math.ceil(triples / 20));
  const stamp = options.stamp || Date.now().toString(36);
  const apiUrl = new URL("/api", options.workerBaseUrl);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";

  // The operator's surface (src/session.ts), spelled locally: this is a Node script, so it cannot
  // import the worker-typed `IterateRpcTarget` (it drags in Cloudflare globals this config has no
  // types for) — the shape a reader needs is written out, its list rows typed like the real
  // `OrganizationRecord`/`ProjectRecord` so the reach check below reads them without a cast.
  type Session = {
    users: {
      create(input: { email: string }): Promise<{ id: string }>;
      list(): Promise<unknown[]>;
    };
    organizations: {
      create(input: { name: string; ownerId: string }): Promise<{ id: string }>;
      list(): Promise<{ id: string; role?: string; projects: number }[]>;
    };
    projects: {
      create(input: { project: string; orgId: string }): Promise<{
        whoami(): Promise<{ projectId: string; projectSlug?: string }>;
        [Symbol.dispose](): void;
      }>;
      list(): Promise<{ id: string; slug: string; orgId: string }[]>;
    };
    [Symbol.dispose](): void;
  };
  const open = async () => {
    const socket = new UndiciWebSocket(apiUrl);
    const api = newWebSocketRpcSession<{
      authenticate(credentials: {
        type: "admin-secret";
        secret: string;
        as?: { email: string };
      }): Promise<Session>;
      [Symbol.dispose](): void;
    }>(socket as unknown as WebSocket);
    const session = await api.authenticate({ type: "admin-secret", secret });
    return { socket, api, session };
  };

  const latency: Record<string, number[]> = { user: [], organization: [], project: [] };
  const refusals: string[] = [];
  const made: { email: string; userId: string; orgId: string; projectId: string; slug: string }[] =
    [];
  const timed = async <T>(verb: string, work: () => Promise<T>) => {
    const started = Date.now();
    const answer = await work();
    latency[verb]!.push(Date.now() - started);
    return answer;
  };

  const sockets = await Promise.all(Array.from({ length: socketCount }, open));
  console.log(`${socketCount} sockets open; ${triples} triples in flight at once…`);
  const wall = Date.now();
  await Promise.all(
    Array.from({ length: triples }, async (_, i) => {
      const { session } = sockets[i % socketCount]!;
      const email = `load-${stamp}-${i}@example.com`;
      const slug = `load-${stamp}-${i}`;
      try {
        const user = await timed("user", () => session.users.create({ email }));
        const org = await timed("organization", () =>
          session.organizations.create({ name: `Load ${stamp} ${i}`, ownerId: user.id }),
        );
        const project = await timed("project", () =>
          session.projects.create({ project: slug, orgId: org.id }),
        );
        const { projectId } = await project.whoami();
        project[Symbol.dispose]();
        made.push({ email, userId: user.id, orgId: org.id, projectId, slug });
      } catch (error) {
        refusals.push(`${i}: ${String(error)}`);
      }
    }),
  );
  const elapsed = Date.now() - wall;
  console.log(
    `\n${made.length} of ${triples} triples made in ${elapsed} ms (${refusals.length} refused)`,
  );
  for (const [verb, samples] of Object.entries(latency)) {
    const q = quantiles(samples);
    console.log(`  ${verb.padEnd(12)} n=${q.n} p50=${q.p50}ms p95=${q.p95}ms max=${q.max}ms`);
  }
  for (const refusal of refusals.slice(0, 10)) console.log(`  refused ${refusal}`);

  // ── what the entities and the index know afterwards ──
  const { session } = sockets[0]!;
  const readBack = Date.now();
  const [users, organizations, projects] = await Promise.all([
    session.users.list(),
    session.organizations.list(),
    session.projects.list(),
  ]);
  const projectIds = new Set(projects.map((p) => p.id));
  const indexed = made.filter((m) => projectIds.has(m.projectId)).length;
  console.log(
    `\nindex (root): ${users.length} users, ${organizations.length} organizations, ${projects.length} projects listed (${Date.now() - readBack} ms); ${indexed} of ${made.length} projects of this run indexed`,
  );
  // a sample of people sign in as themselves and read their own reach: the organization and the project
  const sample = made.filter((_, i) => i % Math.max(1, Math.floor(made.length / 20)) === 0);
  const reachStarted = Date.now();
  const mismatches: string[] = [];
  await Promise.all(
    sample.map(async (m, i) => {
      const { api } = sockets[i % socketCount]!;
      const person = await api.authenticate({
        type: "admin-secret",
        secret,
        as: { email: m.email },
      });
      try {
        const [orgs, projects] = await Promise.all([
          person.organizations.list(),
          person.projects.list(),
        ]);
        const org = orgs.find((o) => o.id === m.orgId);
        const project = projects.find((p) => p.id === m.projectId);
        if (org?.role !== "owner" || org.projects !== 1 || project?.orgId !== m.orgId)
          mismatches.push(`${m.email}: ${JSON.stringify({ orgs, projects })}`);
      } finally {
        person[Symbol.dispose]?.();
      }
    }),
  );
  console.log(
    `reach of ${sample.length} sampled people read in ${Date.now() - reachStarted} ms: ${mismatches.length} mismatches`,
  );
  for (const mismatch of mismatches.slice(0, 5)) console.log(`  ${mismatch}`);
  for (const { session, api, socket } of sockets) {
    session[Symbol.dispose]?.();
    api[Symbol.dispose]?.();
    socket.close();
  }
  if (refusals.length || mismatches.length || indexed !== made.length)
    throw new Error("control-plane-load: refusals, mismatches or an index behind — see above");
  console.log("✅ every triple made, indexed and reachable");
}
if (process.argv[1]?.endsWith("control-plane-load.ts"))
  void createCli({ ...import.meta, name: "control-plane-load" }).run();
