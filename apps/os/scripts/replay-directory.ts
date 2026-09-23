/**
 * Replay the retired D1 directory of a deployed os-next environment into its control plane — through
 * the public `/api` as the operator, every existing id pinned. A ONE-OFF, run by hand right after the
 * deploy that retires the D1; idempotent, so twice is safe. Dry-run first:
 *
 *   doppler run --project project-worker --config prd -- sh -c 'ADMIN_API_SECRET="$(node -p "JSON.parse(process.env.APP_CONFIG).secrets.adminBearer")" pnpm replay-directory --env prd --d1-database-id be6a3789-726a-4786-8b50-ef150c583b4e --dry-run'
 *
 * The e2e suite made most of prd's rows: users at reserved test domains, their orgs and projects, and
 * `prj-…`/`taken-…` projects in `org_admin` are skipped. Once the database is deleted by hand the read
 * answers "not found" and this prints "nothing to replay".
 */
import { newWebSocketRpcSession } from "capnweb";
import { createCli } from "trpc-cli";
import { WebSocket as UndiciWebSocket } from "undici";
import { osEnvs } from "../../../envs.ts";
import { CloudflareApiError, resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const TABLES = ["users", "user_identities", "orgs", "org_members", "projects"] as const;
type Rows = {
  users: { id: string; email: string }[];
  user_identities: { provider: "google" | "cloudflare"; subject: string; user_id: string }[];
  orgs: { id: string; name: string }[];
  org_members: { org_id: string; user_id: string; role: "owner" | "member" }[];
  projects: { id: string; slug: string; org_id: string }[];
};
/** The reserved test domains, as src/password-and-code-sign-in.ts never mails them. */
const fixtureEmail = /@(example\.(com|net|org)|[^@]+\.(test|example|invalid|localhost))$/i;

function withoutFixtures(all: Rows): Rows {
  const fixtureUser = new Set(all.users.filter((u) => fixtureEmail.test(u.email)).map((u) => u.id));
  const withAMember = new Set(
    all.org_members.filter((m) => !fixtureUser.has(m.user_id)).map((m) => m.org_id),
  );
  const fixtureOrg = new Set(
    all.orgs.filter((o) => o.id !== "org_admin" && !withAMember.has(o.id)).map((o) => o.id),
  );
  return {
    users: all.users.filter((u) => !fixtureUser.has(u.id)),
    user_identities: all.user_identities.filter((g) => !fixtureUser.has(g.user_id)),
    orgs: all.orgs.filter((o) => !fixtureOrg.has(o.id)),
    org_members: all.org_members.filter(
      (m) => !fixtureOrg.has(m.org_id) && !fixtureUser.has(m.user_id),
    ),
    projects: all.projects.filter(
      (p) =>
        !fixtureOrg.has(p.org_id) && !(p.org_id === "org_admin" && /^(prj|taken)-/.test(p.slug)),
    ),
  };
}

/** The operator's surface (src/session.ts): `iterate/next/api` declares the app-facing half only. */
type OperatorSession = {
  users: {
    create(input: { email: string; id: string }): Promise<{ id: string }>;
    linkIdentity(input: {
      provider: "google" | "cloudflare";
      subject: string;
      email: string;
    }): Promise<{ id: string }>;
  };
  organizations: {
    create(input: { name: string; id: string; ownerId?: string }): Promise<{ id: string }>;
    addMember(orgId: string, input: { userId: string; role: "owner" | "member" }): Promise<void>;
  };
  projects: {
    create(input: { project: string; orgId: string; restoreProjectId: string }): Promise<{
      whoami(): Promise<{ projectId: string }>;
      [Symbol.dispose](): void;
    }>;
  };
  [Symbol.dispose](): void;
};

export default async function replayDirectory(options: {
  /** Target environment name from envs.ts. Required. */
  env: string;
  /** The retired directory database, still in the account until deleted by hand. Required. */
  d1DatabaseId: string;
  /** Replay into this worker instead of the env's baseUrl (a preview). */
  workerBaseUrl?: string;
  /** Read and count; change nothing. */
  dryRun?: boolean;
}) {
  const adminApiSecret = process.env.ADMIN_API_SECRET;
  if (!adminApiSecret && !options.dryRun) throw new Error("ADMIN_API_SECRET unset");
  const context = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: "project-worker",
    env: options.env,
  });
  const baseUrl = options.workerBaseUrl || context.env.baseUrl;

  let answered: { results: Record<string, unknown>[] }[];
  try {
    answered = await context.cf(`/d1/database/${options.d1DatabaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: TABLES.map((table) => `SELECT * FROM "${table}"`).join("; ") }),
    });
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      console.log("no directory database — nothing to replay");
      return;
    }
    throw error;
  }
  // D1's /query answers one entry per statement, in the order sent: each `results` is that table's rows
  const all = Object.fromEntries(TABLES.map((t, i) => [t, answered[i].results])) as Rows;
  const rows = withoutFixtures(all);
  for (const table of TABLES)
    console.log(`${table}: ${rows[table].length} to replay (${all[table].length} rows)`);
  if (options.dryRun) return;

  const apiUrl = new URL("/api", baseUrl);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new UndiciWebSocket(apiUrl);
  const api = newWebSocketRpcSession<{
    authenticate(credentials: { type: "admin-secret"; secret: string }): Promise<OperatorSession>;
    [Symbol.dispose](): void;
  }>(socket as unknown as WebSocket);
  const session = await api.authenticate({ type: "admin-secret", secret: adminApiSecret! });
  const failures: string[] = [];
  const replay = async <Row>(kind: string, items: Row[], one: (row: Row) => Promise<void>) => {
    let ok = 0;
    for (const row of items)
      try {
        await one(row);
        ok++;
      } catch (error) {
        failures.push(`${kind} ${JSON.stringify(row)}: ${String(error)}`);
      }
    console.log(`${kind}: ${ok} of ${items.length} ok`);
  };
  const emailOf = new Map(all.users.map((u) => [u.id, u.email]));
  // The id the control plane ANSWERED for a D1 user: an email a sign-in already made a user for
  // answers that user, under its own id — every later step follows the answered id.
  const userIdOf = new Map<string, string>();
  const ownerOf = (orgId: string) => {
    const owner = rows.org_members.find((m) => m.org_id === orgId && m.role === "owner")?.user_id;
    return owner && (userIdOf.get(owner) || owner);
  };
  try {
    await replay("user", rows.users, async (u) => {
      userIdOf.set(u.id, (await session.users.create({ email: u.email, id: u.id })).id);
    });
    await replay("identity", rows.user_identities, async (g) => {
      await session.users.linkIdentity({
        provider: g.provider,
        subject: g.subject,
        email: emailOf.get(g.user_id)!,
      });
    });
    await replay("organization", rows.orgs, async (o) => {
      await session.organizations.create({ name: o.name, id: o.id, ownerId: ownerOf(o.id) });
    });
    await replay("membership", rows.org_members, async (m) => {
      await session.organizations.addMember(m.org_id, {
        userId: userIdOf.get(m.user_id) || m.user_id,
        role: m.role,
      });
    });
    await replay("project", rows.projects, async (p) => {
      using project = await session.projects.create({
        project: p.slug,
        orgId: p.org_id,
        restoreProjectId: p.id,
      });
      const { projectId } = await project.whoami();
      if (projectId !== p.id) throw new Error(`answered as ${projectId}`);
    });
  } finally {
    session[Symbol.dispose]?.();
    api[Symbol.dispose]?.();
    socket.close();
  }
  if (failures.length) throw new Error(`replay-directory: failed\n${failures.join("\n")}`);
  console.log(`✅ replayed into ${baseUrl}`);
}
if (process.argv[1]?.endsWith("replay-directory.ts"))
  void createCli({ ...import.meta, name: "replay-directory" }).run();
