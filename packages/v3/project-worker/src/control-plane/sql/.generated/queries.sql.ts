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

const createOrgSql = `
INSERT INTO orgs (id, name) VALUES (?, ?)
RETURNING id, name;
`.trim();
const createOrgQuery = (params: createOrg.Params) => ({
  name: "createOrg",
  sql: createOrgSql,
  args: [params.id, params.name],
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
  };
  export type Result = {
    id: string;
    name: string;
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
SELECT o.id, o.name, m.role
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
    role: string;
  };
}

const createProjectSql = `
INSERT INTO projects (id, org_id) VALUES (?, ?)
ON CONFLICT DO NOTHING;
`.trim();
const createProjectQuery = (params: createProject.Params) => ({
  name: "createProject",
  sql: createProjectSql,
  args: [params.id, params.orgId],
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
    orgId: string;
  };
}

const getProjectSql = `SELECT id, org_id FROM projects WHERE id = ?;`;
const getProjectQuery = (params: getProject.Params) => ({
  name: "getProject",
  sql: getProjectSql,
  args: [params.id],
});

function getProjectMapResult(row: getProject.RawResult): getProject.Result {
  return {
    id: row.id,
    orgId: row.org_id,
  };
}

export const getProject = Object.assign(
  async function getProject(
    client: Client,
    params: getProject.Params,
  ): Promise<getProject.Result | null> {
    const rows = await client.all<getProject.RawResult>(getProjectQuery(params));
    return rows.length > 0 ? getProjectMapResult(rows[0]!) : null;
  },
  { sql: getProjectSql, query: getProjectQuery, mapResult: getProjectMapResult },
);

export namespace getProject {
  export type Params = {
    id: string;
  };
  export type RawResult = {
    id: string;
    org_id: string;
  };
  export type Result = {
    id: string;
    orgId: string;
  };
}

const listProjectsForUserSql = `
SELECT p.id, p.org_id, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = ?
ORDER BY p.id ASC;
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
    org_id: string;
    role: string;
  };
  export type Result = {
    id: string;
    orgId: string;
    role: string;
  };
}
