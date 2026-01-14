/**
 * Returns the logo path based on VITE_APP_STAGE environment.
 * - prd: black/white logo
 * - stg: purple logo
 * - dev (default): yellow logo
 */
export function getEnvLogo(): string {
  const stage = import.meta.env.VITE_APP_STAGE;

  if (["prd", "production", "prod"].includes(stage)) {
    return "/logo-prd.svg";
  }

  if (["stg", "staging"].includes(stage)) {
    return "/logo-stg.svg";
  }

  // Default to dev
  return "/logo-dev.svg";
}
