import repl from "node:repl";
import process from "node:process";

import { RpcTarget } from "capnweb";
import { DEFAULT_ITX_BASE_URL, withItx, withRoot } from "../src/client.ts";

const baseUrl = (
  process.env.ITX_BASE ||
  process.env.APP_CONFIG_BASE_URL ||
  DEFAULT_ITX_BASE_URL
).replace(/\/+$/, "");
const projectId = process.env.ITX_PROJECT_ID || "prj_ref";
const token = process.env.ITX_TOKEN || "alice-token";
const adminToken = process.env.ITX_ADMIN_TOKEN || "root-token";

const root = withRoot({ baseUrl, token: adminToken });
await root.projects.create(projectId);

const itx = withItx({ baseUrl, projectId, token });

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
});

server.on("exit", () => {
  itx[Symbol.dispose]?.();
  root[Symbol.dispose]?.();
});
