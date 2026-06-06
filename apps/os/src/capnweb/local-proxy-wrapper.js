export const LOCAL_PROXY_CALLER_MARK = "__localProxyCaller";

/**
 * This file is intentionally a small JavaScript indulgence.
 *
 * Workers RPC and Cap'n Web already make normal RpcTarget instances feel local:
 *
 *   await ctx.projects.get("proj_123").streams.read({ streamPath: "/events" })
 *
 * We do not want to interfere with that path. If a value is a normal RPC stub,
 * this wrapper should behave like a transparent pass-through.
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
 * 3. When `await ctx.slack` resolves to the marker, this wrapper swaps it for a
 *    local path proxy. Every property read just records another path segment,
 *    and the final function call invokes:
 *
 *      call({ path: ["chat", "postMessage"], args: [{ channel, text }] })
 *
 * This is a trick, and a slightly indulgent one, but it keeps the ordinary RPC
 * model clean. No marker means no SDK path proxy. If this helper is absent,
 * callers can still use the boring explicit shape, for example:
 *
 *   await ctx.slack.call({ path: ["chat", "postMessage"], args: [{ channel, text }] })
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

  return new Proxy(value, {
    get(target, key, receiver) {
      if (key === "then" && typeof target.then === "function") {
        return (onFulfilled, onRejected) =>
          target.then(
            (resolved) => (onFulfilled ? onFulfilled(adapt(resolved)) : adapt(resolved)),
            (error) => onRejected?.(error),
          );
      }

      if (typeof target.then === "function") {
        return lift(target.then((resolved) => Reflect.get(adapt(resolved), key)));
      }

      const member = Reflect.get(target, key, receiver);
      if (
        isLocalProxyCaller(member) ||
        (member && typeof member === "object" && typeof member.then === "function")
      ) {
        return lift(member);
      }
      return member;
    },

    apply(target, thisArg, args) {
      if (typeof target.then === "function") {
        return lift(target.then((resolved) => Reflect.apply(adapt(resolved), undefined, args)));
      }
      return lift(Reflect.apply(target, thisArg, args));
    },
  });
}

function pathProxy(call, path = []) {
  const fn = (...args) => invokeLocalProxyCall(call, { path, args });

  // The path proxy is a local convenience object, not the server capability
  // itself. Disposing it should release the by-reference `call` stub when the
  // underlying RPC implementation exposes a disposer. If it does not, disposal
  // is intentionally a no-op so `using sdk = await ctx.slack` works in both
  // Node and dynamic workers.
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
