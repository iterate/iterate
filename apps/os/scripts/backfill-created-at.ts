/** Date the control plane's rows that predate their `created_at` column
 * (src/control-plane/db/migrations/0004_created_at.sql) from each organization's activity log:
 * an organization by its `organization/created`, a membership by the `organization/member-added`
 * that began it, a project by its `organization/project-added`. A dry run by default; `--apply`
 * writes.
 *
 *   pnpm backfill-created-at --env prd
 *   pnpm backfill-created-at --env prd --apply
 *   pnpm backfill-created-at --env preview --pr 1234 --apply
 *
 * Every write is `where created_at is null`: a date already there is never replaced, so a rerun is
 * a no-op. A row its organization's log holds no fact for stays null and is listed. That is every
 * row of the deployment's own organization, which gets no facts (session.ts
 * `publishProjectAdded`), and an owner the operator named when creating the organization, whose
 * membership gets no `member-added`.
 */
import { createCli } from "trpc-cli";
import { createD1HttpClient } from "sqlfu/cloudflare";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { CLOUDFLARE_API, fetchRetryingPlatformFailures } from "@iterate-com/shared/platform-retry";
import { connectIterate } from "iterate/node";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { parseAppConfig } from "../src/app-config.ts";
import {
  dateMembership,
  dateOrganization,
  dateProject,
  undatedMemberships,
  undatedOrganizations,
  undatedProjects,
} from "../src/control-plane/db/queries/.generated/created-at-backfill.sql.ts";
import { findD1 } from "./d1.ts";
import { previewResourceName, previewUrl } from "./preview-config.ts";

export default async function backfillCreatedAt(options: {
  /** The deployment in envs.ts `osEnvs`: `prd`, or `preview` for the dev/preview account. */
  env: string;
  /** With `--env preview`, a pull request's preview (its own D1 and URL) instead of the parent. */
  pr?: number;
  /** Write the dates. Without it, the plan is printed and nothing is written. */
  apply?: boolean;
}) {
  if (options.pr && options.env !== "preview")
    throw new Error("--pr names a preview on the dev/preview account: pass --env preview.");
  const context = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
  });
  const preview = options.pr && `pr${options.pr}`;
  const databaseName = preview && previewResourceName(preview, "db");
  const databaseId = databaseName
    ? (await findD1(context.cf, databaseName))?.uuid
    : context.env.resources.dbId;
  if (!databaseId) throw new Error(`No D1 named ${databaseName}: is ${preview} deployed?`);
  const baseUrl = preview ? previewUrl(preview) : context.env.baseUrl;
  console.log(`${options.apply ? "Backfill" : "Dry run"}: ${baseUrl}, D1 ${databaseId}`);

  const db = createD1HttpClient({
    accountId: context.env.cloudflareAccountId,
    apiToken: context.secrets.CLOUDFLARE_API_TOKEN!,
    databaseId,
    // Every statement here is idempotent, so any of them is sent again: a read, or an update whose
    // `created_at is null` guard makes a second run of it change nothing.
    fetch: (input, init) =>
      fetchRetryingPlatformFailures(
        "POST D1 query",
        (signal) => fetch(input, { ...init, signal }),
        {
          area: "cloudflare-api",
          schedule: CLOUDFLARE_API,
          idempotent: true,
          timeoutMs: 60_000,
        },
      ),
  });
  const undated = async () => ({
    organizations: await undatedOrganizations(db),
    memberships: await undatedMemberships(db),
    projects: await undatedProjects(db),
  });
  const rows = await undated();

  // The operator bearer, from the two secrets scripts/deploy.ts ships.
  const adminSecret = parseAppConfig({
    APP_CONFIG: context.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: context.secrets.APP_CONFIG_SECRETS__KEY,
  }).secrets.adminBearer.exposeSecret();
  using connection = await connectIterate({
    baseUrl,
    auth: { type: "admin-secret", secret: adminSecret },
  });
  const orgIds = new Set([
    ...rows.organizations.map((row) => row.id),
    ...rows.memberships.map((row) => row.orgId),
    ...rows.projects.map((row) => row.orgId),
  ]);
  const logs = new Map<string, ReturnType<typeof activityDates>>();
  for (const orgId of [...orgIds].sort()) {
    using organization = await connection.session.organizations.get(orgId);
    const events: unknown[] = [];
    for (let after = 0; ;) {
      const page = await organization.readEvents(after, 500);
      events.push(...page.events);
      if (page.atHead || page.scannedThroughOffset <= after) break;
      after = page.scannedThroughOffset;
    }
    logs.set(orgId, activityDates(events));
  }

  const plan = [
    ...rows.organizations.map(({ id }) => ({
      table: "organizations",
      row: id,
      createdAt: logs.get(id)?.organization,
      write: (createdAt: number) => dateOrganization(db, { createdAt }, { id }),
    })),
    ...rows.memberships.map(({ orgId, userId }) => ({
      table: "memberships",
      row: `${orgId} ${userId}`,
      createdAt: logs.get(orgId)?.memberships.get(userId),
      write: (createdAt: number) => dateMembership(db, { createdAt }, { orgId, userId }),
    })),
    ...rows.projects.map(({ id, orgId }) => ({
      table: "projects",
      row: `${orgId} ${id}`,
      createdAt: logs.get(orgId)?.projects.get(id),
      write: (createdAt: number) => dateProject(db, { createdAt }, { id }),
    })),
  ];
  for (const step of plan)
    console.log(
      `${step.table}\t${step.row}\t${step.createdAt ? new Date(step.createdAt).toISOString() : "no fact: stays null"}`,
    );
  for (const table of ["organizations", "memberships", "projects"]) {
    const steps = plan.filter((step) => step.table === table);
    const dated = steps.filter((step) => step.createdAt).length;
    console.log(
      `${table}: ${steps.length} undated, ${dated} dated from the log, ${steps.length - dated} stay null`,
    );
  }
  const now = Date.now();
  const future = plan.filter((step) => step.createdAt && step.createdAt > now);
  if (future.length)
    throw new Error(
      `${future.length} dates are later than now (${future.map((step) => step.row).join(", ")}): nothing is written.`,
    );
  if (!options.apply) {
    console.log("Dry run: nothing written. Pass --apply to write these dates.");
    return;
  }

  let written = 0;
  for (const step of plan) {
    if (!step.createdAt) continue;
    const { rowsAffected } = await step.write(step.createdAt);
    written += rowsAffected ?? 0;
  }
  const left = await undated();
  console.log(
    `Wrote ${written} dates. Still null: ${left.organizations.length} organizations, ${left.memberships.length} memberships, ${left.projects.length} projects.`,
  );
}

/** When an organization's rows began, by the facts on its log, in log order (epoch ms). Only the
 *  platform's facts count (`source.platform`): a member can append any type to the organization's
 *  context. The earliest `created` dates the organization. A membership is dated by the `member-added`
 *  that began it: a later one (a change of role) keeps that date, and a `member-removed` ends it, so
 *  a member who rejoined is dated by the rejoin. A project is dated by its `project-added`, and its
 *  `project-removed` ends that the same way. */
function activityDates(events: unknown[]) {
  let organization: number | undefined;
  const memberships = new Map<string, number>();
  const projects = new Map<string, number>();
  for (const event of z.array(LogEvent).parse(events)) {
    if (event.source?.platform !== true) continue;
    const at = Date.parse(event.createdAt);
    switch (event.type) {
      case "events.iterate.com/organization/created":
        organization ??= at;
        break;
      case "events.iterate.com/organization/member-added": {
        const { userId } = Member.parse(event.payload);
        if (!memberships.has(userId)) memberships.set(userId, at);
        break;
      }
      case "events.iterate.com/organization/member-removed":
        memberships.delete(Member.parse(event.payload).userId);
        break;
      case "events.iterate.com/organization/project-added": {
        const { projectId } = Project.parse(event.payload);
        if (!projects.has(projectId)) projects.set(projectId, at);
        break;
      }
      case "events.iterate.com/organization/project-removed":
        projects.delete(Project.parse(event.payload).projectId);
        break;
    }
  }
  return { organization, memberships, projects };
}
// A list, not an `export function`: trpc-cli makes every exported declaration a command.
export { activityDates };

/** What the fold reads of every event on the log; the facts' payloads are spelled in
 *  src/organization/contract.ts. */
const LogEvent = z.object({
  type: z.string(),
  createdAt: z.iso.datetime(),
  payload: z.unknown(),
  source: z.object({ platform: z.boolean().optional() }).optional(),
});
const Member = z.object({ userId: z.string().min(1) });
const Project = z.object({ projectId: z.string().min(1) });

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "backfill-created-at" }).run();
