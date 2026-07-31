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

const createOrgSql = `
INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)
RETURNING id, name, slug;
`.trim();
const createOrgQuery = (params: createOrg.Params) => ({
  name: "createOrg",
  sql: createOrgSql,
  args: [params.id, params.name, params.slug],
});

export const createOrg = Object.assign(
  async function createOrg(client: Client, params: createOrg.Params): Promise<createOrg.Result> {
    const rows = await client.all<createOrg.Result>(createOrgQuery(params));
    return rows[0];
  },
  { sql: createOrgSql, query: createOrgQuery },
);

export namespace createOrg {
  export type Params = {
    id: string;
    name: string;
    slug: string;
  };
  export type Result = {
    id: string;
    name: string;
    slug: string;
  };
}

const addOrgMemberSql = `
INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)
ON CONFLICT(org_id, user_id) DO NOTHING;
`.trim();
const addOrgMemberQuery = (params: addOrgMember.Params) => ({
  name: "addOrgMember",
  sql: addOrgMemberSql,
  args: [params.orgId, params.userId, params.role],
});

export const addOrgMember = Object.assign(
  async function addOrgMember(client: Client, params: addOrgMember.Params) {
    return client.run(addOrgMemberQuery(params));
  },
  { sql: addOrgMemberSql, query: addOrgMemberQuery },
);

export namespace addOrgMember {
  export type Params = {
    orgId: string;
    userId: string;
    role: string;
  };
}

const listOrgsForUserSql = `
SELECT o.id, o.name, o.slug, m.role
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = ?
ORDER BY o.name ASC;
`.trim();
const listOrgsForUserQuery = (params: listOrgsForUser.Params) => ({
  name: "listOrgsForUser",
  sql: listOrgsForUserSql,
  args: [params.userId],
});

export const listOrgsForUser = Object.assign(
  async function listOrgsForUser(
    client: Client,
    params: listOrgsForUser.Params,
  ): Promise<listOrgsForUser.Result[]> {
    return client.all<listOrgsForUser.Result>(listOrgsForUserQuery(params));
  },
  { sql: listOrgsForUserSql, query: listOrgsForUserQuery },
);

export namespace listOrgsForUser {
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

const createProjectSql = `
INSERT INTO projects (id, slug, org_id) VALUES (?, ?, ?)
ON CONFLICT(slug) DO NOTHING;
`.trim();
const createProjectQuery = (params: createProject.Params) => ({
  name: "createProject",
  sql: createProjectSql,
  args: [params.id, params.slug, params.orgId],
});

export const createProject = Object.assign(
  async function createProject(client: Client, params: createProject.Params) {
    return client.run(createProjectQuery(params));
  },
  { sql: createProjectSql, query: createProjectQuery },
);

export namespace createProject {
  export type Params = {
    id: string;
    slug: string;
    orgId: string;
  };
}

const getProjectBySlugSql = `
SELECT id, slug, org_id FROM projects WHERE slug = ?;
`.trim();
const getProjectBySlugQuery = (params: getProjectBySlug.Params) => ({
  name: "getProjectBySlug",
  sql: getProjectBySlugSql,
  args: [params.slug],
});

function getProjectBySlugMapResult(row: getProjectBySlug.RawResult): getProjectBySlug.Result {
  return {
    id: row.id,
    slug: row.slug,
    orgId: row.org_id,
  };
}

export const getProjectBySlug = Object.assign(
  async function getProjectBySlug(
    client: Client,
    params: getProjectBySlug.Params,
  ): Promise<getProjectBySlug.Result[]> {
    const rows = await client.all<getProjectBySlug.RawResult>(getProjectBySlugQuery(params));
    return rows.map(getProjectBySlugMapResult);
  },
  { sql: getProjectBySlugSql, query: getProjectBySlugQuery, mapResult: getProjectBySlugMapResult },
);

export namespace getProjectBySlug {
  export type Params = {
    slug: string;
  };
  export type RawResult = {
    id: string;
    slug: string;
    org_id: string;
  };
  export type Result = {
    id: string;
    slug: string;
    orgId: string;
  };
}

const listProjectsForUserSql = `
SELECT p.id, p.slug, p.org_id, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = ?
ORDER BY p.slug ASC;
`.trim();
const listProjectsForUserQuery = (params: listProjectsForUser.Params) => ({
  name: "listProjectsForUser",
  sql: listProjectsForUserSql,
  args: [params.userId],
});

function listProjectsForUserMapResult(
  row: listProjectsForUser.RawResult,
): listProjectsForUser.Result {
  return {
    id: row.id,
    slug: row.slug,
    orgId: row.org_id,
    role: row.role,
  };
}

export const listProjectsForUser = Object.assign(
  async function listProjectsForUser(
    client: Client,
    params: listProjectsForUser.Params,
  ): Promise<listProjectsForUser.Result[]> {
    const rows = await client.all<listProjectsForUser.RawResult>(listProjectsForUserQuery(params));
    return rows.map(listProjectsForUserMapResult);
  },
  {
    sql: listProjectsForUserSql,
    query: listProjectsForUserQuery,
    mapResult: listProjectsForUserMapResult,
  },
);

export namespace listProjectsForUser {
  export type Params = {
    userId: string;
  };
  export type RawResult = {
    id: string;
    slug: string;
    org_id: string;
    role: string;
  };
  export type Result = {
    id: string;
    slug: string;
    orgId: string;
    role: string;
  };
}

const checkProjectAccessSql = `
SELECT m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE p.id = ? AND m.user_id = ?;
`.trim();
const checkProjectAccessQuery = (params: checkProjectAccess.Params) => ({
  name: "checkProjectAccess",
  sql: checkProjectAccessSql,
  args: [params.projectId, params.userId],
});

export const checkProjectAccess = Object.assign(
  async function checkProjectAccess(
    client: Client,
    params: checkProjectAccess.Params,
  ): Promise<checkProjectAccess.Result[]> {
    return client.all<checkProjectAccess.Result>(checkProjectAccessQuery(params));
  },
  { sql: checkProjectAccessSql, query: checkProjectAccessQuery },
);

export namespace checkProjectAccess {
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
