import { i as e, n as t, t as n } from "./jsx-runtime-ByY1xr43.js";
import {
  _ as r,
  a as i,
  b as a,
  c as o,
  d as s,
  f as c,
  g as l,
  h as u,
  i as d,
  l as f,
  m as p,
  o as m,
  p as h,
  r as ee,
  s as te,
  u as g,
  v as ne,
  x as re,
  y as _,
} from "./index-BNby28Aj.js";
import {
  A as v,
  B as ie,
  O as ae,
  R as y,
  S as oe,
  T as se,
  a as ce,
  b as le,
  c as ue,
  g as de,
  j as b,
  l as fe,
  o as pe,
  r as me,
  s as he,
  t as ge,
  u as _e,
  v as ve,
  x as ye,
  y as be,
  z as xe,
} from "./fetch-CaJINV1a.js";
var Se = class extends re {
  constructor(e, t) {
    (super(),
      (this.options = t),
      (this.#e = e),
      (this.#s = null),
      (this.#o = te()),
      this.bindMethods(),
      this.setOptions(t));
  }
  #e;
  #t = void 0;
  #n = void 0;
  #r = void 0;
  #i;
  #a;
  #o;
  #s;
  #c;
  #l;
  #u;
  #d;
  #f;
  #p;
  #m = new Set();
  bindMethods() {
    this.refetch = this.refetch.bind(this);
  }
  onSubscribe() {
    this.listeners.size === 1 &&
      (this.#t.addObserver(this),
      we(this.#t, this.options) ? this.#h() : this.updateResult(),
      this.#y());
  }
  onUnsubscribe() {
    this.hasListeners() || this.destroy();
  }
  shouldFetchOnReconnect() {
    return Te(this.#t, this.options, this.options.refetchOnReconnect);
  }
  shouldFetchOnWindowFocus() {
    return Te(this.#t, this.options, this.options.refetchOnWindowFocus);
  }
  destroy() {
    ((this.listeners = new Set()), this.#b(), this.#x(), this.#t.removeObserver(this));
  }
  setOptions(e) {
    let t = this.options,
      n = this.#t;
    if (
      ((this.options = this.#e.defaultQueryOptions(e)),
      this.options.enabled !== void 0 &&
        typeof this.options.enabled != `boolean` &&
        typeof this.options.enabled != `function` &&
        typeof h(this.options.enabled, this.#t) != `boolean`)
    )
      throw Error(`Expected enabled to be a boolean or a callback that returns a boolean`);
    (this.#S(),
      this.#t.setOptions(this.options),
      t._defaulted &&
        !u(this.options, t) &&
        this.#e
          .getQueryCache()
          .notify({ type: `observerOptionsUpdated`, query: this.#t, observer: this }));
    let r = this.hasListeners();
    (r && Ee(this.#t, n, this.options, t) && this.#h(),
      this.updateResult(),
      r &&
        (this.#t !== n ||
          h(this.options.enabled, this.#t) !== h(t.enabled, this.#t) ||
          p(this.options.staleTime, this.#t) !== p(t.staleTime, this.#t)) &&
        this.#g());
    let i = this.#_();
    r &&
      (this.#t !== n ||
        h(this.options.enabled, this.#t) !== h(t.enabled, this.#t) ||
        i !== this.#p) &&
      this.#v(i);
  }
  getOptimisticResult(e) {
    let t = this.#e.getQueryCache().build(this.#e, e),
      n = this.createResult(t, e);
    return (Oe(this, n) && ((this.#r = n), (this.#a = this.options), (this.#i = this.#t.state)), n);
  }
  getCurrentResult() {
    return this.#r;
  }
  trackResult(e, t) {
    return new Proxy(e, {
      get: (e, n) => (
        this.trackProp(n),
        t?.(n),
        n === `promise` &&
          (this.trackProp(`data`),
          !this.options.experimental_prefetchInRender &&
            this.#o.status === `pending` &&
            this.#o.reject(Error(`experimental_prefetchInRender feature flag is not enabled`))),
        Reflect.get(e, n)
      ),
    });
  }
  trackProp(e) {
    this.#m.add(e);
  }
  getCurrentQuery() {
    return this.#t;
  }
  refetch({ ...e } = {}) {
    return this.fetch({ ...e });
  }
  fetchOptimistic(e) {
    let t = this.#e.defaultQueryOptions(e),
      n = this.#e.getQueryCache().build(this.#e, t);
    return n.fetch().then(() => this.createResult(n, t));
  }
  fetch(e) {
    return this.#h({ ...e, cancelRefetch: e.cancelRefetch ?? !0 }).then(
      () => (this.updateResult(), this.#r),
    );
  }
  #h(e) {
    this.#S();
    let t = this.#t.fetch(this.options, e);
    return (e?.throwOnError || (t = t.catch(s)), t);
  }
  #g() {
    this.#b();
    let e = p(this.options.staleTime, this.#t);
    if (o.isServer() || this.#r.isStale || !g(e)) return;
    let t = ne(this.#r.dataUpdatedAt, e) + 1;
    this.#d = _.setTimeout(() => {
      this.#r.isStale || this.updateResult();
    }, t);
  }
  #_() {
    return (
      (typeof this.options.refetchInterval == `function`
        ? this.options.refetchInterval(this.#t)
        : this.options.refetchInterval) ?? !1
    );
  }
  #v(e) {
    (this.#x(),
      (this.#p = e),
      !(o.isServer() || h(this.options.enabled, this.#t) === !1 || !g(this.#p) || this.#p === 0) &&
        (this.#f = _.setInterval(() => {
          (this.options.refetchIntervalInBackground || a.isFocused()) && this.#h();
        }, this.#p)));
  }
  #y() {
    (this.#g(), this.#v(this.#_()));
  }
  #b() {
    this.#d !== void 0 && (_.clearTimeout(this.#d), (this.#d = void 0));
  }
  #x() {
    this.#f !== void 0 && (_.clearInterval(this.#f), (this.#f = void 0));
  }
  createResult(e, t) {
    let n = this.#t,
      r = this.options,
      a = this.#r,
      o = this.#i,
      s = this.#a,
      l = e === n ? this.#n : e.state,
      { state: u } = e,
      d = { ...u },
      f = !1,
      p;
    if (t._optimisticResults) {
      let a = this.hasListeners(),
        o = !a && we(e, t),
        s = a && Ee(e, n, t, r);
      ((o || s) && (d = { ...d, ...i(u.data, e.options) }),
        t._optimisticResults === `isRestoring` && (d.fetchStatus = `idle`));
    }
    let { error: m, errorUpdatedAt: ee, status: g } = d;
    p = d.data;
    let ne = !1;
    if (t.placeholderData !== void 0 && p === void 0 && g === `pending`) {
      let e;
      (a?.isPlaceholderData && t.placeholderData === s?.placeholderData
        ? ((e = a.data), (ne = !0))
        : (e =
            typeof t.placeholderData == `function`
              ? t.placeholderData(this.#u?.state.data, this.#u)
              : t.placeholderData),
        e !== void 0 && ((g = `success`), (p = c(a?.data, e, t)), (f = !0)));
    }
    if (t.select && p !== void 0 && !ne)
      if (a && p === o?.data && t.select === this.#c) p = this.#l;
      else
        try {
          ((this.#c = t.select),
            (p = t.select(p)),
            (p = c(a?.data, p, t)),
            (this.#l = p),
            (this.#s = null));
        } catch (e) {
          this.#s = e;
        }
    this.#s && ((m = this.#s), (p = this.#l), (ee = Date.now()), (g = `error`));
    let re = d.fetchStatus === `fetching`,
      _ = g === `pending`,
      v = g === `error`,
      ie = _ && re,
      ae = p !== void 0,
      y = {
        status: g,
        fetchStatus: d.fetchStatus,
        isPending: _,
        isSuccess: g === `success`,
        isError: v,
        isInitialLoading: ie,
        isLoading: ie,
        data: p,
        dataUpdatedAt: d.dataUpdatedAt,
        error: m,
        errorUpdatedAt: ee,
        failureCount: d.fetchFailureCount,
        failureReason: d.fetchFailureReason,
        errorUpdateCount: d.errorUpdateCount,
        isFetched: e.isFetched(),
        isFetchedAfterMount:
          d.dataUpdateCount > l.dataUpdateCount || d.errorUpdateCount > l.errorUpdateCount,
        isFetching: re,
        isRefetching: re && !_,
        isLoadingError: v && !ae,
        isPaused: d.fetchStatus === `paused`,
        isPlaceholderData: f,
        isRefetchError: v && ae,
        isStale: De(e, t),
        refetch: this.refetch,
        promise: this.#o,
        isEnabled: h(t.enabled, e) !== !1,
      };
    if (this.options.experimental_prefetchInRender) {
      let t = y.data !== void 0,
        r = y.status === `error` && !t,
        i = (e) => {
          r ? e.reject(y.error) : t && e.resolve(y.data);
        },
        a = () => {
          i((this.#o = y.promise = te()));
        },
        o = this.#o;
      switch (o.status) {
        case `pending`:
          e.queryHash === n.queryHash && i(o);
          break;
        case `fulfilled`:
          (r || y.data !== o.value) && a();
          break;
        case `rejected`:
          (!r || y.error !== o.reason) && a();
          break;
      }
    }
    return y;
  }
  updateResult() {
    let e = this.#r,
      t = this.createResult(this.#t, this.options);
    ((this.#i = this.#t.state),
      (this.#a = this.options),
      this.#i.data !== void 0 && (this.#u = this.#t),
      !u(t, e) &&
        ((this.#r = t),
        this.#C({
          listeners: (() => {
            if (!e) return !0;
            let { notifyOnChangeProps: t } = this.options,
              n = typeof t == `function` ? t() : t;
            if (n === `all` || (!n && !this.#m.size)) return !0;
            let r = new Set(n ?? this.#m);
            return (
              this.options.throwOnError && r.add(`error`),
              Object.keys(this.#r).some((t) => {
                let n = t;
                return this.#r[n] !== e[n] && r.has(n);
              })
            );
          })(),
        })));
  }
  #S() {
    let e = this.#e.getQueryCache().build(this.#e, this.options);
    if (e === this.#t) return;
    let t = this.#t;
    ((this.#t = e),
      (this.#n = e.state),
      this.hasListeners() && (t?.removeObserver(this), e.addObserver(this)));
  }
  onQueryUpdate() {
    (this.updateResult(), this.hasListeners() && this.#y());
  }
  #C(e) {
    m.batch(() => {
      (e.listeners &&
        this.listeners.forEach((e) => {
          e(this.#r);
        }),
        this.#e.getQueryCache().notify({ query: this.#t, type: `observerResultsUpdated` }));
    });
  }
};
function Ce(e, t) {
  return (
    h(t.enabled, e) !== !1 &&
    e.state.data === void 0 &&
    !(e.state.status === `error` && t.retryOnMount === !1)
  );
}
function we(e, t) {
  return Ce(e, t) || (e.state.data !== void 0 && Te(e, t, t.refetchOnMount));
}
function Te(e, t, n) {
  if (h(t.enabled, e) !== !1 && p(t.staleTime, e) !== `static`) {
    let r = typeof n == `function` ? n(e) : n;
    return r === `always` || (r !== !1 && De(e, t));
  }
  return !1;
}
function Ee(e, t, n, r) {
  return (
    (e !== t || h(r.enabled, e) === !1) && (!n.suspense || e.state.status !== `error`) && De(e, n)
  );
}
function De(e, t) {
  return h(t.enabled, e) !== !1 && e.isStaleByTime(p(t.staleTime, e));
}
function Oe(e, t) {
  return !u(e.getCurrentResult(), t);
}
var ke = class extends re {
    #e;
    #t = void 0;
    #n;
    #r;
    constructor(e, t) {
      (super(), (this.#e = e), this.setOptions(t), this.bindMethods(), this.#i());
    }
    bindMethods() {
      ((this.mutate = this.mutate.bind(this)), (this.reset = this.reset.bind(this)));
    }
    setOptions(e) {
      let t = this.options;
      ((this.options = this.#e.defaultMutationOptions(e)),
        u(this.options, t) ||
          this.#e
            .getMutationCache()
            .notify({ type: `observerOptionsUpdated`, mutation: this.#n, observer: this }),
        t?.mutationKey &&
        this.options.mutationKey &&
        f(t.mutationKey) !== f(this.options.mutationKey)
          ? this.reset()
          : this.#n?.state.status === `pending` && this.#n.setOptions(this.options));
    }
    onUnsubscribe() {
      this.hasListeners() || this.#n?.removeObserver(this);
    }
    onMutationUpdate(e) {
      (this.#i(), this.#a(e));
    }
    getCurrentResult() {
      return this.#t;
    }
    reset() {
      (this.#n?.removeObserver(this), (this.#n = void 0), this.#i(), this.#a());
    }
    mutate(e, t) {
      return (
        (this.#r = t),
        this.#n?.removeObserver(this),
        (this.#n = this.#e.getMutationCache().build(this.#e, this.options)),
        this.#n.addObserver(this),
        this.#n.execute(e)
      );
    }
    #i() {
      let e = this.#n?.state ?? d();
      this.#t = {
        ...e,
        isPending: e.status === `pending`,
        isSuccess: e.status === `success`,
        isError: e.status === `error`,
        isIdle: e.status === `idle`,
        mutate: this.mutate,
        reset: this.reset,
      };
    }
    #a(e) {
      m.batch(() => {
        if (this.#r && this.hasListeners()) {
          let t = this.#t.variables,
            n = this.#t.context,
            r = { client: this.#e, meta: this.options.meta, mutationKey: this.options.mutationKey };
          if (e?.type === `success`) {
            try {
              this.#r.onSuccess?.(e.data, t, n, r);
            } catch (e) {
              Promise.reject(e);
            }
            try {
              this.#r.onSettled?.(e.data, null, t, n, r);
            } catch (e) {
              Promise.reject(e);
            }
          } else if (e?.type === `error`) {
            try {
              this.#r.onError?.(e.error, t, n, r);
            } catch (e) {
              Promise.reject(e);
            }
            try {
              this.#r.onSettled?.(void 0, e.error, t, n, r);
            } catch (e) {
              Promise.reject(e);
            }
          }
        }
        this.listeners.forEach((e) => {
          e(this.#t);
        });
      });
    }
  },
  x = e(t(), 1),
  Ae = x.createContext(!1),
  je = () => x.useContext(Ae);
Ae.Provider;
var S = n();
function Me() {
  let e = !1;
  return {
    clearReset: () => {
      e = !1;
    },
    reset: () => {
      e = !0;
    },
    isReset: () => e,
  };
}
var Ne = x.createContext(Me()),
  Pe = () => x.useContext(Ne),
  Fe = (e, t, n) => {
    let r =
      n?.state.error && typeof e.throwOnError == `function`
        ? l(e.throwOnError, [n.state.error, n])
        : e.throwOnError;
    (e.suspense || e.experimental_prefetchInRender || r) && (t.isReset() || (e.retryOnMount = !1));
  },
  Ie = (e) => {
    x.useEffect(() => {
      e.clearReset();
    }, [e]);
  },
  Le = ({ result: e, errorResetBoundary: t, throwOnError: n, query: r, suspense: i }) =>
    e.isError &&
    !t.isReset() &&
    !e.isFetching &&
    r &&
    ((i && e.data === void 0) || l(n, [e.error, r])),
  Re = (e) => {
    if (e.suspense) {
      let t = 1e3,
        n = (e) => (e === `static` ? e : Math.max(e ?? t, t)),
        r = e.staleTime;
      ((e.staleTime = typeof r == `function` ? (...e) => n(r(...e)) : n(r)),
        typeof e.gcTime == `number` && (e.gcTime = Math.max(e.gcTime, t)));
    }
  },
  ze = (e, t) => e.isLoading && e.isFetching && !t,
  Be = (e, t) => e?.suspense && t.isPending,
  Ve = (e, t, n) =>
    t.fetchOptimistic(e).catch(() => {
      n.clearReset();
    });
function He(e, t, n) {
  let r = je(),
    i = Pe(),
    a = ee(n),
    c = a.defaultQueryOptions(e);
  a.getDefaultOptions().queries?._experimental_beforeQuery?.(c);
  let l = a.getQueryCache().get(c.queryHash);
  ((c._optimisticResults = r ? `isRestoring` : `optimistic`), Re(c), Fe(c, i, l), Ie(i));
  let u = !a.getQueryCache().get(c.queryHash),
    [d] = x.useState(() => new t(a, c)),
    f = d.getOptimisticResult(c),
    p = !r && e.subscribed !== !1;
  if (
    (x.useSyncExternalStore(
      x.useCallback(
        (e) => {
          let t = p ? d.subscribe(m.batchCalls(e)) : s;
          return (d.updateResult(), t);
        },
        [d, p],
      ),
      () => d.getCurrentResult(),
      () => d.getCurrentResult(),
    ),
    x.useEffect(() => {
      d.setOptions(c);
    }, [c, d]),
    Be(c, f))
  )
    throw Ve(c, d, i);
  if (
    Le({
      result: f,
      errorResetBoundary: i,
      throwOnError: c.throwOnError,
      query: l,
      suspense: c.suspense,
    })
  )
    throw f.error;
  return (
    a.getDefaultOptions().queries?._experimental_afterQuery?.(c, f),
    c.experimental_prefetchInRender &&
      !o.isServer() &&
      ze(f, r) &&
      (u ? Ve(c, d, i) : l?.promise)?.catch(s).finally(() => {
        d.updateResult();
      }),
    c.notifyOnChangeProps ? f : d.trackResult(f)
  );
}
function Ue(e, t) {
  return He(e, Se, t);
}
function We(e, t) {
  let n = ee(t),
    [r] = x.useState(() => new ke(n, e));
  x.useEffect(() => {
    r.setOptions(e);
  }, [r, e]);
  let i = x.useSyncExternalStore(
      x.useCallback((e) => r.subscribe(m.batchCalls(e)), [r]),
      () => r.getCurrentResult(),
      () => r.getCurrentResult(),
    ),
    a = x.useCallback(
      (e, t) => {
        r.mutate(e, t).catch(s);
      },
      [r],
    );
  if (i.error && l(r.options.throwOnError, [i.error])) throw i.error;
  return { ...i, mutate: a, mutateAsync: i.mutate };
}
var Ge = class extends Error {
  issues;
  data;
  constructor(e) {
    (super(e.message, e), (this.issues = e.issues), (this.data = e.data));
  }
};
function Ke(e, t) {
  return { ...e, ...t };
}
var qe = class {
  "~orpc";
  constructor(e) {
    if (e.route?.successStatus && ye(e.route.successStatus))
      throw Error(`[ContractProcedure] Invalid successStatus.`);
    if (Object.values(e.errorMap).some((e) => e && e.status && !ye(e.status)))
      throw Error(`[ContractProcedure] Invalid error status code.`);
    this[`~orpc`] = e;
  }
};
function Je(e) {
  return e instanceof qe
    ? !0
    : (typeof e == `object` || typeof e == `function`) &&
        e !== null &&
        `~orpc` in e &&
        typeof e[`~orpc`] == `object` &&
        e[`~orpc`] !== null &&
        `errorMap` in e[`~orpc`] &&
        `route` in e[`~orpc`] &&
        `meta` in e[`~orpc`];
}
function Ye(e, t) {
  return { ...e, ...t };
}
function Xe(e, t) {
  return { ...e, ...t };
}
function Ze(e, t) {
  return e.path ? { ...e, path: `${t}${e.path}` } : e;
}
function Qe(e, t) {
  return { ...e, tags: [...t, ...(e.tags ?? [])] };
}
function $e(e, t) {
  return e ? `${e}${t}` : t;
}
function et(e, t) {
  return e ? [...e, ...t] : t;
}
function tt(e, t) {
  let n = e;
  return (t.prefix && (n = Ze(n, t.prefix)), t.tags?.length && (n = Qe(n, t.tags)), n);
}
function nt(e, t) {
  if (Je(e))
    return new qe({
      ...e[`~orpc`],
      errorMap: Ke(t.errorMap, e[`~orpc`].errorMap),
      route: tt(e[`~orpc`].route, t),
    });
  if (typeof e != `object` || !e) return e;
  let n = {};
  for (let r in e) n[r] = nt(e[r], t);
  return n;
}
var C = new (class e extends qe {
    constructor(e) {
      (super(e), (this[`~orpc`].prefix = e.prefix), (this[`~orpc`].tags = e.tags));
    }
    $meta(t) {
      return new e({ ...this[`~orpc`], meta: t });
    }
    $route(t) {
      return new e({ ...this[`~orpc`], route: t });
    }
    $input(t) {
      return new e({ ...this[`~orpc`], inputSchema: t });
    }
    errors(t) {
      return new e({ ...this[`~orpc`], errorMap: Ke(this[`~orpc`].errorMap, t) });
    }
    meta(t) {
      return new e({ ...this[`~orpc`], meta: Ye(this[`~orpc`].meta, t) });
    }
    route(t) {
      return new e({ ...this[`~orpc`], route: Xe(this[`~orpc`].route, t) });
    }
    input(t) {
      return new e({ ...this[`~orpc`], inputSchema: t });
    }
    output(t) {
      return new e({ ...this[`~orpc`], outputSchema: t });
    }
    prefix(t) {
      return new e({ ...this[`~orpc`], prefix: $e(this[`~orpc`].prefix, t) });
    }
    tag(...t) {
      return new e({ ...this[`~orpc`], tags: et(this[`~orpc`].tags, t) });
    }
    router(e) {
      return nt(e, this[`~orpc`]);
    }
  })({ errorMap: {}, route: {}, meta: {} }),
  rt = {
    defaultMethod: `POST`,
    defaultSuccessStatus: 200,
    defaultSuccessDescription: `OK`,
    defaultInputStructure: `compact`,
    defaultOutputStructure: `compact`,
  };
function it(e, t) {
  return t === void 0 ? rt[e] : t;
}
var at = Symbol(`ORPC_EVENT_ITERATOR_DETAILS`);
function ot(e, t) {
  return {
    "~standard": {
      [at]: { yields: e, returns: t },
      vendor: `orpc`,
      version: 1,
      validate(n) {
        return v(n)
          ? {
              value: fe(n, {
                async value(n, r) {
                  let i = r ? t : e;
                  if (!i) return n;
                  let a = await i[`~standard`].validate(n);
                  if (a.issues)
                    throw new ve(`EVENT_ITERATOR_VALIDATION_FAILED`, {
                      message: `Event iterator validation failed`,
                      cause: new Ge({
                        issues: a.issues,
                        message: `Event iterator validation failed`,
                        data: n,
                      }),
                    });
                  return a.value;
                },
                error: async (e) => e,
              }),
            }
          : { issues: [{ message: `Expect event iterator`, path: [] }] };
      },
    },
  };
}
var st = class {
  maxArrayIndex;
  constructor(e = {}) {
    this.maxArrayIndex = e.maxBracketNotationArrayIndex ?? 9999;
  }
  serialize(e, t = [], n = []) {
    if (Array.isArray(e))
      e.forEach((e, r) => {
        this.serialize(e, [...t, r], n);
      });
    else if (b(e)) for (let r in e) this.serialize(e[r], [...t, r], n);
    else n.push([this.stringifyPath(t), e]);
    return n;
  }
  deserialize(e) {
    if (e.length === 0) return {};
    let t = new WeakSet(),
      n = { value: [] };
    for (let [r, i] of e) {
      let e = this.parsePath(r),
        a = n,
        o = `value`;
      (e.forEach((n, r) => {
        (!Array.isArray(a[o]) && !b(a[o]) && (a[o] = []),
          r === e.length - 1
            ? Array.isArray(a[o]) &&
              (n === ``
                ? a[o].length && !t.has(a[o]) && (a[o] = lt(a[o]))
                : t.has(a[o])
                  ? (t.delete(a[o]), (a[o] = ut(a[o])))
                  : ct(n, this.maxArrayIndex) || (a[o] = lt(a[o])))
            : Array.isArray(a[o]) &&
              !ct(n, this.maxArrayIndex) &&
              (t.has(a[o]) ? (t.delete(a[o]), (a[o] = ut(a[o]))) : (a[o] = lt(a[o]))),
          (a = a[o]),
          (o = n));
      }),
        Array.isArray(a) && o === ``
          ? (t.add(a), a.push(i))
          : o in a
            ? Array.isArray(a[o])
              ? a[o].push(i)
              : (a[o] = [a[o], i])
            : (a[o] = i));
    }
    return n.value;
  }
  stringifyPath(e) {
    return e
      .map((e) =>
        e.toString().replace(/[\\[\]]/g, (e) => {
          switch (e) {
            case `\\`:
              return `\\\\`;
            case `[`:
              return `\\[`;
            case `]`:
              return `\\]`;
            default:
              return e;
          }
        }),
      )
      .reduce((e, t, n) => (n === 0 ? t : `${e}[${t}]`), ``);
  }
  parsePath(e) {
    let t = [],
      n = !1,
      r = ``,
      i = 0;
    for (let a = 0; a < e.length; a++) {
      let o = e[a],
        s = e[a + 1];
      n && o === `]` && (s === void 0 || s === `[`) && i % 2 == 0
        ? (s === void 0 && (n = !1), t.push(r), (r = ``), a++)
        : t.length === 0 && o === `[` && i % 2 == 0
          ? ((n = !0), t.push(r), (r = ``))
          : o === `\\`
            ? i++
            : ((r += `\\`.repeat(i / 2) + o), (i = 0));
    }
    return n || t.length === 0 ? [e] : t;
  }
};
function ct(e, t) {
  return /^0$|^[1-9]\d*$/.test(e) && Number(e) <= t;
}
function lt(e) {
  let t = new se();
  return (
    e.forEach((e, n) => {
      t[n] = e;
    }),
    t
  );
}
function ut(e) {
  let t = new se();
  return ((t[``] = e.length === 1 ? e[0] : e), t);
}
var dt = class {
  customSerializers;
  constructor(e = {}) {
    this.customSerializers = e.customJsonSerializers ?? [];
  }
  serialize(e, t = { value: !1 }) {
    for (let n of this.customSerializers)
      if (n.condition(e)) return this.serialize(n.serialize(e), t);
    if (e instanceof Blob) return ((t.value = !0), [e, t.value]);
    if (e instanceof Set) return this.serialize(Array.from(e), t);
    if (e instanceof Map) return this.serialize(Array.from(e.entries()), t);
    if (Array.isArray(e))
      return [e.map((e) => (e === void 0 ? null : this.serialize(e, t)[0])), t.value];
    if (b(e)) {
      let n = {};
      for (let r in e)
        (r === `toJSON` && typeof e[r] == `function`) || (n[r] = this.serialize(e[r], t)[0]);
      return [n, t.value];
    }
    return typeof e == `bigint` || e instanceof RegExp || e instanceof URL
      ? [e.toString(), t.value]
      : e instanceof Date
        ? [Number.isNaN(e.getTime()) ? null : e.toISOString(), t.value]
        : Number.isNaN(e)
          ? [null, t.value]
          : [e, t.value];
  }
};
function ft(e) {
  return `/${e.replace(/\/{2,}/g, `/`).replace(/^\/|\/$/g, ``)}`;
}
function pt(e) {
  return e
    ? ft(e)
        .match(/\/\{[^}]+\}/g)
        ?.map((e) => ({ raw: e, name: e.match(/\{\+?([^}]+)\}/)[1] }))
    : void 0;
}
var mt = class {
    constructor(e, t, n) {
      ((this.contract = e),
        (this.serializer = t),
        (this.baseUrl = n.url),
        (this.headers = n.headers ?? {}),
        (this.customErrorResponseBodyDecoder = n.customErrorResponseBodyDecoder));
    }
    baseUrl;
    headers;
    customErrorResponseBodyDecoder;
    async encode(e, t, n) {
      let r = he(await ie(this.headers, n, e, t));
      n.lastEventId !== void 0 && (r = de(r, { "last-event-id": n.lastEventId }));
      let i = await ie(this.baseUrl, n, e, t),
        a = ae(this.contract, e);
      if (!Je(a))
        throw Error(`[StandardOpenapiLinkCodec] expect a contract procedure at ${e.join(`.`)}`);
      return it(`defaultInputStructure`, a[`~orpc`].route.inputStructure) === `compact`
        ? this.#e(a, e, t, n, i, r)
        : this.#t(a, e, t, n, i, r);
    }
    #e(e, t, n, r, i, a) {
      let o = ft(e[`~orpc`].route.path ?? pe(t)),
        s = n,
        c = pt(o);
      if (c?.length) {
        if (!b(n))
          throw TypeError(
            `[StandardOpenapiLinkCodec] Invalid input shape for "compact" structure when has dynamic params at ${t.join(`.`)}.`,
          );
        let e = { ...n };
        for (let t of c) {
          let r = n[t.name];
          ((o = o.replace(t.raw, `/${encodeURIComponent(`${this.serializer.serialize(r)}`)}`)),
            delete e[t.name]);
        }
        s = Object.keys(e).length ? e : void 0;
      }
      let l = it(`defaultMethod`, e[`~orpc`].route.method),
        u = new URL(i);
      if (((u.pathname = `${u.pathname.replace(/\/$/, ``)}${o}`), l === `GET`)) {
        let e = this.serializer.serialize(s, { outputFormat: `URLSearchParams` });
        for (let [t, n] of e) u.searchParams.append(t, n);
        return { url: u, method: l, headers: a, body: void 0, signal: r.signal };
      }
      return {
        url: u,
        method: l,
        headers: a,
        body: this.serializer.serialize(s),
        signal: r.signal,
      };
    }
    #t(e, t, n, r, i, a) {
      let o = ft(e[`~orpc`].route.path ?? pe(t)),
        s = pt(o);
      if (!b(n) && n !== void 0)
        throw TypeError(
          `[StandardOpenapiLinkCodec] Invalid input shape for "detailed" structure at ${t.join(`.`)}.`,
        );
      if (s?.length) {
        if (!b(n?.params))
          throw TypeError(
            `[StandardOpenapiLinkCodec] Invalid input.params shape for "detailed" structure when has dynamic params at ${t.join(`.`)}.`,
          );
        for (let e of s) {
          let t = n.params[e.name];
          o = o.replace(e.raw, `/${encodeURIComponent(`${this.serializer.serialize(t)}`)}`);
        }
      }
      let c = a;
      if (n?.headers !== void 0) {
        if (!b(n.headers))
          throw TypeError(
            `[StandardOpenapiLinkCodec] Invalid input.headers shape for "detailed" structure at ${t.join(`.`)}.`,
          );
        c = de(n.headers, a);
      }
      let l = it(`defaultMethod`, e[`~orpc`].route.method),
        u = new URL(i);
      if (((u.pathname = `${u.pathname.replace(/\/$/, ``)}${o}`), n?.query !== void 0)) {
        let e = this.serializer.serialize(n.query, { outputFormat: `URLSearchParams` });
        for (let [t, n] of e) u.searchParams.append(t, n);
      }
      return l === `GET`
        ? { url: u, method: l, headers: c, body: void 0, signal: r.signal }
        : {
            url: u,
            method: l,
            headers: c,
            body: this.serializer.serialize(n?.body),
            signal: r.signal,
          };
    }
    async decode(e, t, n) {
      let r = !ye(e.status),
        i = await (async () => {
          let t = !1;
          try {
            let n = await e.body();
            return ((t = !0), this.serializer.deserialize(n));
          } catch (e) {
            throw Error(
              t
                ? `Invalid OpenAPI response format.`
                : `Cannot parse response body, please check the response body and content-type.`,
              { cause: e },
            );
          }
        })();
      if (!r)
        throw (
          this.customErrorResponseBodyDecoder?.(i, e) ??
          (le(i) ? be(i) : new ve(ce(e.status), { status: e.status, data: { ...e, body: i } }))
        );
      let a = ae(this.contract, n);
      if (!Je(a))
        throw Error(`[StandardOpenapiLinkCodec] expect a contract procedure at ${n.join(`.`)}`);
      return it(`defaultOutputStructure`, a[`~orpc`].route.outputStructure) === `compact`
        ? i
        : { status: e.status, headers: e.headers, body: i };
    }
  },
  ht = class {
    constructor(e, t) {
      ((this.jsonSerializer = e), (this.bracketNotation = t));
    }
    serialize(e, t = {}) {
      return v(e) && !t.outputFormat
        ? fe(e, {
            value: async (e) => this.#e(e, { outputFormat: `plain` }),
            error: async (e) =>
              new _e({ data: this.#e(oe(e).toJSON(), { outputFormat: `plain` }), cause: e }),
          })
        : this.#e(e, t);
    }
    #e(e, t) {
      let [n, r] = this.jsonSerializer.serialize(e);
      if (t.outputFormat === `plain`) return n;
      if (t.outputFormat === `URLSearchParams`) {
        let e = new URLSearchParams();
        for (let [t, r] of this.bracketNotation.serialize(n))
          (typeof r == `string` || typeof r == `number` || typeof r == `boolean`) &&
            e.append(t, r.toString());
        return e;
      }
      if (n instanceof Blob || n === void 0 || !r) return n;
      let i = new FormData();
      for (let [e, t] of this.bracketNotation.serialize(n))
        typeof t == `string` || typeof t == `number` || typeof t == `boolean`
          ? i.append(e, t.toString())
          : t instanceof Blob && i.append(e, t);
      return i;
    }
    deserialize(e) {
      return e instanceof URLSearchParams || e instanceof FormData
        ? this.bracketNotation.deserialize(Array.from(e.entries()))
        : v(e)
          ? fe(e, {
              value: async (e) => e,
              error: async (e) => (e instanceof _e && le(e.data) ? be(e.data, { cause: e }) : e),
            })
          : e;
    }
  },
  gt = class extends me {
    constructor(e, t, n) {
      let r = new mt(e, new ht(new dt(n), new st({ maxBracketNotationArrayIndex: 4294967294 })), n);
      super(r, t, n);
    }
  },
  _t = class extends gt {
    constructor(e, t) {
      let n = new ge(t);
      super(e, n, t);
    }
  };
function w(e, t = {}) {
  return [
    e,
    {
      ...(t.input === void 0 ? {} : { input: t.input }),
      ...(t.type === void 0 ? {} : { type: t.type }),
      ...(t.fnOptions === void 0 ? {} : { fnOptions: t.fnOptions }),
    },
  ];
}
function vt(e) {
  return {
    key(t) {
      return w(e, t);
    },
  };
}
function yt(e) {
  return async (t) => {
    let n = await e(t),
      r;
    for await (let e of n) {
      if (t.signal.aborted) throw t.signal.reason;
      ((r = { chunk: e }), t.client.setQueryData(t.queryKey, e));
    }
    if (!r)
      throw Error(
        `Live query for ${y(t.queryKey)} did not yield any data. Ensure the query function returns an AsyncIterable with at least one chunk.`,
      );
    return r.chunk;
  };
}
function bt(e, { refetchMode: t = `reset`, maxChunks: n = 1 / 0 } = {}) {
  return async (r) => {
    let i = r.client.getQueryCache().find({ queryKey: r.queryKey, exact: !0 }),
      a = !!i && i.state.data !== void 0;
    a &&
      (t === `reset`
        ? i.setState({ status: `pending`, data: void 0, error: null, fetchStatus: `fetching` })
        : r.client.setQueryData(r.queryKey, (e = []) => T(e, n)));
    let o = [],
      s = await e(r),
      c = !a || t !== `replace`;
    r.client.setQueryData(r.queryKey, (e = []) => T(e, n));
    for await (let e of s) {
      if (r.signal.aborted) throw r.signal.reason;
      (o.push(e),
        (o = T(o, n)),
        c && r.client.setQueryData(r.queryKey, (t = []) => T([...t, e], n)));
    }
    c || r.client.setQueryData(r.queryKey, o);
    let l = r.client.getQueryData(r.queryKey);
    return l ? T(l, n) : o;
  };
}
function T(e, t) {
  return e.length <= t ? e : e.slice(e.length - t);
}
var E = Symbol(`ORPC_OPERATION_CONTEXT`);
function xt(e, t) {
  let n = {
    call: e,
    queryKey(...[e = {}]) {
      return (
        (e = { ...t.experimental_defaults?.queryKey, ...e }),
        e.queryKey ?? w(t.path, { type: `query`, input: e.input })
      );
    },
    queryOptions(...[i = {}]) {
      i = { ...t.experimental_defaults?.queryOptions, ...i };
      let a = n.queryKey(i);
      return {
        queryFn: ({ signal: t }) => {
          if (i.input === r)
            throw Error(`queryFn should not be called with skipToken used as input`);
          return e(i.input, {
            signal: t,
            context: { [E]: { key: a, type: `query` }, ...i.context },
          });
        },
        ...(i.input === r ? { enabled: !1 } : {}),
        ...i,
        queryKey: a,
      };
    },
    experimental_streamedKey(...[e = {}]) {
      return (
        (e = { ...t.experimental_defaults?.experimental_streamedKey, ...e }),
        e.queryKey ?? w(t.path, { type: `streamed`, input: e.input, fnOptions: e.queryFnOptions })
      );
    },
    experimental_streamedOptions(...[i = {}]) {
      i = { ...t.experimental_defaults?.experimental_streamedOptions, ...i };
      let a = n.experimental_streamedKey(i);
      return {
        queryFn: bt(async ({ signal: t }) => {
          if (i.input === r)
            throw Error(`queryFn should not be called with skipToken used as input`);
          let n = await e(i.input, {
            signal: t,
            context: { [E]: { key: a, type: `streamed` }, ...i.context },
          });
          if (!v(n)) throw Error(`streamedQuery requires an event iterator output`);
          return n;
        }, i.queryFnOptions),
        ...(i.input === r ? { enabled: !1 } : {}),
        ...i,
        queryKey: a,
      };
    },
    experimental_liveKey(...[e = {}]) {
      return (
        (e = { ...t.experimental_defaults?.experimental_liveKey, ...e }),
        e.queryKey ?? w(t.path, { type: `live`, input: e.input })
      );
    },
    experimental_liveOptions(...[i = {}]) {
      i = { ...t.experimental_defaults?.experimental_liveOptions, ...i };
      let a = n.experimental_liveKey(i);
      return {
        queryFn: yt(async ({ signal: t }) => {
          if (i.input === r)
            throw Error(`queryFn should not be called with skipToken used as input`);
          let n = await e(i.input, {
            signal: t,
            context: { [E]: { key: a, type: `live` }, ...i.context },
          });
          if (!v(n)) throw Error(`liveQuery requires an event iterator output`);
          return n;
        }),
        ...(i.input === r ? { enabled: !1 } : {}),
        ...i,
        queryKey: a,
      };
    },
    infiniteKey(e) {
      return (
        (e = { ...t.experimental_defaults?.infiniteKey, ...e }),
        e.queryKey ??
          w(t.path, { type: `infinite`, input: e.input === r ? r : e.input(e.initialPageParam) })
      );
    },
    infiniteOptions(i) {
      i = { ...t.experimental_defaults?.infiniteOptions, ...i };
      let a = n.infiniteKey(i);
      return {
        queryFn: ({ pageParam: t, signal: n }) => {
          if (i.input === r)
            throw Error(`queryFn should not be called with skipToken used as input`);
          return e(i.input(t), {
            signal: n,
            context: { [E]: { key: a, type: `infinite` }, ...i.context },
          });
        },
        ...(i.input === r ? { enabled: !1 } : {}),
        ...i,
        queryKey: a,
      };
    },
    mutationKey(...[e = {}]) {
      return (
        (e = { ...t.experimental_defaults?.mutationKey, ...e }),
        e.mutationKey ?? w(t.path, { type: `mutation` })
      );
    },
    mutationOptions(...[r = {}]) {
      r = { ...t.experimental_defaults?.mutationOptions, ...r };
      let i = n.mutationKey(r);
      return {
        mutationFn: (t) => e(t, { context: { [E]: { key: i, type: `mutation` }, ...r.context } }),
        ...r,
        mutationKey: i,
      };
    },
  };
  return n;
}
function St(e, t = {}) {
  let n = xe(t.path),
    r = vt(n),
    i = xt(e, { path: n, experimental_defaults: t.experimental_defaults });
  return new Proxy(
    { ...r, ...i },
    {
      get(r, i) {
        let a = Reflect.get(r, i);
        if (typeof i != `string`) return a;
        let o = St(e[i], {
          ...t,
          path: [...n, i],
          experimental_defaults: ae(t.experimental_defaults, [i]),
        });
        return typeof a == `function`
          ? new Proxy(a, {
              get(e, t) {
                return Reflect.get(o, t);
              },
            })
          : o;
      },
    },
  );
}
var D;
(function (e) {
  e.assertEqual = (e) => {};
  function t(e) {}
  e.assertIs = t;
  function n(e) {
    throw Error();
  }
  ((e.assertNever = n),
    (e.arrayToEnum = (e) => {
      let t = {};
      for (let n of e) t[n] = n;
      return t;
    }),
    (e.getValidEnumValues = (t) => {
      let n = e.objectKeys(t).filter((e) => typeof t[t[e]] != `number`),
        r = {};
      for (let e of n) r[e] = t[e];
      return e.objectValues(r);
    }),
    (e.objectValues = (t) =>
      e.objectKeys(t).map(function (e) {
        return t[e];
      })),
    (e.objectKeys =
      typeof Object.keys == `function`
        ? (e) => Object.keys(e)
        : (e) => {
            let t = [];
            for (let n in e) Object.prototype.hasOwnProperty.call(e, n) && t.push(n);
            return t;
          }),
    (e.find = (e, t) => {
      for (let n of e) if (t(n)) return n;
    }),
    (e.isInteger =
      typeof Number.isInteger == `function`
        ? (e) => Number.isInteger(e)
        : (e) => typeof e == `number` && Number.isFinite(e) && Math.floor(e) === e));
  function r(e, t = ` | `) {
    return e.map((e) => (typeof e == `string` ? `'${e}'` : e)).join(t);
  }
  ((e.joinValues = r),
    (e.jsonStringifyReplacer = (e, t) => (typeof t == `bigint` ? t.toString() : t)));
})((D ||= {}));
var Ct;
(function (e) {
  e.mergeShapes = (e, t) => ({ ...e, ...t });
})((Ct ||= {}));
var O = D.arrayToEnum([
    `string`,
    `nan`,
    `number`,
    `integer`,
    `float`,
    `boolean`,
    `date`,
    `bigint`,
    `symbol`,
    `function`,
    `undefined`,
    `null`,
    `array`,
    `object`,
    `unknown`,
    `promise`,
    `void`,
    `never`,
    `map`,
    `set`,
  ]),
  k = (e) => {
    switch (typeof e) {
      case `undefined`:
        return O.undefined;
      case `string`:
        return O.string;
      case `number`:
        return Number.isNaN(e) ? O.nan : O.number;
      case `boolean`:
        return O.boolean;
      case `function`:
        return O.function;
      case `bigint`:
        return O.bigint;
      case `symbol`:
        return O.symbol;
      case `object`:
        return Array.isArray(e)
          ? O.array
          : e === null
            ? O.null
            : e.then && typeof e.then == `function` && e.catch && typeof e.catch == `function`
              ? O.promise
              : typeof Map < `u` && e instanceof Map
                ? O.map
                : typeof Set < `u` && e instanceof Set
                  ? O.set
                  : typeof Date < `u` && e instanceof Date
                    ? O.date
                    : O.object;
      default:
        return O.unknown;
    }
  },
  A = D.arrayToEnum([
    `invalid_type`,
    `invalid_literal`,
    `custom`,
    `invalid_union`,
    `invalid_union_discriminator`,
    `invalid_enum_value`,
    `unrecognized_keys`,
    `invalid_arguments`,
    `invalid_return_type`,
    `invalid_date`,
    `invalid_string`,
    `too_small`,
    `too_big`,
    `invalid_intersection_types`,
    `not_multiple_of`,
    `not_finite`,
  ]),
  j = class e extends Error {
    get errors() {
      return this.issues;
    }
    constructor(e) {
      (super(),
        (this.issues = []),
        (this.addIssue = (e) => {
          this.issues = [...this.issues, e];
        }),
        (this.addIssues = (e = []) => {
          this.issues = [...this.issues, ...e];
        }));
      let t = new.target.prototype;
      (Object.setPrototypeOf ? Object.setPrototypeOf(this, t) : (this.__proto__ = t),
        (this.name = `ZodError`),
        (this.issues = e));
    }
    format(e) {
      let t =
          e ||
          function (e) {
            return e.message;
          },
        n = { _errors: [] },
        r = (e) => {
          for (let i of e.issues)
            if (i.code === `invalid_union`) i.unionErrors.map(r);
            else if (i.code === `invalid_return_type`) r(i.returnTypeError);
            else if (i.code === `invalid_arguments`) r(i.argumentsError);
            else if (i.path.length === 0) n._errors.push(t(i));
            else {
              let e = n,
                r = 0;
              for (; r < i.path.length; ) {
                let n = i.path[r];
                (r === i.path.length - 1
                  ? ((e[n] = e[n] || { _errors: [] }), e[n]._errors.push(t(i)))
                  : (e[n] = e[n] || { _errors: [] }),
                  (e = e[n]),
                  r++);
              }
            }
        };
      return (r(this), n);
    }
    static assert(t) {
      if (!(t instanceof e)) throw Error(`Not a ZodError: ${t}`);
    }
    toString() {
      return this.message;
    }
    get message() {
      return JSON.stringify(this.issues, D.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
      return this.issues.length === 0;
    }
    flatten(e = (e) => e.message) {
      let t = {},
        n = [];
      for (let r of this.issues)
        if (r.path.length > 0) {
          let n = r.path[0];
          ((t[n] = t[n] || []), t[n].push(e(r)));
        } else n.push(e(r));
      return { formErrors: n, fieldErrors: t };
    }
    get formErrors() {
      return this.flatten();
    }
  };
j.create = (e) => new j(e);
var wt = (e, t) => {
    let n;
    switch (e.code) {
      case A.invalid_type:
        n =
          e.received === O.undefined
            ? `Required`
            : `Expected ${e.expected}, received ${e.received}`;
        break;
      case A.invalid_literal:
        n = `Invalid literal value, expected ${JSON.stringify(e.expected, D.jsonStringifyReplacer)}`;
        break;
      case A.unrecognized_keys:
        n = `Unrecognized key(s) in object: ${D.joinValues(e.keys, `, `)}`;
        break;
      case A.invalid_union:
        n = `Invalid input`;
        break;
      case A.invalid_union_discriminator:
        n = `Invalid discriminator value. Expected ${D.joinValues(e.options)}`;
        break;
      case A.invalid_enum_value:
        n = `Invalid enum value. Expected ${D.joinValues(e.options)}, received '${e.received}'`;
        break;
      case A.invalid_arguments:
        n = `Invalid function arguments`;
        break;
      case A.invalid_return_type:
        n = `Invalid function return type`;
        break;
      case A.invalid_date:
        n = `Invalid date`;
        break;
      case A.invalid_string:
        typeof e.validation == `object`
          ? `includes` in e.validation
            ? ((n = `Invalid input: must include "${e.validation.includes}"`),
              typeof e.validation.position == `number` &&
                (n = `${n} at one or more positions greater than or equal to ${e.validation.position}`))
            : `startsWith` in e.validation
              ? (n = `Invalid input: must start with "${e.validation.startsWith}"`)
              : `endsWith` in e.validation
                ? (n = `Invalid input: must end with "${e.validation.endsWith}"`)
                : D.assertNever(e.validation)
          : (n = e.validation === `regex` ? `Invalid` : `Invalid ${e.validation}`);
        break;
      case A.too_small:
        n =
          e.type === `array`
            ? `Array must contain ${e.exact ? `exactly` : e.inclusive ? `at least` : `more than`} ${e.minimum} element(s)`
            : e.type === `string`
              ? `String must contain ${e.exact ? `exactly` : e.inclusive ? `at least` : `over`} ${e.minimum} character(s)`
              : e.type === `number` || e.type === `bigint`
                ? `Number must be ${e.exact ? `exactly equal to ` : e.inclusive ? `greater than or equal to ` : `greater than `}${e.minimum}`
                : e.type === `date`
                  ? `Date must be ${e.exact ? `exactly equal to ` : e.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(e.minimum))}`
                  : `Invalid input`;
        break;
      case A.too_big:
        n =
          e.type === `array`
            ? `Array must contain ${e.exact ? `exactly` : e.inclusive ? `at most` : `less than`} ${e.maximum} element(s)`
            : e.type === `string`
              ? `String must contain ${e.exact ? `exactly` : e.inclusive ? `at most` : `under`} ${e.maximum} character(s)`
              : e.type === `number`
                ? `Number must be ${e.exact ? `exactly` : e.inclusive ? `less than or equal to` : `less than`} ${e.maximum}`
                : e.type === `bigint`
                  ? `BigInt must be ${e.exact ? `exactly` : e.inclusive ? `less than or equal to` : `less than`} ${e.maximum}`
                  : e.type === `date`
                    ? `Date must be ${e.exact ? `exactly` : e.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(e.maximum))}`
                    : `Invalid input`;
        break;
      case A.custom:
        n = `Invalid input`;
        break;
      case A.invalid_intersection_types:
        n = `Intersection results could not be merged`;
        break;
      case A.not_multiple_of:
        n = `Number must be a multiple of ${e.multipleOf}`;
        break;
      case A.not_finite:
        n = `Number must be finite`;
        break;
      default:
        ((n = t.defaultError), D.assertNever(e));
    }
    return { message: n };
  },
  Tt = wt;
function Et() {
  return Tt;
}
var Dt = (e) => {
  let { data: t, path: n, errorMaps: r, issueData: i } = e,
    a = [...n, ...(i.path || [])],
    o = { ...i, path: a };
  if (i.message !== void 0) return { ...i, path: a, message: i.message };
  let s = ``,
    c = r
      .filter((e) => !!e)
      .slice()
      .reverse();
  for (let e of c) s = e(o, { data: t, defaultError: s }).message;
  return { ...i, path: a, message: s };
};
function M(e, t) {
  let n = Et(),
    r = Dt({
      issueData: t,
      data: e.data,
      path: e.path,
      errorMaps: [e.common.contextualErrorMap, e.schemaErrorMap, n, n === wt ? void 0 : wt].filter(
        (e) => !!e,
      ),
    });
  e.common.issues.push(r);
}
var N = class e {
    constructor() {
      this.value = `valid`;
    }
    dirty() {
      this.value === `valid` && (this.value = `dirty`);
    }
    abort() {
      this.value !== `aborted` && (this.value = `aborted`);
    }
    static mergeArray(e, t) {
      let n = [];
      for (let r of t) {
        if (r.status === `aborted`) return P;
        (r.status === `dirty` && e.dirty(), n.push(r.value));
      }
      return { status: e.value, value: n };
    }
    static async mergeObjectAsync(t, n) {
      let r = [];
      for (let e of n) {
        let t = await e.key,
          n = await e.value;
        r.push({ key: t, value: n });
      }
      return e.mergeObjectSync(t, r);
    }
    static mergeObjectSync(e, t) {
      let n = {};
      for (let r of t) {
        let { key: t, value: i } = r;
        if (t.status === `aborted` || i.status === `aborted`) return P;
        (t.status === `dirty` && e.dirty(),
          i.status === `dirty` && e.dirty(),
          t.value !== `__proto__` && (i.value !== void 0 || r.alwaysSet) && (n[t.value] = i.value));
      }
      return { status: e.value, value: n };
    }
  },
  P = Object.freeze({ status: `aborted` }),
  Ot = (e) => ({ status: `dirty`, value: e }),
  F = (e) => ({ status: `valid`, value: e }),
  kt = (e) => e.status === `aborted`,
  At = (e) => e.status === `dirty`,
  I = (e) => e.status === `valid`,
  jt = (e) => typeof Promise < `u` && e instanceof Promise,
  L;
(function (e) {
  ((e.errToObj = (e) => (typeof e == `string` ? { message: e } : e || {})),
    (e.toString = (e) => (typeof e == `string` ? e : e?.message)));
})((L ||= {}));
var R = class {
    constructor(e, t, n, r) {
      ((this._cachedPath = []),
        (this.parent = e),
        (this.data = t),
        (this._path = n),
        (this._key = r));
    }
    get path() {
      return (
        this._cachedPath.length ||
          (Array.isArray(this._key)
            ? this._cachedPath.push(...this._path, ...this._key)
            : this._cachedPath.push(...this._path, this._key)),
        this._cachedPath
      );
    }
  },
  Mt = (e, t) => {
    if (I(t)) return { success: !0, data: t.value };
    if (!e.common.issues.length) throw Error(`Validation failed but no issues detected.`);
    return {
      success: !1,
      get error() {
        if (this._error) return this._error;
        let t = new j(e.common.issues);
        return ((this._error = t), this._error);
      },
    };
  };
function z(e) {
  if (!e) return {};
  let { errorMap: t, invalid_type_error: n, required_error: r, description: i } = e;
  if (t && (n || r))
    throw Error(
      `Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`,
    );
  return t
    ? { errorMap: t, description: i }
    : {
        errorMap: (t, i) => {
          let { message: a } = e;
          return t.code === `invalid_enum_value`
            ? { message: a ?? i.defaultError }
            : i.data === void 0
              ? { message: a ?? r ?? i.defaultError }
              : t.code === `invalid_type`
                ? { message: a ?? n ?? i.defaultError }
                : { message: i.defaultError };
        },
        description: i,
      };
}
var B = class {
    get description() {
      return this._def.description;
    }
    _getType(e) {
      return k(e.data);
    }
    _getOrReturnCtx(e, t) {
      return (
        t || {
          common: e.parent.common,
          data: e.data,
          parsedType: k(e.data),
          schemaErrorMap: this._def.errorMap,
          path: e.path,
          parent: e.parent,
        }
      );
    }
    _processInputParams(e) {
      return {
        status: new N(),
        ctx: {
          common: e.parent.common,
          data: e.data,
          parsedType: k(e.data),
          schemaErrorMap: this._def.errorMap,
          path: e.path,
          parent: e.parent,
        },
      };
    }
    _parseSync(e) {
      let t = this._parse(e);
      if (jt(t)) throw Error(`Synchronous parse encountered promise.`);
      return t;
    }
    _parseAsync(e) {
      let t = this._parse(e);
      return Promise.resolve(t);
    }
    parse(e, t) {
      let n = this.safeParse(e, t);
      if (n.success) return n.data;
      throw n.error;
    }
    safeParse(e, t) {
      let n = {
        common: { issues: [], async: t?.async ?? !1, contextualErrorMap: t?.errorMap },
        path: t?.path || [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data: e,
        parsedType: k(e),
      };
      return Mt(n, this._parseSync({ data: e, path: n.path, parent: n }));
    }
    "~validate"(e) {
      let t = {
        common: { issues: [], async: !!this[`~standard`].async },
        path: [],
        schemaErrorMap: this._def.errorMap,
        parent: null,
        data: e,
        parsedType: k(e),
      };
      if (!this[`~standard`].async)
        try {
          let n = this._parseSync({ data: e, path: [], parent: t });
          return I(n) ? { value: n.value } : { issues: t.common.issues };
        } catch (e) {
          (e?.message?.toLowerCase()?.includes(`encountered`) && (this[`~standard`].async = !0),
            (t.common = { issues: [], async: !0 }));
        }
      return this._parseAsync({ data: e, path: [], parent: t }).then((e) =>
        I(e) ? { value: e.value } : { issues: t.common.issues },
      );
    }
    async parseAsync(e, t) {
      let n = await this.safeParseAsync(e, t);
      if (n.success) return n.data;
      throw n.error;
    }
    async safeParseAsync(e, t) {
      let n = {
          common: { issues: [], contextualErrorMap: t?.errorMap, async: !0 },
          path: t?.path || [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data: e,
          parsedType: k(e),
        },
        r = this._parse({ data: e, path: n.path, parent: n });
      return Mt(n, await (jt(r) ? r : Promise.resolve(r)));
    }
    refine(e, t) {
      let n = (e) =>
        typeof t == `string` || t === void 0 ? { message: t } : typeof t == `function` ? t(e) : t;
      return this._refinement((t, r) => {
        let i = e(t),
          a = () => r.addIssue({ code: A.custom, ...n(t) });
        return typeof Promise < `u` && i instanceof Promise
          ? i.then((e) => (e ? !0 : (a(), !1)))
          : i
            ? !0
            : (a(), !1);
      });
    }
    refinement(e, t) {
      return this._refinement((n, r) =>
        e(n) ? !0 : (r.addIssue(typeof t == `function` ? t(n, r) : t), !1),
      );
    }
    _refinement(e) {
      return new J({
        schema: this,
        typeName: Z.ZodEffects,
        effect: { type: `refinement`, refinement: e },
      });
    }
    superRefine(e) {
      return this._refinement(e);
    }
    constructor(e) {
      ((this.spa = this.safeParseAsync),
        (this._def = e),
        (this.parse = this.parse.bind(this)),
        (this.safeParse = this.safeParse.bind(this)),
        (this.parseAsync = this.parseAsync.bind(this)),
        (this.safeParseAsync = this.safeParseAsync.bind(this)),
        (this.spa = this.spa.bind(this)),
        (this.refine = this.refine.bind(this)),
        (this.refinement = this.refinement.bind(this)),
        (this.superRefine = this.superRefine.bind(this)),
        (this.optional = this.optional.bind(this)),
        (this.nullable = this.nullable.bind(this)),
        (this.nullish = this.nullish.bind(this)),
        (this.array = this.array.bind(this)),
        (this.promise = this.promise.bind(this)),
        (this.or = this.or.bind(this)),
        (this.and = this.and.bind(this)),
        (this.transform = this.transform.bind(this)),
        (this.brand = this.brand.bind(this)),
        (this.default = this.default.bind(this)),
        (this.catch = this.catch.bind(this)),
        (this.describe = this.describe.bind(this)),
        (this.pipe = this.pipe.bind(this)),
        (this.readonly = this.readonly.bind(this)),
        (this.isNullable = this.isNullable.bind(this)),
        (this.isOptional = this.isOptional.bind(this)),
        (this[`~standard`] = { version: 1, vendor: `zod`, validate: (e) => this[`~validate`](e) }));
    }
    optional() {
      return Y.create(this, this._def);
    }
    nullable() {
      return X.create(this, this._def);
    }
    nullish() {
      return this.nullable().optional();
    }
    array() {
      return U.create(this);
    }
    promise() {
      return On.create(this, this._def);
    }
    or(e) {
      return hn.create([this, e], this._def);
    }
    and(e) {
      return vn.create(this, e, this._def);
    }
    transform(e) {
      return new J({
        ...z(this._def),
        schema: this,
        typeName: Z.ZodEffects,
        effect: { type: `transform`, transform: e },
      });
    }
    default(e) {
      let t = typeof e == `function` ? e : () => e;
      return new kn({ ...z(this._def), innerType: this, defaultValue: t, typeName: Z.ZodDefault });
    }
    brand() {
      return new Mn({ typeName: Z.ZodBranded, type: this, ...z(this._def) });
    }
    catch(e) {
      let t = typeof e == `function` ? e : () => e;
      return new An({ ...z(this._def), innerType: this, catchValue: t, typeName: Z.ZodCatch });
    }
    describe(e) {
      let t = this.constructor;
      return new t({ ...this._def, description: e });
    }
    pipe(e) {
      return Nn.create(this, e);
    }
    readonly() {
      return Pn.create(this);
    }
    isOptional() {
      return this.safeParse(void 0).success;
    }
    isNullable() {
      return this.safeParse(null).success;
    }
  },
  Nt = /^c[^\s-]{8,}$/i,
  Pt = /^[0-9a-z]+$/,
  Ft = /^[0-9A-HJKMNP-TV-Z]{26}$/i,
  It = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i,
  Lt = /^[a-z0-9_-]{21}$/i,
  Rt = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/,
  zt =
    /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/,
  Bt = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i,
  Vt = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`,
  Ht,
  Ut =
    /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
  Wt =
    /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/,
  Gt =
    /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/,
  Kt =
    /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
  qt = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
  Jt = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/,
  Yt = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`,
  Xt = RegExp(`^${Yt}$`);
function Zt(e) {
  let t = `[0-5]\\d`;
  e.precision ? (t = `${t}\\.\\d{${e.precision}}`) : (e.precision ?? (t = `${t}(\\.\\d+)?`));
  let n = e.precision ? `+` : `?`;
  return `([01]\\d|2[0-3]):[0-5]\\d(:${t})${n}`;
}
function Qt(e) {
  return RegExp(`^${Zt(e)}$`);
}
function $t(e) {
  let t = `${Yt}T${Zt(e)}`,
    n = [];
  return (
    n.push(e.local ? `Z?` : `Z`),
    e.offset && n.push(`([+-]\\d{2}:?\\d{2})`),
    (t = `${t}(${n.join(`|`)})`),
    RegExp(`^${t}$`)
  );
}
function en(e, t) {
  return !!(((t === `v4` || !t) && Ut.test(e)) || ((t === `v6` || !t) && Gt.test(e)));
}
function tn(e, t) {
  if (!Rt.test(e)) return !1;
  try {
    let [n] = e.split(`.`);
    if (!n) return !1;
    let r = n
        .replace(/-/g, `+`)
        .replace(/_/g, `/`)
        .padEnd(n.length + ((4 - (n.length % 4)) % 4), `=`),
      i = JSON.parse(atob(r));
    return !(
      typeof i != `object` ||
      !i ||
      (`typ` in i && i?.typ !== `JWT`) ||
      !i.alg ||
      (t && i.alg !== t)
    );
  } catch {
    return !1;
  }
}
function nn(e, t) {
  return !!(((t === `v4` || !t) && Wt.test(e)) || ((t === `v6` || !t) && Kt.test(e)));
}
var rn = class e extends B {
  _parse(e) {
    if ((this._def.coerce && (e.data = String(e.data)), this._getType(e) !== O.string)) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.string, received: t.parsedType }), P);
    }
    let t = new N(),
      n;
    for (let r of this._def.checks)
      if (r.kind === `min`)
        e.data.length < r.value &&
          ((n = this._getOrReturnCtx(e, n)),
          M(n, {
            code: A.too_small,
            minimum: r.value,
            type: `string`,
            inclusive: !0,
            exact: !1,
            message: r.message,
          }),
          t.dirty());
      else if (r.kind === `max`)
        e.data.length > r.value &&
          ((n = this._getOrReturnCtx(e, n)),
          M(n, {
            code: A.too_big,
            maximum: r.value,
            type: `string`,
            inclusive: !0,
            exact: !1,
            message: r.message,
          }),
          t.dirty());
      else if (r.kind === `length`) {
        let i = e.data.length > r.value,
          a = e.data.length < r.value;
        (i || a) &&
          ((n = this._getOrReturnCtx(e, n)),
          i
            ? M(n, {
                code: A.too_big,
                maximum: r.value,
                type: `string`,
                inclusive: !0,
                exact: !0,
                message: r.message,
              })
            : a &&
              M(n, {
                code: A.too_small,
                minimum: r.value,
                type: `string`,
                inclusive: !0,
                exact: !0,
                message: r.message,
              }),
          t.dirty());
      } else if (r.kind === `email`)
        Bt.test(e.data) ||
          ((n = this._getOrReturnCtx(e, n)),
          M(n, { validation: `email`, code: A.invalid_string, message: r.message }),
          t.dirty());
      else if (r.kind === `emoji`)
        ((Ht ||= new RegExp(Vt, `u`)),
          Ht.test(e.data) ||
            ((n = this._getOrReturnCtx(e, n)),
            M(n, { validation: `emoji`, code: A.invalid_string, message: r.message }),
            t.dirty()));
      else if (r.kind === `uuid`)
        It.test(e.data) ||
          ((n = this._getOrReturnCtx(e, n)),
          M(n, { validation: `uuid`, code: A.invalid_string, message: r.message }),
          t.dirty());
      else if (r.kind === `nanoid`)
        Lt.test(e.data) ||
          ((n = this._getOrReturnCtx(e, n)),
          M(n, { validation: `nanoid`, code: A.invalid_string, message: r.message }),
          t.dirty());
      else if (r.kind === `cuid`)
        Nt.test(e.data) ||
          ((n = this._getOrReturnCtx(e, n)),
          M(n, { validation: `cuid`, code: A.invalid_string, message: r.message }),
          t.dirty());
      else if (r.kind === `cuid2`)
        Pt.test(e.data) ||
          ((n = this._getOrReturnCtx(e, n)),
          M(n, { validation: `cuid2`, code: A.invalid_string, message: r.message }),
          t.dirty());
      else if (r.kind === `ulid`)
        Ft.test(e.data) ||
          ((n = this._getOrReturnCtx(e, n)),
          M(n, { validation: `ulid`, code: A.invalid_string, message: r.message }),
          t.dirty());
      else if (r.kind === `url`)
        try {
          new URL(e.data);
        } catch {
          ((n = this._getOrReturnCtx(e, n)),
            M(n, { validation: `url`, code: A.invalid_string, message: r.message }),
            t.dirty());
        }
      else
        r.kind === `regex`
          ? ((r.regex.lastIndex = 0),
            r.regex.test(e.data) ||
              ((n = this._getOrReturnCtx(e, n)),
              M(n, { validation: `regex`, code: A.invalid_string, message: r.message }),
              t.dirty()))
          : r.kind === `trim`
            ? (e.data = e.data.trim())
            : r.kind === `includes`
              ? e.data.includes(r.value, r.position) ||
                ((n = this._getOrReturnCtx(e, n)),
                M(n, {
                  code: A.invalid_string,
                  validation: { includes: r.value, position: r.position },
                  message: r.message,
                }),
                t.dirty())
              : r.kind === `toLowerCase`
                ? (e.data = e.data.toLowerCase())
                : r.kind === `toUpperCase`
                  ? (e.data = e.data.toUpperCase())
                  : r.kind === `startsWith`
                    ? e.data.startsWith(r.value) ||
                      ((n = this._getOrReturnCtx(e, n)),
                      M(n, {
                        code: A.invalid_string,
                        validation: { startsWith: r.value },
                        message: r.message,
                      }),
                      t.dirty())
                    : r.kind === `endsWith`
                      ? e.data.endsWith(r.value) ||
                        ((n = this._getOrReturnCtx(e, n)),
                        M(n, {
                          code: A.invalid_string,
                          validation: { endsWith: r.value },
                          message: r.message,
                        }),
                        t.dirty())
                      : r.kind === `datetime`
                        ? $t(r).test(e.data) ||
                          ((n = this._getOrReturnCtx(e, n)),
                          M(n, {
                            code: A.invalid_string,
                            validation: `datetime`,
                            message: r.message,
                          }),
                          t.dirty())
                        : r.kind === `date`
                          ? Xt.test(e.data) ||
                            ((n = this._getOrReturnCtx(e, n)),
                            M(n, {
                              code: A.invalid_string,
                              validation: `date`,
                              message: r.message,
                            }),
                            t.dirty())
                          : r.kind === `time`
                            ? Qt(r).test(e.data) ||
                              ((n = this._getOrReturnCtx(e, n)),
                              M(n, {
                                code: A.invalid_string,
                                validation: `time`,
                                message: r.message,
                              }),
                              t.dirty())
                            : r.kind === `duration`
                              ? zt.test(e.data) ||
                                ((n = this._getOrReturnCtx(e, n)),
                                M(n, {
                                  validation: `duration`,
                                  code: A.invalid_string,
                                  message: r.message,
                                }),
                                t.dirty())
                              : r.kind === `ip`
                                ? en(e.data, r.version) ||
                                  ((n = this._getOrReturnCtx(e, n)),
                                  M(n, {
                                    validation: `ip`,
                                    code: A.invalid_string,
                                    message: r.message,
                                  }),
                                  t.dirty())
                                : r.kind === `jwt`
                                  ? tn(e.data, r.alg) ||
                                    ((n = this._getOrReturnCtx(e, n)),
                                    M(n, {
                                      validation: `jwt`,
                                      code: A.invalid_string,
                                      message: r.message,
                                    }),
                                    t.dirty())
                                  : r.kind === `cidr`
                                    ? nn(e.data, r.version) ||
                                      ((n = this._getOrReturnCtx(e, n)),
                                      M(n, {
                                        validation: `cidr`,
                                        code: A.invalid_string,
                                        message: r.message,
                                      }),
                                      t.dirty())
                                    : r.kind === `base64`
                                      ? qt.test(e.data) ||
                                        ((n = this._getOrReturnCtx(e, n)),
                                        M(n, {
                                          validation: `base64`,
                                          code: A.invalid_string,
                                          message: r.message,
                                        }),
                                        t.dirty())
                                      : r.kind === `base64url`
                                        ? Jt.test(e.data) ||
                                          ((n = this._getOrReturnCtx(e, n)),
                                          M(n, {
                                            validation: `base64url`,
                                            code: A.invalid_string,
                                            message: r.message,
                                          }),
                                          t.dirty())
                                        : D.assertNever(r);
    return { status: t.value, value: e.data };
  }
  _regex(e, t, n) {
    return this.refinement((t) => e.test(t), {
      validation: t,
      code: A.invalid_string,
      ...L.errToObj(n),
    });
  }
  _addCheck(t) {
    return new e({ ...this._def, checks: [...this._def.checks, t] });
  }
  email(e) {
    return this._addCheck({ kind: `email`, ...L.errToObj(e) });
  }
  url(e) {
    return this._addCheck({ kind: `url`, ...L.errToObj(e) });
  }
  emoji(e) {
    return this._addCheck({ kind: `emoji`, ...L.errToObj(e) });
  }
  uuid(e) {
    return this._addCheck({ kind: `uuid`, ...L.errToObj(e) });
  }
  nanoid(e) {
    return this._addCheck({ kind: `nanoid`, ...L.errToObj(e) });
  }
  cuid(e) {
    return this._addCheck({ kind: `cuid`, ...L.errToObj(e) });
  }
  cuid2(e) {
    return this._addCheck({ kind: `cuid2`, ...L.errToObj(e) });
  }
  ulid(e) {
    return this._addCheck({ kind: `ulid`, ...L.errToObj(e) });
  }
  base64(e) {
    return this._addCheck({ kind: `base64`, ...L.errToObj(e) });
  }
  base64url(e) {
    return this._addCheck({ kind: `base64url`, ...L.errToObj(e) });
  }
  jwt(e) {
    return this._addCheck({ kind: `jwt`, ...L.errToObj(e) });
  }
  ip(e) {
    return this._addCheck({ kind: `ip`, ...L.errToObj(e) });
  }
  cidr(e) {
    return this._addCheck({ kind: `cidr`, ...L.errToObj(e) });
  }
  datetime(e) {
    return typeof e == `string`
      ? this._addCheck({ kind: `datetime`, precision: null, offset: !1, local: !1, message: e })
      : this._addCheck({
          kind: `datetime`,
          precision: e?.precision === void 0 ? null : e?.precision,
          offset: e?.offset ?? !1,
          local: e?.local ?? !1,
          ...L.errToObj(e?.message),
        });
  }
  date(e) {
    return this._addCheck({ kind: `date`, message: e });
  }
  time(e) {
    return typeof e == `string`
      ? this._addCheck({ kind: `time`, precision: null, message: e })
      : this._addCheck({
          kind: `time`,
          precision: e?.precision === void 0 ? null : e?.precision,
          ...L.errToObj(e?.message),
        });
  }
  duration(e) {
    return this._addCheck({ kind: `duration`, ...L.errToObj(e) });
  }
  regex(e, t) {
    return this._addCheck({ kind: `regex`, regex: e, ...L.errToObj(t) });
  }
  includes(e, t) {
    return this._addCheck({
      kind: `includes`,
      value: e,
      position: t?.position,
      ...L.errToObj(t?.message),
    });
  }
  startsWith(e, t) {
    return this._addCheck({ kind: `startsWith`, value: e, ...L.errToObj(t) });
  }
  endsWith(e, t) {
    return this._addCheck({ kind: `endsWith`, value: e, ...L.errToObj(t) });
  }
  min(e, t) {
    return this._addCheck({ kind: `min`, value: e, ...L.errToObj(t) });
  }
  max(e, t) {
    return this._addCheck({ kind: `max`, value: e, ...L.errToObj(t) });
  }
  length(e, t) {
    return this._addCheck({ kind: `length`, value: e, ...L.errToObj(t) });
  }
  nonempty(e) {
    return this.min(1, L.errToObj(e));
  }
  trim() {
    return new e({ ...this._def, checks: [...this._def.checks, { kind: `trim` }] });
  }
  toLowerCase() {
    return new e({ ...this._def, checks: [...this._def.checks, { kind: `toLowerCase` }] });
  }
  toUpperCase() {
    return new e({ ...this._def, checks: [...this._def.checks, { kind: `toUpperCase` }] });
  }
  get isDatetime() {
    return !!this._def.checks.find((e) => e.kind === `datetime`);
  }
  get isDate() {
    return !!this._def.checks.find((e) => e.kind === `date`);
  }
  get isTime() {
    return !!this._def.checks.find((e) => e.kind === `time`);
  }
  get isDuration() {
    return !!this._def.checks.find((e) => e.kind === `duration`);
  }
  get isEmail() {
    return !!this._def.checks.find((e) => e.kind === `email`);
  }
  get isURL() {
    return !!this._def.checks.find((e) => e.kind === `url`);
  }
  get isEmoji() {
    return !!this._def.checks.find((e) => e.kind === `emoji`);
  }
  get isUUID() {
    return !!this._def.checks.find((e) => e.kind === `uuid`);
  }
  get isNANOID() {
    return !!this._def.checks.find((e) => e.kind === `nanoid`);
  }
  get isCUID() {
    return !!this._def.checks.find((e) => e.kind === `cuid`);
  }
  get isCUID2() {
    return !!this._def.checks.find((e) => e.kind === `cuid2`);
  }
  get isULID() {
    return !!this._def.checks.find((e) => e.kind === `ulid`);
  }
  get isIP() {
    return !!this._def.checks.find((e) => e.kind === `ip`);
  }
  get isCIDR() {
    return !!this._def.checks.find((e) => e.kind === `cidr`);
  }
  get isBase64() {
    return !!this._def.checks.find((e) => e.kind === `base64`);
  }
  get isBase64url() {
    return !!this._def.checks.find((e) => e.kind === `base64url`);
  }
  get minLength() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `min` && (e === null || t.value > e) && (e = t.value);
    return e;
  }
  get maxLength() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `max` && (e === null || t.value < e) && (e = t.value);
    return e;
  }
};
rn.create = (e) => new rn({ checks: [], typeName: Z.ZodString, coerce: e?.coerce ?? !1, ...z(e) });
function an(e, t) {
  let n = (e.toString().split(`.`)[1] || ``).length,
    r = (t.toString().split(`.`)[1] || ``).length,
    i = n > r ? n : r;
  return (
    (Number.parseInt(e.toFixed(i).replace(`.`, ``)) %
      Number.parseInt(t.toFixed(i).replace(`.`, ``))) /
    10 ** i
  );
}
var on = class e extends B {
  constructor() {
    (super(...arguments),
      (this.min = this.gte),
      (this.max = this.lte),
      (this.step = this.multipleOf));
  }
  _parse(e) {
    if ((this._def.coerce && (e.data = Number(e.data)), this._getType(e) !== O.number)) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.number, received: t.parsedType }), P);
    }
    let t,
      n = new N();
    for (let r of this._def.checks)
      r.kind === `int`
        ? D.isInteger(e.data) ||
          ((t = this._getOrReturnCtx(e, t)),
          M(t, {
            code: A.invalid_type,
            expected: `integer`,
            received: `float`,
            message: r.message,
          }),
          n.dirty())
        : r.kind === `min`
          ? (r.inclusive ? e.data < r.value : e.data <= r.value) &&
            ((t = this._getOrReturnCtx(e, t)),
            M(t, {
              code: A.too_small,
              minimum: r.value,
              type: `number`,
              inclusive: r.inclusive,
              exact: !1,
              message: r.message,
            }),
            n.dirty())
          : r.kind === `max`
            ? (r.inclusive ? e.data > r.value : e.data >= r.value) &&
              ((t = this._getOrReturnCtx(e, t)),
              M(t, {
                code: A.too_big,
                maximum: r.value,
                type: `number`,
                inclusive: r.inclusive,
                exact: !1,
                message: r.message,
              }),
              n.dirty())
            : r.kind === `multipleOf`
              ? an(e.data, r.value) !== 0 &&
                ((t = this._getOrReturnCtx(e, t)),
                M(t, { code: A.not_multiple_of, multipleOf: r.value, message: r.message }),
                n.dirty())
              : r.kind === `finite`
                ? Number.isFinite(e.data) ||
                  ((t = this._getOrReturnCtx(e, t)),
                  M(t, { code: A.not_finite, message: r.message }),
                  n.dirty())
                : D.assertNever(r);
    return { status: n.value, value: e.data };
  }
  gte(e, t) {
    return this.setLimit(`min`, e, !0, L.toString(t));
  }
  gt(e, t) {
    return this.setLimit(`min`, e, !1, L.toString(t));
  }
  lte(e, t) {
    return this.setLimit(`max`, e, !0, L.toString(t));
  }
  lt(e, t) {
    return this.setLimit(`max`, e, !1, L.toString(t));
  }
  setLimit(t, n, r, i) {
    return new e({
      ...this._def,
      checks: [...this._def.checks, { kind: t, value: n, inclusive: r, message: L.toString(i) }],
    });
  }
  _addCheck(t) {
    return new e({ ...this._def, checks: [...this._def.checks, t] });
  }
  int(e) {
    return this._addCheck({ kind: `int`, message: L.toString(e) });
  }
  positive(e) {
    return this._addCheck({ kind: `min`, value: 0, inclusive: !1, message: L.toString(e) });
  }
  negative(e) {
    return this._addCheck({ kind: `max`, value: 0, inclusive: !1, message: L.toString(e) });
  }
  nonpositive(e) {
    return this._addCheck({ kind: `max`, value: 0, inclusive: !0, message: L.toString(e) });
  }
  nonnegative(e) {
    return this._addCheck({ kind: `min`, value: 0, inclusive: !0, message: L.toString(e) });
  }
  multipleOf(e, t) {
    return this._addCheck({ kind: `multipleOf`, value: e, message: L.toString(t) });
  }
  finite(e) {
    return this._addCheck({ kind: `finite`, message: L.toString(e) });
  }
  safe(e) {
    return this._addCheck({
      kind: `min`,
      inclusive: !0,
      value: -(2 ** 53 - 1),
      message: L.toString(e),
    })._addCheck({ kind: `max`, inclusive: !0, value: 2 ** 53 - 1, message: L.toString(e) });
  }
  get minValue() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `min` && (e === null || t.value > e) && (e = t.value);
    return e;
  }
  get maxValue() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `max` && (e === null || t.value < e) && (e = t.value);
    return e;
  }
  get isInt() {
    return !!this._def.checks.find(
      (e) => e.kind === `int` || (e.kind === `multipleOf` && D.isInteger(e.value)),
    );
  }
  get isFinite() {
    let e = null,
      t = null;
    for (let n of this._def.checks)
      if (n.kind === `finite` || n.kind === `int` || n.kind === `multipleOf`) return !0;
      else
        n.kind === `min`
          ? (t === null || n.value > t) && (t = n.value)
          : n.kind === `max` && (e === null || n.value < e) && (e = n.value);
    return Number.isFinite(t) && Number.isFinite(e);
  }
};
on.create = (e) => new on({ checks: [], typeName: Z.ZodNumber, coerce: e?.coerce || !1, ...z(e) });
var sn = class e extends B {
  constructor() {
    (super(...arguments), (this.min = this.gte), (this.max = this.lte));
  }
  _parse(e) {
    if (this._def.coerce)
      try {
        e.data = BigInt(e.data);
      } catch {
        return this._getInvalidInput(e);
      }
    if (this._getType(e) !== O.bigint) return this._getInvalidInput(e);
    let t,
      n = new N();
    for (let r of this._def.checks)
      r.kind === `min`
        ? (r.inclusive ? e.data < r.value : e.data <= r.value) &&
          ((t = this._getOrReturnCtx(e, t)),
          M(t, {
            code: A.too_small,
            type: `bigint`,
            minimum: r.value,
            inclusive: r.inclusive,
            message: r.message,
          }),
          n.dirty())
        : r.kind === `max`
          ? (r.inclusive ? e.data > r.value : e.data >= r.value) &&
            ((t = this._getOrReturnCtx(e, t)),
            M(t, {
              code: A.too_big,
              type: `bigint`,
              maximum: r.value,
              inclusive: r.inclusive,
              message: r.message,
            }),
            n.dirty())
          : r.kind === `multipleOf`
            ? e.data % r.value !== BigInt(0) &&
              ((t = this._getOrReturnCtx(e, t)),
              M(t, { code: A.not_multiple_of, multipleOf: r.value, message: r.message }),
              n.dirty())
            : D.assertNever(r);
    return { status: n.value, value: e.data };
  }
  _getInvalidInput(e) {
    let t = this._getOrReturnCtx(e);
    return (M(t, { code: A.invalid_type, expected: O.bigint, received: t.parsedType }), P);
  }
  gte(e, t) {
    return this.setLimit(`min`, e, !0, L.toString(t));
  }
  gt(e, t) {
    return this.setLimit(`min`, e, !1, L.toString(t));
  }
  lte(e, t) {
    return this.setLimit(`max`, e, !0, L.toString(t));
  }
  lt(e, t) {
    return this.setLimit(`max`, e, !1, L.toString(t));
  }
  setLimit(t, n, r, i) {
    return new e({
      ...this._def,
      checks: [...this._def.checks, { kind: t, value: n, inclusive: r, message: L.toString(i) }],
    });
  }
  _addCheck(t) {
    return new e({ ...this._def, checks: [...this._def.checks, t] });
  }
  positive(e) {
    return this._addCheck({ kind: `min`, value: BigInt(0), inclusive: !1, message: L.toString(e) });
  }
  negative(e) {
    return this._addCheck({ kind: `max`, value: BigInt(0), inclusive: !1, message: L.toString(e) });
  }
  nonpositive(e) {
    return this._addCheck({ kind: `max`, value: BigInt(0), inclusive: !0, message: L.toString(e) });
  }
  nonnegative(e) {
    return this._addCheck({ kind: `min`, value: BigInt(0), inclusive: !0, message: L.toString(e) });
  }
  multipleOf(e, t) {
    return this._addCheck({ kind: `multipleOf`, value: e, message: L.toString(t) });
  }
  get minValue() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `min` && (e === null || t.value > e) && (e = t.value);
    return e;
  }
  get maxValue() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `max` && (e === null || t.value < e) && (e = t.value);
    return e;
  }
};
sn.create = (e) => new sn({ checks: [], typeName: Z.ZodBigInt, coerce: e?.coerce ?? !1, ...z(e) });
var cn = class extends B {
  _parse(e) {
    if ((this._def.coerce && (e.data = !!e.data), this._getType(e) !== O.boolean)) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.boolean, received: t.parsedType }), P);
    }
    return F(e.data);
  }
};
cn.create = (e) => new cn({ typeName: Z.ZodBoolean, coerce: e?.coerce || !1, ...z(e) });
var ln = class e extends B {
  _parse(e) {
    if ((this._def.coerce && (e.data = new Date(e.data)), this._getType(e) !== O.date)) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.date, received: t.parsedType }), P);
    }
    if (Number.isNaN(e.data.getTime()))
      return (M(this._getOrReturnCtx(e), { code: A.invalid_date }), P);
    let t = new N(),
      n;
    for (let r of this._def.checks)
      r.kind === `min`
        ? e.data.getTime() < r.value &&
          ((n = this._getOrReturnCtx(e, n)),
          M(n, {
            code: A.too_small,
            message: r.message,
            inclusive: !0,
            exact: !1,
            minimum: r.value,
            type: `date`,
          }),
          t.dirty())
        : r.kind === `max`
          ? e.data.getTime() > r.value &&
            ((n = this._getOrReturnCtx(e, n)),
            M(n, {
              code: A.too_big,
              message: r.message,
              inclusive: !0,
              exact: !1,
              maximum: r.value,
              type: `date`,
            }),
            t.dirty())
          : D.assertNever(r);
    return { status: t.value, value: new Date(e.data.getTime()) };
  }
  _addCheck(t) {
    return new e({ ...this._def, checks: [...this._def.checks, t] });
  }
  min(e, t) {
    return this._addCheck({ kind: `min`, value: e.getTime(), message: L.toString(t) });
  }
  max(e, t) {
    return this._addCheck({ kind: `max`, value: e.getTime(), message: L.toString(t) });
  }
  get minDate() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `min` && (e === null || t.value > e) && (e = t.value);
    return e == null ? null : new Date(e);
  }
  get maxDate() {
    let e = null;
    for (let t of this._def.checks)
      t.kind === `max` && (e === null || t.value < e) && (e = t.value);
    return e == null ? null : new Date(e);
  }
};
ln.create = (e) => new ln({ checks: [], coerce: e?.coerce || !1, typeName: Z.ZodDate, ...z(e) });
var un = class extends B {
  _parse(e) {
    if (this._getType(e) !== O.symbol) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.symbol, received: t.parsedType }), P);
    }
    return F(e.data);
  }
};
un.create = (e) => new un({ typeName: Z.ZodSymbol, ...z(e) });
var dn = class extends B {
  _parse(e) {
    if (this._getType(e) !== O.undefined) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.undefined, received: t.parsedType }), P);
    }
    return F(e.data);
  }
};
dn.create = (e) => new dn({ typeName: Z.ZodUndefined, ...z(e) });
var fn = class extends B {
  _parse(e) {
    if (this._getType(e) !== O.null) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.null, received: t.parsedType }), P);
    }
    return F(e.data);
  }
};
fn.create = (e) => new fn({ typeName: Z.ZodNull, ...z(e) });
var pn = class extends B {
  constructor() {
    (super(...arguments), (this._any = !0));
  }
  _parse(e) {
    return F(e.data);
  }
};
pn.create = (e) => new pn({ typeName: Z.ZodAny, ...z(e) });
var V = class extends B {
  constructor() {
    (super(...arguments), (this._unknown = !0));
  }
  _parse(e) {
    return F(e.data);
  }
};
V.create = (e) => new V({ typeName: Z.ZodUnknown, ...z(e) });
var H = class extends B {
  _parse(e) {
    let t = this._getOrReturnCtx(e);
    return (M(t, { code: A.invalid_type, expected: O.never, received: t.parsedType }), P);
  }
};
H.create = (e) => new H({ typeName: Z.ZodNever, ...z(e) });
var mn = class extends B {
  _parse(e) {
    if (this._getType(e) !== O.undefined) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.void, received: t.parsedType }), P);
    }
    return F(e.data);
  }
};
mn.create = (e) => new mn({ typeName: Z.ZodVoid, ...z(e) });
var U = class e extends B {
  _parse(e) {
    let { ctx: t, status: n } = this._processInputParams(e),
      r = this._def;
    if (t.parsedType !== O.array)
      return (M(t, { code: A.invalid_type, expected: O.array, received: t.parsedType }), P);
    if (r.exactLength !== null) {
      let e = t.data.length > r.exactLength.value,
        i = t.data.length < r.exactLength.value;
      (e || i) &&
        (M(t, {
          code: e ? A.too_big : A.too_small,
          minimum: i ? r.exactLength.value : void 0,
          maximum: e ? r.exactLength.value : void 0,
          type: `array`,
          inclusive: !0,
          exact: !0,
          message: r.exactLength.message,
        }),
        n.dirty());
    }
    if (
      (r.minLength !== null &&
        t.data.length < r.minLength.value &&
        (M(t, {
          code: A.too_small,
          minimum: r.minLength.value,
          type: `array`,
          inclusive: !0,
          exact: !1,
          message: r.minLength.message,
        }),
        n.dirty()),
      r.maxLength !== null &&
        t.data.length > r.maxLength.value &&
        (M(t, {
          code: A.too_big,
          maximum: r.maxLength.value,
          type: `array`,
          inclusive: !0,
          exact: !1,
          message: r.maxLength.message,
        }),
        n.dirty()),
      t.common.async)
    )
      return Promise.all(
        [...t.data].map((e, n) => r.type._parseAsync(new R(t, e, t.path, n))),
      ).then((e) => N.mergeArray(n, e));
    let i = [...t.data].map((e, n) => r.type._parseSync(new R(t, e, t.path, n)));
    return N.mergeArray(n, i);
  }
  get element() {
    return this._def.type;
  }
  min(t, n) {
    return new e({ ...this._def, minLength: { value: t, message: L.toString(n) } });
  }
  max(t, n) {
    return new e({ ...this._def, maxLength: { value: t, message: L.toString(n) } });
  }
  length(t, n) {
    return new e({ ...this._def, exactLength: { value: t, message: L.toString(n) } });
  }
  nonempty(e) {
    return this.min(1, e);
  }
};
U.create = (e, t) =>
  new U({
    type: e,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: Z.ZodArray,
    ...z(t),
  });
function W(e) {
  if (e instanceof G) {
    let t = {};
    for (let n in e.shape) {
      let r = e.shape[n];
      t[n] = Y.create(W(r));
    }
    return new G({ ...e._def, shape: () => t });
  } else if (e instanceof U) return new U({ ...e._def, type: W(e.element) });
  else if (e instanceof Y) return Y.create(W(e.unwrap()));
  else if (e instanceof X) return X.create(W(e.unwrap()));
  else if (e instanceof q) return q.create(e.items.map((e) => W(e)));
  else return e;
}
var G = class e extends B {
  constructor() {
    (super(...arguments),
      (this._cached = null),
      (this.nonstrict = this.passthrough),
      (this.augment = this.extend));
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    let e = this._def.shape(),
      t = D.objectKeys(e);
    return ((this._cached = { shape: e, keys: t }), this._cached);
  }
  _parse(e) {
    if (this._getType(e) !== O.object) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.object, received: t.parsedType }), P);
    }
    let { status: t, ctx: n } = this._processInputParams(e),
      { shape: r, keys: i } = this._getCached(),
      a = [];
    if (!(this._def.catchall instanceof H && this._def.unknownKeys === `strip`))
      for (let e in n.data) i.includes(e) || a.push(e);
    let o = [];
    for (let e of i) {
      let t = r[e],
        i = n.data[e];
      o.push({
        key: { status: `valid`, value: e },
        value: t._parse(new R(n, i, n.path, e)),
        alwaysSet: e in n.data,
      });
    }
    if (this._def.catchall instanceof H) {
      let e = this._def.unknownKeys;
      if (e === `passthrough`)
        for (let e of a)
          o.push({
            key: { status: `valid`, value: e },
            value: { status: `valid`, value: n.data[e] },
          });
      else if (e === `strict`)
        a.length > 0 && (M(n, { code: A.unrecognized_keys, keys: a }), t.dirty());
      else if (e !== `strip`) throw Error(`Internal ZodObject error: invalid unknownKeys value.`);
    } else {
      let e = this._def.catchall;
      for (let t of a) {
        let r = n.data[t];
        o.push({
          key: { status: `valid`, value: t },
          value: e._parse(new R(n, r, n.path, t)),
          alwaysSet: t in n.data,
        });
      }
    }
    return n.common.async
      ? Promise.resolve()
          .then(async () => {
            let e = [];
            for (let t of o) {
              let n = await t.key,
                r = await t.value;
              e.push({ key: n, value: r, alwaysSet: t.alwaysSet });
            }
            return e;
          })
          .then((e) => N.mergeObjectSync(t, e))
      : N.mergeObjectSync(t, o);
  }
  get shape() {
    return this._def.shape();
  }
  strict(t) {
    return (
      L.errToObj,
      new e({
        ...this._def,
        unknownKeys: `strict`,
        ...(t === void 0
          ? {}
          : {
              errorMap: (e, n) => {
                let r = this._def.errorMap?.(e, n).message ?? n.defaultError;
                return e.code === `unrecognized_keys`
                  ? { message: L.errToObj(t).message ?? r }
                  : { message: r };
              },
            }),
      })
    );
  }
  strip() {
    return new e({ ...this._def, unknownKeys: `strip` });
  }
  passthrough() {
    return new e({ ...this._def, unknownKeys: `passthrough` });
  }
  extend(t) {
    return new e({ ...this._def, shape: () => ({ ...this._def.shape(), ...t }) });
  }
  merge(t) {
    return new e({
      unknownKeys: t._def.unknownKeys,
      catchall: t._def.catchall,
      shape: () => ({ ...this._def.shape(), ...t._def.shape() }),
      typeName: Z.ZodObject,
    });
  }
  setKey(e, t) {
    return this.augment({ [e]: t });
  }
  catchall(t) {
    return new e({ ...this._def, catchall: t });
  }
  pick(t) {
    let n = {};
    for (let e of D.objectKeys(t)) t[e] && this.shape[e] && (n[e] = this.shape[e]);
    return new e({ ...this._def, shape: () => n });
  }
  omit(t) {
    let n = {};
    for (let e of D.objectKeys(this.shape)) t[e] || (n[e] = this.shape[e]);
    return new e({ ...this._def, shape: () => n });
  }
  deepPartial() {
    return W(this);
  }
  partial(t) {
    let n = {};
    for (let e of D.objectKeys(this.shape)) {
      let r = this.shape[e];
      t && !t[e] ? (n[e] = r) : (n[e] = r.optional());
    }
    return new e({ ...this._def, shape: () => n });
  }
  required(t) {
    let n = {};
    for (let e of D.objectKeys(this.shape))
      if (t && !t[e]) n[e] = this.shape[e];
      else {
        let t = this.shape[e];
        for (; t instanceof Y; ) t = t._def.innerType;
        n[e] = t;
      }
    return new e({ ...this._def, shape: () => n });
  }
  keyof() {
    return Tn(D.objectKeys(this.shape));
  }
};
((G.create = (e, t) =>
  new G({
    shape: () => e,
    unknownKeys: `strip`,
    catchall: H.create(),
    typeName: Z.ZodObject,
    ...z(t),
  })),
  (G.strictCreate = (e, t) =>
    new G({
      shape: () => e,
      unknownKeys: `strict`,
      catchall: H.create(),
      typeName: Z.ZodObject,
      ...z(t),
    })),
  (G.lazycreate = (e, t) =>
    new G({
      shape: e,
      unknownKeys: `strip`,
      catchall: H.create(),
      typeName: Z.ZodObject,
      ...z(t),
    })));
var hn = class extends B {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e),
      n = this._def.options;
    function r(e) {
      for (let t of e) if (t.result.status === `valid`) return t.result;
      for (let n of e)
        if (n.result.status === `dirty`)
          return (t.common.issues.push(...n.ctx.common.issues), n.result);
      let n = e.map((e) => new j(e.ctx.common.issues));
      return (M(t, { code: A.invalid_union, unionErrors: n }), P);
    }
    if (t.common.async)
      return Promise.all(
        n.map(async (e) => {
          let n = { ...t, common: { ...t.common, issues: [] }, parent: null };
          return { result: await e._parseAsync({ data: t.data, path: t.path, parent: n }), ctx: n };
        }),
      ).then(r);
    {
      let e,
        r = [];
      for (let i of n) {
        let n = { ...t, common: { ...t.common, issues: [] }, parent: null },
          a = i._parseSync({ data: t.data, path: t.path, parent: n });
        if (a.status === `valid`) return a;
        (a.status === `dirty` && !e && (e = { result: a, ctx: n }),
          n.common.issues.length && r.push(n.common.issues));
      }
      if (e) return (t.common.issues.push(...e.ctx.common.issues), e.result);
      let i = r.map((e) => new j(e));
      return (M(t, { code: A.invalid_union, unionErrors: i }), P);
    }
  }
  get options() {
    return this._def.options;
  }
};
hn.create = (e, t) => new hn({ options: e, typeName: Z.ZodUnion, ...z(t) });
var K = (e) =>
    e instanceof Cn
      ? K(e.schema)
      : e instanceof J
        ? K(e.innerType())
        : e instanceof wn
          ? [e.value]
          : e instanceof En
            ? e.options
            : e instanceof Dn
              ? D.objectValues(e.enum)
              : e instanceof kn
                ? K(e._def.innerType)
                : e instanceof dn
                  ? [void 0]
                  : e instanceof fn
                    ? [null]
                    : e instanceof Y
                      ? [void 0, ...K(e.unwrap())]
                      : e instanceof X
                        ? [null, ...K(e.unwrap())]
                        : e instanceof Mn || e instanceof Pn
                          ? K(e.unwrap())
                          : e instanceof An
                            ? K(e._def.innerType)
                            : [],
  gn = class e extends B {
    _parse(e) {
      let { ctx: t } = this._processInputParams(e);
      if (t.parsedType !== O.object)
        return (M(t, { code: A.invalid_type, expected: O.object, received: t.parsedType }), P);
      let n = this.discriminator,
        r = t.data[n],
        i = this.optionsMap.get(r);
      return i
        ? t.common.async
          ? i._parseAsync({ data: t.data, path: t.path, parent: t })
          : i._parseSync({ data: t.data, path: t.path, parent: t })
        : (M(t, {
            code: A.invalid_union_discriminator,
            options: Array.from(this.optionsMap.keys()),
            path: [n],
          }),
          P);
    }
    get discriminator() {
      return this._def.discriminator;
    }
    get options() {
      return this._def.options;
    }
    get optionsMap() {
      return this._def.optionsMap;
    }
    static create(t, n, r) {
      let i = new Map();
      for (let e of n) {
        let n = K(e.shape[t]);
        if (!n.length)
          throw Error(
            `A discriminator value for key \`${t}\` could not be extracted from all schema options`,
          );
        for (let r of n) {
          if (i.has(r))
            throw Error(`Discriminator property ${String(t)} has duplicate value ${String(r)}`);
          i.set(r, e);
        }
      }
      return new e({
        typeName: Z.ZodDiscriminatedUnion,
        discriminator: t,
        options: n,
        optionsMap: i,
        ...z(r),
      });
    }
  };
function _n(e, t) {
  let n = k(e),
    r = k(t);
  if (e === t) return { valid: !0, data: e };
  if (n === O.object && r === O.object) {
    let n = D.objectKeys(t),
      r = D.objectKeys(e).filter((e) => n.indexOf(e) !== -1),
      i = { ...e, ...t };
    for (let n of r) {
      let r = _n(e[n], t[n]);
      if (!r.valid) return { valid: !1 };
      i[n] = r.data;
    }
    return { valid: !0, data: i };
  } else if (n === O.array && r === O.array) {
    if (e.length !== t.length) return { valid: !1 };
    let n = [];
    for (let r = 0; r < e.length; r++) {
      let i = e[r],
        a = t[r],
        o = _n(i, a);
      if (!o.valid) return { valid: !1 };
      n.push(o.data);
    }
    return { valid: !0, data: n };
  } else if (n === O.date && r === O.date && +e == +t) return { valid: !0, data: e };
  else return { valid: !1 };
}
var vn = class extends B {
  _parse(e) {
    let { status: t, ctx: n } = this._processInputParams(e),
      r = (e, r) => {
        if (kt(e) || kt(r)) return P;
        let i = _n(e.value, r.value);
        return i.valid
          ? ((At(e) || At(r)) && t.dirty(), { status: t.value, value: i.data })
          : (M(n, { code: A.invalid_intersection_types }), P);
      };
    return n.common.async
      ? Promise.all([
          this._def.left._parseAsync({ data: n.data, path: n.path, parent: n }),
          this._def.right._parseAsync({ data: n.data, path: n.path, parent: n }),
        ]).then(([e, t]) => r(e, t))
      : r(
          this._def.left._parseSync({ data: n.data, path: n.path, parent: n }),
          this._def.right._parseSync({ data: n.data, path: n.path, parent: n }),
        );
  }
};
vn.create = (e, t, n) => new vn({ left: e, right: t, typeName: Z.ZodIntersection, ...z(n) });
var q = class e extends B {
  _parse(e) {
    let { status: t, ctx: n } = this._processInputParams(e);
    if (n.parsedType !== O.array)
      return (M(n, { code: A.invalid_type, expected: O.array, received: n.parsedType }), P);
    if (n.data.length < this._def.items.length)
      return (
        M(n, {
          code: A.too_small,
          minimum: this._def.items.length,
          inclusive: !0,
          exact: !1,
          type: `array`,
        }),
        P
      );
    !this._def.rest &&
      n.data.length > this._def.items.length &&
      (M(n, {
        code: A.too_big,
        maximum: this._def.items.length,
        inclusive: !0,
        exact: !1,
        type: `array`,
      }),
      t.dirty());
    let r = [...n.data]
      .map((e, t) => {
        let r = this._def.items[t] || this._def.rest;
        return r ? r._parse(new R(n, e, n.path, t)) : null;
      })
      .filter((e) => !!e);
    return n.common.async ? Promise.all(r).then((e) => N.mergeArray(t, e)) : N.mergeArray(t, r);
  }
  get items() {
    return this._def.items;
  }
  rest(t) {
    return new e({ ...this._def, rest: t });
  }
};
q.create = (e, t) => {
  if (!Array.isArray(e)) throw Error(`You must pass an array of schemas to z.tuple([ ... ])`);
  return new q({ items: e, typeName: Z.ZodTuple, rest: null, ...z(t) });
};
var yn = class e extends B {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(e) {
      let { status: t, ctx: n } = this._processInputParams(e);
      if (n.parsedType !== O.object)
        return (M(n, { code: A.invalid_type, expected: O.object, received: n.parsedType }), P);
      let r = [],
        i = this._def.keyType,
        a = this._def.valueType;
      for (let e in n.data)
        r.push({
          key: i._parse(new R(n, e, n.path, e)),
          value: a._parse(new R(n, n.data[e], n.path, e)),
          alwaysSet: e in n.data,
        });
      return n.common.async ? N.mergeObjectAsync(t, r) : N.mergeObjectSync(t, r);
    }
    get element() {
      return this._def.valueType;
    }
    static create(t, n, r) {
      return n instanceof B
        ? new e({ keyType: t, valueType: n, typeName: Z.ZodRecord, ...z(r) })
        : new e({ keyType: rn.create(), valueType: t, typeName: Z.ZodRecord, ...z(n) });
    }
  },
  bn = class extends B {
    get keySchema() {
      return this._def.keyType;
    }
    get valueSchema() {
      return this._def.valueType;
    }
    _parse(e) {
      let { status: t, ctx: n } = this._processInputParams(e);
      if (n.parsedType !== O.map)
        return (M(n, { code: A.invalid_type, expected: O.map, received: n.parsedType }), P);
      let r = this._def.keyType,
        i = this._def.valueType,
        a = [...n.data.entries()].map(([e, t], a) => ({
          key: r._parse(new R(n, e, n.path, [a, `key`])),
          value: i._parse(new R(n, t, n.path, [a, `value`])),
        }));
      if (n.common.async) {
        let e = new Map();
        return Promise.resolve().then(async () => {
          for (let n of a) {
            let r = await n.key,
              i = await n.value;
            if (r.status === `aborted` || i.status === `aborted`) return P;
            ((r.status === `dirty` || i.status === `dirty`) && t.dirty(), e.set(r.value, i.value));
          }
          return { status: t.value, value: e };
        });
      } else {
        let e = new Map();
        for (let n of a) {
          let r = n.key,
            i = n.value;
          if (r.status === `aborted` || i.status === `aborted`) return P;
          ((r.status === `dirty` || i.status === `dirty`) && t.dirty(), e.set(r.value, i.value));
        }
        return { status: t.value, value: e };
      }
    }
  };
bn.create = (e, t, n) => new bn({ valueType: t, keyType: e, typeName: Z.ZodMap, ...z(n) });
var xn = class e extends B {
  _parse(e) {
    let { status: t, ctx: n } = this._processInputParams(e);
    if (n.parsedType !== O.set)
      return (M(n, { code: A.invalid_type, expected: O.set, received: n.parsedType }), P);
    let r = this._def;
    (r.minSize !== null &&
      n.data.size < r.minSize.value &&
      (M(n, {
        code: A.too_small,
        minimum: r.minSize.value,
        type: `set`,
        inclusive: !0,
        exact: !1,
        message: r.minSize.message,
      }),
      t.dirty()),
      r.maxSize !== null &&
        n.data.size > r.maxSize.value &&
        (M(n, {
          code: A.too_big,
          maximum: r.maxSize.value,
          type: `set`,
          inclusive: !0,
          exact: !1,
          message: r.maxSize.message,
        }),
        t.dirty()));
    let i = this._def.valueType;
    function a(e) {
      let n = new Set();
      for (let r of e) {
        if (r.status === `aborted`) return P;
        (r.status === `dirty` && t.dirty(), n.add(r.value));
      }
      return { status: t.value, value: n };
    }
    let o = [...n.data.values()].map((e, t) => i._parse(new R(n, e, n.path, t)));
    return n.common.async ? Promise.all(o).then((e) => a(e)) : a(o);
  }
  min(t, n) {
    return new e({ ...this._def, minSize: { value: t, message: L.toString(n) } });
  }
  max(t, n) {
    return new e({ ...this._def, maxSize: { value: t, message: L.toString(n) } });
  }
  size(e, t) {
    return this.min(e, t).max(e, t);
  }
  nonempty(e) {
    return this.min(1, e);
  }
};
xn.create = (e, t) =>
  new xn({ valueType: e, minSize: null, maxSize: null, typeName: Z.ZodSet, ...z(t) });
var Sn = class e extends B {
    constructor() {
      (super(...arguments), (this.validate = this.implement));
    }
    _parse(e) {
      let { ctx: t } = this._processInputParams(e);
      if (t.parsedType !== O.function)
        return (M(t, { code: A.invalid_type, expected: O.function, received: t.parsedType }), P);
      function n(e, n) {
        return Dt({
          data: e,
          path: t.path,
          errorMaps: [t.common.contextualErrorMap, t.schemaErrorMap, Et(), wt].filter((e) => !!e),
          issueData: { code: A.invalid_arguments, argumentsError: n },
        });
      }
      function r(e, n) {
        return Dt({
          data: e,
          path: t.path,
          errorMaps: [t.common.contextualErrorMap, t.schemaErrorMap, Et(), wt].filter((e) => !!e),
          issueData: { code: A.invalid_return_type, returnTypeError: n },
        });
      }
      let i = { errorMap: t.common.contextualErrorMap },
        a = t.data;
      if (this._def.returns instanceof On) {
        let e = this;
        return F(async function (...t) {
          let o = new j([]),
            s = await e._def.args.parseAsync(t, i).catch((e) => {
              throw (o.addIssue(n(t, e)), o);
            }),
            c = await Reflect.apply(a, this, s);
          return await e._def.returns._def.type.parseAsync(c, i).catch((e) => {
            throw (o.addIssue(r(c, e)), o);
          });
        });
      } else {
        let e = this;
        return F(function (...t) {
          let o = e._def.args.safeParse(t, i);
          if (!o.success) throw new j([n(t, o.error)]);
          let s = Reflect.apply(a, this, o.data),
            c = e._def.returns.safeParse(s, i);
          if (!c.success) throw new j([r(s, c.error)]);
          return c.data;
        });
      }
    }
    parameters() {
      return this._def.args;
    }
    returnType() {
      return this._def.returns;
    }
    args(...t) {
      return new e({ ...this._def, args: q.create(t).rest(V.create()) });
    }
    returns(t) {
      return new e({ ...this._def, returns: t });
    }
    implement(e) {
      return this.parse(e);
    }
    strictImplement(e) {
      return this.parse(e);
    }
    static create(t, n, r) {
      return new e({
        args: t || q.create([]).rest(V.create()),
        returns: n || V.create(),
        typeName: Z.ZodFunction,
        ...z(r),
      });
    }
  },
  Cn = class extends B {
    get schema() {
      return this._def.getter();
    }
    _parse(e) {
      let { ctx: t } = this._processInputParams(e);
      return this._def.getter()._parse({ data: t.data, path: t.path, parent: t });
    }
  };
Cn.create = (e, t) => new Cn({ getter: e, typeName: Z.ZodLazy, ...z(t) });
var wn = class extends B {
  _parse(e) {
    if (e.data !== this._def.value) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { received: t.data, code: A.invalid_literal, expected: this._def.value }), P);
    }
    return { status: `valid`, value: e.data };
  }
  get value() {
    return this._def.value;
  }
};
wn.create = (e, t) => new wn({ value: e, typeName: Z.ZodLiteral, ...z(t) });
function Tn(e, t) {
  return new En({ values: e, typeName: Z.ZodEnum, ...z(t) });
}
var En = class e extends B {
  _parse(e) {
    if (typeof e.data != `string`) {
      let t = this._getOrReturnCtx(e),
        n = this._def.values;
      return (M(t, { expected: D.joinValues(n), received: t.parsedType, code: A.invalid_type }), P);
    }
    if (((this._cache ||= new Set(this._def.values)), !this._cache.has(e.data))) {
      let t = this._getOrReturnCtx(e),
        n = this._def.values;
      return (M(t, { received: t.data, code: A.invalid_enum_value, options: n }), P);
    }
    return F(e.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    let e = {};
    for (let t of this._def.values) e[t] = t;
    return e;
  }
  get Values() {
    let e = {};
    for (let t of this._def.values) e[t] = t;
    return e;
  }
  get Enum() {
    let e = {};
    for (let t of this._def.values) e[t] = t;
    return e;
  }
  extract(t, n = this._def) {
    return e.create(t, { ...this._def, ...n });
  }
  exclude(t, n = this._def) {
    return e.create(
      this.options.filter((e) => !t.includes(e)),
      { ...this._def, ...n },
    );
  }
};
En.create = Tn;
var Dn = class extends B {
  _parse(e) {
    let t = D.getValidEnumValues(this._def.values),
      n = this._getOrReturnCtx(e);
    if (n.parsedType !== O.string && n.parsedType !== O.number) {
      let e = D.objectValues(t);
      return (M(n, { expected: D.joinValues(e), received: n.parsedType, code: A.invalid_type }), P);
    }
    if (
      ((this._cache ||= new Set(D.getValidEnumValues(this._def.values))), !this._cache.has(e.data))
    ) {
      let e = D.objectValues(t);
      return (M(n, { received: n.data, code: A.invalid_enum_value, options: e }), P);
    }
    return F(e.data);
  }
  get enum() {
    return this._def.values;
  }
};
Dn.create = (e, t) => new Dn({ values: e, typeName: Z.ZodNativeEnum, ...z(t) });
var On = class extends B {
  unwrap() {
    return this._def.type;
  }
  _parse(e) {
    let { ctx: t } = this._processInputParams(e);
    return t.parsedType !== O.promise && t.common.async === !1
      ? (M(t, { code: A.invalid_type, expected: O.promise, received: t.parsedType }), P)
      : F(
          (t.parsedType === O.promise ? t.data : Promise.resolve(t.data)).then((e) =>
            this._def.type.parseAsync(e, { path: t.path, errorMap: t.common.contextualErrorMap }),
          ),
        );
  }
};
On.create = (e, t) => new On({ type: e, typeName: Z.ZodPromise, ...z(t) });
var J = class extends B {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === Z.ZodEffects
      ? this._def.schema.sourceType()
      : this._def.schema;
  }
  _parse(e) {
    let { status: t, ctx: n } = this._processInputParams(e),
      r = this._def.effect || null,
      i = {
        addIssue: (e) => {
          (M(n, e), e.fatal ? t.abort() : t.dirty());
        },
        get path() {
          return n.path;
        },
      };
    if (((i.addIssue = i.addIssue.bind(i)), r.type === `preprocess`)) {
      let e = r.transform(n.data, i);
      if (n.common.async)
        return Promise.resolve(e).then(async (e) => {
          if (t.value === `aborted`) return P;
          let r = await this._def.schema._parseAsync({ data: e, path: n.path, parent: n });
          return r.status === `aborted`
            ? P
            : r.status === `dirty` || t.value === `dirty`
              ? Ot(r.value)
              : r;
        });
      {
        if (t.value === `aborted`) return P;
        let r = this._def.schema._parseSync({ data: e, path: n.path, parent: n });
        return r.status === `aborted`
          ? P
          : r.status === `dirty` || t.value === `dirty`
            ? Ot(r.value)
            : r;
      }
    }
    if (r.type === `refinement`) {
      let e = (e) => {
        let t = r.refinement(e, i);
        if (n.common.async) return Promise.resolve(t);
        if (t instanceof Promise)
          throw Error(
            `Async refinement encountered during synchronous parse operation. Use .parseAsync instead.`,
          );
        return e;
      };
      if (n.common.async === !1) {
        let r = this._def.schema._parseSync({ data: n.data, path: n.path, parent: n });
        return r.status === `aborted`
          ? P
          : (r.status === `dirty` && t.dirty(), e(r.value), { status: t.value, value: r.value });
      } else
        return this._def.schema
          ._parseAsync({ data: n.data, path: n.path, parent: n })
          .then((n) =>
            n.status === `aborted`
              ? P
              : (n.status === `dirty` && t.dirty(),
                e(n.value).then(() => ({ status: t.value, value: n.value }))),
          );
    }
    if (r.type === `transform`)
      if (n.common.async === !1) {
        let e = this._def.schema._parseSync({ data: n.data, path: n.path, parent: n });
        if (!I(e)) return P;
        let a = r.transform(e.value, i);
        if (a instanceof Promise)
          throw Error(
            `Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`,
          );
        return { status: t.value, value: a };
      } else
        return this._def.schema
          ._parseAsync({ data: n.data, path: n.path, parent: n })
          .then((e) =>
            I(e)
              ? Promise.resolve(r.transform(e.value, i)).then((e) => ({
                  status: t.value,
                  value: e,
                }))
              : P,
          );
    D.assertNever(r);
  }
};
((J.create = (e, t, n) => new J({ schema: e, typeName: Z.ZodEffects, effect: t, ...z(n) })),
  (J.createWithPreprocess = (e, t, n) =>
    new J({
      schema: t,
      effect: { type: `preprocess`, transform: e },
      typeName: Z.ZodEffects,
      ...z(n),
    })));
var Y = class extends B {
  _parse(e) {
    return this._getType(e) === O.undefined ? F(void 0) : this._def.innerType._parse(e);
  }
  unwrap() {
    return this._def.innerType;
  }
};
Y.create = (e, t) => new Y({ innerType: e, typeName: Z.ZodOptional, ...z(t) });
var X = class extends B {
  _parse(e) {
    return this._getType(e) === O.null ? F(null) : this._def.innerType._parse(e);
  }
  unwrap() {
    return this._def.innerType;
  }
};
X.create = (e, t) => new X({ innerType: e, typeName: Z.ZodNullable, ...z(t) });
var kn = class extends B {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e),
      n = t.data;
    return (
      t.parsedType === O.undefined && (n = this._def.defaultValue()),
      this._def.innerType._parse({ data: n, path: t.path, parent: t })
    );
  }
  removeDefault() {
    return this._def.innerType;
  }
};
kn.create = (e, t) =>
  new kn({
    innerType: e,
    typeName: Z.ZodDefault,
    defaultValue: typeof t.default == `function` ? t.default : () => t.default,
    ...z(t),
  });
var An = class extends B {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e),
      n = { ...t, common: { ...t.common, issues: [] } },
      r = this._def.innerType._parse({ data: n.data, path: n.path, parent: { ...n } });
    return jt(r)
      ? r.then((e) => ({
          status: `valid`,
          value:
            e.status === `valid`
              ? e.value
              : this._def.catchValue({
                  get error() {
                    return new j(n.common.issues);
                  },
                  input: n.data,
                }),
        }))
      : {
          status: `valid`,
          value:
            r.status === `valid`
              ? r.value
              : this._def.catchValue({
                  get error() {
                    return new j(n.common.issues);
                  },
                  input: n.data,
                }),
        };
  }
  removeCatch() {
    return this._def.innerType;
  }
};
An.create = (e, t) =>
  new An({
    innerType: e,
    typeName: Z.ZodCatch,
    catchValue: typeof t.catch == `function` ? t.catch : () => t.catch,
    ...z(t),
  });
var jn = class extends B {
  _parse(e) {
    if (this._getType(e) !== O.nan) {
      let t = this._getOrReturnCtx(e);
      return (M(t, { code: A.invalid_type, expected: O.nan, received: t.parsedType }), P);
    }
    return { status: `valid`, value: e.data };
  }
};
jn.create = (e) => new jn({ typeName: Z.ZodNaN, ...z(e) });
var Mn = class extends B {
    _parse(e) {
      let { ctx: t } = this._processInputParams(e),
        n = t.data;
      return this._def.type._parse({ data: n, path: t.path, parent: t });
    }
    unwrap() {
      return this._def.type;
    }
  },
  Nn = class e extends B {
    _parse(e) {
      let { status: t, ctx: n } = this._processInputParams(e);
      if (n.common.async)
        return (async () => {
          let e = await this._def.in._parseAsync({ data: n.data, path: n.path, parent: n });
          return e.status === `aborted`
            ? P
            : e.status === `dirty`
              ? (t.dirty(), Ot(e.value))
              : this._def.out._parseAsync({ data: e.value, path: n.path, parent: n });
        })();
      {
        let e = this._def.in._parseSync({ data: n.data, path: n.path, parent: n });
        return e.status === `aborted`
          ? P
          : e.status === `dirty`
            ? (t.dirty(), { status: `dirty`, value: e.value })
            : this._def.out._parseSync({ data: e.value, path: n.path, parent: n });
      }
    }
    static create(t, n) {
      return new e({ in: t, out: n, typeName: Z.ZodPipeline });
    }
  },
  Pn = class extends B {
    _parse(e) {
      let t = this._def.innerType._parse(e),
        n = (e) => (I(e) && (e.value = Object.freeze(e.value)), e);
      return jt(t) ? t.then((e) => n(e)) : n(t);
    }
    unwrap() {
      return this._def.innerType;
    }
  };
((Pn.create = (e, t) => new Pn({ innerType: e, typeName: Z.ZodReadonly, ...z(t) })), G.lazycreate);
var Z;
(function (e) {
  ((e.ZodString = `ZodString`),
    (e.ZodNumber = `ZodNumber`),
    (e.ZodNaN = `ZodNaN`),
    (e.ZodBigInt = `ZodBigInt`),
    (e.ZodBoolean = `ZodBoolean`),
    (e.ZodDate = `ZodDate`),
    (e.ZodSymbol = `ZodSymbol`),
    (e.ZodUndefined = `ZodUndefined`),
    (e.ZodNull = `ZodNull`),
    (e.ZodAny = `ZodAny`),
    (e.ZodUnknown = `ZodUnknown`),
    (e.ZodNever = `ZodNever`),
    (e.ZodVoid = `ZodVoid`),
    (e.ZodArray = `ZodArray`),
    (e.ZodObject = `ZodObject`),
    (e.ZodUnion = `ZodUnion`),
    (e.ZodDiscriminatedUnion = `ZodDiscriminatedUnion`),
    (e.ZodIntersection = `ZodIntersection`),
    (e.ZodTuple = `ZodTuple`),
    (e.ZodRecord = `ZodRecord`),
    (e.ZodMap = `ZodMap`),
    (e.ZodSet = `ZodSet`),
    (e.ZodFunction = `ZodFunction`),
    (e.ZodLazy = `ZodLazy`),
    (e.ZodLiteral = `ZodLiteral`),
    (e.ZodEnum = `ZodEnum`),
    (e.ZodEffects = `ZodEffects`),
    (e.ZodNativeEnum = `ZodNativeEnum`),
    (e.ZodOptional = `ZodOptional`),
    (e.ZodNullable = `ZodNullable`),
    (e.ZodDefault = `ZodDefault`),
    (e.ZodCatch = `ZodCatch`),
    (e.ZodPromise = `ZodPromise`),
    (e.ZodBranded = `ZodBranded`),
    (e.ZodPipeline = `ZodPipeline`),
    (e.ZodReadonly = `ZodReadonly`));
})((Z ||= {}));
var Q = rn.create,
  Fn = on.create;
(jn.create, sn.create);
var In = cn.create;
(ln.create, un.create, dn.create, fn.create, pn.create, V.create, H.create, mn.create);
var Ln = U.create,
  $ = G.create;
(G.strictCreate,
  hn.create,
  gn.create,
  vn.create,
  q.create,
  yn.create,
  bn.create,
  xn.create,
  Sn.create,
  Cn.create);
var Rn = wn.create;
(En.create, Dn.create, On.create, J.create, Y.create, X.create, J.createWithPreprocess, Nn.create);
var zn = $({ id: Q(), name: Q(), createdAt: Q() }),
  Bn = $({
    count: Fn().int().min(1).max(500),
    minDelayMs: Fn().int().min(0).max(1e4),
    maxDelayMs: Fn().int().min(1).max(1e4),
  }),
  Vn = C.router({
    ping: C.route({
      method: `GET`,
      path: `/ping`,
      description: `Health check`,
      tags: [`debug`],
    }).output($({ message: Q(), time: Q() })),
    things: {
      list: C.route({
        method: `GET`,
        path: `/things`,
        description: `List all things`,
        tags: [`things`],
      }).output($({ items: Ln(zn), total: Fn() })),
      create: C.route({
        method: `POST`,
        path: `/things`,
        description: `Create a thing`,
        tags: [`things`],
      })
        .input($({ name: Q().min(1).max(200) }))
        .output(zn),
      remove: C.route({
        method: `POST`,
        path: `/things/remove`,
        description: `Delete a thing`,
        tags: [`things`],
      })
        .input($({ id: Q().min(1) }))
        .output($({ ok: Rn(!0), id: Q(), deleted: In() })),
    },
    test: {
      randomLogStream: C.route({
        method: `POST`,
        path: `/test/random-log-stream`,
        description: `Stream random log lines with variable delays (async iterator)`,
        tags: [`streaming`],
      })
        .input(Bn)
        .output(ot(Q())),
    },
  });
function Hn() {
  return ue(new _t(Vn, { url: `${window.location.origin}/api` }));
}
var Un;
function Wn() {
  return typeof window > `u`
    ? ue(new _t(Vn, { url: `http://localhost/api` }))
    : ((Un ??= Hn()), Un);
}
var Gn = St(Wn());
function Kn() {
  let e = ee(),
    t = Wn(),
    [n, r] = (0, x.useState)(``),
    { data: i, isPending: a, error: o } = Ue(Gn.things.list.queryOptions()),
    s = We({
      mutationFn: (e) => t.things.create({ name: e }),
      onSuccess: () => {
        (e.invalidateQueries({ queryKey: Gn.things.list.queryOptions().queryKey }), r(``));
      },
    }),
    c = We({
      mutationFn: (e) => t.things.remove({ id: e }),
      onSuccess: () => {
        e.invalidateQueries({ queryKey: Gn.things.list.queryOptions().queryKey });
      },
    }),
    l = (e) => {
      e.preventDefault();
      let t = n.trim();
      t && s.mutate(t);
    },
    u = i?.items ?? [];
  return (0, S.jsxs)(`main`, {
    children: [
      (0, S.jsx)(`h1`, { children: `Things` }),
      (0, S.jsxs)(`p`, {
        children: [
          `CRUD via `,
          (0, S.jsx)(`code`, { children: `@orpc/openapi-client` }),
          ` → `,
          (0, S.jsx)(`code`, { children: `OpenAPIHandler` }),
          `. Typed end-to-end from contract to UI.`,
        ],
      }),
      (0, S.jsxs)(`form`, {
        onSubmit: l,
        style: { display: `flex`, gap: `0.5rem`, marginBottom: `1.5rem` },
        children: [
          (0, S.jsx)(`input`, {
            type: `text`,
            value: n,
            onChange: (e) => r(e.target.value),
            placeholder: `New thing...`,
            disabled: s.isPending,
            style: { flex: 1 },
          }),
          (0, S.jsx)(`button`, {
            type: `submit`,
            className: `btn-primary`,
            disabled: s.isPending || !n.trim(),
            children: s.isPending ? `Creating...` : `Create`,
          }),
        ],
      }),
      a && (0, S.jsx)(`p`, { style: { color: `#888` }, children: `Loading...` }),
      o &&
        (0, S.jsx)(`pre`, {
          style: { color: `#fca5a5`, background: `#450a0a` },
          children: o.message,
        }),
      u.length === 0 &&
        !a &&
        (0, S.jsx)(`p`, {
          style: { color: `#555`, textAlign: `center`, padding: `2rem` },
          children: `No things yet.`,
        }),
      (0, S.jsx)(`div`, {
        style: { display: `flex`, flexDirection: `column`, gap: `0.5rem` },
        children: u.map((e) =>
          (0, S.jsxs)(
            `div`,
            {
              className: `card`,
              style: { display: `flex`, alignItems: `center`, justifyContent: `space-between` },
              children: [
                (0, S.jsxs)(`div`, {
                  children: [
                    (0, S.jsx)(`div`, { style: { fontWeight: 500 }, children: e.name }),
                    (0, S.jsxs)(`div`, {
                      style: { fontSize: `0.75rem`, color: `#666`, marginTop: `0.2rem` },
                      children: [e.id, ` · `, new Date(e.createdAt).toLocaleString()],
                    }),
                  ],
                }),
                (0, S.jsx)(`button`, {
                  className: `btn-danger`,
                  onClick: () => c.mutate(e.id),
                  disabled: c.isPending,
                  style: { fontSize: `0.75rem`, padding: `0.3rem 0.6rem` },
                  children: `Delete`,
                }),
              ],
            },
            e.id,
          ),
        ),
      }),
      i &&
        (0, S.jsxs)(`p`, {
          style: { marginTop: `1rem`, fontSize: `0.8rem`, color: `#555` },
          children: [
            i.total,
            ` total · via `,
            (0, S.jsx)(`code`, { children: `OpenAPILink` }),
            ` → `,
            (0, S.jsx)(`code`, { children: `GET /api/things` }),
          ],
        }),
    ],
  });
}
export { Kn as component };
