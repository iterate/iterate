- **Dotted client surface (defect 24) — blocked by capnweb RpcTarget dispatch**: wrapping the
  returned Itx in a Proxy(pathProxy) does NOT intercept — capnweb resolves `stub.a.b.c(x)`
  against the RpcTarget's OWN method resolution (prototype methods), not dynamic property access
  through a wrapper, so `itx.whoami()` still errors "'whoami' is not a function" (verified live,
  reverted). The replayOnto proof works only because OUR RetainedCallbackInvoker does the
  Reflect.get explicitly. Options: (a) a capnweb feature request for dynamic-method RpcTargets;
  (b) accept the explicit doors (invokeCapability/invoke, both working) as the surface and drop
  24; (c) a thin client-side path-proxy helper (but that reintroduces a client SDK — violates
  the just-capnweb invariant). Needs an owner decision; NOT a guard.
