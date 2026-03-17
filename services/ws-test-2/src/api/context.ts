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

export function createContext(
  raw: Record<string, string | undefined> = process.env,
): WsTest2Context {
  return {
    env: getWsTest2ServiceEnv(raw),
  };
}

export function getEnv() {
  cachedEnv ??= getWsTest2ServiceEnv();
  return cachedEnv;
}
