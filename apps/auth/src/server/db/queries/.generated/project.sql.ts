import type { Client } from "sqlfu";

const getProjectBySlugSql = `
SELECT id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE slug = ?
LIMIT 1;
`.trim();
const getProjectBySlugQuery = (params: getProjectBySlug.Params) => ({
  name: "getProjectBySlug",
  sql: getProjectBySlugSql,
  args: [params.slug],
});

export const getProjectBySlug = Object.assign(
  async function getProjectBySlug(
    client: Client,
    params: getProjectBySlug.Params,
  ): Promise<getProjectBySlug.Result | null> {
    const rows = await client.all<getProjectBySlug.Result>(getProjectBySlugQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getProjectBySlugSql, query: getProjectBySlugQuery },
);

export namespace getProjectBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    metadata: string;
    archivedAt?: number;
  };
}

const getProjectByIdSql = `
SELECT id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE id = ?
LIMIT 1;
`.trim();
const getProjectByIdQuery = (params: getProjectById.Params) => ({
  name: "getProjectById",
  sql: getProjectByIdSql,
  args: [params.id],
});

export const getProjectById = Object.assign(
  async function getProjectById(
    client: Client,
    params: getProjectById.Params,
  ): Promise<getProjectById.Result | null> {
    const rows = await client.all<getProjectById.Result>(getProjectByIdQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getProjectByIdSql, query: getProjectByIdQuery },
);

export namespace getProjectById {
  export type Params = {
    id: string;
  };
  export type Result = {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    metadata: string;
    archivedAt?: number;
  };
}

const getProjectWithOrganizationBySlugSql = `
SELECT p.id,
  p.organization_id AS organizationId,
  p.name,
  p.slug,
  p.metadata,
  p.archived_at AS archivedAt,
  o.id AS organizationRecordId,
  o.name AS organizationName,
  o.slug AS organizationSlug
FROM project p
JOIN organization o ON o.id = p.organization_id
WHERE p.slug = ?
LIMIT 1;
`.trim();
const getProjectWithOrganizationBySlugQuery = (
  params: getProjectWithOrganizationBySlug.Params,
) => ({
  name: "getProjectWithOrganizationBySlug",
  sql: getProjectWithOrganizationBySlugSql,
  args: [params.slug],
});

export const getProjectWithOrganizationBySlug = Object.assign(
  async function getProjectWithOrganizationBySlug(
    client: Client,
    params: getProjectWithOrganizationBySlug.Params,
  ): Promise<getProjectWithOrganizationBySlug.Result | null> {
    const rows = await client.all<getProjectWithOrganizationBySlug.Result>(
      getProjectWithOrganizationBySlugQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: getProjectWithOrganizationBySlugSql, query: getProjectWithOrganizationBySlugQuery },
);

export namespace getProjectWithOrganizationBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    metadata: string;
    archivedAt?: number;
    organizationRecordId: string;
    organizationName: string;
    organizationSlug: string;
  };
}

const listProjectsByOrganizationIdSql = `
SELECT id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt
FROM project
WHERE organization_id = ?
ORDER BY created_at ASC,
  slug ASC;
`.trim();
const listProjectsByOrganizationIdQuery = (params: listProjectsByOrganizationId.Params) => ({
  name: "listProjectsByOrganizationId",
  sql: listProjectsByOrganizationIdSql,
  args: [params.organizationId],
});

export const listProjectsByOrganizationId = Object.assign(
  async function listProjectsByOrganizationId(
    client: Client,
    params: listProjectsByOrganizationId.Params,
  ): Promise<listProjectsByOrganizationId.Result[]> {
    return client.all<listProjectsByOrganizationId.Result>(
      listProjectsByOrganizationIdQuery(params),
    );
  },
  { sql: listProjectsByOrganizationIdSql, query: listProjectsByOrganizationIdQuery },
);

export namespace listProjectsByOrganizationId {
  export type Params = {
    organizationId: string;
  };
  export type Result = {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    metadata: string;
    archivedAt?: number;
  };
}

const listProjectsForUserSql = `
SELECT p.id,
  p.organization_id AS organizationId,
  p.name,
  p.slug,
  p.metadata,
  p.archived_at AS archivedAt
FROM project p
JOIN member m ON m.organizationId = p.organization_id
WHERE m.userId = ?
ORDER BY p.created_at ASC,
  p.slug ASC;
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
    organizationId: string;
    name: string;
    slug: string;
    metadata: string;
    archivedAt?: number;
  };
}

const insertProjectReturningSql = `
INSERT INTO project (
  id,
  organization_id,
  name,
  slug,
  metadata,
  archived_at,
  created_at,
  updated_at
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
)
RETURNING id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt;
`.trim();
const insertProjectReturningQuery = (params: insertProjectReturning.Params) => ({
  name: "insertProjectReturning",
  sql: insertProjectReturningSql,
  args: [
    params.id,
    params.organizationId,
    params.name,
    params.slug,
    params.metadata,
    params.archivedAt,
    params.createdAt,
    params.updatedAt,
  ],
});

export const insertProjectReturning = Object.assign(
  async function insertProjectReturning(
    client: Client,
    params: insertProjectReturning.Params,
  ): Promise<insertProjectReturning.Result> {
    const rows = await client.all<insertProjectReturning.Result>(
      insertProjectReturningQuery(params),
    );
    return rows[0];
  },
  { sql: insertProjectReturningSql, query: insertProjectReturningQuery },
);

export namespace insertProjectReturning {
  export type Params = {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    metadata: string;
    archivedAt: number | null;
    createdAt: number;
    updatedAt: number;
  };
  export type Result = {
    id: string;
    organization_id: string;
    name: string;
    slug: string;
    metadata: string;
    archived_at?: number;
  };
}

const updateProjectReturningSql = `
UPDATE project
SET name = ?,
  slug = ?,
  metadata = ?,
  updated_at = ?
WHERE id = ?
RETURNING id,
  organization_id AS organizationId,
  name,
  slug,
  metadata,
  archived_at AS archivedAt;
`.trim();
const updateProjectReturningQuery = (
  data: updateProjectReturning.Data,
  params: updateProjectReturning.Params,
) => ({
  name: "updateProjectReturning",
  sql: updateProjectReturningSql,
  args: [data.name, data.slug, data.metadata, data.updatedAt, params.id],
});

export const updateProjectReturning = Object.assign(
  async function updateProjectReturning(
    client: Client,
    data: updateProjectReturning.Data,
    params: updateProjectReturning.Params,
  ): Promise<updateProjectReturning.Result> {
    const rows = await client.all<updateProjectReturning.Result>(
      updateProjectReturningQuery(data, params),
    );
    return rows[0];
  },
  { sql: updateProjectReturningSql, query: updateProjectReturningQuery },
);

export namespace updateProjectReturning {
  export type Data = {
    name: string;
    slug: string;
    metadata: string;
    updatedAt: number;
  };
  export type Params = {
    id: string;
  };
  export type Result = {
    id: string;
    organization_id: string;
    name: string;
    slug: string;
    metadata: string;
    archived_at?: number;
  };
}

const deleteProjectByIdSql = `
DELETE FROM project
WHERE id = ?;
`.trim();
const deleteProjectByIdQuery = (params: deleteProjectById.Params) => ({
  name: "deleteProjectById",
  sql: deleteProjectByIdSql,
  args: [params.id],
});

export const deleteProjectById = Object.assign(
  async function deleteProjectById(client: Client, params: deleteProjectById.Params) {
    return client.run(deleteProjectByIdQuery(params));
  },
  { sql: deleteProjectByIdSql, query: deleteProjectByIdQuery },
);

export namespace deleteProjectById {
  export type Params = {
    id: string;
  };
}
