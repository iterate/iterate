import { useParams } from "@tanstack/react-router";

export interface EstateParams {
  organizationId: string;
  installationId: string;
}

// Simple hook to get estate params from URL
// Access checking is now done in the loader
export function useInstallation(): EstateParams | null {
  const params = useParams({ strict: false });

  const organizationId = params.organizationId;
  const installationId = params.installationId;

  if (!organizationId || !installationId) {
    return null;
  }

  return {
    organizationId,
    installationId,
  };
}

// Hook to get just the estate ID (for backward compatibility)
export function useInstallationId(): string {
  const params = useParams({ strict: false });
  const installationId = params.installationId;

  if (!installationId) {
    throw new Error(
      "useInstallationId() can only be used on pages with estate ID in the URL path (/:organizationId/:installationId/*)",
    );
  }

  return installationId;
}

export function useOrganizationId(): string {
  const params = useParams({ strict: false });
  const organizationId = params.organizationId;

  if (!organizationId) {
    throw new Error(
      "useOrganizationId() can only be used on pages with organization ID in the URL path (/:organizationId/:installationId/*)",
    );
  }

  return organizationId;
}

// Hook to format navigation URLs with current org/estate
export function useInstallationUrl() {
  const params = useParams({ strict: false });
  const organizationId = params.organizationId;
  const installationId = params.installationId;

  return (path: string) => {
    if (!organizationId || !installationId) {
      throw new Error(
        "useInstallationUrl() can only be used on pages with organization and estate ID in the URL path (/:organizationId/:installationId/*)",
      );
    }

    // Remove leading slash if present
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;

    // Return the full path with org and estate
    return `/${organizationId}/${installationId}${cleanPath ? `/${cleanPath}` : ""}`;
  };
}
