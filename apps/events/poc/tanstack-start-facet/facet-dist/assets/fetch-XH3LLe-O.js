function e(e) {
  return e[0] ?? {};
}
function t(e) {
  return Array.isArray(e) ? e : e == null ? [] : [e];
}
function n(e) {
  return typeof e.bytes == `function` ? e.bytes() : e.arrayBuffer();
}
var r = `orpc`,
  i = `@orpc/shared`,
  a = `1.14.0`,
  o = class extends Error {
    constructor(...e) {
      (super(...e), (this.name = `AbortError`));
    }
  };
function s(e) {
  let t;
  return () => {
    if (t) return t.result;
    let n = e();
    return ((t = { result: n }), n);
  };
}
function c(e) {
  let t = Promise.resolve();
  return (...n) => (t = t.catch(() => {}).then(() => e(...n)));
}
var l = 2,
  ee = `__${i}@${a}/otel/config__`;
function u() {
  return globalThis[ee];
}
function d(e, t = {}, n) {
  return u()?.tracer?.startSpan(e, t, n);
}
function f(e, t, n = {}) {
  if (!e) return;
  let r = te(t);
  (e.recordException(r),
    (!n.signal?.aborted || n.signal.reason !== t) && e.setStatus({ code: l, message: r.message }));
}
function te(e) {
  if (e instanceof Error) {
    let t = { message: e.message, name: e.name, stack: e.stack };
    return (
      `code` in e && (typeof e.code == `string` || typeof e.code == `number`) && (t.code = e.code),
      t
    );
  }
  return { message: String(e) };
}
async function p({ name: e, context: t, ...n }, r) {
  let i = u()?.tracer;
  if (!i) return r();
  let a = async (e) => {
    try {
      return await r(e);
    } catch (t) {
      throw (f(e, t, n), t);
    } finally {
      e.end();
    }
  };
  return t ? i.startActiveSpan(e, n, t, a) : i.startActiveSpan(e, n, a);
}
async function m(e, t) {
  let n = u();
  if (!e || !n) return t();
  let r = n.trace.setSpan(n.context.active(), e);
  return n.context.with(r, t);
}
var ne = class {
  openIds = new Set();
  queues = new Map();
  waiters = new Map();
  get length() {
    return this.openIds.size;
  }
  get waiterIds() {
    return Array.from(this.waiters.keys());
  }
  hasBufferedItems(e) {
    return !!this.queues.get(e)?.length;
  }
  open(e) {
    this.openIds.add(e);
  }
  isOpen(e) {
    return this.openIds.has(e);
  }
  push(e, t) {
    this.assertOpen(e);
    let n = this.waiters.get(e);
    if (n?.length) (n.shift()[0](t), n.length === 0 && this.waiters.delete(e));
    else {
      let n = this.queues.get(e);
      n ? n.push(t) : this.queues.set(e, [t]);
    }
  }
  async pull(e) {
    this.assertOpen(e);
    let t = this.queues.get(e);
    if (t?.length) {
      let n = t.shift();
      return (t.length === 0 && this.queues.delete(e), n);
    }
    return new Promise((t, n) => {
      let r = this.waiters.get(e),
        i = [t, n];
      r ? r.push(i) : this.waiters.set(e, [i]);
    });
  }
  close({ id: e, reason: t } = {}) {
    if (e === void 0) {
      (this.waiters.forEach((e, n) => {
        let r =
          t ?? new o(`[AsyncIdQueue] Queue[${n}] was closed or aborted while waiting for pulling.`);
        e.forEach(([, e]) => e(r));
      }),
        this.waiters.clear(),
        this.openIds.clear(),
        this.queues.clear());
      return;
    }
    let n =
      t ?? new o(`[AsyncIdQueue] Queue[${e}] was closed or aborted while waiting for pulling.`);
    (this.waiters.get(e)?.forEach(([, e]) => e(n)),
      this.waiters.delete(e),
      this.openIds.delete(e),
      this.queues.delete(e));
  }
  assertOpen(e) {
    if (!this.isOpen(e))
      throw Error(`[AsyncIdQueue] Cannot access queue[${e}] because it is not open or aborted.`);
  }
};
function h(e) {
  return !e || typeof e != `object`
    ? !1
    : `next` in e &&
        typeof e.next == `function` &&
        Symbol.asyncIterator in e &&
        typeof e[Symbol.asyncIterator] == `function`;
}
var re = Symbol.asyncDispose ?? Symbol.for(`asyncDispose`),
  g = class {
    #e = !1;
    #t = !1;
    #n;
    #r;
    constructor(e, t) {
      ((this.#n = t),
        (this.#r = c(async () => {
          if (this.#e) return { done: !0, value: void 0 };
          try {
            let t = await e();
            return (t.done && (this.#e = !0), t);
          } catch (e) {
            throw ((this.#e = !0), e);
          } finally {
            this.#e && !this.#t && ((this.#t = !0), await this.#n(`next`));
          }
        })));
    }
    next() {
      return this.#r();
    }
    async return(e) {
      return (
        (this.#e = !0), this.#t || ((this.#t = !0), await this.#n(`return`)), { done: !0, value: e }
      );
    }
    async throw(e) {
      throw ((this.#e = !0), this.#t || ((this.#t = !0), await this.#n(`throw`)), e);
    }
    async [re]() {
      ((this.#e = !0), this.#t || ((this.#t = !0), await this.#n(`dispose`)));
    }
    [Symbol.asyncIterator]() {
      return this;
    }
  };
function _({ name: e, ...t }, n) {
  let r;
  return new g(
    async () => {
      r ??= d(e);
      try {
        let e = await m(r, () => n.next());
        return (r?.addEvent(e.done ? `completed` : `yielded`), e);
      } catch (e) {
        throw (f(r, e, t), e);
      }
    },
    async (e) => {
      try {
        e !== `next` && (await m(r, () => n.return?.()));
      } catch (e) {
        throw (f(r, e, t), e);
      } finally {
        r?.end();
      }
    },
  );
}
var ie = class {
  index = BigInt(1);
  generate() {
    let e = this.index.toString(36);
    return (this.index++, e);
  }
};
function v(e, t, n) {
  let r = (t, i) => {
    let a = e[i];
    return a ? a({ ...t, next: (e = t) => r(e, i + 1) }) : n(t);
  };
  return r(t, 0);
}
function y(e) {
  if (e) return JSON.parse(e);
}
function b(e) {
  return JSON.stringify(e);
}
function ae(e) {
  return S(e) ? Object.getPrototypeOf(e)?.constructor : null;
}
function x(e) {
  if (!e || typeof e != `object`) return !1;
  let t = Object.getPrototypeOf(e);
  return t === Object.prototype || !t || !t.constructor;
}
function S(e) {
  return !!e && (typeof e == `object` || typeof e == `function`);
}
function C(e) {
  if (Array.isArray(e)) return e.map(C);
  if (x(e)) {
    let t = {};
    for (let n in e) t[n] = C(e[n]);
    for (let n of Object.getOwnPropertySymbols(e)) t[n] = C(e[n]);
    return t;
  }
  return e;
}
function oe(e, t) {
  let n = e;
  for (let e of t) {
    if (!S(n)) return;
    n = n[e];
  }
  return n;
}
var se = (() => {
  let e = function () {};
  return ((e.prototype = Object.create(null)), Object.freeze(e.prototype), e);
})();
function w(e, ...t) {
  return typeof e == `function` ? e(...t) : e;
}
function T(e) {
  return new Proxy(e, {
    get(e, t, n) {
      let r = Reflect.get(e, t, n);
      return t !== `then` || typeof r != `function`
        ? r
        : new Proxy(r, {
            apply(t, n, r) {
              if (r.length !== 2 || r.some((e) => !le(e))) return Reflect.apply(t, n, r);
              let i = !0;
              r[0].call(
                n,
                T(
                  new Proxy(e, {
                    get: (e, t, n) => {
                      if (i && t === `then`) {
                        i = !1;
                        return;
                      }
                      return Reflect.get(e, t, n);
                    },
                  }),
                ),
              );
            },
          });
    },
  });
}
var ce = /^\s*function\s*\(\)\s*\{\s*\[native code\]\s*\}\s*$/;
function le(e) {
  return typeof e == `function` && ce.test(e.toString());
}
function ue(e) {
  try {
    return decodeURIComponent(e);
  } catch {
    return e;
  }
}
var de = `@orpc/client`,
  fe = `1.14.0`,
  E = {
    BAD_REQUEST: { status: 400, message: `Bad Request` },
    UNAUTHORIZED: { status: 401, message: `Unauthorized` },
    FORBIDDEN: { status: 403, message: `Forbidden` },
    NOT_FOUND: { status: 404, message: `Not Found` },
    METHOD_NOT_SUPPORTED: { status: 405, message: `Method Not Supported` },
    NOT_ACCEPTABLE: { status: 406, message: `Not Acceptable` },
    TIMEOUT: { status: 408, message: `Request Timeout` },
    CONFLICT: { status: 409, message: `Conflict` },
    PRECONDITION_FAILED: { status: 412, message: `Precondition Failed` },
    PAYLOAD_TOO_LARGE: { status: 413, message: `Payload Too Large` },
    UNSUPPORTED_MEDIA_TYPE: { status: 415, message: `Unsupported Media Type` },
    UNPROCESSABLE_CONTENT: { status: 422, message: `Unprocessable Content` },
    TOO_MANY_REQUESTS: { status: 429, message: `Too Many Requests` },
    CLIENT_CLOSED_REQUEST: { status: 499, message: `Client Closed Request` },
    INTERNAL_SERVER_ERROR: { status: 500, message: `Internal Server Error` },
    NOT_IMPLEMENTED: { status: 501, message: `Not Implemented` },
    BAD_GATEWAY: { status: 502, message: `Bad Gateway` },
    SERVICE_UNAVAILABLE: { status: 503, message: `Service Unavailable` },
    GATEWAY_TIMEOUT: { status: 504, message: `Gateway Timeout` },
  };
function pe(e, t) {
  return t ?? E[e]?.status ?? 500;
}
function me(e, t) {
  return t || E[e]?.message || e;
}
var D = Symbol.for(`__${de}@${fe}/error/ORPC_ERROR_CONSTRUCTORS__`);
globalThis[D] ??= new WeakSet();
var O = globalThis[D],
  k = class extends Error {
    defined;
    code;
    status;
    data;
    constructor(t, ...n) {
      let r = e(n);
      if (r.status !== void 0 && !j(r.status))
        throw Error(`[ORPCError] Invalid error status code.`);
      let i = me(t, r.message);
      (super(i, r),
        (this.code = t),
        (this.status = pe(t, r.status)),
        (this.defined = r.defined ?? !1),
        (this.data = r.data));
    }
    toJSON() {
      return {
        defined: this.defined,
        code: this.code,
        status: this.status,
        message: this.message,
        data: this.data,
      };
    }
    static [Symbol.hasInstance](e) {
      if (O.has(this)) {
        let t = ae(e);
        if (t && O.has(t)) return !0;
      }
      return super[Symbol.hasInstance](e);
    }
  };
O.add(k);
function A(e) {
  return e instanceof k
    ? e
    : new k(`INTERNAL_SERVER_ERROR`, { message: `Internal server error`, cause: e });
}
function j(e) {
  return e < 200 || e >= 400;
}
function M(e) {
  if (!x(e)) return !1;
  let t = [`defined`, `code`, `status`, `message`, `data`];
  return Object.keys(e).some((e) => !t.includes(e))
    ? !1
    : `defined` in e &&
        typeof e.defined == `boolean` &&
        `code` in e &&
        typeof e.code == `string` &&
        `status` in e &&
        typeof e.status == `number` &&
        j(e.status) &&
        `message` in e &&
        typeof e.message == `string`;
}
function N(e, t = {}) {
  return new k(e.code, { ...t, ...e });
}
var P = class extends TypeError {},
  he = class extends TypeError {},
  F = class extends Error {
    data;
    constructor(e) {
      (super(e?.message ?? `An error event was received`, e), (this.data = e?.data));
    }
  };
function ge(e) {
  let t = e.replace(/\n+$/, ``).split(/\n/),
    n = { data: void 0, event: void 0, id: void 0, retry: void 0, comments: [] };
  for (let e of t) {
    let t = e.indexOf(`:`),
      r = t === -1 ? e : e.slice(0, t),
      i = t === -1 ? `` : e.slice(t + 1).replace(/^\s/, ``);
    if (t === 0) n.comments.push(i);
    else if (r === `data`)
      ((n.data ??= ``),
        (n.data += `${i}
`));
    else if (r === `event`) n.event = i;
    else if (r === `id`) n.id = i;
    else if (r === `retry`) {
      let e = Number.parseInt(i);
      Number.isInteger(e) && e >= 0 && e.toString() === i && (n.retry = e);
    }
  }
  return ((n.data = n.data?.replace(/\n$/, ``)), n);
}
var _e = class {
    constructor(e = {}) {
      this.options = e;
    }
    incomplete = ``;
    feed(e) {
      this.incomplete += e;
      let t = this.incomplete.lastIndexOf(`

`);
      if (t === -1) return;
      let n = this.incomplete.slice(0, t).split(/\n\n/);
      this.incomplete = this.incomplete.slice(t + 2);
      for (let e of n) {
        let t = ge(`${e}

`);
        this.options.onEvent && this.options.onEvent(t);
      }
    }
    end() {
      if (this.incomplete) throw new he(`Event Iterator ended before complete`);
    }
  },
  ve = class extends TransformStream {
    constructor() {
      let e;
      super({
        start(t) {
          e = new _e({
            onEvent: (e) => {
              t.enqueue(e);
            },
          });
        },
        transform(t) {
          e.feed(t);
        },
        flush() {
          e.end();
        },
      });
    }
  };
function I(e) {
  if (
    e.includes(`
`)
  )
    throw new P(`Event's id must not contain a newline character`);
}
function ye(e) {
  if (
    e.includes(`
`)
  )
    throw new P(`Event's event must not contain a newline character`);
}
function L(e) {
  if (!Number.isInteger(e) || e < 0) throw new P(`Event's retry must be a integer and >= 0`);
}
function R(e) {
  if (
    e.includes(`
`)
  )
    throw new P(`Event's comment must not contain a newline character`);
}
function be(e) {
  let t = e?.split(/\n/) ?? [],
    n = ``;
  for (let e of t)
    n += `data: ${e}
`;
  return n;
}
function xe(e) {
  let t = ``;
  for (let n of e ?? [])
    (R(n),
      (t += `: ${n}
`));
  return t;
}
function z(e) {
  let t = ``;
  return (
    (t += xe(e.comments)),
    e.event !== void 0 &&
      (ye(e.event),
      (t += `event: ${e.event}
`)),
    e.retry !== void 0 &&
      (L(e.retry),
      (t += `retry: ${e.retry}
`)),
    e.id !== void 0 &&
      (I(e.id),
      (t += `id: ${e.id}
`)),
    (t += be(e.data)),
    (t += `
`),
    t
  );
}
var B = Symbol(`ORPC_EVENT_SOURCE_META`);
function V(e, t) {
  if (t.id === void 0 && t.retry === void 0 && !t.comments?.length) return e;
  if ((t.id !== void 0 && I(t.id), t.retry !== void 0 && L(t.retry), t.comments !== void 0))
    for (let e of t.comments) R(e);
  return new Proxy(e, {
    get(e, n, r) {
      return n === B ? t : Reflect.get(e, n, r);
    },
  });
}
function H(e) {
  return S(e) ? Reflect.get(e, B) : void 0;
}
function U(e, t = `inline`) {
  return `${t}; filename="${e.replace(/[^\x20-\x7E]/g, `_`).replace(/"/g, `\\"`)}"; filename*=utf-8''${encodeURIComponent(
    e,
  )
    .replace(/['()*]/g, (e) => `%${e.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (e, t) => String.fromCharCode(Number.parseInt(t, 16)))}`;
}
function W(e) {
  let t = e.match(/filename\*=(UTF-8'')?([^;]*)/i);
  if (t && typeof t[2] == `string`) return ue(t[2]);
  let n = e.match(/filename="((?:\\"|[^"])*)"/i);
  if (n && typeof n[1] == `string`) return n[1].replace(/\\"/g, `"`);
}
function G(e, n) {
  let r = { ...e };
  for (let e in n)
    Array.isArray(n[e])
      ? (r[e] = [...t(r[e]), ...n[e]])
      : n[e] !== void 0 &&
        (Array.isArray(r[e])
          ? (r[e] = [...r[e], n[e]])
          : r[e] === void 0
            ? (r[e] = n[e])
            : (r[e] = [r[e], n[e]]));
  return r;
}
function K(e) {
  if (typeof e == `string` || e === void 0) return e;
  if (e.length !== 0) return e.join(`, `);
}
function Se(e) {
  return !!(
    K(e[`content-type`])?.startsWith(`text/event-stream`) && K(e[`content-disposition`]) === void 0
  );
}
function q(e, t) {
  let n = async (e) => {
    let n = await t.error(e);
    if (n !== e) {
      let t = H(e);
      t && S(n) && (n = V(n, t));
    }
    return n;
  };
  return new g(
    async () => {
      let { done: r, value: i } = await (async () => {
          try {
            return await e.next();
          } catch (e) {
            throw await n(e);
          }
        })(),
        a = await t.value(i, r);
      if (a !== i) {
        let e = H(i);
        e && S(a) && (a = V(a, e));
      }
      return { done: r, value: a };
    },
    async () => {
      try {
        await e.return?.();
      } catch (e) {
        throw await n(e);
      }
    },
  );
}
function Ce(e) {
  return { ...e, context: e.context ?? {} };
}
function J(e, t = {}) {
  let n = t.path ?? [];
  return T(
    new Proxy(async (...[t, r = {}]) => await e.call(n, t, Ce(r)), {
      get(r, i) {
        return typeof i == `string` ? J(e, { ...t, path: [...n, i] }) : Reflect.get(r, i);
      },
    }),
  );
}
function we(e, t = {}) {
  let n = e?.pipeThrough(new TextDecoderStream()).pipeThrough(new ve())?.getReader(),
    r,
    i = !1;
  return new g(
    async () => {
      r ??= d(`consume_event_iterator_stream`);
      try {
        for (;;) {
          if (n === void 0) return { done: !0, value: void 0 };
          let { done: e, value: t } = await m(r, () => n.read());
          if (e) {
            if (i) throw new o(`Stream was cancelled`);
            return { done: !0, value: void 0 };
          }
          switch (t.event) {
            case `message`: {
              let e = y(t.data);
              return (S(e) && (e = V(e, t)), r?.addEvent(`message`), { done: !1, value: e });
            }
            case `error`: {
              let e = new F({ data: y(t.data) });
              throw ((e = V(e, t)), r?.addEvent(`error`), e);
            }
            case `done`: {
              let e = y(t.data);
              return (S(e) && (e = V(e, t)), r?.addEvent(`done`), { done: !0, value: e });
            }
            default:
              r?.addEvent(`maybe_keepalive`);
          }
        }
      } catch (e) {
        throw (e instanceof F || f(r, e, t), e);
      }
    },
    async (e) => {
      try {
        (e !== `next` && ((i = !0), r?.addEvent(`cancelled`)), await m(r, () => n?.cancel()));
      } catch (e) {
        throw (f(r, e, t), e);
      } finally {
        r?.end();
      }
    },
  );
}
function Te(e, t = {}) {
  let n = t.eventIteratorKeepAliveEnabled ?? !0,
    r = t.eventIteratorKeepAliveInterval ?? 5e3,
    i = t.eventIteratorKeepAliveComment ?? ``,
    a = t.eventIteratorInitialCommentEnabled ?? !0,
    o = t.eventIteratorInitialComment ?? ``,
    s = !1,
    c,
    l;
  return new ReadableStream({
    start(e) {
      ((l = d(`stream_event_iterator`)), a && e.enqueue(z({ comments: [o] })));
    },
    async pull(t) {
      try {
        n &&
          (c = setInterval(() => {
            (t.enqueue(z({ comments: [i] })), l?.addEvent(`keepalive`));
          }, r));
        let a = await m(l, () => e.next());
        if ((clearInterval(c), s)) return;
        let o = H(a.value);
        if (!a.done || a.value !== void 0 || o !== void 0) {
          let e = a.done ? `done` : `message`;
          (t.enqueue(z({ ...o, event: e, data: b(a.value) })), l?.addEvent(e));
        }
        a.done && (t.close(), l?.end());
      } catch (e) {
        if ((clearInterval(c), s)) return;
        (e instanceof F
          ? (t.enqueue(z({ ...H(e), event: `error`, data: b(e.data) })),
            l?.addEvent(`error`),
            t.close())
          : (f(l, e), t.error(e)),
          l?.end());
      }
    },
    async cancel() {
      try {
        ((s = !0), clearInterval(c), l?.addEvent(`cancelled`), await m(l, () => e.return?.()));
      } catch (e) {
        throw (f(l, e), e);
      } finally {
        l?.end();
      }
    },
  }).pipeThrough(new TextEncoderStream());
}
function Ee(e, t = {}) {
  return p({ name: `parse_standard_body`, signal: t.signal }, async () => {
    let n = e.headers.get(`content-disposition`);
    if (typeof n == `string`) {
      let t = W(n) ?? `blob`,
        r = await e.blob();
      return new File([r], t, { type: r.type });
    }
    let r = e.headers.get(`content-type`);
    if (!r || r.startsWith(`application/json`)) return y(await e.text());
    if (r.startsWith(`multipart/form-data`)) return await e.formData();
    if (r.startsWith(`application/x-www-form-urlencoded`)) {
      let t = await e.text();
      return new URLSearchParams(t);
    }
    if (r.startsWith(`text/event-stream`)) return we(e.body, t);
    if (r.startsWith(`text/plain`)) return await e.text();
    let i = await e.blob();
    return new File([i], `blob`, { type: i.type });
  });
}
function De(e, t, n = {}) {
  if (e instanceof ReadableStream) return e;
  let r = t.get(`content-disposition`);
  if ((t.delete(`content-type`), t.delete(`content-disposition`), e !== void 0))
    return e instanceof Blob
      ? (t.set(`content-type`, e.type),
        t.set(`content-length`, e.size.toString()),
        t.set(`content-disposition`, r ?? U(e instanceof File ? e.name : `blob`)),
        e)
      : e instanceof FormData || e instanceof URLSearchParams
        ? e
        : h(e)
          ? (t.set(`content-type`, `text/event-stream`), Te(e, n))
          : (t.set(`content-type`, `application/json`), b(e));
}
function Y(e, t = {}) {
  return (
    e.forEach((e, n) => {
      Array.isArray(t[n]) ? t[n].push(e) : t[n] === void 0 ? (t[n] = e) : (t[n] = [t[n], e]);
    }),
    t
  );
}
function Oe(e, t = new Headers()) {
  for (let [n, r] of Object.entries(e))
    if (Array.isArray(r)) for (let e of r) t.append(n, e);
    else r !== void 0 && t.append(n, r);
  return t;
}
function ke(e, t = {}) {
  let n = Oe(e.headers),
    r = De(e.body, n, t);
  return new Request(e.url, { signal: e.signal, method: e.method, headers: n, body: r });
}
function Ae(e, t = {}) {
  return {
    body: s(() => Ee(e, t)),
    status: e.status,
    get headers() {
      let t = Y(e.headers);
      return (Object.defineProperty(this, `headers`, { value: t, writable: !0 }), t);
    },
    set headers(e) {
      Object.defineProperty(this, `headers`, { value: e, writable: !0 });
    },
  };
}
var X = class {
    plugins;
    constructor(e = []) {
      this.plugins = [...e].sort((e, t) => (e.order ?? 0) - (t.order ?? 0));
    }
    init(e) {
      for (let t of this.plugins) t.init?.(e);
    }
  },
  Z = class {
    constructor(e, n, r = {}) {
      ((this.codec = e),
        (this.sender = n),
        new X(r.plugins).init(r),
        (this.interceptors = t(r.interceptors)),
        (this.clientInterceptors = t(r.clientInterceptors)));
    }
    interceptors;
    clientInterceptors;
    call(e, t, n) {
      return p(
        { name: `${r}.${e.join(`/`)}`, signal: n.signal },
        (i) => (
          i?.setAttribute(`rpc.system`, r),
          i?.setAttribute(`rpc.method`, e.join(`.`)),
          h(t) && (t = _({ name: `consume_event_iterator_input`, signal: n.signal }, t)),
          v(this.interceptors, { ...n, path: e, input: t }, async ({ path: e, input: t, ...n }) => {
            let r = u(),
              a,
              o = r?.trace.getActiveSpan() ?? i;
            o && r && (a = r?.trace.setSpan(r.context.active(), o));
            let s = await p({ name: `encode_request`, context: a }, () =>
                this.codec.encode(e, t, n),
              ),
              c = await v(
                this.clientInterceptors,
                { ...n, input: t, path: e, request: s },
                ({ input: e, path: t, request: n, ...r }) =>
                  p({ name: `send_request`, signal: r.signal, context: a }, () =>
                    this.sender.call(n, r, t, e),
                  ),
              ),
              l = await p({ name: `decode_response`, context: a }, () =>
                this.codec.decode(c, n, e, t),
              );
            return h(l) ? _({ name: `consume_event_iterator_output`, signal: n.signal }, l) : l;
          })
        ),
      );
    }
  },
  Q = { BIGINT: 0, DATE: 1, NAN: 2, UNDEFINED: 3, URL: 4, REGEXP: 5, SET: 6, MAP: 7 },
  je = class {
    customSerializers;
    constructor(e = {}) {
      if (
        ((this.customSerializers = e.customJsonSerializers ?? []),
        this.customSerializers.length !== new Set(this.customSerializers.map((e) => e.type)).size)
      )
        throw Error(`Custom serializer type must be unique.`);
    }
    serialize(e, t = [], n = [], r = [], i = []) {
      for (let a of this.customSerializers)
        if (a.condition(e)) {
          let o = this.serialize(a.serialize(e), t, n, r, i);
          return (n.push([a.type, ...t]), o);
        }
      if (e instanceof Blob) return (r.push(t), i.push(e), [e, n, r, i]);
      if (typeof e == `bigint`) return (n.push([Q.BIGINT, ...t]), [e.toString(), n, r, i]);
      if (e instanceof Date)
        return (
          n.push([Q.DATE, ...t]),
          Number.isNaN(e.getTime()) ? [null, n, r, i] : [e.toISOString(), n, r, i]
        );
      if (Number.isNaN(e)) return (n.push([Q.NAN, ...t]), [null, n, r, i]);
      if (e instanceof URL) return (n.push([Q.URL, ...t]), [e.toString(), n, r, i]);
      if (e instanceof RegExp) return (n.push([Q.REGEXP, ...t]), [e.toString(), n, r, i]);
      if (e instanceof Set) {
        let a = this.serialize(Array.from(e), t, n, r, i);
        return (n.push([Q.SET, ...t]), a);
      }
      if (e instanceof Map) {
        let a = this.serialize(Array.from(e.entries()), t, n, r, i);
        return (n.push([Q.MAP, ...t]), a);
      }
      if (Array.isArray(e))
        return [
          e.map((e, a) =>
            e === void 0
              ? (n.push([Q.UNDEFINED, ...t, a]), null)
              : this.serialize(e, [...t, a], n, r, i)[0],
          ),
          n,
          r,
          i,
        ];
      if (x(e)) {
        let a = {};
        for (let o in e)
          (o === `toJSON` && typeof e[o] == `function`) ||
            (a[o] = this.serialize(e[o], [...t, o], n, r, i)[0]);
        return [a, n, r, i];
      }
      return [e, n, r, i];
    }
    deserialize(e, t, n, r) {
      let i = { data: e };
      n &&
        r &&
        n.forEach((e, t) => {
          let n = i,
            a = `data`;
          (e.forEach((e) => {
            if (((n = n[a]), (a = e), !Object.hasOwn(n, a)))
              throw Error(
                `Security error: accessing non-existent path during deserialization. Path segment: ${a}`,
              );
          }),
            (n[a] = r(t)));
        });
      for (let e of t) {
        let t = e[0],
          n = i,
          r = `data`;
        for (let t = 1; t < e.length; t++)
          if (((n = n[r]), (r = e[t]), !Object.hasOwn(n, r)))
            throw Error(
              `Security error: accessing non-existent path during deserialization. Path segment: ${r}`,
            );
        for (let e of this.customSerializers)
          if (e.type === t) {
            n[r] = e.deserialize(n[r]);
            break;
          }
        switch (t) {
          case Q.BIGINT:
            n[r] = BigInt(n[r]);
            break;
          case Q.DATE:
            n[r] = new Date(n[r] ?? `Invalid Date`);
            break;
          case Q.NAN:
            n[r] = NaN;
            break;
          case Q.UNDEFINED:
            n[r] = void 0;
            break;
          case Q.URL:
            n[r] = new URL(n[r]);
            break;
          case Q.REGEXP: {
            let [, e, t] = n[r].match(/^\/(.*)\/([a-z]*)$/);
            n[r] = new RegExp(e, t);
            break;
          }
          case Q.SET:
            n[r] = new Set(n[r]);
            break;
          case Q.MAP:
            n[r] = new Map(n[r]);
            break;
        }
      }
      return i.data;
    }
  };
function $(e) {
  return `/${e.map(encodeURIComponent).join(`/`)}`;
}
function Me(e) {
  return typeof e.forEach == `function` ? Y(e) : e;
}
function Ne(e) {
  return Object.entries(E).find(([, t]) => t.status === e)?.[0] ?? `MALFORMED_ORPC_ERROR_RESPONSE`;
}
var Pe = class {
    constructor(e, t) {
      ((this.serializer = e),
        (this.baseUrl = t.url),
        (this.maxUrlLength = t.maxUrlLength ?? 2083),
        (this.fallbackMethod = t.fallbackMethod ?? `POST`),
        (this.expectedMethod = t.method ?? this.fallbackMethod),
        (this.headers = t.headers ?? {}));
    }
    baseUrl;
    maxUrlLength;
    fallbackMethod;
    expectedMethod;
    headers;
    async encode(e, t, n) {
      let r = Me(await w(this.headers, n, e, t));
      n.lastEventId !== void 0 && (r = G(r, { "last-event-id": n.lastEventId }));
      let i = await w(this.expectedMethod, n, e, t),
        a = await w(this.baseUrl, n, e, t),
        o = new URL(a);
      o.pathname = `${o.pathname.replace(/\/$/, ``)}${$(e)}`;
      let s = this.serializer.serialize(t);
      if (i === `GET` && !(s instanceof FormData) && !h(s)) {
        let a = await w(this.maxUrlLength, n, e, t),
          c = new URL(o);
        if ((c.searchParams.append(`data`, b(s)), c.toString().length <= a))
          return { body: void 0, method: i, headers: r, url: c, signal: n.signal };
      }
      return {
        url: o,
        method: i === `GET` ? this.fallbackMethod : i,
        headers: r,
        body: s,
        signal: n.signal,
      };
    }
    async decode(e) {
      let t = !j(e.status),
        n = await (async () => {
          let t = !1;
          try {
            let n = await e.body();
            return ((t = !0), this.serializer.deserialize(n));
          } catch (e) {
            throw Error(
              t
                ? `Invalid RPC response format.`
                : `Cannot parse response body, please check the response body and content-type.`,
              { cause: e },
            );
          }
        })();
      if (!t)
        throw M(n) ? N(n) : new k(Ne(e.status), { status: e.status, data: { ...e, body: n } });
      return n;
    }
  },
  Fe = class {
    constructor(e) {
      this.jsonSerializer = e;
    }
    serialize(e) {
      return h(e)
        ? q(e, {
            value: async (e) => this.#e(e, !1),
            error: async (e) => new F({ data: this.#e(A(e).toJSON(), !1), cause: e }),
          })
        : this.#e(e, !0);
    }
    #e(e, t) {
      let [n, r, i, a] = this.jsonSerializer.serialize(e),
        o = r.length === 0 ? void 0 : r;
      if (!t || a.length === 0) return { json: n, meta: o };
      let s = new FormData();
      return (
        s.set(`data`, b({ json: n, meta: o, maps: i })),
        a.forEach((e, t) => {
          s.set(t.toString(), e);
        }),
        s
      );
    }
    deserialize(e) {
      return h(e)
        ? q(e, {
            value: async (e) => this.#t(e),
            error: async (e) => {
              if (!(e instanceof F)) return e;
              let t = this.#t(e.data);
              return M(t) ? N(t, { cause: e }) : new F({ data: t, cause: e });
            },
          })
        : this.#t(e);
    }
    #t(e) {
      if (e === void 0) return;
      if (!(e instanceof FormData)) return this.jsonSerializer.deserialize(e.json, e.meta ?? []);
      let t = JSON.parse(e.get(`data`));
      return this.jsonSerializer.deserialize(t.json, t.meta ?? [], t.maps, (t) =>
        e.get(t.toString()),
      );
    }
  },
  Ie = class extends Z {
    constructor(e, t) {
      let n = new Pe(new Fe(new je(t)), t);
      super(n, e, t);
    }
  },
  Le = class extends X {
    initRuntimeAdapter(e) {
      for (let t of this.plugins) t.initRuntimeAdapter?.(e);
    }
  },
  Re = class {
    fetch;
    toFetchRequestOptions;
    adapterInterceptors;
    constructor(e) {
      (new Le(e.plugins).initRuntimeAdapter(e),
        (this.fetch = e.fetch ?? globalThis.fetch.bind(globalThis)),
        (this.toFetchRequestOptions = e),
        (this.adapterInterceptors = t(e.adapterInterceptors)));
    }
    async call(e, t, n, r) {
      let i = ke(e, this.toFetchRequestOptions);
      return Ae(
        await v(
          this.adapterInterceptors,
          { ...t, request: i, path: n, input: r, init: { redirect: `manual` } },
          ({ request: e, path: t, input: n, init: r, ...i }) => this.fetch(e, r, i, t, n),
        ),
        { signal: i.signal },
      );
    }
  },
  ze = class extends Ie {
    constructor(e) {
      let t = new Re(e);
      super(t, e);
    }
  };
export {
  h as A,
  w as B,
  ne as C,
  C as D,
  ie as E,
  p as F,
  f as I,
  d as L,
  S as M,
  n as N,
  oe as O,
  m as P,
  b as R,
  A as S,
  se as T,
  V as _,
  Ne as a,
  M as b,
  J as c,
  K as d,
  U as f,
  G as g,
  Se as h,
  Ie as i,
  x as j,
  u as k,
  q as l,
  W as m,
  ze as n,
  $ as o,
  H as p,
  Z as r,
  Me as s,
  Re as t,
  F as u,
  k as v,
  g as w,
  j as x,
  N as y,
  t as z,
};
