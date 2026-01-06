import {
  pgTable,
  timestamp,
  text,
  uniqueIndex,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { typeid } from "typeid-js";
import { relations } from "drizzle-orm";
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

export const account = pgTable("account", (t) => ({
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

export const accountRelations = relations(account, ({ one, many }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
  instanceAccountPermissions: many(instanceAccountPermission),
}));

export const verification = pgTable("verification", (t) => ({
  id: iterateId("ver"),
  identifier: t.text().notNull(),
  value: t.text().notNull(),
  expiresAt: t.timestamp().notNull(),
  ...withTimestamps,
}));
// #endregion ========== Better Auth Schema ==========

// #region ========== Organization & Instance ==========
export const organization = pgTable("organization", (t) => ({
  id: iterateId("org"),
  name: t.text().notNull(),
  slug: t.text().notNull().unique(), // URL-safe slug
  ...withTimestamps,
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  instances: many(instance),
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

// Instance (renamed from estate)
export const instance = pgTable("instance", (t) => ({
  id: iterateId("inst"),
  name: t.text().notNull(),
  slug: t.text().notNull(), // URL-safe slug (unique within org)
  organizationId: t
    .text()
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  ...withTimestamps,
}), (t) => [
  uniqueIndex().on(t.organizationId, t.slug),
]);

export const instanceRelations = relations(instance, ({ one, many }) => ({
  organization: one(organization, {
    fields: [instance.organizationId],
    references: [organization.id],
  }),
  instanceAccountPermissions: many(instanceAccountPermission),
  events: many(event),
  machines: many(machine),
  repos: many(repo),
}));

// Instance Account Permission (renamed from estate_accounts_permissions)
export const instanceAccountPermission = pgTable(
  "instance_account_permission",
  (t) => ({
    id: iterateId("iap"),
    instanceId: t
      .text()
      .notNull()
      .references(() => instance.id, { onDelete: "cascade" }),
    accountId: t
      .text()
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.instanceId, t.accountId)],
);

export const instanceAccountPermissionRelations = relations(
  instanceAccountPermission,
  ({ one }) => ({
    instance: one(instance, {
      fields: [instanceAccountPermission.instanceId],
      references: [instance.id],
    }),
    account: one(account, {
      fields: [instanceAccountPermission.accountId],
      references: [account.id],
    }),
  }),
);
// #endregion ========== Organization & Instance ==========

// #region ========== Machine ==========
export const machine = pgTable(
  "machine",
  (t) => ({
    id: iterateId("mach"),
    instanceId: t
      .text()
      .notNull()
      .references(() => instance.id, { onDelete: "cascade" }),
    name: t.text().notNull(),
    type: t.text({ enum: [...MachineType] }).notNull().default("daytona"),
    state: t.text({ enum: [...MachineState] }).notNull().default("started"),
    metadata: jsonb().$type<Record<string, unknown>>().default({}).notNull(),
    ...withTimestamps,
  }),
  (t) => [
    index().on(t.instanceId),
    index().on(t.state),
  ],
);

export const machineRelations = relations(machine, ({ one }) => ({
  instance: one(instance, {
    fields: [machine.instanceId],
    references: [instance.id],
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
    instanceId: t
      .text()
      .notNull()
      .references(() => instance.id, { onDelete: "cascade" }),
    ...withTimestamps,
  }),
  (t) => [
    index().on(t.instanceId),
    index().on(t.type),
  ],
);

export const eventRelations = relations(event, ({ one }) => ({
  instance: one(instance, {
    fields: [event.instanceId],
    references: [instance.id],
  }),
}));
// #endregion ========== Events ==========

// #region ========== Repo (simplified iterateConfigSource) ==========
export const repo = pgTable(
  "repo",
  (t) => ({
    id: iterateId("repo"),
    instanceId: t
      .text()
      .notNull()
      .references(() => instance.id, { onDelete: "cascade" }),
    provider: t.text({ enum: ["github"] }).notNull(),
    accountId: t.text().notNull(),
    repoId: t.integer().notNull(),
    branch: t.text().notNull(),
    deactivatedAt: t.timestamp(),
    ...withTimestamps,
  }),
  (t) => [index().on(t.instanceId)],
);

export const repoRelations = relations(repo, ({ one }) => ({
  instance: one(instance, {
    fields: [repo.instanceId],
    references: [instance.id],
  }),
}));
// #endregion ========== Repo ==========
