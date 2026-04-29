/**
 * Returns the logo path based on VITE_APP_STAGE environment.
 * - prd: black/white logo
 * - preview: purple logo
 * - dev (default): yellow logo
 */
export function getEnvLogo(): string {
  const stage = import.meta.env.VITE_APP_STAGE;

  if (["prd", "production", "prod"].includes(stage)) {
    return "/logo-prd.svg";
  }

  if (["preview"].includes(stage)) {
    return "/logo-preview.svg";
  }

  // Default to dev
  return "/logo-dev.svg";
}
