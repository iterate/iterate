// A minimal PUBLIC capnweb API — the remote target that proves itx.connectToCapnweb(url) works.
// Serves an RpcTarget at /api (newWorkersRpcResponse handles both the WS upgrade and the one-shot
// HTTP batch POST that itx.connectToCapnweb's newHttpBatchRpcSession sends).
import { newWorkersRpcResponse, RpcTarget } from "capnweb";

// A NESTED RpcTarget — reachable via `.math`, so a genuine MULTI-HOP capnweb chain exists
// (`connectToCapnweb(url).math.add(2,3)`): one property hop THEN a call. Passed by reference
// (capnweb serializes an RpcTarget as a capability), so `.math` is a real pipelined intermediate.
class MathApi extends RpcTarget {
  add(a, b) {
    return a + b;
  }
}

class DummyApi extends RpcTarget {
  hello(name) {
    return `hi ${name} from dummy-capnweb`;
  }
  add(a, b) {
    return a + b;
  }
  get math() {
    return new MathApi();
  }
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return newWorkersRpcResponse(request, new DummyApi());
    return new Response("dummy capnweb — POST /api (hello, add, math.add)\n");
  },
};
