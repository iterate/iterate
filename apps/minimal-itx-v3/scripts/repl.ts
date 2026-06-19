import repl from "node:repl";
import process from "node:process";

import { RpcTarget } from "capnweb";
import {
  connectItx,
  DEFAULT_ITX_BASE_URL,
  type ProjectItxRpc,
  type RootRpc,
  type RpcStub,
} from "../src/client.ts";

const baseUrl = (
  process.env.ITX_BASE ||
  process.env.APP_CONFIG_BASE_URL ||
  DEFAULT_ITX_BASE_URL
).replace(/\/+$/, "");
const projectId = process.env.ITX_PROJECT_ID || "prj_ref";
const token = process.env.ITX_TOKEN || "alice-token";
const adminToken = process.env.ITX_ADMIN_TOKEN || "root-token";

const unauthenticated = connectItx({ baseUrl });
const root = unauthenticated.authenticate({
  auth: { type: "token", token: adminToken },
}) as RpcStub<RootRpc>;
await root.projects.create(projectId);

const itx = unauthenticated.authenticate({
  auth: { type: "token", token },
  projectId,
}) as RpcStub<ProjectItxRpc>;

const server = repl.start({
  ignoreUndefined: true,
  prompt: `itx:${projectId}/> `,
  useGlobal: true,
});

Object.assign(server.context, {
  RpcTarget,
  baseUrl,
  itx,
  projectId,
  root,
  token,
  unauthenticated,
});

server.on("exit", () => {
  itx[Symbol.dispose]?.();
  root[Symbol.dispose]?.();
  unauthenticated[Symbol.dispose]?.();
});
