import type { Client } from "sqlfu";

const selectResourcesSql = `
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
ORDER BY type ASC, created_at ASC, slug ASC;
`.trim();
const selectResourcesQuery = { name: "selectResources", sql: selectResourcesSql, args: [] };

export const selectResources = Object.assign(
  async function selectResources(client: Client): Promise<selectResources.Result[]> {
    return client.all<selectResources.Result>(selectResourcesQuery);
  },
  { sql: selectResourcesSql, query: selectResourcesQuery },
);

export namespace selectResources {
  export type Result = {
    type: string;
    slug: string;
    data: string;
    lease_state: string;
    leased_until?: number;
    last_acquired_at?: number;
    last_released_at?: number;
    created_at: string;
    updated_at: string;
  };
}

const selectResourcesByTypeSql = `
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = ?
ORDER BY created_at ASC, slug ASC;
`.trim();
const selectResourcesByTypeQuery = (params: selectResourcesByType.Params) => ({
  name: "selectResourcesByType",
  sql: selectResourcesByTypeSql,
  args: [params.type],
});

export const selectResourcesByType = Object.assign(
  async function selectResourcesByType(
    client: Client,
    params: selectResourcesByType.Params,
  ): Promise<selectResourcesByType.Result[]> {
    return client.all<selectResourcesByType.Result>(selectResourcesByTypeQuery(params));
  },
  { sql: selectResourcesByTypeSql, query: selectResourcesByTypeQuery },
);

export namespace selectResourcesByType {
  export type Params = {
    type: string;
  };
  export type Result = {
    type: string;
    slug: string;
    data: string;
    lease_state: string;
    leased_until?: number;
    last_acquired_at?: number;
    last_released_at?: number;
    created_at: string;
    updated_at: string;
  };
}

const insertResourceRowSql = `
INSERT INTO resources (type, slug, data)
VALUES (?, ?, ?);
`.trim();
const insertResourceRowQuery = (params: insertResourceRow.Params) => ({
  name: "insertResourceRow",
  sql: insertResourceRowSql,
  args: [params.type, params.slug, params.data],
});

export const insertResourceRow = Object.assign(
  async function insertResourceRow(client: Client, params: insertResourceRow.Params) {
    return client.run(insertResourceRowQuery(params));
  },
  { sql: insertResourceRowSql, query: insertResourceRowQuery },
);

export namespace insertResourceRow {
  export type Params = {
    type: string;
    slug: string;
    data: string;
  };
}

const selectResourceByTypeAndSlugSql = `
SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at
FROM resources
WHERE type = ? AND slug = ?;
`.trim();
const selectResourceByTypeAndSlugQuery = (params: selectResourceByTypeAndSlug.Params) => ({
  name: "selectResourceByTypeAndSlug",
  sql: selectResourceByTypeAndSlugSql,
  args: [params.type, params.slug],
});

export const selectResourceByTypeAndSlug = Object.assign(
  async function selectResourceByTypeAndSlug(
    client: Client,
    params: selectResourceByTypeAndSlug.Params,
  ): Promise<selectResourceByTypeAndSlug.Result | null> {
    const rows = await client.all<selectResourceByTypeAndSlug.Result>(
      selectResourceByTypeAndSlugQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectResourceByTypeAndSlugSql, query: selectResourceByTypeAndSlugQuery },
);

export namespace selectResourceByTypeAndSlug {
  export type Params = {
    type: string;
    slug: string;
  };
  export type Result = {
    type: string;
    slug: string;
    data: string;
    lease_state: string;
    leased_until?: number;
    last_acquired_at?: number;
    last_released_at?: number;
    created_at: string;
    updated_at: string;
  };
}

const deleteResourceByTypeAndSlugSql = `
DELETE FROM resources
WHERE type = ? AND slug = ?;
`.trim();
const deleteResourceByTypeAndSlugQuery = (params: deleteResourceByTypeAndSlug.Params) => ({
  name: "deleteResourceByTypeAndSlug",
  sql: deleteResourceByTypeAndSlugSql,
  args: [params.type, params.slug],
});

export const deleteResourceByTypeAndSlug = Object.assign(
  async function deleteResourceByTypeAndSlug(
    client: Client,
    params: deleteResourceByTypeAndSlug.Params,
  ) {
    return client.run(deleteResourceByTypeAndSlugQuery(params));
  },
  { sql: deleteResourceByTypeAndSlugSql, query: deleteResourceByTypeAndSlugQuery },
);

export namespace deleteResourceByTypeAndSlug {
  export type Params = {
    type: string;
    slug: string;
  };
}

const selectResourcePresenceByTypeSql = `
SELECT 1 AS present
FROM resources
WHERE type = ?
LIMIT 1;
`.trim();
const selectResourcePresenceByTypeQuery = (params: selectResourcePresenceByType.Params) => ({
  name: "selectResourcePresenceByType",
  sql: selectResourcePresenceByTypeSql,
  args: [params.type],
});

export const selectResourcePresenceByType = Object.assign(
  async function selectResourcePresenceByType(
    client: Client,
    params: selectResourcePresenceByType.Params,
  ): Promise<selectResourcePresenceByType.Result | null> {
    const rows = await client.all<selectResourcePresenceByType.Result>(
      selectResourcePresenceByTypeQuery(params),
    );
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectResourcePresenceByTypeSql, query: selectResourcePresenceByTypeQuery },
);

export namespace selectResourcePresenceByType {
  export type Params = {
    type: string;
  };
  export type Result = {
    present: number;
  };
}

const updateResourceLeasedSql = `
UPDATE resources
SET lease_state = 'leased',
  leased_until = ?,
  last_acquired_at = ?,
  updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE type = ? AND slug = ?;
`.trim();
const updateResourceLeasedQuery = (
  data: updateResourceLeased.Data,
  params: updateResourceLeased.Params,
) => ({
  name: "updateResourceLeased",
  sql: updateResourceLeasedSql,
  args: [data.leasedUntil, data.lastAcquiredAt, params.type, params.slug],
});

export const updateResourceLeased = Object.assign(
  async function updateResourceLeased(
    client: Client,
    data: updateResourceLeased.Data,
    params: updateResourceLeased.Params,
  ) {
    return client.run(updateResourceLeasedQuery(data, params));
  },
  { sql: updateResourceLeasedSql, query: updateResourceLeasedQuery },
);

export namespace updateResourceLeased {
  export type Data = {
    leasedUntil: number | null;
    lastAcquiredAt: number | null;
  };
  export type Params = {
    type: string;
    slug: string;
  };
}

const updateResourceAvailableSql = `
UPDATE resources
SET lease_state = 'available',
  leased_until = NULL,
  last_released_at = COALESCE(?, last_released_at),
  updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
WHERE type = ? AND slug = ?;
`.trim();
const updateResourceAvailableQuery = (
  data: updateResourceAvailable.Data,
  params: updateResourceAvailable.Params,
) => ({
  name: "updateResourceAvailable",
  sql: updateResourceAvailableSql,
  args: [data.lastReleasedAt, params.type, params.slug],
});

export const updateResourceAvailable = Object.assign(
  async function updateResourceAvailable(
    client: Client,
    data: updateResourceAvailable.Data,
    params: updateResourceAvailable.Params,
  ) {
    return client.run(updateResourceAvailableQuery(data, params));
  },
  { sql: updateResourceAvailableSql, query: updateResourceAvailableQuery },
);

export namespace updateResourceAvailable {
  export type Data = {
    lastReleasedAt: number | null;
  };
  export type Params = {
    type: string;
    slug: string;
  };
}
