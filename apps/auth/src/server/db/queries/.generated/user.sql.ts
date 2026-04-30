import type { Client } from "sqlfu";

const getUserByIdSql = `
SELECT id,
  name,
  email,
  emailVerified,
  image,
  role,
  banned,
  banReason,
  banExpires,
  createdAt,
  updatedAt
FROM user
WHERE id = ?
LIMIT 1;
`.trim();
const getUserByIdQuery = (params: getUserById.Params) => ({
  sql: getUserByIdSql,
  args: [params.id],
  name: "getUserById",
});

export const getUserById = Object.assign(
  async function getUserById(
    client: Client,
    params: getUserById.Params,
  ): Promise<getUserById.Result | null> {
    const rows = await client.all<getUserById.Result>(getUserByIdQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getUserByIdSql, query: getUserByIdQuery },
);

export namespace getUserById {
  export type Params = {
    id: string;
  };
  export type Result = {
    id: string;
    name: string;
    email: string;
    emailVerified: number;
    image?: string;
    role?: string;
    banned?: number;
    banReason?: string;
    banExpires?: number;
    createdAt: number;
    updatedAt: number;
  };
}

const getUserByEmailSql = `
SELECT id,
  name,
  email,
  emailVerified,
  image,
  role,
  banned,
  banReason,
  banExpires,
  createdAt,
  updatedAt
FROM user
WHERE email = ?
LIMIT 1;
`.trim();
const getUserByEmailQuery = (params: getUserByEmail.Params) => ({
  sql: getUserByEmailSql,
  args: [params.email],
  name: "getUserByEmail",
});

export const getUserByEmail = Object.assign(
  async function getUserByEmail(
    client: Client,
    params: getUserByEmail.Params,
  ): Promise<getUserByEmail.Result | null> {
    const rows = await client.all<getUserByEmail.Result>(getUserByEmailQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getUserByEmailSql, query: getUserByEmailQuery },
);

export namespace getUserByEmail {
  export type Params = {
    email: string;
  };
  export type Result = {
    id: string;
    name: string;
    email: string;
    emailVerified: number;
    image?: string;
    role?: string;
    banned?: number;
    banReason?: string;
    banExpires?: number;
    createdAt: number;
    updatedAt: number;
  };
}

const updateVerifiedUserByIdSql = `
UPDATE user
SET name = ?,
  image = ?,
  emailVerified = 1,
  updatedAt = ?
WHERE id = ?;
`.trim();
const updateVerifiedUserByIdQuery = (
  data: updateVerifiedUserById.Data,
  params: updateVerifiedUserById.Params,
) => ({
  sql: updateVerifiedUserByIdSql,
  args: [data.name, data.image, data.updatedAt, params.id],
  name: "updateVerifiedUserById",
});

export const updateVerifiedUserById = Object.assign(
  async function updateVerifiedUserById(
    client: Client,
    data: updateVerifiedUserById.Data,
    params: updateVerifiedUserById.Params,
  ) {
    return client.run(updateVerifiedUserByIdQuery(data, params));
  },
  { sql: updateVerifiedUserByIdSql, query: updateVerifiedUserByIdQuery },
);

export namespace updateVerifiedUserById {
  export type Data = {
    name: string;
    image: string | null;
    updatedAt: number;
  };
  export type Params = {
    id: string;
  };
}

const insertUserSql = `
INSERT INTO user (
  id,
  name,
  email,
  emailVerified,
  image,
  role,
  createdAt,
  updatedAt
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
const insertUserQuery = (params: insertUser.Params) => ({
  sql: insertUserSql,
  args: [
    params.id,
    params.name,
    params.email,
    params.emailVerified,
    params.image,
    params.role,
    params.createdAt,
    params.updatedAt,
  ],
  name: "insertUser",
});

export const insertUser = Object.assign(
  async function insertUser(client: Client, params: insertUser.Params) {
    return client.run(insertUserQuery(params));
  },
  { sql: insertUserSql, query: insertUserQuery },
);

export namespace insertUser {
  export type Params = {
    id: string;
    name: string;
    email: string;
    emailVerified: number;
    image: string | null;
    role: string | null;
    createdAt: number;
    updatedAt: number;
  };
}

const listOrganizationsForUserSql = `
SELECT o.id,
  o.name,
  o.slug,
  m.role
FROM member m
JOIN organization o ON o.id = m.organizationId
WHERE m.userId = ?
ORDER BY o.createdAt ASC,
  o.slug ASC;
`.trim();
const listOrganizationsForUserQuery = (params: listOrganizationsForUser.Params) => ({
  sql: listOrganizationsForUserSql,
  args: [params.userId],
  name: "listOrganizationsForUser",
});

export const listOrganizationsForUser = Object.assign(
  async function listOrganizationsForUser(
    client: Client,
    params: listOrganizationsForUser.Params,
  ): Promise<listOrganizationsForUser.Result[]> {
    return client.all<listOrganizationsForUser.Result>(listOrganizationsForUserQuery(params));
  },
  { sql: listOrganizationsForUserSql, query: listOrganizationsForUserQuery },
);

export namespace listOrganizationsForUser {
  export type Params = {
    userId: string;
  };
  export type Result = {
    id: string;
    name: string;
    slug: string;
    role: string;
  };
}
