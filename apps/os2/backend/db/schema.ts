import { pgTable, timestamp, text, uniqueIndex, jsonb, index } from "drizzle-orm/pg-core";
import { typeid } from "typeid-js";
import { relations } from "drizzle-orm";

export const UserRole = ["member", "admin", "owner"] as const;
export type UserRole = (typeof UserRole)[number];

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

export const user = pgTable("user", (t) => ({
  id: iterateId("usr"),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  emailVerified: t.boolean().default(false).notNull(),
  image: t.text(),
  role: t.text().default("user"),
  debugMode: t.boolean().default(false),
  banned: t.boolean(),
  banReason: t.text(),
  banExpires: t.timestamp(),
  ...withTimestamps,
}));
export const userRelations = relations(user, ({ many }) => ({
  session: many(session),
  account: many(account),
  organizationUserMembership: many(organizationUserMembership),
}));

export const session = pgTable("session", (t) => ({
  id: iterateId("ses"),
  expiresAt: t.timestamp().notNull(),
  token: t.text().notNull().unique(),
  ipAddress: t.text(),
  userAgent: t.text(),
  userId: t
    .text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: t.text().references(() => user.id, { onDelete: "cascade" }),
  ...withTimestamps,
}));
export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const account = pgTable("account", (t) => ({
  id: iterateId("acc"),
  accountId: t.text().notNull(),
  providerId: t.text().notNull(),
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
export const accountRelations = relations(account, ({ one, many }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
  projectAccountPermissions: many(projectAccountPermission),
}));

export const verification = pgTable("verification", (t) => ({
  id: iterateId("ver"),
  identifier: t.text().notNull(),
  value: t.text().notNull(),
  expiresAt: t.timestamp().notNull(),
  ...withTimestamps,
}));

export const organization = pgTable("organization", (t) => ({
  id: iterateId("org"),
  name: t.text().notNull(),
  slug: t.text().notNull().unique(),
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

export const project = pgTable("project", (t) => ({
  id: iterateId("proj"),
  name: t.text().notNull(),
  slug: t.text().notNull(),
  organizationId: t
    .text()
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  ...withTimestamps,
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  projectAccountPermissions: many(projectAccountPermission),
  events: many(event),
  machines: many(machine),
  repos: many(repo),
}));

export const projectAccountPermission = pgTable(
  "project_account_permission",
  (t) => ({
    id: iterateId("pap"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    accountId: t
      .text()
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.projectId, t.accountId)],
);
export const projectAccountPermissionRelations = relations(projectAccountPermission, ({ one }) => ({
  project: one(project, {
    fields: [projectAccountPermission.projectId],
    references: [project.id],
  }),
  account: one(account, {
    fields: [projectAccountPermission.accountId],
    references: [account.id],
  }),
}));

export const MachineState = ["started", "archived"] as const;
export type MachineState = (typeof MachineState)[number];

export const MachineType = ["daytona"] as const;
export type MachineType = (typeof MachineType)[number];

export const machine = pgTable(
  "machine",
  (t) => ({
    id: iterateId("mach"),
    name: t.text().notNull(),
    type: t
      .text({ enum: [...MachineType] })
      .notNull()
      .default("daytona"),
    state: t
      .text({ enum: [...MachineState] })
      .notNull()
      .default("started"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
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

export const event = pgTable(
  "event",
  (t) => ({
    id: iterateId("evt"),
    type: t.text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
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

export const repo = pgTable(
  "repo",
  (t) => ({
    id: iterateId("repo"),
    projectId: t
      .text()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    provider: t.text({ enum: ["github"] }).notNull(),
    repoId: t.integer().notNull(),
    branch: t.text().notNull(),
    deactivatedAt: t.timestamp(),
    ...withTimestamps,
  }),
  (t) => [index().on(t.projectId)],
);
export const repoRelations = relations(repo, ({ one }) => ({
  project: one(project, {
    fields: [repo.projectId],
    references: [project.id],
  }),
}));
