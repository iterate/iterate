import {
  wsTest2ServiceManifest,
  type WsTest2ServiceEnv as WsTest2Env,
} from "@iterate-com/ws-test-2-contract";

export const serviceName = wsTest2ServiceManifest.serviceName;
export type { WsTest2Env };

export interface WsTest2Context {
  env: WsTest2Env;
  serviceName: string;
}

export function createOrpcContext(env: WsTest2Env): WsTest2Context {
  return {
    env,
    serviceName,
  };
}
