import type { SyncClient } from "sqlfu";

const deleteLeaseBySlugSql = `
DELETE FROM leases
WHERE slug = ?;
`.trim();
const deleteLeaseBySlugQuery = (params: deleteLeaseBySlug.Params) => ({
  name: "deleteLeaseBySlug",
  sql: deleteLeaseBySlugSql,
  args: [params.slug],
});

export const deleteLeaseBySlug = Object.assign(
  function deleteLeaseBySlug(client: SyncClient, params: deleteLeaseBySlug.Params) {
    return client.run(deleteLeaseBySlugQuery(params));
  },
  { sql: deleteLeaseBySlugSql, query: deleteLeaseBySlugQuery },
);

export namespace deleteLeaseBySlug {
  export type Params = {
    slug: string;
  };
}

const deleteLeaseBySlugAndLeaseIdSql = `
DELETE FROM leases
WHERE slug = ? AND lease_id = ?;
`.trim();
const deleteLeaseBySlugAndLeaseIdQuery = (params: deleteLeaseBySlugAndLeaseId.Params) => ({
  name: "deleteLeaseBySlugAndLeaseId",
  sql: deleteLeaseBySlugAndLeaseIdSql,
  args: [params.slug, params.leaseId],
});

export const deleteLeaseBySlugAndLeaseId = Object.assign(
  function deleteLeaseBySlugAndLeaseId(
    client: SyncClient,
    params: deleteLeaseBySlugAndLeaseId.Params,
  ) {
    return client.run(deleteLeaseBySlugAndLeaseIdQuery(params));
  },
  { sql: deleteLeaseBySlugAndLeaseIdSql, query: deleteLeaseBySlugAndLeaseIdQuery },
);

export namespace deleteLeaseBySlugAndLeaseId {
  export type Params = {
    slug: string;
    leaseId: string;
  };
}

const insertCoordinatorTypeSql = `
INSERT OR REPLACE INTO metadata (key, value)
VALUES ('type', ?);
`.trim();
const insertCoordinatorTypeQuery = (params: insertCoordinatorType.Params) => ({
  name: "insertCoordinatorType",
  sql: insertCoordinatorTypeSql,
  args: [params.type],
});

export const insertCoordinatorType = Object.assign(
  function insertCoordinatorType(client: SyncClient, params: insertCoordinatorType.Params) {
    return client.run(insertCoordinatorTypeQuery(params));
  },
  { sql: insertCoordinatorTypeSql, query: insertCoordinatorTypeQuery },
);

export namespace insertCoordinatorType {
  export type Params = {
    type: string;
  };
}

const insertEventSql = `
INSERT INTO events (occurred_at, event, slug, payload)
VALUES (?, ?, ?, ?);
`.trim();
const insertEventQuery = (params: insertEvent.Params) => ({
  name: "insertEvent",
  sql: insertEventSql,
  args: [params.occurredAt, params.event, params.slug, params.payload],
});

export const insertEvent = Object.assign(
  function insertEvent(client: SyncClient, params: insertEvent.Params) {
    return client.run(insertEventQuery(params));
  },
  { sql: insertEventSql, query: insertEventQuery },
);

export namespace insertEvent {
  export type Params = {
    occurredAt: number;
    event: string;
    slug: string | null;
    payload: string;
  };
}

const insertLeaseSql = `
INSERT INTO leases (slug, lease_id, expires_at, created_at)
VALUES (?, ?, ?, ?);
`.trim();
const insertLeaseQuery = (params: insertLease.Params) => ({
  name: "insertLease",
  sql: insertLeaseSql,
  args: [params.slug, params.leaseId, params.expiresAt, params.createdAt],
});

export const insertLease = Object.assign(
  function insertLease(client: SyncClient, params: insertLease.Params) {
    return client.run(insertLeaseQuery(params));
  },
  { sql: insertLeaseSql, query: insertLeaseQuery },
);

export namespace insertLease {
  export type Params = {
    slug: string;
    leaseId: string;
    expiresAt: number;
    createdAt: number;
  };
}

const selectActiveLeaseSlugsSql = `
SELECT slug
FROM leases;
`.trim();
const selectActiveLeaseSlugsQuery = {
  name: "selectActiveLeaseSlugs",
  sql: selectActiveLeaseSlugsSql,
  args: [],
};

export const selectActiveLeaseSlugs = Object.assign(
  function selectActiveLeaseSlugs(client: SyncClient): selectActiveLeaseSlugs.Result[] {
    return client.all<selectActiveLeaseSlugs.Result>(selectActiveLeaseSlugsQuery);
  },
  { sql: selectActiveLeaseSlugsSql, query: selectActiveLeaseSlugsQuery },
);

export namespace selectActiveLeaseSlugs {
  export type Result = {
    slug: string;
  };
}

const selectCoordinatorTypeSql = `
SELECT value
FROM metadata
WHERE key = 'type';
`.trim();
const selectCoordinatorTypeQuery = {
  name: "selectCoordinatorType",
  sql: selectCoordinatorTypeSql,
  args: [],
};

export const selectCoordinatorType = Object.assign(
  function selectCoordinatorType(client: SyncClient): selectCoordinatorType.Result | null {
    const rows = client.all<selectCoordinatorType.Result>(selectCoordinatorTypeQuery);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectCoordinatorTypeSql, query: selectCoordinatorTypeQuery },
);

export namespace selectCoordinatorType {
  export type Result = {
    value: string;
  };
}

const selectExpiredLeasesSql = `
SELECT slug, lease_id, expires_at
FROM leases
WHERE expires_at <= ?
ORDER BY expires_at ASC;
`.trim();
const selectExpiredLeasesQuery = (params: selectExpiredLeases.Params) => ({
  name: "selectExpiredLeases",
  sql: selectExpiredLeasesSql,
  args: [params.now],
});

export const selectExpiredLeases = Object.assign(
  function selectExpiredLeases(
    client: SyncClient,
    params: selectExpiredLeases.Params,
  ): selectExpiredLeases.Result[] {
    return client.all<selectExpiredLeases.Result>(selectExpiredLeasesQuery(params));
  },
  { sql: selectExpiredLeasesSql, query: selectExpiredLeasesQuery },
);

export namespace selectExpiredLeases {
  export type Params = {
    now: number;
  };
  export type Result = {
    slug: string;
    lease_id: string;
    expires_at: number;
  };
}

const selectLeaseCountBySlugSql = `
SELECT COUNT(*) AS count
FROM leases
WHERE slug = ?;
`.trim();
const selectLeaseCountBySlugQuery = (params: selectLeaseCountBySlug.Params) => ({
  name: "selectLeaseCountBySlug",
  sql: selectLeaseCountBySlugSql,
  args: [params.slug],
});

export const selectLeaseCountBySlug = Object.assign(
  function selectLeaseCountBySlug(
    client: SyncClient,
    params: selectLeaseCountBySlug.Params,
  ): selectLeaseCountBySlug.Result | null {
    const rows = client.all<selectLeaseCountBySlug.Result>(selectLeaseCountBySlugQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectLeaseCountBySlugSql, query: selectLeaseCountBySlugQuery },
);

export namespace selectLeaseCountBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    count: number;
  };
}

const selectLeaseIdBySlugSql = `
SELECT lease_id
FROM leases
WHERE slug = ?;
`.trim();
const selectLeaseIdBySlugQuery = (params: selectLeaseIdBySlug.Params) => ({
  name: "selectLeaseIdBySlug",
  sql: selectLeaseIdBySlugSql,
  args: [params.slug],
});

export const selectLeaseIdBySlug = Object.assign(
  function selectLeaseIdBySlug(
    client: SyncClient,
    params: selectLeaseIdBySlug.Params,
  ): selectLeaseIdBySlug.Result | null {
    const rows = client.all<selectLeaseIdBySlug.Result>(selectLeaseIdBySlugQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectLeaseIdBySlugSql, query: selectLeaseIdBySlugQuery },
);

export namespace selectLeaseIdBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    lease_id: string;
  };
}

const selectLeaseBySlugSql = `
SELECT lease_id, expires_at
FROM leases
WHERE slug = ?;
`.trim();
const selectLeaseBySlugQuery = (params: selectLeaseBySlug.Params) => ({
  name: "selectLeaseBySlug",
  sql: selectLeaseBySlugSql,
  args: [params.slug],
});

export const selectLeaseBySlug = Object.assign(
  function selectLeaseBySlug(
    client: SyncClient,
    params: selectLeaseBySlug.Params,
  ): selectLeaseBySlug.Result | null {
    const rows = client.all<selectLeaseBySlug.Result>(selectLeaseBySlugQuery(params));
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectLeaseBySlugSql, query: selectLeaseBySlugQuery },
);

export namespace selectLeaseBySlug {
  export type Params = {
    slug: string;
  };
  export type Result = {
    lease_id: string;
    expires_at: number;
  };
}

const selectNextLeaseSql = `
SELECT expires_at
FROM leases
ORDER BY expires_at ASC
LIMIT 1;
`.trim();
const selectNextLeaseQuery = { name: "selectNextLease", sql: selectNextLeaseSql, args: [] };

export const selectNextLease = Object.assign(
  function selectNextLease(client: SyncClient): selectNextLease.Result | null {
    const rows = client.all<selectNextLease.Result>(selectNextLeaseQuery);
    return rows.length > 0 ? rows[0] : null;
  },
  { sql: selectNextLeaseSql, query: selectNextLeaseQuery },
);

export namespace selectNextLease {
  export type Result = {
    expires_at: number;
  };
}

const updateLeaseExpiresSql = `
UPDATE leases
SET expires_at = ?
WHERE slug = ? AND lease_id = ?;
`.trim();
const updateLeaseExpiresQuery = (
  data: updateLeaseExpires.Data,
  params: updateLeaseExpires.Params,
) => ({
  name: "updateLeaseExpires",
  sql: updateLeaseExpiresSql,
  args: [data.expiresAt, params.slug, params.leaseId],
});

export const updateLeaseExpires = Object.assign(
  function updateLeaseExpires(
    client: SyncClient,
    data: updateLeaseExpires.Data,
    params: updateLeaseExpires.Params,
  ) {
    return client.run(updateLeaseExpiresQuery(data, params));
  },
  { sql: updateLeaseExpiresSql, query: updateLeaseExpiresQuery },
);

export namespace updateLeaseExpires {
  export type Data = {
    expiresAt: number;
  };
  export type Params = {
    slug: string;
    leaseId: string;
  };
}
