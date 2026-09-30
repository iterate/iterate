/**
 * THE CONTROL PLANE UNDER LOAD: N people, each with an organization and a project, born at once
 * against a deployed worker — `users.create`, `organizations.create` and `projects.create` over the
 * public `/api` as the operator, `--triples` of them in flight across `--sockets` websocket
 * sessions (each socket is one request to the edge, and a request has a 1000-subrequest budget:
 * one triple costs ~20). Prints the wall time and the latency distribution per verb, every refusal,
 * then reads back what the control plane knows: the people's reach (their organization, their
 * project), the operator's listings (every user, organization and project counted). A logic error shows as a mismatch; a bottleneck as a verb whose p95 grows with the
 * load. Nothing here is cleaned up: deleting the deployment is (`pnpm preview delete`, or the next
 * push's Clean up superseded).
 *
 *   doppler run --project os --config preview -- sh -c 'APP_CONFIG_SECRETS__ADMIN_BEARER="$(node -p "JSON.parse(process.env.APP_CONFIG).secrets.adminBearer")" pnpm os:control-plane-load --worker-base-url https://pr2828-a1b2c3d-os.iterate-dev-preview.workers.dev --triples 1000 --sockets 50'
 */
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { connectIterate } from "iterate/node";
import { createCli } from "trpc-cli";

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
  const secret = process.env.APP_CONFIG_SECRETS__ADMIN_BEARER;
  if (!secret) throw new Error("APP_CONFIG_SECRETS__ADMIN_BEARER unset");
  const triples = options.triples || 100;
  const socketCount = options.sockets || Math.max(1, Math.ceil(triples / 20));
  const stamp = options.stamp || Date.now().toString(36);
  const connect = (as?: { email: string }) =>
    connectIterate({ baseUrl: options.workerBaseUrl, auth: { type: "admin-secret", secret, as } });

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

  const sockets = await Promise.all(Array.from({ length: socketCount }, () => connect()));
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
  // a sample of people sign in as themselves, each on a connection of its own, and read their own
  // reach: the organization and the project
  const sample = made.filter((_, i) => i % Math.max(1, Math.floor(made.length / 20)) === 0);
  const reachStarted = Date.now();
  const mismatches: string[] = [];
  await Promise.all(
    sample.map(async (m) => {
      using person = await connect({ email: m.email });
      const [orgs, projects] = await Promise.all([
        person.session.organizations.list(),
        person.session.projects.list(),
      ]);
      const org = orgs.find((o) => o.id === m.orgId);
      const project = projects.find((p) => p.id === m.projectId);
      if (org?.role !== "owner" || org.projects !== 1 || project?.orgId !== m.orgId)
        mismatches.push(`${m.email}: ${JSON.stringify({ orgs, projects })}`);
    }),
  );
  console.log(
    `reach of ${sample.length} sampled people read in ${Date.now() - reachStarted} ms: ${mismatches.length} mismatches`,
  );
  for (const mismatch of mismatches.slice(0, 5)) console.log(`  ${mismatch}`);
  for (const connection of sockets) connection[Symbol.dispose]();
  if (refusals.length || mismatches.length || indexed !== made.length)
    throw new Error("control-plane-load: refusals, mismatches or an index behind — see above");
  console.log("✅ every triple made, indexed and reachable");
}
if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "control-plane-load" }).run();
