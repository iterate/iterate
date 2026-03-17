import {
  getWsTest2ServiceEnv,
  wsTest2ServiceManifest,
  type WsTest2ServiceEnv,
} from "../manifest.ts";

export const serviceName = wsTest2ServiceManifest.serviceName;

export interface WsTest2Context {
  env: WsTest2ServiceEnv;
  serviceName: string;
}

let cachedEnv: WsTest2ServiceEnv | null = null;

export function createContext(raw: Record<string, string | undefined>): WsTest2Context {
  return {
    env: getWsTest2ServiceEnv(raw),
    serviceName,
  };
}

export function getEnv() {
  cachedEnv ??= getWsTest2ServiceEnv();
  return cachedEnv;
}
