import { i as e, n as t, t as n } from "./jsx-runtime-ByY1xr43.js";
import {
  A as r,
  C as i,
  D as a,
  E as o,
  F as s,
  I as c,
  L as l,
  M as u,
  N as d,
  P as f,
  R as p,
  _ as m,
  c as h,
  d as g,
  f as _,
  h as v,
  i as y,
  k as b,
  m as x,
  n as S,
  p as C,
  u as w,
  w as T,
} from "./fetch-CaJINV1a.js";
var E = e(t()),
  D = /^http:\/\/orpc\//,
  O = ((e) => (
    (e[(e.REQUEST = 1)] = `REQUEST`),
    (e[(e.RESPONSE = 2)] = `RESPONSE`),
    (e[(e.EVENT_ITERATOR = 3)] = `EVENT_ITERATOR`),
    (e[(e.ABORT_SIGNAL = 4)] = `ABORT_SIGNAL`),
    e
  ))(O || {});
function k(e, t, n) {
  if (t === 3) {
    let r = n;
    return { i: e, t, p: { e: r.event, d: r.data, m: r.meta } };
  }
  if (t === 4) return { i: e, t, p: n };
  let r = n;
  return {
    i: e,
    p: {
      u: r.url.toString().replace(D, `/`),
      b: r.body,
      h: Object.keys(r.headers).length > 0 ? r.headers : void 0,
      m: r.method === `POST` ? void 0 : r.method,
    },
  };
}
function A(e) {
  let t = e.i,
    n = e.t;
  if (n === 3) {
    let r = e.p;
    return [t, n, { event: r.e, data: r.d, meta: r.m }];
  }
  if (n === 4) return [t, n, e.p];
  let r = e.p;
  return [t, 2, { status: r.s ?? 200, headers: r.h ?? {}, body: r.b }];
}
async function j(e, t, n) {
  if (t === 3 || t === 4) return I(k(e, t, n));
  let r = n,
    { body: i, headers: a } = await N(r.body, r.headers),
    o = k(e, 1, { ...r, body: i instanceof Blob ? void 0 : i, headers: a });
  return i instanceof Blob ? I(o, i) : I(o);
}
async function M(e) {
  let { json: t, buffer: n } = await L(e),
    [r, i, a] = A(t);
  if (i === 3 || i === 4) return [r, i, a];
  let o = a,
    s = await P(o.headers, o.body, n);
  return [r, i, { ...o, body: s }];
}
async function N(e, t) {
  let n = { ...t },
    i = n[`content-disposition`];
  if ((delete n[`content-type`], delete n[`content-disposition`], e instanceof Blob))
    return (
      (n[`content-type`] = e.type),
      (n[`content-disposition`] = i ?? _(e instanceof File ? e.name : `blob`)),
      { body: e, headers: n }
    );
  if (e instanceof FormData) {
    let t = new Response(e);
    return (
      (n[`content-type`] = t.headers.get(`content-type`)), { body: await t.blob(), headers: n }
    );
  }
  return e instanceof URLSearchParams
    ? ((n[`content-type`] = `application/x-www-form-urlencoded`),
      { body: e.toString(), headers: n })
    : r(e)
      ? ((n[`content-type`] = `text/event-stream`), { body: void 0, headers: n })
      : { body: e, headers: n };
}
async function P(e, t, n) {
  let r = g(e[`content-type`]),
    i = g(e[`content-disposition`]);
  if (typeof i == `string`) {
    let e = x(i) ?? `blob`;
    return new File(n === void 0 ? [] : [n], e, { type: r });
  }
  return r?.startsWith(`multipart/form-data`)
    ? new Response(n, { headers: { "content-type": r } }).formData()
    : r?.startsWith(`application/x-www-form-urlencoded`) && typeof t == `string`
      ? new URLSearchParams(t)
      : t;
}
var F = 255;
async function I(e, t) {
  let n = p(e);
  return t === void 0 || t.size === 0
    ? n
    : d(new Blob([new TextEncoder().encode(n), new Uint8Array([F]), t]));
}
async function L(e) {
  if (typeof e == `string`) return { json: JSON.parse(e) };
  let t = e instanceof Uint8Array ? e : new Uint8Array(e),
    n = t.indexOf(F);
  if (n === -1) {
    let e = new TextDecoder().decode(t);
    return { json: JSON.parse(e) };
  }
  let r = new TextDecoder().decode(t.subarray(0, n)),
    i = t.subarray(n + 1);
  return { json: JSON.parse(r), buffer: i };
}
function R(e, t, n, r = {}) {
  let i;
  return new T(
    async () => {
      i ??= l(`consume_event_iterator_stream`);
      try {
        let n = await f(i, () => e.pull(t));
        switch (n.event) {
          case `message`: {
            let e = n.data;
            return (
              n.meta && u(e) && (e = m(e, n.meta)), i?.addEvent(`message`), { value: e, done: !1 }
            );
          }
          case `error`: {
            let e = new w({ data: n.data });
            throw (n.meta && (e = m(e, n.meta)), i?.addEvent(`error`), e);
          }
          case `done`: {
            let e = n.data;
            return (
              n.meta && u(e) && (e = m(e, n.meta)), i?.addEvent(`done`), { value: e, done: !0 }
            );
          }
        }
      } catch (e) {
        throw (e instanceof w || c(i, e, r), e);
      }
    },
    async (e) => {
      try {
        (e !== `next` && i?.addEvent(`cancelled`), await f(i, () => n(e)));
      } catch (e) {
        throw (c(i, e, r), e);
      } finally {
        i?.end();
      }
    },
  );
}
function z(e, t) {
  return s({ name: `stream_event_iterator` }, async (n) => {
    for (;;) {
      let r = await (async () => {
          try {
            let { value: t, done: r } = await e.next();
            return r
              ? (n?.addEvent(`done`), { event: `done`, data: t, meta: C(t) })
              : (n?.addEvent(`message`), { event: `message`, data: t, meta: C(t) });
          } catch (e) {
            if (e instanceof w)
              return (n?.addEvent(`error`), { event: `error`, data: e.data, meta: C(e) });
            try {
              await t({ event: `error`, data: void 0 });
            } catch (t) {
              throw (c(n, e), t);
            }
            throw e;
          }
        })(),
        i = !1;
      try {
        let n = await t(r);
        if (r.event === `done` || r.event === `error`) return;
        if (n === `abort`) {
          ((i = !0), await e.return?.());
          return;
        }
      } catch (t) {
        if (!i)
          try {
            await e.return?.();
          } catch (e) {
            throw (c(n, t), e);
          }
        throw t;
      }
    }
  });
}
var B = class {
    peer;
    constructor(e) {
      this.peer = new V(async ([t, n, r]) => {
        await e(await j(t, n, r));
      });
    }
    get length() {
      return this.peer.length;
    }
    open(e) {
      return this.peer.open(e);
    }
    async request(e) {
      return this.peer.request(e);
    }
    async message(e) {
      return this.peer.message(await M(e));
    }
    close(e = {}) {
      return this.peer.close(e);
    }
  },
  V = class {
    idGenerator = new o();
    responseQueue = new i();
    serverEventIteratorQueue = new i();
    serverControllers = new Map();
    cleanupFns = new Map();
    send;
    constructor(e) {
      this.send = async (t) => {
        let n = t[0];
        this.serverControllers.has(n) && (await e(t));
      };
    }
    get length() {
      return (
        (+this.responseQueue.length +
          this.serverEventIteratorQueue.length +
          this.serverControllers.size +
          this.cleanupFns.size) /
        4
      );
    }
    open(e) {
      (this.serverEventIteratorQueue.open(e), this.responseQueue.open(e));
      let t = new AbortController();
      return (this.serverControllers.set(e, t), this.cleanupFns.set(e, []), t);
    }
    async request(e) {
      let t = e.signal;
      return s({ name: `send_peer_request`, signal: t }, async () => {
        if (t?.aborted) throw t.reason;
        let n = this.idGenerator.generate(),
          i = this.open(n);
        try {
          let o = b();
          if (o) {
            let t = a(e.headers);
            (o.propagation.inject(o.context.active(), t), (e = { ...e, headers: t }));
          }
          if ((await this.send([n, O.REQUEST, e]), t?.aborted))
            throw (await this.send([n, O.ABORT_SIGNAL, void 0]), t.reason);
          let s;
          if (
            (t?.addEventListener(
              `abort`,
              (s = async () => {
                (await this.send([n, O.ABORT_SIGNAL, void 0]),
                  this.close({ id: n, reason: t.reason }));
              }),
              { once: !0 },
            ),
            this.cleanupFns.get(n)?.push(() => {
              t?.removeEventListener(`abort`, s);
            }),
            r(e.body))
          ) {
            let t = e.body;
            z(t, async (e) =>
              i.signal.aborted ? `abort` : (await this.send([n, O.EVENT_ITERATOR, e]), `next`),
            );
          }
          let c = await this.responseQueue.pull(n);
          if (v(c.headers)) {
            let e = R(
              this.serverEventIteratorQueue,
              n,
              async (e) => {
                try {
                  e !== `next` && (await this.send([n, O.ABORT_SIGNAL, void 0]));
                } finally {
                  this.close({ id: n });
                }
              },
              { signal: t },
            );
            return { ...c, body: e };
          }
          return (this.close({ id: n }), c);
        } catch (e) {
          throw (this.close({ id: n, reason: e }), e);
        }
      });
    }
    async message([e, t, n]) {
      if (t === O.ABORT_SIGNAL) {
        this.serverControllers.get(e)?.abort();
        return;
      }
      if (t === O.EVENT_ITERATOR) {
        this.serverEventIteratorQueue.isOpen(e) && this.serverEventIteratorQueue.push(e, n);
        return;
      }
      this.responseQueue.isOpen(e) && this.responseQueue.push(e, n);
    }
    close(e = {}) {
      (e.id === void 0
        ? (this.serverControllers.forEach((t) => t.abort(e.reason)),
          this.serverControllers.clear(),
          this.cleanupFns.forEach((e) => e.forEach((e) => e())),
          this.cleanupFns.clear())
        : (this.serverControllers.get(e.id)?.abort(e.reason),
          this.serverControllers.delete(e.id),
          this.cleanupFns.get(e.id)?.forEach((e) => e()),
          this.cleanupFns.delete(e.id)),
        this.responseQueue.close(e),
        this.serverEventIteratorQueue.close(e));
    }
  },
  H = 0,
  U = class {
    peer;
    constructor(e) {
      let t = new Promise((t) => {
        e.websocket.readyState === H
          ? e.websocket.addEventListener(
              `open`,
              () => {
                t();
              },
              { once: !0 },
            )
          : t();
      });
      ((this.peer = new B(async (n) => (await t, e.websocket.send(n)))),
        e.websocket.addEventListener(`message`, async (e) => {
          let t = e.data instanceof Blob ? await d(e.data) : e.data;
          this.peer.message(t);
        }),
        e.websocket.addEventListener(`close`, () => {
          this.peer.close();
        }));
    }
    async call(e, t, n, r) {
      let i = await this.peer.request(e);
      return { ...i, body: () => Promise.resolve(i.body) };
    }
  },
  W = class extends y {
    constructor(e) {
      let t = new U(e);
      super(t, { ...e, url: `http://orpc` });
    }
  },
  G = n();
function K() {
  return h(new S({ url: `${window.location.origin}/api/rpc` }));
}
function q() {
  let e = new URL(`/api/rpc-ws`, window.location.origin);
  e.protocol = e.protocol === `https:` ? `wss:` : `ws:`;
  let t = new WebSocket(e.toString());
  return { client: h(new W({ websocket: t })), close: () => t.close() };
}
function J() {
  let [e, t] = (0, E.useState)(`openapi`),
    [n, r] = (0, E.useState)(20),
    [i, a] = (0, E.useState)(50),
    [o, s] = (0, E.useState)(300),
    [c, l] = (0, E.useState)([]),
    [u, d] = (0, E.useState)(`idle`),
    [f, p] = (0, E.useState)(null),
    m = (0, E.useRef)(null),
    h = (0, E.useRef)(null);
  (0, E.useEffect)(() => {
    m.current && (m.current.scrollTop = m.current.scrollHeight);
  }, [c]);
  async function g() {
    h.current?.abort();
    let t = new AbortController();
    ((h.current = t), l([]), p(null), d(`connecting`));
    let r = { count: n, minDelayMs: i, maxDelayMs: o },
      a = e === `websocket` ? q() : { client: K(), close: () => {} };
    try {
      let e = await a.client.test.randomLogStream(r, { signal: t.signal });
      d(`streaming`);
      for await (let n of e) {
        if (t.signal.aborted) return;
        l((e) => [...e, n].slice(-500));
      }
      t.signal.aborted || d(`completed`);
    } catch (e) {
      t.signal.aborted || (p(e.message || String(e)), d(`error`));
    } finally {
      a.close();
    }
  }
  let _ = u === `connecting` || u === `streaming`;
  return (0, G.jsxs)(`main`, {
    style: {
      maxWidth: `none`,
      display: `flex`,
      flexDirection: `column`,
      height: `calc(100vh - 49px)`,
    },
    children: [
      (0, G.jsxs)(`div`, {
        style: { padding: `1rem 2rem`, borderBottom: `1px solid #222` },
        children: [
          (0, G.jsxs)(`div`, {
            style: { display: `flex`, alignItems: `center`, gap: `0.75rem`, flexWrap: `wrap` },
            children: [
              (0, G.jsx)(`h1`, {
                style: { fontSize: `1.2rem`, margin: 0 },
                children: `Log Stream`,
              }),
              (0, G.jsx)(X, { status: u }),
              (0, G.jsxs)(`span`, {
                style: { color: `#555`, fontSize: `0.85rem` },
                children: [
                  e === `websocket` ? `WebSocket` : `OpenAPI/SSE`,
                  ` · `,
                  c.length,
                  ` lines`,
                ],
              }),
            ],
          }),
          (0, G.jsxs)(`p`, {
            style: { fontSize: `0.85rem`, color: `#888`, margin: `0.5rem 0 0.75rem` },
            children: [
              `Streams from an `,
              (0, G.jsx)(`code`, { children: `async function*` }),
              ` oRPC handler. Switch between OpenAPI (SSE over HTTP) and WebSocket transport.`,
            ],
          }),
          (0, G.jsxs)(`div`, {
            style: { display: `flex`, gap: `0.75rem`, alignItems: `flex-end`, flexWrap: `wrap` },
            children: [
              (0, G.jsxs)(`div`, {
                children: [
                  (0, G.jsx)(`label`, {
                    style: {
                      fontSize: `0.7rem`,
                      color: `#666`,
                      display: `block`,
                      marginBottom: `0.2rem`,
                    },
                    children: `Transport`,
                  }),
                  (0, G.jsx)(`div`, {
                    style: { display: `flex`, gap: `0.25rem` },
                    children: [`openapi`, `websocket`].map((n) =>
                      (0, G.jsx)(
                        `button`,
                        {
                          onClick: () => t(n),
                          disabled: _,
                          style: {
                            background: e === n ? `#1e3a5f` : `#1a1a1a`,
                            borderColor: e === n ? `#2563eb` : `#333`,
                            color: e === n ? `#93c5fd` : `#888`,
                            fontSize: `0.8rem`,
                          },
                          children: n === `openapi` ? `OpenAPI (SSE)` : `WebSocket`,
                        },
                        n,
                      ),
                    ),
                  }),
                ],
              }),
              (0, G.jsx)(Y, {
                label: `Count`,
                value: n,
                onChange: r,
                min: 1,
                max: 500,
                disabled: _,
              }),
              (0, G.jsx)(Y, {
                label: `Min ms`,
                value: i,
                onChange: a,
                min: 0,
                max: 1e4,
                disabled: _,
              }),
              (0, G.jsx)(Y, {
                label: `Max ms`,
                value: o,
                onChange: s,
                min: 1,
                max: 1e4,
                disabled: _,
              }),
              (0, G.jsx)(`button`, {
                className: `btn-primary`,
                onClick: g,
                disabled: _ || o <= i,
                children: _ ? `Streaming...` : `Start`,
              }),
              (0, G.jsx)(`button`, {
                onClick: () => {
                  (h.current?.abort(), l([]), d(`idle`), p(null));
                },
                children: `Clear`,
              }),
            ],
          }),
          (0, G.jsxs)(`div`, {
            style: {
              marginTop: `0.5rem`,
              padding: `0.4rem 0.6rem`,
              background: `#111`,
              border: `1px solid #222`,
              borderRadius: 6,
              fontFamily: `monospace`,
              fontSize: `0.7rem`,
              color: `#888`,
            },
            children: [
              (0, G.jsx)(`span`, { style: { color: `#555` }, children: `procedure:` }),
              ` `,
              (0, G.jsx)(`span`, { style: { color: `#4ade80` }, children: `test.randomLogStream` }),
              (0, G.jsx)(`span`, { style: { color: `#555` }, children: ` | transport:` }),
              ` `,
              (0, G.jsx)(`span`, {
                style: { color: `#60a5fa` },
                children: e === `websocket` ? `WebSocketRPCLink` : `RPCLink (fetch/SSE)`,
              }),
              (0, G.jsx)(`span`, { style: { color: `#555` }, children: ` | endpoint:` }),
              ` `,
              (0, G.jsx)(`span`, {
                style: { color: `#aaa` },
                children: e === `websocket` ? `/api/rpc-ws` : `/api/rpc/test/randomLogStream`,
              }),
            ],
          }),
        ],
      }),
      f &&
        (0, G.jsx)(`div`, {
          style: {
            margin: `0.5rem 2rem`,
            padding: `0.5rem 0.75rem`,
            background: `#450a0a`,
            border: `1px solid #7f1d1d`,
            borderRadius: 6,
            color: `#fca5a5`,
            fontSize: `0.85rem`,
          },
          children: f,
        }),
      (0, G.jsx)(`pre`, {
        ref: m,
        style: {
          flex: 1,
          margin: 0,
          padding: `1rem 2rem`,
          whiteSpace: `pre-wrap`,
          wordBreak: `break-all`,
          background: `#0a0a0a`,
        },
        children:
          c.length > 0
            ? c.join(`
`)
            : `Click Start to stream log lines via oRPC.`,
      }),
    ],
  });
}
function Y({ label: e, value: t, onChange: n, min: r, max: i, disabled: a }) {
  return (0, G.jsxs)(`div`, {
    children: [
      (0, G.jsx)(`label`, {
        style: { fontSize: `0.7rem`, color: `#666`, display: `block`, marginBottom: `0.2rem` },
        children: e,
      }),
      (0, G.jsx)(`input`, {
        type: `number`,
        value: t,
        min: r,
        max: i,
        onChange: (e) => n(+e.target.value),
        disabled: a,
        style: { width: 70, textAlign: `center`, fontFamily: `monospace` },
      }),
    ],
  });
}
function X({ status: e }) {
  return (0, G.jsx)(`span`, {
    style: {
      padding: `1px 6px`,
      borderRadius: 4,
      fontSize: `0.7rem`,
      border: `1px solid ${{ idle: `#333`, connecting: `#92400e`, streaming: `#166534`, completed: `#1d4ed8`, error: `#991b1b` }[e]}`,
      color: {
        idle: `#888`,
        connecting: `#fbbf24`,
        streaming: `#4ade80`,
        completed: `#93c5fd`,
        error: `#fca5a5`,
      }[e],
    },
    children: e,
  });
}
export { J as component };
