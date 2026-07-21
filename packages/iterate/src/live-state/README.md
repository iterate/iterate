# Live state

`iterate/live-state` is a small, project-independent live-value protocol built
on Cap'n Web. A server owns a `LiveState`, exposes it through
`LiveStateRpcTarget`, and clients receive one snapshot followed by structural
patches. Revision gaps trigger a fresh subscription instead of applying
possibly-corrupt state.

The React binding is a separate entry so server bundles never pull React:

```tsx
import { newWebSocketRpcSession, type RpcStub } from "@iterate-com/capnweb";
import type { LiveStateRpc } from "iterate/live-state";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "iterate/live-state/react";

type Api = {
  liveState: LiveStateRpc<{ count: number }>;
  increment(): Promise<void>;
};

const makeConnection = () => newWebSocketRpcSession<Api>("wss://example.com/api");

function App() {
  const api = useCapnWebRoot<RpcStub<Api>>();
  const { value, status } = useLiveState(
    (root: RpcStub<Api>) => root.liveState,
    (state) => state.count,
  );
  return <button onClick={() => api?.increment()}>{status === "live" ? value : "…"}</button>;
}

root.render(
  <CapnWebProvider makeConnection={makeConnection}>
    <App />
  </CapnWebProvider>,
);
```

`CapnWebProvider` owns the root returned by `makeConnection`, observes
`onRpcBroken`, disposes broken roots, and reconnects with bounded backoff. The
factory may dial directly or return a duplicate from an existing lower-level
connection keeper. `useLiveState(..., ..., ..., { root })` is the explicit,
borrowed-root escape hatch; the hook never disposes that override.
