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

export function createOrpcContext(env: WsTest2ServiceEnv): WsTest2Context {
  return {
    env,
    serviceName,
  };
}
