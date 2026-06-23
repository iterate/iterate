import repl from "node:repl";
import process from "node:process";

import { RpcTarget } from "capnweb";
import {
  connectItx,
  DEFAULT_ITX_BASE_URL,
  type ItxAuthToken,
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
const token = parseTokenEnv("ITX_TOKEN", {
  principal: "alice",
  projectScopes: ["prj_alice", "prj_ref"],
  type: "user",
});
const adminToken = parseTokenEnv("ITX_ADMIN_TOKEN", { principal: "root", type: "admin" });

const unauthenticated = connectItx({ baseUrl });
const root = unauthenticated.authenticate({
  type: "token",
  token: adminToken,
}) as unknown as RpcStub<RootRpc>;
await root.projects.create({ projectId, slug: projectId });

const userRoot = unauthenticated.authenticate({
  type: "token",
  token,
}) as unknown as RpcStub<RootRpc>;
const itx = userRoot.projects.get(projectId) as unknown as RpcStub<ProjectItxRpc>;

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
  userRoot,
});

server.on("exit", () => {
  itx[Symbol.dispose]?.();
  root[Symbol.dispose]?.();
  userRoot[Symbol.dispose]?.();
  unauthenticated[Symbol.dispose]?.();
});

function parseTokenEnv(
  name: "ITX_ADMIN_TOKEN" | "ITX_TOKEN",
  fallback: ItxAuthToken,
): ItxAuthToken {
  const value = process.env[name]?.trim();
  return value ? (JSON.parse(value) as ItxAuthToken) : fallback;
}
