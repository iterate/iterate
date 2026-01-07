export type OrganizationParams = {
  organizationSlug: string;
};

export type ProjectParams = {
  organizationSlug: string;
  projectSlug: string;
};

export function assertOrganizationParams(params: unknown): OrganizationParams {
  if (!params || typeof params !== "object") {
    throw new Error("Missing organization slug");
  }

  const candidate = params as { organizationSlug?: string };
  if (!candidate.organizationSlug) {
    throw new Error("Missing organization slug");
  }

  return { organizationSlug: candidate.organizationSlug };
}

export function assertProjectParams(params: unknown): ProjectParams {
  if (!params || typeof params !== "object") {
    throw new Error("Missing project parameters");
  }

  const candidate = params as { organizationSlug?: string; projectSlug?: string };
  if (!candidate.organizationSlug || !candidate.projectSlug) {
    throw new Error("Missing project parameters");
  }

  return {
    organizationSlug: candidate.organizationSlug,
    projectSlug: candidate.projectSlug,
  };
}
