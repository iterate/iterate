// A minimal PUBLIC capnweb API — the remote target that proves itx.connectToCapnweb(url) works.
// Serves an RpcTarget at /api (newWorkersRpcResponse handles both the WS upgrade and the one-shot
// HTTP batch POST that itx.connectToCapnweb's newHttpBatchRpcSession sends).
import { newWorkersRpcResponse, RpcTarget } from "capnweb";

class DummyApi extends RpcTarget {
  hello(name) {
    return `hi ${name} from dummy-capnweb`;
  }
  add(a, b) {
    return a + b;
  }
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return newWorkersRpcResponse(request, new DummyApi());
    return new Response("dummy capnweb — POST /api (hello, add)\n");
  },
};
