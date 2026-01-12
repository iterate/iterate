import { pgTable, timestamp, text, uniqueIndex, jsonb, index } from "drizzle-orm/pg-core";
import { typeid } from "typeid-js";
import { relations, sql } from "drizzle-orm";
import type { SlackEvent } from "@slack/web-api";

// Organization roles: owner, admin, member (simplified from OS)
export const UserRole = ["member", "admin", "owner"] as const;
export type UserRole = (typeof UserRole)[number];

// Machine states
export const MachineState = ["started", "archived"] as const;
export type MachineState = (typeof MachineState)[number];

// Machine types
export const MachineType = ["daytona"] as const;
export type MachineType = (typeof MachineType)[number];

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
export const organization = pgTable("organization", (t) => ({
  id: iterateId("org"),
  name: t.text().notNull(),
  slug: t.text().notNull().unique(), // URL-safe slug
  ...withTimestamps,
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  projects: many(project),
  members: many(organizationUserMembership),
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

// Project (renamed from instance/estate)
export const project = pgTable(
  "project",
  (t) => ({
    id: iterateId("prj"),
    name: t.text().notNull(),
    slug: t.text().notNull(), // URL-safe slug (unique within org)
    organizationId: t
      .text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.organizationId, t.slug)],
);

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  events: many(event),
  machines: many(machine),
  projectRepo: one(projectRepo),
  envVars: many(projectEnvVar),
  accessTokens: many(projectAccessToken),
  connections: many(projectConnection),
}));

// Encrypted environment variables for a project
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
    encryptedValue: t.text().notNull(),
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

// API access tokens for a project
export const projectAccessToken = pgTable(
  "project_access_token",
  (t) => ({
    id: iterateId("pat"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: t.text().notNull(),
    tokenHash: t.text().notNull(),
    lastUsedAt: t.timestamp(),
    revokedAt: t.timestamp(),
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
// Project-scoped: one connection per provider per project (e.g., Slack workspace)
// User-scoped: one connection per provider per user per project (e.g., Gmail account)
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
  (t) => [
    // For project-scoped connections: ensure provider+externalId is unique globally
    // (e.g., a Slack workspace can only be connected to one project)
    uniqueIndex("project_connection_provider_external_id_idx")
      .on(t.provider, t.externalId)
      .where(sql`scope = 'project'`),
    // For user-scoped connections: ensure each user can only have one connection
    // per provider per project
    uniqueIndex("project_connection_user_provider_project_idx")
      .on(t.projectId, t.provider, t.userId)
      .where(sql`scope = 'user'`),
    index().on(t.projectId),
    index().on(t.userId),
  ],
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
      .default("started"),
    externalId: t.text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    ...withTimestamps,
  }),
  (t) => [index().on(t.projectId), index().on(t.state)],
);

export const machineRelations = relations(machine, ({ one }) => ({
  project: one(project, {
    fields: [machine.projectId],
    references: [project.id],
  }),
}));
// #endregion ========== Machine ==========

// #region ========== Events (unified) ==========
export const event = pgTable(
  "event",
  (t) => ({
    id: iterateId("evt"),
    type: t.text().notNull(), // e.g., "slack.message", "slack.reaction_added"
    payload: t.jsonb().$type<SlackEvent | Record<string, unknown>>().notNull(),
    projectId: t.text().references(() => project.id, { onDelete: "cascade" }),
    ...withTimestamps,
  }),
  (t) => [index().on(t.projectId), index().on(t.type)],
);

export const eventRelations = relations(event, ({ one }) => ({
  project: one(project, {
    fields: [event.projectId],
    references: [project.id],
  }),
}));
// #endregion ========== Events ==========

// #region ========== Project Repo (simplified iterateConfigSource) ==========
export const projectRepo = pgTable("project_repo", (t) => ({
  id: iterateId("repo"),
  projectId: t
    .text()
    .notNull()
    .unique()
    .references(() => project.id, { onDelete: "cascade" }),
  provider: t.text().notNull(),
  externalId: t.text().notNull(),
  owner: t.text().notNull(),
  name: t.text().notNull(),
  defaultBranch: t.text().notNull().default("main"),
  ...withTimestamps,
}));

export const projectRepoRelations = relations(projectRepo, ({ one }) => ({
  project: one(project, {
    fields: [projectRepo.projectId],
    references: [project.id],
  }),
}));
// #endregion ========== Project Repo ==========
