import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import WebSocket from "ws";

import type { FakeIterateCapability } from "./capability.ts";
import type { PrototypeScriptInput } from "./scripts.ts";

type CliInput = {
  adminApiSecret: string;
  baseUrl: string;
  script: string;
  vars: PrototypeScriptInput["vars"];
};

const input = JSON.parse(process.argv[2] ?? "null") as CliInput | null;
if (!input) {
  throw new Error(
    'Usage: tsx cli.ts \'{"adminApiSecret":"...","baseUrl":"http://...","script":"...","vars":{...}}\'',
  );
}

const ctx = connectPrototypeContext(input);
try {
  const script = (0, eval)(`(${input.script})`) as (input: {
    ctx: RpcStub<FakeIterateCapability>;
    vars: PrototypeScriptInput["vars"];
  }) => Promise<unknown>;
  console.log(
    JSON.stringify(
      await script({
        ctx,
        vars: input.vars,
      }),
    ),
  );
} finally {
  ctx[Symbol.dispose]?.();
}

function connectPrototypeContext(input: CliInput) {
  const wsUrl = new URL("/api/capability-prototype", input.baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<FakeIterateCapability>(
    new WebSocket(wsUrl.toString(), {
      headers: {
        Authorization: `Bearer ${input.adminApiSecret}`,
      },
    }) as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}
