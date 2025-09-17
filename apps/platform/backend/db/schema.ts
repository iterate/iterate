import { pgTable, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";
import { typeid } from "typeid-js";
import { relations } from "drizzle-orm";

export const withTimestamps = {
  createdAt: timestamp().defaultNow().notNull(),
  updatedAt: timestamp()
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
};

export const iterateId = <P extends string>(prefix: P) =>
  text()
    // .$type<`${P}_${string}`>() // TODO: Uncomment this when we have a zod validator
    .primaryKey()
    .$defaultFn(() => typeid(prefix).toString() as `${P}_${string}`);

// #region ========== Better Auth Schema ==========
export const user = pgTable("user", (t) => ({
  id: iterateId("usr"),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  emailVerified: t.boolean().default(false).notNull(),
  image: t.text(),
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
  userId: t.text().notNull(),
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
  userId: t.text().notNull(),
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
  estateAccountsPermissions: many(estateAccountsPermissions),
}));

export const verification = pgTable("verification", (t) => ({
  id: iterateId("ver"),
  identifier: t.text().notNull(),
  value: t.text().notNull(),
  expiresAt: t.timestamp().notNull(),
  ...withTimestamps,
}));

// #endregion ========== Better Auth Schema ==========

export const files = pgTable("files", (t) => ({
  id: iterateId("file"),
  status: t
    .text({ enum: ["started", "completed", "error"] })
    .notNull()
    .default("started"),
  filename: t.text(),
  fileSize: t.integer(), // Size in bytes
  mimeType: t.text(),
  openAIFileId: t.text(),
  estateId: t.text(),
  ...withTimestamps,
}));
export const filesRelations = relations(files, ({ one }) => ({
  estate: one(estate, {
    fields: [files.estateId],
    references: [estate.id],
  }),
}));

export const estate = pgTable("estate", (t) => ({
  id: iterateId("est"),
  name: t.text().notNull(),
  organizationId: t.text().notNull(),
  ...withTimestamps,
}));

export const estateRelations = relations(estate, ({ one, many }) => ({
  organization: one(organization, {
    fields: [estate.organizationId],
    references: [organization.id],
  }),
  estateAccountsPermissions: many(estateAccountsPermissions),
  files: many(files),
}));

export const organization = pgTable("organization", (t) => ({
  id: iterateId("org"),
  name: t.text().notNull(),
  ...withTimestamps,
}));
export const organizationRelations = relations(organization, ({ many }) => ({
  estates: many(estate),
  members: many(organizationUserMembership),
}));

export const estateAccountsPermissions = pgTable(
  "estate_accounts_permissions",
  (t) => ({
    id: iterateId("eap"),
    estateId: t.text().notNull(),
    accountId: t.text().notNull(),
    ...withTimestamps,
  }),
  (t) => [uniqueIndex().on(t.estateId, t.accountId)],
);
export const estateAccountsPermissionsRelations = relations(
  estateAccountsPermissions,
  ({ one }) => ({
    estate: one(estate, {
      fields: [estateAccountsPermissions.estateId],
      references: [estate.id],
    }),
    account: one(account, {
      fields: [estateAccountsPermissions.accountId],
      references: [account.id],
    }),
  }),
);

export const organizationUserMembership = pgTable("organization_user_membership", (t) => ({
  id: iterateId("member"),
  organizationId: t.text().notNull(),
  userId: t.text().notNull(),
  role: t
    .text({ enum: ["member", "admin", "owner", "guest"] })
    .notNull()
    .default("member"),
  ...withTimestamps,
}));
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
