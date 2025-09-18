import { useParams } from "react-router";

export interface EstateParams {
  organizationId: string;
  estateId: string;
}

// Simple hook to get estate params from URL
// Access checking is now done in the loader
export function useEstate(): EstateParams | null {
  const params = useParams();

  const organizationId = params.organizationId;
  const estateId = params.estateId;

  if (!organizationId || !estateId) {
    return null;
  }

  return {
    organizationId,
    estateId,
  };
}

// Hook to get just the estate ID (for backward compatibility)
export function useEstateId(): string {
  const params = useParams();
  const estateId = params.estateId;

  if (!estateId) {
    throw new Error(
      "useEstateId() can only be used on pages with estate ID in the URL path (/:organizationId/:estateId/*)",
    );
  }

  return estateId;
}

// Hook to format navigation URLs with current org/estate
export function useEstateUrl() {
  const params = useParams();
  const organizationId = params.organizationId;
  const estateId = params.estateId;

  return (path: string) => {
    if (!organizationId || !estateId) {
      throw new Error(
        "useEstateUrl() can only be used on pages with organization and estate ID in the URL path (/:organizationId/:estateId/*)",
      );
    }

    // Remove leading slash if present
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;

    // Return the full path with org and estate
    return `/${organizationId}/${estateId}${cleanPath ? `/${cleanPath}` : ""}`;
  };
}
