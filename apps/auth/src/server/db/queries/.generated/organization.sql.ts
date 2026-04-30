import type { Client } from "sqlfu";

const getOrganizationBySlugSql = `
SELECT id, name, slug
FROM organization
WHERE slug = ?
LIMIT 1;
`.trim();
const getOrganizationBySlugQuery = (params: getOrganizationBySlug.Params) => ({
  sql: getOrganizationBySlugSql,
  args: [params.slug],
  name: "getOrganizationBySlug",
});

export const getOrganizationBySlug = Object.assign(
  async function getOrganizationBySlug(
    client: Client,
    params: getOrganizationBySlug.Params,
  ): Promise<getOrganizationBySlug.Result | null> {
    const rows = await client.all<getOrganizationBySlug.Result>(getOrganizationBySlugQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getOrganizationBySlugSql, query: getOrganizationBySlugQuery },
);

export namespace getOrganizationBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    id: string;
    name: string;
    slug: string;
  };
}

const insertOrganizationSql = `
INSERT INTO organization (id, name, slug, logo, createdAt, metadata)
VALUES (?, ?, ?, ?, ?, ?);
`.trim();
const insertOrganizationQuery = (params: insertOrganization.Params) => ({
  sql: insertOrganizationSql,
  args: [params.id, params.name, params.slug, params.logo, params.createdAt, params.metadata],
  name: "insertOrganization",
});

export const insertOrganization = Object.assign(
  async function insertOrganization(client: Client, params: insertOrganization.Params) {
    return client.run(insertOrganizationQuery(params));
  },
  { sql: insertOrganizationSql, query: insertOrganizationQuery },
);

export namespace insertOrganization {
  export type Params = {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    createdAt: number;
    metadata: string | null;
  };
}

const updateOrganizationNameByIdSql = `
UPDATE organization
SET name = ?
WHERE id = ?;
`.trim();
const updateOrganizationNameByIdQuery = (
  data: updateOrganizationNameById.Data,
  params: updateOrganizationNameById.Params,
) => ({
  sql: updateOrganizationNameByIdSql,
  args: [data.name, params.id],
  name: "updateOrganizationNameById",
});

export const updateOrganizationNameById = Object.assign(
  async function updateOrganizationNameById(
    client: Client,
    data: updateOrganizationNameById.Data,
    params: updateOrganizationNameById.Params,
  ) {
    return client.run(updateOrganizationNameByIdQuery(data, params));
  },
  { sql: updateOrganizationNameByIdSql, query: updateOrganizationNameByIdQuery },
);

export namespace updateOrganizationNameById {
  export type Data = {
    name: string;
  };
  export type Params = {
    id: string;
  };
}

const deleteOrganizationByIdSql = `
DELETE FROM organization
WHERE id = ?;
`.trim();
const deleteOrganizationByIdQuery = (params: deleteOrganizationById.Params) => ({
  sql: deleteOrganizationByIdSql,
  args: [params.id],
  name: "deleteOrganizationById",
});

export const deleteOrganizationById = Object.assign(
  async function deleteOrganizationById(client: Client, params: deleteOrganizationById.Params) {
    return client.run(deleteOrganizationByIdQuery(params));
  },
  { sql: deleteOrganizationByIdSql, query: deleteOrganizationByIdQuery },
);

export namespace deleteOrganizationById {
  export type Params = {
    id: string;
  };
}

const getMembershipByOrganizationAndUserIdSql = `
SELECT id, organizationId, userId, role
FROM member
WHERE organizationId = ?
  AND userId = ?
LIMIT 1;
`.trim();
const getMembershipByOrganizationAndUserIdQuery = (
  params: getMembershipByOrganizationAndUserId.Params,
) => ({
  sql: getMembershipByOrganizationAndUserIdSql,
  args: [params.organizationId, params.userId],
  name: "getMembershipByOrganizationAndUserId",
});

export const getMembershipByOrganizationAndUserId = Object.assign(
  async function getMembershipByOrganizationAndUserId(
    client: Client,
    params: getMembershipByOrganizationAndUserId.Params,
  ): Promise<getMembershipByOrganizationAndUserId.Result | null> {
    const rows = await client.all<getMembershipByOrganizationAndUserId.Result>(
      getMembershipByOrganizationAndUserIdQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  {
    sql: getMembershipByOrganizationAndUserIdSql,
    query: getMembershipByOrganizationAndUserIdQuery,
  },
);

export namespace getMembershipByOrganizationAndUserId {
  export type Params = {
    organizationId: string;
    userId: string;
  };
  export type Result = {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  };
}

const insertMembershipSql = `
INSERT INTO member (id, organizationId, userId, role, createdAt)
VALUES (?, ?, ?, ?, ?);
`.trim();
const insertMembershipQuery = (params: insertMembership.Params) => ({
  sql: insertMembershipSql,
  args: [params.id, params.organizationId, params.userId, params.role, params.createdAt],
  name: "insertMembership",
});

export const insertMembership = Object.assign(
  async function insertMembership(client: Client, params: insertMembership.Params) {
    return client.run(insertMembershipQuery(params));
  },
  { sql: insertMembershipSql, query: insertMembershipQuery },
);

export namespace insertMembership {
  export type Params = {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
    createdAt: number;
  };
}

const updateMembershipRoleByOrganizationAndUserIdSql = `
UPDATE member
SET role = ?
WHERE organizationId = ?
  AND userId = ?;
`.trim();
const updateMembershipRoleByOrganizationAndUserIdQuery = (
  data: updateMembershipRoleByOrganizationAndUserId.Data,
  params: updateMembershipRoleByOrganizationAndUserId.Params,
) => ({
  sql: updateMembershipRoleByOrganizationAndUserIdSql,
  args: [data.role, params.organizationId, params.userId],
  name: "updateMembershipRoleByOrganizationAndUserId",
});

export const updateMembershipRoleByOrganizationAndUserId = Object.assign(
  async function updateMembershipRoleByOrganizationAndUserId(
    client: Client,
    data: updateMembershipRoleByOrganizationAndUserId.Data,
    params: updateMembershipRoleByOrganizationAndUserId.Params,
  ) {
    return client.run(updateMembershipRoleByOrganizationAndUserIdQuery(data, params));
  },
  {
    sql: updateMembershipRoleByOrganizationAndUserIdSql,
    query: updateMembershipRoleByOrganizationAndUserIdQuery,
  },
);

export namespace updateMembershipRoleByOrganizationAndUserId {
  export type Data = {
    role: string;
  };
  export type Params = {
    organizationId: string;
    userId: string;
  };
}

const deleteMembershipByOrganizationAndUserIdSql = `
DELETE FROM member
WHERE organizationId = ?
  AND userId = ?;
`.trim();
const deleteMembershipByOrganizationAndUserIdQuery = (
  params: deleteMembershipByOrganizationAndUserId.Params,
) => ({
  sql: deleteMembershipByOrganizationAndUserIdSql,
  args: [params.organizationId, params.userId],
  name: "deleteMembershipByOrganizationAndUserId",
});

export const deleteMembershipByOrganizationAndUserId = Object.assign(
  async function deleteMembershipByOrganizationAndUserId(
    client: Client,
    params: deleteMembershipByOrganizationAndUserId.Params,
  ) {
    return client.run(deleteMembershipByOrganizationAndUserIdQuery(params));
  },
  {
    sql: deleteMembershipByOrganizationAndUserIdSql,
    query: deleteMembershipByOrganizationAndUserIdQuery,
  },
);

export namespace deleteMembershipByOrganizationAndUserId {
  export type Params = {
    organizationId: string;
    userId: string;
  };
}

const listMembersByOrganizationIdSql = `
SELECT m.id,
  m.userId,
  m.role,
  u.name AS userName,
  u.email AS userEmail,
  u.image AS userImage,
  u.role AS userRole
FROM member m
JOIN user u ON u.id = m.userId
WHERE m.organizationId = ?
ORDER BY m.createdAt ASC,
  u.email ASC;
`.trim();
const listMembersByOrganizationIdQuery = (params: listMembersByOrganizationId.Params) => ({
  sql: listMembersByOrganizationIdSql,
  args: [params.organizationId],
  name: "listMembersByOrganizationId",
});

export const listMembersByOrganizationId = Object.assign(
  async function listMembersByOrganizationId(
    client: Client,
    params: listMembersByOrganizationId.Params,
  ): Promise<listMembersByOrganizationId.Result[]> {
    return client.all<listMembersByOrganizationId.Result>(listMembersByOrganizationIdQuery(params));
  },
  { sql: listMembersByOrganizationIdSql, query: listMembersByOrganizationIdQuery },
);

export namespace listMembersByOrganizationId {
  export type Params = {
    organizationId: string;
  };
  export type Result = {
    id: string;
    userId: string;
    role: string;
    userName: string;
    userEmail: string;
    userImage?: string;
    userRole: string;
  };
}

const getOrganizationMemberPresenceByEmailSql = `
SELECT 1 AS present
FROM member m
JOIN user u ON u.id = m.userId
WHERE m.organizationId = ?
  AND u.email = ?
LIMIT 1;
`.trim();
const getOrganizationMemberPresenceByEmailQuery = (
  params: getOrganizationMemberPresenceByEmail.Params,
) => ({
  sql: getOrganizationMemberPresenceByEmailSql,
  args: [params.organizationId, params.email],
  name: "getOrganizationMemberPresenceByEmail",
});

export const getOrganizationMemberPresenceByEmail = Object.assign(
  async function getOrganizationMemberPresenceByEmail(
    client: Client,
    params: getOrganizationMemberPresenceByEmail.Params,
  ): Promise<getOrganizationMemberPresenceByEmail.Result | null> {
    const rows = await client.all<getOrganizationMemberPresenceByEmail.Result>(
      getOrganizationMemberPresenceByEmailQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  {
    sql: getOrganizationMemberPresenceByEmailSql,
    query: getOrganizationMemberPresenceByEmailQuery,
  },
);

export namespace getOrganizationMemberPresenceByEmail {
  export type Params = {
    organizationId: string;
    email: string;
  };
  export type Result = {
    present: number;
  };
}

const getInviteByOrganizationAndEmailSql = `
SELECT id
FROM invitation
WHERE organizationId = ?
  AND email = ?
LIMIT 1;
`.trim();
const getInviteByOrganizationAndEmailQuery = (params: getInviteByOrganizationAndEmail.Params) => ({
  sql: getInviteByOrganizationAndEmailSql,
  args: [params.organizationId, params.email],
  name: "getInviteByOrganizationAndEmail",
});

export const getInviteByOrganizationAndEmail = Object.assign(
  async function getInviteByOrganizationAndEmail(
    client: Client,
    params: getInviteByOrganizationAndEmail.Params,
  ): Promise<getInviteByOrganizationAndEmail.Result | null> {
    const rows = await client.all<getInviteByOrganizationAndEmail.Result>(
      getInviteByOrganizationAndEmailQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getInviteByOrganizationAndEmailSql, query: getInviteByOrganizationAndEmailQuery },
);

export namespace getInviteByOrganizationAndEmail {
  export type Params = {
    organizationId: string;
    email: string;
  };
  export type Result = {
    id: string;
  };
}

const insertInviteSql = `
INSERT INTO invitation (
  id,
  organizationId,
  email,
  role,
  status,
  expiresAt,
  createdAt,
  inviterId
)
VALUES (
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
);
`.trim();
const insertInviteQuery = (params: insertInvite.Params) => ({
  sql: insertInviteSql,
  args: [
    params.id,
    params.organizationId,
    params.email,
    params.role,
    params.status,
    params.expiresAt,
    params.createdAt,
    params.inviterId,
  ],
  name: "insertInvite",
});

export const insertInvite = Object.assign(
  async function insertInvite(client: Client, params: insertInvite.Params) {
    return client.run(insertInviteQuery(params));
  },
  { sql: insertInviteSql, query: insertInviteQuery },
);

export namespace insertInvite {
  export type Params = {
    id: string;
    organizationId: string;
    email: string;
    role: string | null;
    status: string;
    expiresAt: number;
    createdAt: number;
    inviterId: string;
  };
}

const listInvitesByOrganizationIdSql = `
SELECT i.id,
  i.email,
  i.role,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug,
  u.id AS inviterId,
  u.name AS inviterName,
  u.email AS inviterEmail
FROM invitation i
JOIN organization o ON o.id = i.organizationId
JOIN user u ON u.id = i.inviterId
WHERE i.organizationId = ?
ORDER BY i.createdAt DESC,
  i.email ASC;
`.trim();
const listInvitesByOrganizationIdQuery = (params: listInvitesByOrganizationId.Params) => ({
  sql: listInvitesByOrganizationIdSql,
  args: [params.organizationId],
  name: "listInvitesByOrganizationId",
});

export const listInvitesByOrganizationId = Object.assign(
  async function listInvitesByOrganizationId(
    client: Client,
    params: listInvitesByOrganizationId.Params,
  ): Promise<listInvitesByOrganizationId.Result[]> {
    return client.all<listInvitesByOrganizationId.Result>(listInvitesByOrganizationIdQuery(params));
  },
  { sql: listInvitesByOrganizationIdSql, query: listInvitesByOrganizationIdQuery },
);

export namespace listInvitesByOrganizationId {
  export type Params = {
    organizationId: string;
  };
  export type Result = {
    id: string;
    email: string;
    role?: string;
    organizationRecordId: string;
    organizationName: string;
    organizationSlug: string;
    inviterId: string;
    inviterName: string;
    inviterEmail: string;
  };
}

const deleteInviteByIdAndOrganizationIdSql = `
DELETE FROM invitation
WHERE id = ?
  AND organizationId = ?;
`.trim();
const deleteInviteByIdAndOrganizationIdQuery = (
  params: deleteInviteByIdAndOrganizationId.Params,
) => ({
  sql: deleteInviteByIdAndOrganizationIdSql,
  args: [params.id, params.organizationId],
  name: "deleteInviteByIdAndOrganizationId",
});

export const deleteInviteByIdAndOrganizationId = Object.assign(
  async function deleteInviteByIdAndOrganizationId(
    client: Client,
    params: deleteInviteByIdAndOrganizationId.Params,
  ) {
    return client.run(deleteInviteByIdAndOrganizationIdQuery(params));
  },
  { sql: deleteInviteByIdAndOrganizationIdSql, query: deleteInviteByIdAndOrganizationIdQuery },
);

export namespace deleteInviteByIdAndOrganizationId {
  export type Params = {
    id: string;
    organizationId: string;
  };
}

const listPendingInvitesByEmailSql = `
SELECT i.id,
  i.email,
  i.role,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug,
  u.id AS inviterId,
  u.name AS inviterName,
  u.email AS inviterEmail
FROM invitation i
JOIN organization o ON o.id = i.organizationId
JOIN user u ON u.id = i.inviterId
WHERE i.email = ?
  AND i.status = 'pending'
ORDER BY i.createdAt DESC,
  i.id ASC;
`.trim();
const listPendingInvitesByEmailQuery = (params: listPendingInvitesByEmail.Params) => ({
  sql: listPendingInvitesByEmailSql,
  args: [params.email],
  name: "listPendingInvitesByEmail",
});

export const listPendingInvitesByEmail = Object.assign(
  async function listPendingInvitesByEmail(
    client: Client,
    params: listPendingInvitesByEmail.Params,
  ): Promise<listPendingInvitesByEmail.Result[]> {
    return client.all<listPendingInvitesByEmail.Result>(listPendingInvitesByEmailQuery(params));
  },
  { sql: listPendingInvitesByEmailSql, query: listPendingInvitesByEmailQuery },
);

export namespace listPendingInvitesByEmail {
  export type Params = {
    email: string;
  };
  export type Result = {
    id: string;
    email: string;
    role?: string;
    organizationRecordId: string;
    organizationName: string;
    organizationSlug: string;
    inviterId: string;
    inviterName: string;
    inviterEmail: string;
  };
}

const getPendingInviteByIdAndEmailSql = `
SELECT i.id,
  i.email,
  i.role,
  i.organizationId,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug
FROM invitation i
JOIN organization o ON o.id = i.organizationId
WHERE i.id = ?
  AND i.email = ?
  AND i.status = 'pending'
LIMIT 1;
`.trim();
const getPendingInviteByIdAndEmailQuery = (params: getPendingInviteByIdAndEmail.Params) => ({
  sql: getPendingInviteByIdAndEmailSql,
  args: [params.id, params.email],
  name: "getPendingInviteByIdAndEmail",
});

export const getPendingInviteByIdAndEmail = Object.assign(
  async function getPendingInviteByIdAndEmail(
    client: Client,
    params: getPendingInviteByIdAndEmail.Params,
  ): Promise<getPendingInviteByIdAndEmail.Result | null> {
    const rows = await client.all<getPendingInviteByIdAndEmail.Result>(
      getPendingInviteByIdAndEmailQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getPendingInviteByIdAndEmailSql, query: getPendingInviteByIdAndEmailQuery },
);

export namespace getPendingInviteByIdAndEmail {
  export type Params = {
    id: string;
    email: string;
  };
  export type Result = {
    id: string;
    email: string;
    role?: string;
    organizationId: string;
    organizationRecordId: string;
    organizationName: string;
    organizationSlug: string;
  };
}

const updateInviteStatusByIdSql = `
UPDATE invitation
SET status = ?
WHERE id = ?;
`.trim();
const updateInviteStatusByIdQuery = (
  data: updateInviteStatusById.Data,
  params: updateInviteStatusById.Params,
) => ({
  sql: updateInviteStatusByIdSql,
  args: [data.status, params.id],
  name: "updateInviteStatusById",
});

export const updateInviteStatusById = Object.assign(
  async function updateInviteStatusById(
    client: Client,
    data: updateInviteStatusById.Data,
    params: updateInviteStatusById.Params,
  ) {
    return client.run(updateInviteStatusByIdQuery(data, params));
  },
  { sql: updateInviteStatusByIdSql, query: updateInviteStatusByIdQuery },
);

export namespace updateInviteStatusById {
  export type Data = {
    status: string;
  };
  export type Params = {
    id: string;
  };
}
