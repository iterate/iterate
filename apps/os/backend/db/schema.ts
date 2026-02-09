import {
  pgTable,
  timestamp,
  text,
  uniqueIndex,
  unique,
  jsonb,
  index,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { typeid } from "typeid-js";
import { relations, sql } from "drizzle-orm";
import { MachineType as SandboxMachineType } from "@iterate-com/sandbox/providers/types";

// Slug constraint: alphanumeric and hyphens only, must contain at least one letter, max 50 chars, not reserved
const slugCheck = (columnName: string, constraintName: string) =>
  check(
    constraintName,
    sql`${sql.identifier(columnName)} ~ '^[a-z0-9-]+$' AND ${sql.identifier(columnName)} ~ '[a-z]' AND length(${sql.identifier(columnName)}) <= 50 AND ${sql.identifier(columnName)} NOT IN ('prj', 'org')`,
  );
import type { SlackEvent } from "@slack/web-api";

// Organization roles: owner, admin, member (simplified from OS)
export const UserRole = ["member", "admin", "owner"] as const;
export type UserRole = (typeof UserRole)[number];

// Machine states:
// - starting: machine is being provisioned, not yet ready for use
// - active: machine is ready and is the current active machine for the project
// - detached: machine was replaced by a newer active machine but may still be reachable
// - archived: machine has been replaced or manually archived
export const MachineState = ["starting", "active", "detached", "archived"] as const;
export type MachineState = (typeof MachineState)[number];

// Machine types
// Note: "docker" replaces "local-docker" (migration 0017).
export const MachineType = [...SandboxMachineType] as const;
export type MachineType = (typeof MachineType)[number];

// Secret metadata for OAuth tokens
export type SecretMetadata = {
  // For OAuth tokens - encrypted refresh token for automatic renewal
  encryptedRefreshToken?: string;
  // OAuth token expiry (ISO string)
  expiresAt?: string;
  // OAuth scopes granted
  scopes?: string[];
  // Connection ID this secret is associated with
  connectionId?: string;
  // GitHub App installation ID for regenerating installation tokens
  githubInstallationId?: number;
};

export const withTimestamps = {
  createdAt: timestamp().defaultNow().notNull(),
  updatedAt: timestamp()
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const iterateId = <P extends string>(prefix: P) =>
  text()
    .primaryKey()
    .$defaultFn(() => typeid(prefix).toString() as `${P}_${string}`);

// #region ========== Better Auth Schema ==========
export const user = pgTable("user", (t) => ({
  id: iterateId("usr"),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  emailVerified: t.boolean().default(false).notNull(),
  image: t.text(),
  // https://www.better-auth.com/docs/plugins/admin#schema
  role: t.text().default("user"),
  banned: t.boolean(),
  banReason: t.text(),
  banExpires: t.timestamp(),
  ...withTimestamps,
}));

export const userRelations = relations(user, ({ many }) => ({
  session: many(session),
  account: many(account),
  organizationUserMembership: many(organizationUserMembership),
  projectConnections: many(projectConnection),
}));

export const session = pgTable("better_auth_session", (t) => ({
  id: iterateId("ses"),
  expiresAt: t.timestamp().notNull(),
  token: t.text().notNull().unique(),
  ipAddress: t.text(),
  userAgent: t.text(),
  userId: t
    .text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // https://www.better-auth.com/docs/plugins/admin#schema
  impersonatedBy: t.text().references(() => user.id, { onDelete: "cascade" }),
  ...withTimestamps,
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const account = pgTable("better_auth_account", (t) => ({
  id: iterateId("acc"),
  accountId: t.text().notNull(),
  providerId: t.text().notNull(), // google, slack, slack-bot
  userId: t
    .text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: t.text(),
  refreshToken: t.text(),
  idToken: t.text(),
  accessTokenExpiresAt: t.timestamp(),
  refreshTokenExpiresAt: t.timestamp(),
  scope: t.text(),
  password: t.text(),
  ...withTimestamps,
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const verification = pgTable("better_auth_verification", (t) => ({
  id: iterateId("ver"),
  identifier: t.text().notNull(),
  value: t.text().notNull(),
  expiresAt: t.timestamp().notNull(),
  ...withTimestamps,
}));
// #endregion ========== Better Auth Schema ==========

// #region ========== Organization & Project ==========
export const organization = pgTable(
  "organization",
  (t) => ({
    id: iterateId("org"),
    name: t.text().notNull(),
    slug: t.text().notNull().unique(), // URL-safe slug: alphanumeric only, must contain letter
    ...withTimestamps,
  }),
  () => [slugCheck("slug", "organization_slug_valid")],
);

export const organizationRelations = relations(organization, ({ many, one }) => ({
  projects: many(project),
  members: many(organizationUserMembership),
  invites: many(organizationInvite),
  billingAccount: one(billingAccount),
}));

export const organizationUserMembership = pgTable(
  "organization_user_membership",
  (t) => ({
    id: iterateId("member"),
    organizationId: t
      .text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: t
      .text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: t
      .text({ enum: [...UserRole] })
      .notNull()
      .default("member"),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.userId, t.organizationId)],
);

export const organizationUserMembershipRelations = relations(
  organizationUserMembership,
  ({ one }) => ({
    organization: one(organization, {
      fields: [organizationUserMembership.organizationId],
      references: [organization.id],
    }),
    user: one(user, {
      fields: [organizationUserMembership.userId],
      references: [user.id],
    }),
  }),
);

// Organization invites (pending invitations by email)
export const organizationInvite = pgTable(
  "organization_invite",
  (t) => ({
    id: iterateId("inv"),
    organizationId: t
      .text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: t.text().notNull(),
    invitedByUserId: t
      .text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: t
      .text({ enum: [...UserRole] })
      .notNull()
      .default("member"),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.organizationId, t.email)],
);

export const organizationInviteRelations = relations(organizationInvite, ({ one }) => ({
  organization: one(organization, {
    fields: [organizationInvite.organizationId],
    references: [organization.id],
  }),
  invitedBy: one(user, {
    fields: [organizationInvite.invitedByUserId],
    references: [user.id],
  }),
}));

// Project (renamed from instance/estate)
export const project = pgTable(
  "project",
  (t) => ({
    id: iterateId("prj"),
    name: t.text().notNull(),
    slug: t.text().notNull().unique(), // Globally unique URL-safe slug
    organizationId: t
      .text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sandboxProvider: t
      .text({ enum: [...MachineType] })
      .notNull()
      .default("daytona"),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.organizationId, t.name), slugCheck("slug", "project_slug_valid")],
);

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  events: many(event),
  machines: many(machine),
  projectRepos: many(projectRepo),
  envVars: many(projectEnvVar),
  accessTokens: many(projectAccessToken),
  connections: many(projectConnection),
}));

// Environment variables for a project (non-secret, plain text values)
export const projectEnvVar = pgTable(
  "project_env_var",
  (t) => ({
    id: iterateId("env"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    machineId: t.text().references(() => machine.id, { onDelete: "cascade" }),
    key: t.text().notNull(),
    value: t.text().notNull(), // Plain text - secrets go in the secret table
    description: t.text(), // Optional description (shown as comment in .env file)
    type: t.text({ enum: ["user", "system"] }).default("user"),
    ...withTimestamps,
  }),
  (t) => [
    uniqueIndex().on(t.projectId, t.machineId, t.key),
    index().on(t.projectId),
    index().on(t.machineId),
  ],
);

export const projectEnvVarRelations = relations(projectEnvVar, ({ one }) => ({
  project: one(project, {
    fields: [projectEnvVar.projectId],
    references: [project.id],
  }),
  machine: one(machine, {
    fields: [projectEnvVar.machineId],
    references: [machine.id],
  }),
}));

// Secrets table - encrypted values with hierarchy (global > org > project > user)
// All scope fields nullable: null = global scope
export const secret = pgTable(
  "secret",
  (t) => ({
    id: iterateId("sec"),
    organizationId: t.text().references(() => organization.id, { onDelete: "cascade" }),
    projectId: t.text().references(() => project.id, { onDelete: "cascade" }),
    userId: t.text().references(() => user.id, { onDelete: "cascade" }),
    key: t.text().notNull(), // e.g. "openai_api_key", "gmail.access_token"
    encryptedValue: t.text().notNull(),
    description: t.text(), // Human-readable description for UI and .env comments
    egressProxyRule: t.text(), // URL pattern for egress proxy (e.g. "api.openai.com/*")
    metadata: jsonb().$type<SecretMetadata>(), // OAuth metadata, expiry, etc.
    lastSuccessAt: t.timestamp({ withTimezone: true }), // Last successful use
    lastFailedAt: t.timestamp({ withTimezone: true }), // Last failed use (401, etc.)
    ...withTimestamps,
  }),
  (t) => [
    // Unique within each scope level (NULLS NOT DISTINCT so global secrets with NULL scope are unique)
    unique("secret_scope_key_idx")
      .on(t.organizationId, t.projectId, t.userId, t.key)
      .nullsNotDistinct(),
    index().on(t.organizationId),
    index().on(t.projectId),
    index().on(t.userId),
    index().on(t.key),
  ],
);

export const secretRelations = relations(secret, ({ one }) => ({
  organization: one(organization, {
    fields: [secret.organizationId],
    references: [organization.id],
  }),
  project: one(project, {
    fields: [secret.projectId],
    references: [project.id],
  }),
  user: one(user, {
    fields: [secret.userId],
    references: [user.id],
  }),
}));

export const egressPolicy = pgTable(
  "egress_policy",
  (t) => ({
    id: iterateId("egp"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    priority: integer().notNull().default(100),
    urlPattern: t.text(),
    method: t.text(),
    headerMatch: jsonb().$type<Record<string, string>>(),
    decision: t.text({ enum: ["allow", "deny", "human_approval"] }).notNull(),
    reason: t.text(),
    ...withTimestamps,
  }),
  (t) => [index().on(t.projectId, t.priority)],
);

export const egressPolicyRelations = relations(egressPolicy, ({ one }) => ({
  project: one(project, {
    fields: [egressPolicy.projectId],
    references: [project.id],
  }),
}));

export const egressApproval = pgTable(
  "egress_approval",
  (t) => ({
    id: iterateId("ega"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    policyId: t.text().references(() => egressPolicy.id, { onDelete: "set null" }),
    method: t.text().notNull(),
    url: t.text().notNull(),
    headers: jsonb().$type<Record<string, string>>().notNull(),
    body: t.text(),
    status: t
      .text({ enum: ["pending", "approved", "rejected", "timeout"] })
      .notNull()
      .default("pending"),
    decidedAt: t.timestamp(),
    decidedBy: t.text().references(() => user.id, { onDelete: "set null" }),
    sessionId: t.text(),
    context: t.text(),
    ...withTimestamps,
  }),
  (t) => [index().on(t.projectId, t.status), index().on(t.status)],
);

export const egressApprovalRelations = relations(egressApproval, ({ one }) => ({
  project: one(project, {
    fields: [egressApproval.projectId],
    references: [project.id],
  }),
  policy: one(egressPolicy, {
    fields: [egressApproval.policyId],
    references: [egressPolicy.id],
  }),
  decidedByUser: one(user, {
    fields: [egressApproval.decidedBy],
    references: [user.id],
  }),
}));

// API access tokens for a project (also used by machines for control plane auth)
export const projectAccessToken = pgTable(
  "project_access_token",
  (t) => ({
    id: iterateId("pat"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: t.text().notNull(),
    encryptedToken: t.text().notNull(), // Encrypted API token (can be decrypted to send to machines)
    lastUsedAt: t.timestamp({ withTimezone: true }),
    revokedAt: t.timestamp({ withTimezone: true }),
    ...withTimestamps,
  }),
  (t) => [index().on(t.projectId)],
);

export const projectAccessTokenRelations = relations(projectAccessToken, ({ one }) => ({
  project: one(project, {
    fields: [projectAccessToken.projectId],
    references: [project.id],
  }),
}));

// OAuth connections (project-scoped like Slack, or user-scoped like Gmail)
export const projectConnection = pgTable(
  "project_connection",
  (t) => ({
    id: iterateId("conn"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    provider: t.text().notNull(),
    externalId: t.text().notNull(),
    scope: t.text({ enum: ["project", "user"] }).notNull(),
    userId: t.text().references(() => user.id, { onDelete: "cascade" }),
    providerData: t.jsonb().$type<Record<string, unknown>>().notNull().default({}),
    scopes: t.text(),
    ...withTimestamps,
  }),
  (t) => [index().on(t.provider, t.externalId), index().on(t.projectId)],
);

export const projectConnectionRelations = relations(projectConnection, ({ one }) => ({
  project: one(project, {
    fields: [projectConnection.projectId],
    references: [project.id],
  }),
  user: one(user, {
    fields: [projectConnection.userId],
    references: [user.id],
  }),
}));
// #endregion ========== Organization & Project ==========

// #region ========== Machine ==========
export const machine = pgTable(
  "machine",
  (t) => ({
    id: iterateId("mach"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: t.text().notNull(),
    type: t
      .text({ enum: [...MachineType] })
      .notNull()
      .default("daytona"),
    state: t
      .text({ enum: [...MachineState] })
      .notNull()
      .default("starting"),
    externalId: t.text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    ...withTimestamps,
  }),
  (t) => [
    index().on(t.projectId),
    index().on(t.state),
    // Only one active machine per project (starting machines don't count)
    uniqueIndex("machine_project_one_active")
      .on(t.projectId)
      .where(sql`state = 'active'`),
  ],
);

export const machineRelations = relations(machine, ({ one, many }) => ({
  project: one(project, {
    fields: [machine.projectId],
    references: [project.id],
  }),
  previewTokens: many(daytonaPreviewToken),
}));
// #endregion ========== Machine ==========

// #region ========== Daytona Preview Tokens ==========
export const daytonaPreviewToken = pgTable(
  "daytona_preview_token",
  (t) => ({
    id: iterateId("dtpv"),
    machineId: t
      .text()
      .notNull()
      .references(() => machine.id, { onDelete: "cascade" }),
    port: t.text().notNull(),
    token: t.text().notNull(),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.machineId, t.port), index().on(t.machineId)],
);

export const daytonaPreviewTokenRelations = relations(daytonaPreviewToken, ({ one }) => ({
  machine: one(machine, {
    fields: [daytonaPreviewToken.machineId],
    references: [machine.id],
  }),
}));
// #endregion ========== Daytona Preview Tokens ==========

// #region ========== Events (unified) ==========
export const event = pgTable(
  "event",
  (t) => ({
    id: iterateId("evt"),
    type: t.text().notNull(), // e.g., "slack:webhook-received"
    payload: t.jsonb().$type<SlackEvent | Record<string, unknown>>().notNull(),
    projectId: t.text().references(() => project.id, { onDelete: "cascade" }),
    externalId: t.text().notNull(), // Provider event ID for deduplication (e.g., Slack event_id, GitHub delivery_id)
    ...withTimestamps,
  }),
  (t) => [
    index().on(t.projectId),
    index().on(t.type),
    uniqueIndex("event_type_external_id_unique").on(t.type, t.externalId),
  ],
);

export const eventRelations = relations(event, ({ one }) => ({
  project: one(project, {
    fields: [event.projectId],
    references: [project.id],
  }),
}));
// #endregion ========== Events ==========

// #region ========== Project Repo (simplified iterateConfigSource) ==========
export const projectRepo = pgTable(
  "project_repo",
  (t) => ({
    id: iterateId("repo"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    provider: t.text().notNull(),
    externalId: t.text().notNull(),
    owner: t.text().notNull(),
    name: t.text().notNull(),
    defaultBranch: t.text().notNull().default("main"),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex("project_repo_project_owner_name_idx").on(t.projectId, t.owner, t.name)],
);

export const projectRepoRelations = relations(projectRepo, ({ one }) => ({
  project: one(project, {
    fields: [projectRepo.projectId],
    references: [project.id],
  }),
}));
// #endregion ========== Project Repo ==========

// #region ========== Billing ==========
export const SubscriptionStatus = [
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
] as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[number];

export const billingAccount = pgTable(
  "billing_account",
  (t) => ({
    id: iterateId("bill"),
    organizationId: t
      .text()
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: t.text().unique(),
    stripeSubscriptionId: t.text().unique(),
    stripeSubscriptionItemId: t.text(),
    subscriptionStatus: t.text({ enum: [...SubscriptionStatus] }),
    currentPeriodStart: t.timestamp(),
    currentPeriodEnd: t.timestamp(),
    cancelAtPeriodEnd: t.boolean().default(false),
    ...withTimestamps,
  }),
  (t) => [index().on(t.stripeCustomerId), index().on(t.stripeSubscriptionId)],
);

export const billingAccountRelations = relations(billingAccount, ({ one }) => ({
  organization: one(organization, {
    fields: [billingAccount.organizationId],
    references: [organization.id],
  }),
}));

// #endregion ========== Billing ==========
