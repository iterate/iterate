import { readLocalDevServerInfo } from "@iterate-com/shared/alchemy/local-dev-server";

/**
 * The deployment under test: `APP_CONFIG_BASE_URL` (from the Doppler config)
 * or, for local dev, the dev-server discovery file written by `pnpm dev`.
 * See docs/testing.md.
 */
export function resolveBaseUrl(appRoot: string): string | undefined {
  return (
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    readLocalDevServerInfo(appRoot, { requireLive: true })?.baseUrl.replace(/\/+$/, "")
  );
}
