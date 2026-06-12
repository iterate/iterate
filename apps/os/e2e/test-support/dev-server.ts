import { readLocalDevServerInfo } from "@iterate-com/shared/alchemy/local-dev-server";

export function localDevServerBaseUrl(appRoot: string) {
  return readLocalDevServerInfo(appRoot, { requireLive: true })?.baseUrl.replace(/\/+$/, "");
}
