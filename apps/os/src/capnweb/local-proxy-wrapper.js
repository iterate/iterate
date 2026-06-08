export const LOCAL_PROXY_CALLER_MARK = "__localProxyCaller";
const BUILT_IN_RPC_ROOTS = new Set([
  "project",
  "projects",
  "repos",
  "streams",
  "worker",
  "workspace",
]);

/**
 * This file is intentionally a small JavaScript indulgence.
 *
 * Workers RPC and Cap'n Web already make normal RpcTarget instances feel local:
 *
 *   await ctx.projects.get("proj_123").streams.read({ streamPath: "/events" })
 *
 * We do not want to change that path's semantics. The wrapper may proxy normal
 * objects so it can notice when a promise resolves to a marker, but only marker
 * values get SDK-style path behavior. Ordinary RPC members still dispatch
 * through their own runtime stubs.
 *
 * The one place where we deliberately cheat is SDK-shaped APIs whose method
 * tree is not known ahead of time. Slack is the motivating example. The Slack
 * WebClient type exposes calls like:
 *
 *   await slack.chat.postMessage({ channel, text })
 *   await slack.conversations.history({ channel })
 *
 * We want an AI agent to write exactly that shape, and ideally type it against
 * the published Slack SDK types. We do not want to predeclare every Slack
 * namespace and method as Worker RPC methods.
 *
 * The trick is:
 *
 * 1. A server-side getter/method returns this marker object:
 *
 *      localProxyCaller(({ path, args }) => runSdkCall(path, args))
 *
 *    The marker is plain data, so it crosses RPC by value. Its `call` function
 *    crosses RPC by reference, so invoking it still runs on the server with the
 *    closure that created it. This is intentionally just a function, not a
 *    tiny RpcTarget class. The function already is the capability.
 *
 * 2. Client-side code wraps an RPC stub once:
 *
 *      const ctx = liftLocalProxies(await env.ITERATE.context)
 *
 * 3. When `ctx.slack.chat.postMessage(...)` starts from an unresolved RPC
 *    promise, this wrapper records the path but does not assume Slack yet. The
 *    final function call waits for the original promise. Only if that promise
 *    resolves to a marker do we invoke:
 *
 *      call({ path: ["chat", "postMessage"], args: [{ channel, text }] })
 *
 * This is a trick, and a slightly indulgent one, but it keeps the ordinary RPC
 * model clean. No marker means no SDK path proxy. If this helper is absent,
 * callers can still use the boring explicit shape, for example:
 *
 *   await (await ctx.slack).call({ path: ["chat", "postMessage"], args: [{ channel, text }] })
 */
export function localProxyCaller(call) {
  return { [LOCAL_PROXY_CALLER_MARK]: true, call };
}

export function liftLocalProxies(value) {
  return lift(value);
}

export function isLocalProxyCaller(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value[LOCAL_PROXY_CALLER_MARK] === true &&
    typeof value.call === "function"
  );
}

export function callLocalProxyCaller(value, input) {
  return value.call(input);
}

function adapt(value) {
  if (!isLocalProxyCaller(value)) return value;
  // Regression guard:
  // - Unit: local-proxy-wrapper.test.ts
  //   "supports SDK-shaped calls through a pending ... local proxy marker"
  // - Browser e2e: captnweb.browser.test.ts
  //   "calls a browser-owned Slack SDK-shaped local proxy marker"
  //
  // This is the only place where the helper intentionally changes a value's
  // behavior. A marker is plain data saying "turn this one awaited value into
  // an SDK-shaped path recorder". Ordinary Cap'n Web / Workers RPC stubs must
  // not come through here.
  return pathProxy(value.call);
}

function lift(value) {
  if (isLocalProxyCaller(value)) return adapt(value);
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  // Native promises are not callable, so treating a top-level one as a pending
  // marker candidate cannot reproduce the production REPL bug. The regression
  // was specifically a callable Cap'n Web root (`newWebSocketRpcSession(...)`)
  // whose synthetic `.then` member made the old helper think the whole root was
  // a promise before `ctx.projects.list({ limit: 5 })` had a chance to dispatch.
  //
  // Regression guard:
  // - local-proxy-wrapper.test.ts
  //   "does not even read a callable RPC root then member..."
  if (typeof value === "object" && isThenable(value)) {
    return pendingValueProxy(value, value, []);
  }

  // This Proxy is client-side only and deliberately transparent for built-in
  // Cap'n Web roots. The one exception is unknown top-level roots, which are
  // how mounted provider SDKs enter the context. Example: `ctx.slack` is not a
  // real IterateContext prototype method, it is a mounted root that resolves to
  // localProxyCaller(...).
  //
  // Cloudflare Workers RPC and Cap'n Web both already use JavaScript Proxy
  // objects for remote stubs:
  // - https://developers.cloudflare.com/workers/runtime-apis/rpc/
  // - https://github.com/cloudflare/capnweb
  //
  // Built-in roots stay raw so normal RPC promise-pipelining remains owned by
  // Cap'n Web:
  //
  //   await ctx.projects.list({ limit: 5 })
  //   await ctx.projects.get(id).describe()
  //
  // Unknown roots get pending SDK recording:
  //
  //   await ctx.slack.chat.postMessage({ channel, text })
  //
  // The pending recorder still waits for `ctx.slack` to resolve before doing
  // anything. If that value is not localProxyCaller(...), it falls back to the
  // captured normal member/call path.
  //
  // Regression guard:
  // - Unit: local-proxy-wrapper.test.ts
  //   "does not treat ordinary callable proxy targets as promises..."
  // - Unit: browser-repl.test.ts
  //   "default snippet uses Cap'n Web promise pipelining"
  // - Browser e2e: captnweb.browser.test.ts
  //   "runs the default browser REPL project list expression"
  //
  // Those tests cover the production failure where the browser REPL evaluated
  // `await ctx.projects.list({ limit: 5 })` and the wrapper accidentally
  // treated a callable Cap'n Web root proxy's synthetic `then` member as a
  // promise. The built-in root table is intentionally a narrow boundary: known
  // Iterate RPC roots are left to Cap'n Web, while unknown mounted roots can
  // still opt into the SDK recorder by resolving to localProxyCaller(...).
  return new Proxy(value, {
    get(target, key, receiver) {
      if (key === "then" && typeof target === "function") {
        // Promise machinery probes `.then`. Cap'n Web's callable root proxies
        // can synthesize arbitrary string members, including `then`, but that
        // must not make the lifted root itself thenable. This exact probe is
        // pinned by local-proxy-wrapper.test.ts:
        // "does not even read a callable RPC root then member..."
        return undefined;
      }

      const member = Reflect.get(target, key, receiver);
      if (typeof key === "string" && BUILT_IN_RPC_ROOTS.has(key)) {
        return member;
      }
      return liftReturnValue(member);
    },

    apply(target, thisArg, args) {
      return liftReturnValue(Reflect.apply(target, thisArg, args));
    },
  });
}

function liftReturnValue(value) {
  if (isLocalProxyCaller(value)) return adapt(value);
  // This is where unknown roots such as `ctx.slack` become eligible for
  // SDK-shaped path recording. Known Iterate roots are filtered out one level
  // above, so ordinary Cap'n Web promises below `ctx.projects` / `ctx.project`
  // do not pass through this helper at all.
  //
  // Regression guard:
  // - local-proxy-wrapper.test.ts
  //   "supports SDK-shaped calls through a pending ... local proxy marker"
  // - browser-repl.test.ts
  //   "REPL supports pre-await Slack SDK-shaped local proxy calls"
  if (isThenable(value)) return pendingValueProxy(value, value, []);
  return value;
}

function isThenable(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return typeof value.then === "function";
  } catch {
    // Unit test "does not even read a callable RPC root then member..." uses a
    // throwing getter to make this failure mode loud. If a random object makes
    // `.then` hostile, it is safer to leave it alone than to classify it as an
    // SDK marker candidate.
    return false;
  }
}

function pendingValueProxy(value, rootPromise, path) {
  const fn = (...args) => invokePendingValue(value, rootPromise, path, args);
  return new Proxy(fn, {
    get(target, key, receiver) {
      if (key === "then") {
        return (onFulfilled, onRejected) =>
          rootPromise.then(
            (resolved) => {
              const next = isLocalProxyCaller(resolved)
                ? pathProxy(resolved.call, path)
                : path.length === 0
                  ? resolved
                  : (value ?? resolvePath(resolved, path));
              return Promise.resolve(next).then((final) =>
                onFulfilled ? onFulfilled(adapt(final)) : adapt(final),
              );
            },
            (error) => onRejected?.(error),
          );
      }

      if (typeof key === "symbol" || key in target) {
        return Reflect.get(target, key, receiver);
      }

      // This is the pending Slack SDK path recorder. The key rule is that
      // recording does not mean execution. `ctx.slack.chat.postMessage` records
      // ["chat", "postMessage"], but invokePendingValue below still waits for
      // `ctx.slack` and only calls the recorded path when it resolves to a
      // localProxyCaller marker. If it resolves to a normal RPC/JS object,
      // fallback dispatch uses the captured member or the resolved object path.
      //
      // Regression guard:
      // - captnweb.browser.test.ts
      //   "calls a browser-owned Slack SDK-shaped local proxy marker"
      const member = value == null ? undefined : Reflect.get(value, key);
      return pendingValueProxy(member, rootPromise, [...path, key]);
    },

    apply(_target, _thisArg, args) {
      return invokePendingValue(value, rootPromise, path, args);
    },
  });
}

function invokePendingValue(value, rootPromise, path, args) {
  return lift(
    rootPromise.then((resolved) => {
      if (isLocalProxyCaller(resolved)) {
        return callLocalProxyCaller(resolved, { path, args });
      }
      return Reflect.apply(value ?? resolvePath(resolved, path), undefined, args);
    }),
  );
}

function resolvePath(value, path) {
  let current = value;
  for (const part of path) {
    current = Reflect.get(current, part);
  }
  return current;
}

function pathProxy(call, path = []) {
  const fn = (...args) => invokeLocalProxyCall(call, { path, args });

  // The path proxy is a local convenience object, not the server capability
  // itself. Disposing it should release the by-reference `call` stub when the
  // underlying RPC implementation exposes a disposer. If it does not, disposal
  // is intentionally a no-op.
  Object.defineProperty(fn, Symbol.dispose, {
    configurable: true,
    value() {
      call[Symbol.dispose]?.();
    },
  });

  if (Symbol.asyncDispose) {
    Object.defineProperty(fn, Symbol.asyncDispose, {
      configurable: true,
      async value() {
        if (call[Symbol.asyncDispose]) {
          await call[Symbol.asyncDispose]();
          return;
        }
        call[Symbol.dispose]?.();
      },
    });
  }

  // This Proxy is the deliberate "infinite SDK path" object. We cannot model a
  // Slack-style SDK as Worker RPC prototype methods because the namespace tree
  // is not known ahead of time. The Cap'n Web README documents that RPC stubs
  // themselves are Proxies, and the Workers RPC docs describe stubs as Proxy
  // objects, but this object is not a remote stub. It is a local recorder:
  // each property read appends one path segment, and the final function call
  // invokes the by-reference `call` capability with { path, args }. Returning
  // undefined for `then` is essential so `await ctx.slack` does not treat the
  // path proxy as a promise and accidentally call the remote SDK.
  //
  // References:
  // - https://github.com/cloudflare/capnweb
  // - https://developers.cloudflare.com/workers/runtime-apis/rpc/
  return new Proxy(fn, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target) {
        return Reflect.get(target, key, receiver);
      }

      // Promise machinery probes `then`. Returning another function proxy here
      // would make the SDK proxy accidentally thenable and break `await`.
      if (key === "then") return undefined;

      return pathProxy(call, [...path, key]);
    },

    apply(_target, _thisArg, args) {
      return invokeLocalProxyCall(call, { path, args });
    },
  });
}

function invokeLocalProxyCall(call, input) {
  return call(input);
}
