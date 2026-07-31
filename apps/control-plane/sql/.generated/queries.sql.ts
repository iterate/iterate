import type { Client } from "sqlfu";

const upsertUserSql = `
INSERT INTO users (id, email) VALUES (?, ?)
ON CONFLICT(id) DO UPDATE SET email = excluded.email
RETURNING id, email;
`.trim();
const upsertUserQuery = (params: upsertUser.Params) => ({
  name: "upsertUser",
  sql: upsertUserSql,
  args: [params.id, params.email],
});

export const upsertUser = Object.assign(
  async function upsertUser(client: Client, params: upsertUser.Params): Promise<upsertUser.Result> {
    const rows = await client.all<upsertUser.Result>(upsertUserQuery(params));
    return rows[0];
  },
  { sql: upsertUserSql, query: upsertUserQuery },
);

export namespace upsertUser {
  export type Params = {
    id: string;
    email: string;
  };
  export type Result = {
    id: string;
    email: string;
  };
}

const getUserByEmailSql = `SELECT id, email FROM users WHERE email = ?;`;
const getUserByEmailQuery = (params: getUserByEmail.Params) => ({
  name: "getUserByEmail",
  sql: getUserByEmailSql,
  args: [params.email],
});

export const getUserByEmail = Object.assign(
  async function getUserByEmail(
    client: Client,
    params: getUserByEmail.Params,
  ): Promise<getUserByEmail.Result[]> {
    return client.all<getUserByEmail.Result>(getUserByEmailQuery(params));
  },
  { sql: getUserByEmailSql, query: getUserByEmailQuery },
);

export namespace getUserByEmail {
  export type Params = {
    email: string;
  };
  export type Result = {
    id: string;
    email: string;
  };
}

const createProjectSql = `
INSERT INTO projects (id, slug) VALUES (?, ?)
ON CONFLICT(slug) DO NOTHING
RETURNING id, slug;
`.trim();
const createProjectQuery = (params: createProject.Params) => ({
  name: "createProject",
  sql: createProjectSql,
  args: [params.id, params.slug],
});

export const createProject = Object.assign(
  async function createProject(
    client: Client,
    params: createProject.Params,
  ): Promise<createProject.Result> {
    const rows = await client.all<createProject.Result>(createProjectQuery(params));
    return rows[0];
  },
  { sql: createProjectSql, query: createProjectQuery },
);

export namespace createProject {
  export type Params = {
    id: string;
    slug: string;
  };
  export type Result = {
    id: string;
    slug: string;
  };
}

const getProjectBySlugSql = `SELECT id, slug FROM projects WHERE slug = ?;`;
const getProjectBySlugQuery = (params: getProjectBySlug.Params) => ({
  name: "getProjectBySlug",
  sql: getProjectBySlugSql,
  args: [params.slug],
});

export const getProjectBySlug = Object.assign(
  async function getProjectBySlug(
    client: Client,
    params: getProjectBySlug.Params,
  ): Promise<getProjectBySlug.Result[]> {
    return client.all<getProjectBySlug.Result>(getProjectBySlugQuery(params));
  },
  { sql: getProjectBySlugSql, query: getProjectBySlugQuery },
);

export namespace getProjectBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    id: string;
    slug: string;
  };
}

const addMembershipSql = `
INSERT INTO memberships (project_id, user_id, role) VALUES (?, ?, ?)
ON CONFLICT(project_id, user_id) DO NOTHING;
`.trim();
const addMembershipQuery = (params: addMembership.Params) => ({
  name: "addMembership",
  sql: addMembershipSql,
  args: [params.projectId, params.userId, params.role],
});

export const addMembership = Object.assign(
  async function addMembership(client: Client, params: addMembership.Params) {
    return client.run(addMembershipQuery(params));
  },
  { sql: addMembershipSql, query: addMembershipQuery },
);

export namespace addMembership {
  export type Params = {
    projectId: string;
    userId: string;
    role: string;
  };
}

const listProjectsForUserSql = `
SELECT p.id, p.slug, m.role
FROM projects p
JOIN memberships m ON m.project_id = p.id
WHERE m.user_id = ?
ORDER BY p.slug ASC;
`.trim();
const listProjectsForUserQuery = (params: listProjectsForUser.Params) => ({
  name: "listProjectsForUser",
  sql: listProjectsForUserSql,
  args: [params.userId],
});

export const listProjectsForUser = Object.assign(
  async function listProjectsForUser(
    client: Client,
    params: listProjectsForUser.Params,
  ): Promise<listProjectsForUser.Result[]> {
    return client.all<listProjectsForUser.Result>(listProjectsForUserQuery(params));
  },
  { sql: listProjectsForUserSql, query: listProjectsForUserQuery },
);

export namespace listProjectsForUser {
  export type Params = {
    userId: string;
  };
  export type Result = {
    id: string;
    slug: string;
    role: string;
  };
}

const checkMembershipSql = `
SELECT role FROM memberships WHERE project_id = ? AND user_id = ?;
`.trim();
const checkMembershipQuery = (params: checkMembership.Params) => ({
  name: "checkMembership",
  sql: checkMembershipSql,
  args: [params.projectId, params.userId],
});

export const checkMembership = Object.assign(
  async function checkMembership(
    client: Client,
    params: checkMembership.Params,
  ): Promise<checkMembership.Result | null> {
    const rows = await client.all<checkMembership.Result>(checkMembershipQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: checkMembershipSql, query: checkMembershipQuery },
);

export namespace checkMembership {
  export type Params = {
    projectId: string;
    userId: string;
  };
  export type Result = {
    role: string;
  };
}

const resolveRouteSql = `SELECT project_id, app FROM routes WHERE host = ?;`;
const resolveRouteQuery = (params: resolveRoute.Params) => ({
  name: "resolveRoute",
  sql: resolveRouteSql,
  args: [params.host],
});

function resolveRouteMapResult(row: resolveRoute.RawResult): resolveRoute.Result {
  return {
    projectId: row.project_id,
    app: row.app,
  };
}

export const resolveRoute = Object.assign(
  async function resolveRoute(
    client: Client,
    params: resolveRoute.Params,
  ): Promise<resolveRoute.Result | null> {
    const rows = await client.all<resolveRoute.RawResult>(resolveRouteQuery(params));
    return rows.length > 0 ? resolveRouteMapResult(rows[0]!) : null;
  },
  { sql: resolveRouteSql, query: resolveRouteQuery, mapResult: resolveRouteMapResult },
);

export namespace resolveRoute {
  export type Params = {
    host: string;
  };
  export type RawResult = {
    project_id: string;
    app: string;
  };
  export type Result = {
    projectId: string;
    app: string;
  };
}

const upsertRouteSql = `
INSERT INTO routes (host, project_id, app) VALUES (?, ?, ?)
ON CONFLICT(host) DO UPDATE SET project_id = excluded.project_id, app = excluded.app;
`.trim();
const upsertRouteQuery = (params: upsertRoute.Params) => ({
  name: "upsertRoute",
  sql: upsertRouteSql,
  args: [params.host, params.projectId, params.app],
});

export const upsertRoute = Object.assign(
  async function upsertRoute(client: Client, params: upsertRoute.Params) {
    return client.run(upsertRouteQuery(params));
  },
  { sql: upsertRouteSql, query: upsertRouteQuery },
);

export namespace upsertRoute {
  export type Params = {
    host: string;
    projectId: string;
    app: string;
  };
}

const listRoutesForProjectSql = `
SELECT host, app FROM routes WHERE project_id = ? ORDER BY host ASC;
`.trim();
const listRoutesForProjectQuery = (params: listRoutesForProject.Params) => ({
  name: "listRoutesForProject",
  sql: listRoutesForProjectSql,
  args: [params.projectId],
});

export const listRoutesForProject = Object.assign(
  async function listRoutesForProject(
    client: Client,
    params: listRoutesForProject.Params,
  ): Promise<listRoutesForProject.Result[]> {
    return client.all<listRoutesForProject.Result>(listRoutesForProjectQuery(params));
  },
  { sql: listRoutesForProjectSql, query: listRoutesForProjectQuery },
);

export namespace listRoutesForProject {
  export type Params = {
    projectId: string;
  };
  export type Result = {
    host: string;
    app: string;
  };
}

const insertApiKeySql = `
INSERT INTO api_keys (hash, user_id, label, grants) VALUES (?, ?, ?, ?);
`.trim();
const insertApiKeyQuery = (params: insertApiKey.Params) => ({
  name: "insertApiKey",
  sql: insertApiKeySql,
  args: [params.hash, params.userId, params.label, params.grants],
});

export const insertApiKey = Object.assign(
  async function insertApiKey(client: Client, params: insertApiKey.Params) {
    return client.run(insertApiKeyQuery(params));
  },
  { sql: insertApiKeySql, query: insertApiKeyQuery },
);

export namespace insertApiKey {
  export type Params = {
    hash: string;
    userId: string;
    label: string | null;
    grants: string;
  };
}

const getApiKeySql = `
SELECT hash, user_id, label, grants FROM api_keys WHERE hash = ?;
`.trim();
const getApiKeyQuery = (params: getApiKey.Params) => ({
  name: "getApiKey",
  sql: getApiKeySql,
  args: [params.hash],
});

function getApiKeyMapResult(row: getApiKey.RawResult): getApiKey.Result {
  return {
    hash: row.hash,
    userId: row.user_id,
    label: row.label,
    grants: row.grants,
  };
}

export const getApiKey = Object.assign(
  async function getApiKey(
    client: Client,
    params: getApiKey.Params,
  ): Promise<getApiKey.Result | null> {
    const rows = await client.all<getApiKey.RawResult>(getApiKeyQuery(params));
    return rows.length > 0 ? getApiKeyMapResult(rows[0]!) : null;
  },
  { sql: getApiKeySql, query: getApiKeyQuery, mapResult: getApiKeyMapResult },
);

export namespace getApiKey {
  export type Params = {
    hash: string;
  };
  export type RawResult = {
    hash: string;
    user_id: string;
    label?: string;
    grants: string;
  };
  export type Result = {
    hash: string;
    userId: string;
    label?: string;
    grants: string;
  };
}

const listApiKeysForUserSql = `
SELECT hash, label, grants, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC;
`.trim();
const listApiKeysForUserQuery = (params: listApiKeysForUser.Params) => ({
  name: "listApiKeysForUser",
  sql: listApiKeysForUserSql,
  args: [params.userId],
});

function listApiKeysForUserMapResult(row: listApiKeysForUser.RawResult): listApiKeysForUser.Result {
  return {
    hash: row.hash,
    label: row.label,
    grants: row.grants,
    createdAt: row.created_at,
  };
}

export const listApiKeysForUser = Object.assign(
  async function listApiKeysForUser(
    client: Client,
    params: listApiKeysForUser.Params,
  ): Promise<listApiKeysForUser.Result[]> {
    const rows = await client.all<listApiKeysForUser.RawResult>(listApiKeysForUserQuery(params));
    return rows.map(listApiKeysForUserMapResult);
  },
  {
    sql: listApiKeysForUserSql,
    query: listApiKeysForUserQuery,
    mapResult: listApiKeysForUserMapResult,
  },
);

export namespace listApiKeysForUser {
  export type Params = {
    userId: string;
  };
  export type RawResult = {
    hash: string;
    label?: string;
    grants: string;
    created_at: string;
  };
  export type Result = {
    hash: string;
    label?: string;
    grants: string;
    createdAt: string;
  };
}

const deleteApiKeySql = `DELETE FROM api_keys WHERE hash = ? AND user_id = ?;`;
const deleteApiKeyQuery = (params: deleteApiKey.Params) => ({
  name: "deleteApiKey",
  sql: deleteApiKeySql,
  args: [params.hash, params.userId],
});

export const deleteApiKey = Object.assign(
  async function deleteApiKey(client: Client, params: deleteApiKey.Params) {
    return client.run(deleteApiKeyQuery(params));
  },
  { sql: deleteApiKeySql, query: deleteApiKeyQuery },
);

export namespace deleteApiKey {
  export type Params = {
    hash: string;
    userId: string;
  };
}
