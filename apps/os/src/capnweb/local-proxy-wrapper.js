export const LOCAL_PROXY_CALLER_MARK = "__localProxyCaller";
const TRANSPARENT_RPC_ROOTS = new Set([
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
 * 3. When `ctx.slack.chat.postMessage(...)` reaches a marker, this wrapper
 *    uses a local path proxy. Every property read after the marker root records
 *    another path segment, and the final function call invokes:
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
  return pathProxy(value.call);
}

function lift(value) {
  if (isLocalProxyCaller(value)) return adapt(value);
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  if (isThenable(value) && typeof value !== "function") return pendingValueProxy(value, value, []);

  // This Proxy is client-side only. Cloudflare Workers RPC and Cap'n Web both
  // already use JavaScript Proxy objects for remote stubs:
  // - https://developers.cloudflare.com/workers/runtime-apis/rpc/
  // - https://github.com/cloudflare/capnweb
  //
  // We wrap the stub/promise locally so property reads on an unresolved RPC
  // promise still pipeline through to the eventual value, but we do not change
  // ordinary RPC semantics. The only special case is a value marked by
  // localProxyCaller(), which becomes an SDK-shaped local path proxy. This is
  // why normal calls such as ctx.projects.get(id).describe() still dispatch
  // through the runtime stub, while marker values can support Slack-style
  // unknown paths such as ctx.slack.chat.postMessage(...).
  return new Proxy(value, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      if (typeof key === "string" && TRANSPARENT_RPC_ROOTS.has(key)) {
        return member;
      }
      if (isLocalProxyCaller(member) || isThenable(member)) {
        return isThenable(member) ? pendingValueProxy(member, member, []) : lift(member);
      }
      return member;
    },

    apply(target, thisArg, args) {
      return lift(Reflect.apply(target, thisArg, args));
    },
  });
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
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
