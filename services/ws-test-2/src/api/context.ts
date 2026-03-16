import {
  getWsTest2ServiceEnv,
  wsTest2ServiceManifest,
  type WsTest2ServiceEnv,
} from "../manifest.ts";

export const serviceName = wsTest2ServiceManifest.serviceName;

export interface WsTest2Context {
  env: WsTest2ServiceEnv;
}

let cachedEnv: WsTest2ServiceEnv | null = null;

export function getEnv() {
  cachedEnv ??= getWsTest2ServiceEnv();
  return cachedEnv;
}
