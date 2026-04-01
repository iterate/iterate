import {
  PreviewEnvironmentCreateInput,
  PreviewEnvironmentDestroyInput,
  PreviewEnvironmentEnsureInventoryInput,
  PreviewEnvironmentListInput,
  PreviewEnvironmentResourceData,
  type SemaphoreLeaseRecord,
  PreviewEnvironmentType,
  previewEnvironmentAppSlugSchema,
  previewEnvironmentIdentifierSchema,
  previewEnvironmentTypeSchema,
  type PreviewEnvironmentRecord,
} from "@iterate-com/semaphore-contract";
import { z } from "zod";
import type { AppContext } from "~/context.ts";
import { findResourceByKey, listResourcesFromDb } from "~/lib/resource-store.ts";

/**
 * Preview environment naming is intentionally derived rather than configured ad hoc.
 *
 * Example:
 * - previewEnvironmentType: `example-preview-environment`
 * - previewEnvironmentIdentifier: `example-preview-1`
 * - previewEnvironmentAlchemyStageName: `preview-1`
 * - previewEnvironmentDopplerConfigName: `stg_1`
 * - previewEnvironmentWorkersDevHostname: `example-preview-1.iterate.workers.dev`
 *
 * Source of truth for active ownership lives in `preview_assignments`; the PR comment is display-only.
 */
const previewEnvironmentTypeByAppSlug = {
  example: "example-preview-environment",
  events: "events-preview-environment",
  semaphore: "semaphore-preview-environment",
  "ingress-proxy": "ingress-proxy-preview-environment",
} as const;

const previewEnvironmentDefaultSlotsPerApp = 10;

type PreviewEnvironmentAppSlug = keyof typeof previewEnvironmentTypeByAppSlug;

type PreviewAssignmentRow = {
  preview_environment_identifier: string;
  preview_environment_type: string;
  preview_environment_app_slug: string;
  repository_full_name: string;
  pull_request_number: number;
  pull_request_head_ref_name: string;
  pull_request_head_sha: string;
  workflow_run_url: string;
  active_lease_id: string;
  leased_until: number;
  created_at: string;
  updated_at: string;
};

type PreviewResourceRow = Awaited<ReturnType<typeof listResourcesFromDb>>[number];

export function isPreviewEnvironmentType(type: string) {
  return Object.values(previewEnvironmentTypeByAppSlug).includes(type as PreviewEnvironmentType);
}

export function getPreviewEnvironmentType(previewEnvironmentAppSlug: PreviewEnvironmentAppSlug) {
  return previewEnvironmentTypeByAppSlug[previewEnvironmentAppSlug];
}

export function makePreviewEnvironmentAlchemyStageName(slotNumber: number) {
  return `preview-${slotNumber}`;
}

export function makePreviewEnvironmentDopplerConfigName(slotNumber: number) {
  return `stg_${slotNumber}`;
}

export function makePreviewEnvironmentIdentifier(input: {
  previewEnvironmentAppSlug: PreviewEnvironmentAppSlug;
  slotNumber: number;
}) {
  return `${input.previewEnvironmentAppSlug}-${makePreviewEnvironmentAlchemyStageName(input.slotNumber)}`;
}

export function makePreviewEnvironmentWorkersDevHostname(previewEnvironmentIdentifier: string) {
  return `${previewEnvironmentIdentifier}.iterate.workers.dev`;
}

export function parsePreviewEnvironmentIdentifier(previewEnvironmentIdentifier: string) {
  const parsedIdentifier = previewEnvironmentIdentifierSchema.parse(previewEnvironmentIdentifier);

  for (const previewEnvironmentAppSlug of Object.keys(
    previewEnvironmentTypeByAppSlug,
  ) as PreviewEnvironmentAppSlug[]) {
    const prefix = `${previewEnvironmentAppSlug}-`;
    if (!parsedIdentifier.startsWith(prefix)) {
      continue;
    }

    const previewEnvironmentAlchemyStageName = parsedIdentifier.slice(prefix.length);
    const match = /^preview-(\d+)$/.exec(previewEnvironmentAlchemyStageName);
    if (!match) {
      break;
    }

    const slotNumber = Number(match[1]);
    return {
      previewEnvironmentIdentifier: parsedIdentifier,
      previewEnvironmentAppSlug,
      previewEnvironmentType: getPreviewEnvironmentType(previewEnvironmentAppSlug),
      previewEnvironmentAlchemyStageName,
      previewEnvironmentDopplerConfigName: makePreviewEnvironmentDopplerConfigName(slotNumber),
      previewEnvironmentWorkersDevHostname:
        makePreviewEnvironmentWorkersDevHostname(parsedIdentifier),
      slotNumber,
    };
  }

  throw new Error(`Unrecognized preview environment identifier: ${parsedIdentifier}`);
}

function makePreviewEnvironmentResourceData(input: {
  previewEnvironmentAppSlug: PreviewEnvironmentAppSlug;
  slotNumber: number;
}) {
  const previewEnvironmentIdentifier = makePreviewEnvironmentIdentifier(input);

  return PreviewEnvironmentResourceData.parse({
    kind: "preview-environment",
    previewEnvironmentAppSlug: input.previewEnvironmentAppSlug,
    previewEnvironmentIdentifier,
    previewEnvironmentDopplerConfigName: makePreviewEnvironmentDopplerConfigName(input.slotNumber),
    previewEnvironmentAlchemyStageName: makePreviewEnvironmentAlchemyStageName(input.slotNumber),
    previewEnvironmentWorkersDevHostname: makePreviewEnvironmentWorkersDevHostname(
      previewEnvironmentIdentifier,
    ),
  });
}

function mapPreviewAssignmentRow(row: PreviewAssignmentRow) {
  return {
    previewEnvironmentIdentifier: row.preview_environment_identifier,
    previewEnvironmentType: previewEnvironmentTypeSchema.parse(row.preview_environment_type),
    previewEnvironmentAppSlug: previewEnvironmentAppSlugSchema.parse(
      row.preview_environment_app_slug,
    ),
    repositoryFullName: row.repository_full_name,
    pullRequestNumber: row.pull_request_number,
    pullRequestHeadRefName: row.pull_request_head_ref_name,
    pullRequestHeadSha: row.pull_request_head_sha,
    workflowRunUrl: row.workflow_run_url,
    previewEnvironmentSemaphoreLeaseId: row.active_lease_id,
    leasedUntil: row.leased_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPreviewEnvironmentRecord(input: {
  resource: PreviewResourceRow;
  previewAssignment: PreviewAssignmentRow | null;
}): PreviewEnvironmentRecord {
  const previewData = PreviewEnvironmentResourceData.parse(input.resource.data);

  return {
    previewEnvironmentType: previewEnvironmentTypeSchema.parse(input.resource.type),
    previewEnvironmentIdentifier: previewData.previewEnvironmentIdentifier,
    previewEnvironmentAppSlug: previewData.previewEnvironmentAppSlug,
    previewEnvironmentDopplerConfigName: previewData.previewEnvironmentDopplerConfigName,
    previewEnvironmentAlchemyStageName: previewData.previewEnvironmentAlchemyStageName,
    previewEnvironmentWorkersDevHostname: previewData.previewEnvironmentWorkersDevHostname,
    leaseState: input.resource.leaseState,
    leasedUntil: input.previewAssignment?.leased_until ?? input.resource.leasedUntil,
    previewEnvironmentSemaphoreLeaseId: input.previewAssignment?.active_lease_id ?? null,
    previewEnvironmentLeaseOwner: input.previewAssignment
      ? {
          repositoryFullName: input.previewAssignment.repository_full_name,
          pullRequestNumber: input.previewAssignment.pull_request_number,
          pullRequestHeadRefName: input.previewAssignment.pull_request_head_ref_name,
          pullRequestHeadSha: input.previewAssignment.pull_request_head_sha,
          workflowRunUrl: input.previewAssignment.workflow_run_url,
        }
      : null,
    lastAcquiredAt: input.resource.lastAcquiredAt,
    lastReleasedAt: input.resource.lastReleasedAt,
    createdAt: input.resource.createdAt,
    updatedAt:
      input.previewAssignment?.updated_at &&
      input.previewAssignment.updated_at > input.resource.updatedAt
        ? input.previewAssignment.updated_at
        : input.resource.updatedAt,
  };
}

async function listPreviewAssignmentRows(
  db: D1Database,
  input: {
    repositoryFullName?: string;
    pullRequestNumber?: number;
    previewEnvironmentAppSlug?: PreviewEnvironmentAppSlug;
    expiredOnly?: boolean;
  } = {},
) {
  const whereClauses: string[] = [];
  const bindings: Array<number | string> = [];

  if (input.repositoryFullName) {
    whereClauses.push("repository_full_name = ?");
    bindings.push(input.repositoryFullName);
  }
  if (input.pullRequestNumber) {
    whereClauses.push("pull_request_number = ?");
    bindings.push(input.pullRequestNumber);
  }
  if (input.previewEnvironmentAppSlug) {
    whereClauses.push("preview_environment_app_slug = ?");
    bindings.push(input.previewEnvironmentAppSlug);
  }
  if (input.expiredOnly) {
    whereClauses.push("leased_until <= ?");
    bindings.push(Date.now());
  }

  const sql = [
    "SELECT preview_environment_identifier, preview_environment_type, preview_environment_app_slug, repository_full_name, pull_request_number, pull_request_head_ref_name, pull_request_head_sha, workflow_run_url, active_lease_id, leased_until, created_at, updated_at",
    "FROM preview_assignments",
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "",
    "ORDER BY preview_environment_identifier ASC",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all<PreviewAssignmentRow>();

  return result.results;
}

async function findPreviewAssignmentRowByIdentifier(
  db: D1Database,
  previewEnvironmentIdentifier: string,
) {
  const row = await db
    .prepare(
      `SELECT preview_environment_identifier, preview_environment_type, preview_environment_app_slug,
        repository_full_name, pull_request_number, pull_request_head_ref_name, pull_request_head_sha,
        workflow_run_url, active_lease_id, leased_until, created_at, updated_at
      FROM preview_assignments
      WHERE preview_environment_identifier = ?`,
    )
    .bind(previewEnvironmentIdentifier)
    .first<PreviewAssignmentRow>();

  return row ?? null;
}

async function findPreviewAssignmentRowByPullRequest(
  db: D1Database,
  input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    previewEnvironmentAppSlug: PreviewEnvironmentAppSlug;
  },
) {
  const row = await db
    .prepare(
      `SELECT preview_environment_identifier, preview_environment_type, preview_environment_app_slug,
        repository_full_name, pull_request_number, pull_request_head_ref_name, pull_request_head_sha,
        workflow_run_url, active_lease_id, leased_until, created_at, updated_at
      FROM preview_assignments
      WHERE repository_full_name = ?
        AND pull_request_number = ?
        AND preview_environment_app_slug = ?`,
    )
    .bind(input.repositoryFullName, input.pullRequestNumber, input.previewEnvironmentAppSlug)
    .first<PreviewAssignmentRow>();

  return row ?? null;
}

async function upsertPreviewAssignmentRow(
  db: D1Database,
  input: {
    previewEnvironmentIdentifier: string;
    previewEnvironmentType: PreviewEnvironmentType;
    previewEnvironmentAppSlug: PreviewEnvironmentAppSlug;
    repositoryFullName: string;
    pullRequestNumber: number;
    pullRequestHeadRefName: string;
    pullRequestHeadSha: string;
    workflowRunUrl: string;
    previewEnvironmentSemaphoreLeaseId: string;
    leasedUntil: number;
  },
) {
  await db
    .prepare(
      `INSERT INTO preview_assignments (
        preview_environment_identifier,
        preview_environment_type,
        preview_environment_app_slug,
        repository_full_name,
        pull_request_number,
        pull_request_head_ref_name,
        pull_request_head_sha,
        workflow_run_url,
        active_lease_id,
        leased_until
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(preview_environment_identifier) DO UPDATE SET
        preview_environment_type = excluded.preview_environment_type,
        preview_environment_app_slug = excluded.preview_environment_app_slug,
        repository_full_name = excluded.repository_full_name,
        pull_request_number = excluded.pull_request_number,
        pull_request_head_ref_name = excluded.pull_request_head_ref_name,
        pull_request_head_sha = excluded.pull_request_head_sha,
        workflow_run_url = excluded.workflow_run_url,
        active_lease_id = excluded.active_lease_id,
        leased_until = excluded.leased_until,
        updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      input.previewEnvironmentIdentifier,
      input.previewEnvironmentType,
      input.previewEnvironmentAppSlug,
      input.repositoryFullName,
      input.pullRequestNumber,
      input.pullRequestHeadRefName,
      input.pullRequestHeadSha,
      input.workflowRunUrl,
      input.previewEnvironmentSemaphoreLeaseId,
      input.leasedUntil,
    )
    .run();
}

async function deletePreviewAssignmentRow(
  db: D1Database,
  input: {
    previewEnvironmentIdentifier: string;
    previewEnvironmentSemaphoreLeaseId?: string;
  },
) {
  const sql = input.previewEnvironmentSemaphoreLeaseId
    ? "DELETE FROM preview_assignments WHERE preview_environment_identifier = ? AND active_lease_id = ?"
    : "DELETE FROM preview_assignments WHERE preview_environment_identifier = ?";
  const bindings = input.previewEnvironmentSemaphoreLeaseId
    ? [input.previewEnvironmentIdentifier, input.previewEnvironmentSemaphoreLeaseId]
    : [input.previewEnvironmentIdentifier];
  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

async function upsertPreviewResource(
  db: D1Database,
  input: {
    previewEnvironmentType: PreviewEnvironmentType;
    previewEnvironmentIdentifier: string;
    previewEnvironmentResourceData: z.infer<typeof PreviewEnvironmentResourceData>;
  },
) {
  await db
    .prepare(
      `INSERT INTO resources (type, slug, data)
      VALUES (?, ?, ?)
      ON CONFLICT(type, slug) DO UPDATE SET
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      input.previewEnvironmentType,
      input.previewEnvironmentIdentifier,
      JSON.stringify(input.previewEnvironmentResourceData),
    )
    .run();
}

async function findPreviewResource(db: D1Database, previewEnvironmentIdentifier: string) {
  const parsedIdentifier = parsePreviewEnvironmentIdentifier(previewEnvironmentIdentifier);
  const resource = await findResourceByKey(db, {
    type: parsedIdentifier.previewEnvironmentType,
    slug: parsedIdentifier.previewEnvironmentIdentifier,
  });

  if (!resource) {
    return null;
  }

  return resource;
}

function getPreviewCoordinator(
  context: AppContext,
  previewEnvironmentType: PreviewEnvironmentType,
) {
  return context.env.RESOURCE_COORDINATOR.getByName(previewEnvironmentType);
}

export async function ensurePreviewInventory(context: Pick<AppContext, "db">, rawInput: unknown) {
  const input = PreviewEnvironmentEnsureInventoryInput.parse(rawInput);
  const slotsPerApp = input.slotsPerApp ?? previewEnvironmentDefaultSlotsPerApp;
  let upsertedCount = 0;

  for (const previewEnvironmentAppSlug of Object.keys(
    previewEnvironmentTypeByAppSlug,
  ) as PreviewEnvironmentAppSlug[]) {
    for (let slotNumber = 1; slotNumber <= slotsPerApp; slotNumber += 1) {
      const previewEnvironmentType = getPreviewEnvironmentType(previewEnvironmentAppSlug);
      const previewEnvironmentIdentifier = makePreviewEnvironmentIdentifier({
        previewEnvironmentAppSlug,
        slotNumber,
      });

      await upsertPreviewResource(context.db, {
        previewEnvironmentType,
        previewEnvironmentIdentifier,
        previewEnvironmentResourceData: makePreviewEnvironmentResourceData({
          previewEnvironmentAppSlug,
          slotNumber,
        }),
      });
      upsertedCount += 1;
    }
  }

  return {
    upsertedCount,
  };
}

export async function createPreviewEnvironment(context: AppContext, rawInput: unknown) {
  const input = PreviewEnvironmentCreateInput.parse(rawInput);

  const previewEnvironmentAppSlug = input.previewEnvironmentAppSlug;
  const previewEnvironmentType = getPreviewEnvironmentType(previewEnvironmentAppSlug);
  const previewCoordinator = getPreviewCoordinator(context, previewEnvironmentType);
  const currentAssignmentForPullRequest = await findPreviewAssignmentRowByPullRequest(context.db, {
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    previewEnvironmentAppSlug,
  });
  const requestedAssignment = input.previewEnvironmentIdentifier
    ? await findPreviewAssignmentRowByIdentifier(context.db, input.previewEnvironmentIdentifier)
    : null;

  if (requestedAssignment) {
    const requestedAssignmentCurrentLease = await previewCoordinator.getLease({
      type: previewEnvironmentType,
      slug: requestedAssignment.preview_environment_identifier,
    });

    const requestedAssignmentStillOwned =
      requestedAssignmentCurrentLease?.leaseId === requestedAssignment.active_lease_id;

    if (!requestedAssignmentStillOwned) {
      await deletePreviewAssignmentRow(context.db, {
        previewEnvironmentIdentifier: requestedAssignment.preview_environment_identifier,
        previewEnvironmentSemaphoreLeaseId: requestedAssignment.active_lease_id,
      });
    } else if (
      requestedAssignment.repository_full_name !== input.repositoryFullName ||
      requestedAssignment.pull_request_number !== input.pullRequestNumber
    ) {
      throw new Error(
        `${requestedAssignment.preview_environment_identifier} is already assigned to another pull request`,
      );
    }
  }

  const requestedPreviewEnvironmentIdentifier =
    input.previewEnvironmentIdentifier ??
    currentAssignmentForPullRequest?.preview_environment_identifier ??
    null;

  let previewLease: SemaphoreLeaseRecord | null = null;

  if (
    requestedPreviewEnvironmentIdentifier &&
    input.previewEnvironmentIdentifier &&
    requestedAssignment
  ) {
    previewLease = await previewCoordinator.renew({
      type: previewEnvironmentType,
      slug: requestedPreviewEnvironmentIdentifier,
      leaseId: requestedAssignment.active_lease_id,
      leaseMs: input.leaseMs,
    });
  }

  if (
    requestedPreviewEnvironmentIdentifier &&
    !input.previewEnvironmentIdentifier &&
    currentAssignmentForPullRequest?.active_lease_id
  ) {
    previewLease = await previewCoordinator.renew({
      type: previewEnvironmentType,
      slug: requestedPreviewEnvironmentIdentifier,
      leaseId: currentAssignmentForPullRequest.active_lease_id,
      leaseMs: input.leaseMs,
    });
  }

  if (!previewLease && requestedPreviewEnvironmentIdentifier) {
    previewLease = await previewCoordinator.acquireSpecific({
      type: previewEnvironmentType,
      slug: requestedPreviewEnvironmentIdentifier,
      leaseMs: input.leaseMs,
    });
  }

  if (!previewLease && !input.previewEnvironmentIdentifier) {
    previewLease = await previewCoordinator.acquire({
      type: previewEnvironmentType,
      leaseMs: input.leaseMs,
      waitMs: input.waitMs,
    });
  }

  if (!previewLease) {
    throw new Error(
      `No preview environment is currently available for ${previewEnvironmentAppSlug}. Ensure preview inventory exists and that a slot is free.`,
    );
  }

  const resolvedPreviewLease = previewLease as SemaphoreLeaseRecord;
  const previewEnvironmentIdentifier = previewEnvironmentIdentifierSchema.parse(
    resolvedPreviewLease.slug,
  );

  if (
    currentAssignmentForPullRequest &&
    currentAssignmentForPullRequest.preview_environment_identifier !== previewEnvironmentIdentifier
  ) {
    const currentPreviewLease = await previewCoordinator.getLease({
      type: previewEnvironmentType,
      slug: currentAssignmentForPullRequest.preview_environment_identifier,
    });

    if (currentPreviewLease?.leaseId === currentAssignmentForPullRequest.active_lease_id) {
      await previewCoordinator.release({
        type: previewEnvironmentType,
        slug: currentAssignmentForPullRequest.preview_environment_identifier,
        leaseId: currentAssignmentForPullRequest.active_lease_id,
      });
    }

    await deletePreviewAssignmentRow(context.db, {
      previewEnvironmentIdentifier: currentAssignmentForPullRequest.preview_environment_identifier,
      previewEnvironmentSemaphoreLeaseId: currentAssignmentForPullRequest.active_lease_id,
    });
  }

  await upsertPreviewAssignmentRow(context.db, {
    previewEnvironmentIdentifier,
    previewEnvironmentType,
    previewEnvironmentAppSlug,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestHeadRefName: input.pullRequestHeadRefName,
    pullRequestHeadSha: input.pullRequestHeadSha,
    workflowRunUrl: input.workflowRunUrl,
    previewEnvironmentSemaphoreLeaseId: resolvedPreviewLease.leaseId,
    leasedUntil: resolvedPreviewLease.expiresAt,
  });

  const resource = await findPreviewResource(context.db, previewEnvironmentIdentifier);
  if (!resource) {
    throw new Error(`Preview resource ${previewEnvironmentIdentifier} was not found after acquire`);
  }

  const previewAssignment = await findPreviewAssignmentRowByIdentifier(
    context.db,
    previewEnvironmentIdentifier,
  );
  if (!previewAssignment) {
    throw new Error(
      `Preview assignment ${previewEnvironmentIdentifier} was not found after acquire`,
    );
  }

  return mapPreviewEnvironmentRecord({
    resource,
    previewAssignment,
  });
}

export async function destroyPreviewEnvironment(context: AppContext, rawInput: unknown) {
  const input = PreviewEnvironmentDestroyInput.parse(rawInput);
  const previewAssignment = await findPreviewAssignmentRowByIdentifier(
    context.db,
    input.previewEnvironmentIdentifier,
  );
  if (!previewAssignment) {
    return {
      destroyed: false,
    };
  }

  if (previewAssignment.active_lease_id !== input.previewEnvironmentSemaphoreLeaseId) {
    return {
      destroyed: false,
    };
  }

  const previewEnvironmentType = previewEnvironmentTypeSchema.parse(
    previewAssignment.preview_environment_type,
  );
  const previewCoordinator = getPreviewCoordinator(context, previewEnvironmentType);
  const currentLease = await previewCoordinator.getLease({
    type: previewEnvironmentType,
    slug: previewAssignment.preview_environment_identifier,
  });

  if (currentLease?.leaseId === previewAssignment.active_lease_id) {
    await previewCoordinator.release({
      type: previewEnvironmentType,
      slug: previewAssignment.preview_environment_identifier,
      leaseId: previewAssignment.active_lease_id,
    });
  }

  const deleted = await deletePreviewAssignmentRow(context.db, {
    previewEnvironmentIdentifier: input.previewEnvironmentIdentifier,
    previewEnvironmentSemaphoreLeaseId: input.previewEnvironmentSemaphoreLeaseId,
  });

  return {
    destroyed: deleted,
  };
}

export async function getPreviewEnvironmentRecord(
  context: Pick<AppContext, "db">,
  previewEnvironmentIdentifier: string,
) {
  const resource = await findPreviewResource(context.db, previewEnvironmentIdentifier);
  if (!resource) {
    return null;
  }

  const previewAssignment = await findPreviewAssignmentRowByIdentifier(
    context.db,
    previewEnvironmentIdentifier,
  );

  return mapPreviewEnvironmentRecord({
    resource,
    previewAssignment,
  });
}

export async function listPreviewEnvironmentRecords(
  context: Pick<AppContext, "db">,
  rawInput: unknown,
) {
  const input = PreviewEnvironmentListInput.parse(rawInput);
  const previewResources = (await listResourcesFromDb(context.db)).filter((resource) =>
    Object.values(previewEnvironmentTypeByAppSlug).includes(
      resource.type as PreviewEnvironmentType,
    ),
  );
  const previewAssignments = await listPreviewAssignmentRows(context.db, input);
  const previewAssignmentByIdentifier = new Map(
    previewAssignments.map((row) => [row.preview_environment_identifier, row]),
  );

  return previewResources
    .map((resource) =>
      mapPreviewEnvironmentRecord({
        resource,
        previewAssignment: previewAssignmentByIdentifier.get(resource.slug) ?? null,
      }),
    )
    .filter((previewEnvironmentRecord) => {
      if (
        input.repositoryFullName &&
        previewEnvironmentRecord.previewEnvironmentLeaseOwner?.repositoryFullName !==
          input.repositoryFullName
      ) {
        return false;
      }
      if (
        input.pullRequestNumber &&
        previewEnvironmentRecord.previewEnvironmentLeaseOwner?.pullRequestNumber !==
          input.pullRequestNumber
      ) {
        return false;
      }
      if (
        input.previewEnvironmentAppSlug &&
        previewEnvironmentRecord.previewEnvironmentAppSlug !== input.previewEnvironmentAppSlug
      ) {
        return false;
      }
      if (
        input.expiredOnly &&
        (!previewEnvironmentRecord.leasedUntil || previewEnvironmentRecord.leasedUntil > Date.now())
      ) {
        return false;
      }

      return true;
    })
    .sort((left, right) =>
      left.previewEnvironmentIdentifier.localeCompare(right.previewEnvironmentIdentifier),
    );
}
