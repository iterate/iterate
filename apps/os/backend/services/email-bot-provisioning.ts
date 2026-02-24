/**
 * Email-bot auto-provisioning service.
 *
 * When an unknown sender emails the bot address, this pipeline creates
 * a user account, organisation, project, and machine — then forwards
 * the original email once the machine is active.
 *
 * Each step is idempotent: on retry it detects prior work and skips forward.
 *
 * Archil persistent storage is handled at the platform level by
 * machine-creation.ts (every machine gets a disk, not just email-bot ones).
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { slugify, slugifyWithSuffix } from "../utils/slug.ts";
import { getAuthWithEnv } from "../auth/auth.ts";
import { getDefaultProjectSandboxProvider } from "../utils/sandbox-providers.ts";
import { createMachineForProject } from "./machine-creation.ts";

/**
 * Derive a human-readable name from an email address.
 *   "Jane Doe <jane.doe@gmail.com>" → "Jane Doe"
 *   "jane.doe@gmail.com"            → "jane doe" → titlecased → "Jane Doe"
 */
export function deriveNameFromEmail(senderName: string, senderEmail: string): string {
  // If the sender string has a display name (e.g. from Resend "from" field), use it
  const nameMatch = senderName.match(/^([^<]+)</);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name.length > 0) return name;
  }

  // Otherwise derive from local part: jane.doe → Jane Doe
  const local = senderEmail.split("@")[0] ?? senderEmail;
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Derive an org name from an email address.
 *   "johnsmith@gmail.com" → "johnsmith"
 *   "jane.doe+test@company.com" → "jane-doe"
 */
export function deriveOrgNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  // Strip +suffix (plus addressing)
  const base = local.split("+")[0] ?? local;
  // Slugify handles the rest (lowercasing, special chars, etc.)
  return slugify(base);
}

// ─── Step 1: Create user ──────────────────────────────────────────────

export async function createEmailBotUser(
  db: DB,
  env: CloudflareEnv,
  params: { senderEmail: string; senderName: string },
): Promise<{ userId: string; alreadyExisted: boolean }> {
  const email = params.senderEmail.toLowerCase().trim();

  // Idempotent: check if user already exists
  const existing = await db.query.user.findFirst({
    where: (u, { eq: whereEq }) => whereEq(u.email, email),
  });
  if (existing) {
    logger.info(`[email-bot] User already exists for ${email} userId=${existing.id}`);
    return { userId: existing.id, alreadyExisted: true };
  }

  // Create via Better Auth admin API — this respects databaseHooks (allowlist + avatar)
  const auth = getAuthWithEnv(db, env);
  const name = deriveNameFromEmail(params.senderName, email);

  const result = await auth.api.createUser({
    body: {
      email,
      name,
      // Random password — user won't log in with it. They can reset later.
      password: crypto.randomUUID(),
      data: {
        emailVerified: true, // they proved ownership by sending the email
      },
    },
  });

  const userId = result.user.id;
  logger.info(`[email-bot] User created userId=${userId} email=${email}`);
  return { userId, alreadyExisted: false };
}

// ─── Step 2: Create organisation ──────────────────────────────────────

export async function createEmailBotOrg(
  db: DB,
  params: { userId: string; senderEmail: string },
): Promise<{ organizationId: string; alreadyExisted: boolean }> {
  // Idempotent: if user already has an org, use it
  const existingMembership = await db.query.organizationUserMembership.findFirst({
    where: (m, { eq: whereEq }) => whereEq(m.userId, params.userId),
    with: { organization: true },
  });
  if (existingMembership) {
    logger.info(`[email-bot] User already has org orgId=${existingMembership.organizationId}`);
    return { organizationId: existingMembership.organizationId, alreadyExisted: true };
  }

  const orgName = deriveOrgNameFromEmail(params.senderEmail);
  let slug = slugify(orgName);

  // Check uniqueness, add suffix if needed
  const existingOrg = await db.query.organization.findFirst({
    where: eq(schema.organization.slug, slug),
  });
  if (existingOrg) {
    slug = slugifyWithSuffix(orgName);
  }

  const [newOrg] = await db.insert(schema.organization).values({ name: orgName, slug }).returning();

  if (!newOrg) throw new Error("[email-bot] Failed to create organization");

  await db.insert(schema.organizationUserMembership).values({
    organizationId: newOrg.id,
    userId: params.userId,
    role: "owner",
  });

  logger.info(`[email-bot] Org created orgId=${newOrg.id} slug=${slug}`);
  return { organizationId: newOrg.id, alreadyExisted: false };
}

// ─── Step 3: Create project ──────────────────────────────────────────

export async function createEmailBotProject(
  db: DB,
  env: CloudflareEnv,
  params: { organizationId: string },
): Promise<{ projectId: string; alreadyExisted: boolean }> {
  // Idempotent: if org already has a project, use it
  const existingProject = await db.query.project.findFirst({
    where: eq(schema.project.organizationId, params.organizationId),
  });
  if (existingProject) {
    logger.info(`[email-bot] Org already has project projectId=${existingProject.id}`);
    return { projectId: existingProject.id, alreadyExisted: true };
  }

  // For first project, slug = org slug (mirrors org router behaviour)
  const org = await db.query.organization.findFirst({
    where: eq(schema.organization.id, params.organizationId),
  });
  if (!org) throw new Error(`[email-bot] Org not found: ${params.organizationId}`);

  let slug = org.slug;

  // Check global uniqueness (project slugs are globally unique)
  const existingSlug = await db.query.project.findFirst({
    where: eq(schema.project.slug, slug),
  });
  if (existingSlug) {
    slug = slugifyWithSuffix(slug);
  }

  const sandboxProvider = getDefaultProjectSandboxProvider(env, false);

  const [newProject] = await db
    .insert(schema.project)
    .values({
      name: org.name,
      slug,
      organizationId: params.organizationId,
      sandboxProvider,
    })
    .returning();

  if (!newProject) throw new Error("[email-bot] Failed to create project");

  logger.info(`[email-bot] Project created projectId=${newProject.id} slug=${slug}`);
  return { projectId: newProject.id, alreadyExisted: false };
}

// ─── Step 4: Provision machine ────────────────────────────────────────

export async function provisionEmailBotInfra(
  db: DB,
  env: CloudflareEnv,
  params: {
    projectId: string;
    resendEmailId: string;
    resendPayload: Record<string, unknown>;
    recipientEmail: string;
    userId: string;
  },
): Promise<{ machineId: string }> {
  // Idempotent: if project already has a starting/active machine, skip
  const existingMachine = await db.query.machine.findFirst({
    where: (m, { eq: whereEq, and: whereAnd, inArray }) =>
      whereAnd(whereEq(m.projectId, params.projectId), inArray(m.state, ["starting", "active"])),
  });
  if (existingMachine) {
    logger.info(
      `[email-bot] Project already has machine machineId=${existingMachine.id} state=${existingMachine.state}`,
    );
    return { machineId: existingMachine.id };
  }

  // Create machine — this also ensures the Archil disk exists (platform-level),
  // emits machine:created, and enters the existing provisioning pipeline.
  const { machine } = await createMachineForProject({
    db,
    env,
    projectId: params.projectId,
    name: "email-bot",
    metadata: {
      pendingEmail: {
        resendEmailId: params.resendEmailId,
        resendPayload: params.resendPayload,
        recipientEmail: params.recipientEmail,
        userId: params.userId,
      },
    },
  });

  logger.info(`[email-bot] Machine creation started machineId=${machine.id}`);
  return { machineId: machine.id };
}
