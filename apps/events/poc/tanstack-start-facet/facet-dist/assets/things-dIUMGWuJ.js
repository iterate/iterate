var wt = (i) => {
  throw TypeError(i);
};
var ht = (i, t, e) => t.has(i) || wt("Cannot " + e);
var s = (i, t, e) => (ht(i, t, "read from private field"), e ? e.call(i) : t.get(i)),
  m = (i, t, e) =>
    t.has(i)
      ? wt("Cannot add the same private member more than once")
      : t instanceof WeakSet
        ? t.add(i)
        : t.set(i, e),
  l = (i, t, e, r) => (ht(i, t, "write to private field"), r ? r.call(i, e) : t.set(i, e), e),
  f = (i, t, e) => (ht(i, t, "access private method"), e);
import {
  S as Nt,
  p as Tt,
  r as T,
  s as st,
  a as V,
  n as it,
  e as ct,
  i as Mt,
  t as Kt,
  b as tt,
  f as Bt,
  c as At,
  d as jt,
  g as rt,
  h as It,
  j as zt,
  k as S,
  l as vt,
  u as St,
  m as y,
} from "./index-CGt5-eaW.js";
var R,
  o,
  J,
  v,
  N,
  K,
  M,
  Q,
  G,
  B,
  A,
  L,
  k,
  F,
  z,
  c,
  $,
  ut,
  lt,
  dt,
  ft,
  pt,
  mt,
  bt,
  Lt,
  _t,
  Wt =
    ((_t = class extends Nt {
      constructor(t, e) {
        super();
        m(this, c);
        m(this, R);
        m(this, o);
        m(this, J);
        m(this, v);
        m(this, N);
        m(this, K);
        m(this, M);
        m(this, Q);
        m(this, G);
        m(this, B);
        m(this, A);
        m(this, L);
        m(this, k);
        m(this, F);
        m(this, z, new Set());
        ((this.options = e),
          l(this, R, t),
          l(this, Q, null),
          l(this, M, Tt()),
          this.bindMethods(),
          this.setOptions(e));
      }
      bindMethods() {
        this.refetch = this.refetch.bind(this);
      }
      onSubscribe() {
        this.listeners.size === 1 &&
          (s(this, o).addObserver(this),
          Dt(s(this, o), this.options) ? f(this, c, $).call(this) : this.updateResult(),
          f(this, c, ft).call(this));
      }
      onUnsubscribe() {
        this.hasListeners() || this.destroy();
      }
      shouldFetchOnReconnect() {
        return gt(s(this, o), this.options, this.options.refetchOnReconnect);
      }
      shouldFetchOnWindowFocus() {
        return gt(s(this, o), this.options, this.options.refetchOnWindowFocus);
      }
      destroy() {
        ((this.listeners = new Set()),
          f(this, c, pt).call(this),
          f(this, c, mt).call(this),
          s(this, o).removeObserver(this));
      }
      setOptions(t) {
        const e = this.options,
          r = s(this, o);
        if (
          ((this.options = s(this, R).defaultQueryOptions(t)),
          this.options.enabled !== void 0 &&
            typeof this.options.enabled != "boolean" &&
            typeof this.options.enabled != "function" &&
            typeof T(this.options.enabled, s(this, o)) != "boolean")
        )
          throw new Error("Expected enabled to be a boolean or a callback that returns a boolean");
        (f(this, c, bt).call(this),
          s(this, o).setOptions(this.options),
          e._defaulted &&
            !st(this.options, e) &&
            s(this, R)
              .getQueryCache()
              .notify({ type: "observerOptionsUpdated", query: s(this, o), observer: this }));
        const n = this.hasListeners();
        (n && Pt(s(this, o), r, this.options, e) && f(this, c, $).call(this),
          this.updateResult(),
          n &&
            (s(this, o) !== r ||
              T(this.options.enabled, s(this, o)) !== T(e.enabled, s(this, o)) ||
              V(this.options.staleTime, s(this, o)) !== V(e.staleTime, s(this, o))) &&
            f(this, c, ut).call(this));
        const h = f(this, c, lt).call(this);
        n &&
          (s(this, o) !== r ||
            T(this.options.enabled, s(this, o)) !== T(e.enabled, s(this, o)) ||
            h !== s(this, F)) &&
          f(this, c, dt).call(this, h);
      }
      getOptimisticResult(t) {
        const e = s(this, R).getQueryCache().build(s(this, R), t),
          r = this.createResult(e, t);
        return (
          $t(this, r) && (l(this, v, r), l(this, K, this.options), l(this, N, s(this, o).state)), r
        );
      }
      getCurrentResult() {
        return s(this, v);
      }
      trackResult(t, e) {
        return new Proxy(t, {
          get: (r, n) => (
            this.trackProp(n),
            e == null || e(n),
            n === "promise" &&
              (this.trackProp("data"),
              !this.options.experimental_prefetchInRender &&
                s(this, M).status === "pending" &&
                s(this, M).reject(
                  new Error("experimental_prefetchInRender feature flag is not enabled"),
                )),
            Reflect.get(r, n)
          ),
        });
      }
      trackProp(t) {
        s(this, z).add(t);
      }
      getCurrentQuery() {
        return s(this, o);
      }
      refetch({ ...t } = {}) {
        return this.fetch({ ...t });
      }
      fetchOptimistic(t) {
        const e = s(this, R).defaultQueryOptions(t),
          r = s(this, R).getQueryCache().build(s(this, R), e);
        return r.fetch().then(() => this.createResult(r, e));
      }
      fetch(t) {
        return f(this, c, $)
          .call(this, { ...t, cancelRefetch: t.cancelRefetch ?? !0 })
          .then(() => (this.updateResult(), s(this, v)));
      }
      createResult(t, e) {
        var Ct;
        const r = s(this, o),
          n = this.options,
          h = s(this, v),
          a = s(this, N),
          g = s(this, K),
          u = t !== r ? t.state : s(this, J),
          { state: b } = t;
        let p = { ...b },
          C = !1,
          d;
        if (e._optimisticResults) {
          const O = this.hasListeners(),
            H = !O && Dt(t, e),
            Y = O && Pt(t, r, e, n);
          ((H || Y) && (p = { ...p, ...At(b.data, t.options) }),
            e._optimisticResults === "isRestoring" && (p.fetchStatus = "idle"));
        }
        let { error: U, errorUpdatedAt: W, status: E } = p;
        d = p.data;
        let X = !1;
        if (e.placeholderData !== void 0 && d === void 0 && E === "pending") {
          let O;
          (h != null &&
          h.isPlaceholderData &&
          e.placeholderData === (g == null ? void 0 : g.placeholderData)
            ? ((O = h.data), (X = !0))
            : (O =
                typeof e.placeholderData == "function"
                  ? e.placeholderData(
                      (Ct = s(this, A)) == null ? void 0 : Ct.state.data,
                      s(this, A),
                    )
                  : e.placeholderData),
            O !== void 0 &&
              ((E = "success"), (d = jt(h == null ? void 0 : h.data, O, e)), (C = !0)));
        }
        if (e.select && d !== void 0 && !X)
          if (h && d === (a == null ? void 0 : a.data) && e.select === s(this, G)) d = s(this, B);
          else
            try {
              (l(this, G, e.select),
                (d = e.select(d)),
                (d = jt(h == null ? void 0 : h.data, d, e)),
                l(this, B, d),
                l(this, Q, null));
            } catch (O) {
              l(this, Q, O);
            }
        s(this, Q) && ((U = s(this, Q)), (d = s(this, B)), (W = Date.now()), (E = "error"));
        const nt = p.fetchStatus === "fetching",
          at = E === "pending",
          ot = E === "error",
          xt = at && nt,
          Et = d !== void 0,
          P = {
            status: E,
            fetchStatus: p.fetchStatus,
            isPending: at,
            isSuccess: E === "success",
            isError: ot,
            isInitialLoading: xt,
            isLoading: xt,
            data: d,
            dataUpdatedAt: p.dataUpdatedAt,
            error: U,
            errorUpdatedAt: W,
            failureCount: p.fetchFailureCount,
            failureReason: p.fetchFailureReason,
            errorUpdateCount: p.errorUpdateCount,
            isFetched: t.isFetched(),
            isFetchedAfterMount:
              p.dataUpdateCount > u.dataUpdateCount || p.errorUpdateCount > u.errorUpdateCount,
            isFetching: nt,
            isRefetching: nt && !at,
            isLoadingError: ot && !Et,
            isPaused: p.fetchStatus === "paused",
            isPlaceholderData: C,
            isRefetchError: ot && Et,
            isStale: Rt(t, e),
            refetch: this.refetch,
            promise: s(this, M),
            isEnabled: T(e.enabled, t) !== !1,
          };
        if (this.options.experimental_prefetchInRender) {
          const O = P.data !== void 0,
            H = P.status === "error" && !O,
            Y = (q) => {
              H ? q.reject(P.error) : O && q.resolve(P.data);
            },
            Ot = () => {
              const q = l(this, M, (P.promise = Tt()));
              Y(q);
            },
            Z = s(this, M);
          switch (Z.status) {
            case "pending":
              t.queryHash === r.queryHash && Y(Z);
              break;
            case "fulfilled":
              (H || P.data !== Z.value) && Ot();
              break;
            case "rejected":
              (!H || P.error !== Z.reason) && Ot();
              break;
          }
        }
        return P;
      }
      updateResult() {
        const t = s(this, v),
          e = this.createResult(s(this, o), this.options);
        if (
          (l(this, N, s(this, o).state),
          l(this, K, this.options),
          s(this, N).data !== void 0 && l(this, A, s(this, o)),
          st(e, t))
        )
          return;
        l(this, v, e);
        const r = () => {
          if (!t) return !0;
          const { notifyOnChangeProps: n } = this.options,
            h = typeof n == "function" ? n() : n;
          if (h === "all" || (!h && !s(this, z).size)) return !0;
          const a = new Set(h ?? s(this, z));
          return (
            this.options.throwOnError && a.add("error"),
            Object.keys(s(this, v)).some((g) => {
              const w = g;
              return s(this, v)[w] !== t[w] && a.has(w);
            })
          );
        };
        f(this, c, Lt).call(this, { listeners: r() });
      }
      onQueryUpdate() {
        (this.updateResult(), this.hasListeners() && f(this, c, ft).call(this));
      }
    }),
    (R = new WeakMap()),
    (o = new WeakMap()),
    (J = new WeakMap()),
    (v = new WeakMap()),
    (N = new WeakMap()),
    (K = new WeakMap()),
    (M = new WeakMap()),
    (Q = new WeakMap()),
    (G = new WeakMap()),
    (B = new WeakMap()),
    (A = new WeakMap()),
    (L = new WeakMap()),
    (k = new WeakMap()),
    (F = new WeakMap()),
    (z = new WeakMap()),
    (c = new WeakSet()),
    ($ = function (t) {
      f(this, c, bt).call(this);
      let e = s(this, o).fetch(this.options, t);
      return ((t != null && t.throwOnError) || (e = e.catch(it)), e);
    }),
    (ut = function () {
      f(this, c, pt).call(this);
      const t = V(this.options.staleTime, s(this, o));
      if (ct.isServer() || s(this, v).isStale || !Mt(t)) return;
      const r = Kt(s(this, v).dataUpdatedAt, t) + 1;
      l(
        this,
        L,
        tt.setTimeout(() => {
          s(this, v).isStale || this.updateResult();
        }, r),
      );
    }),
    (lt = function () {
      return (
        (typeof this.options.refetchInterval == "function"
          ? this.options.refetchInterval(s(this, o))
          : this.options.refetchInterval) ?? !1
      );
    }),
    (dt = function (t) {
      (f(this, c, mt).call(this),
        l(this, F, t),
        !(
          ct.isServer() ||
          T(this.options.enabled, s(this, o)) === !1 ||
          !Mt(s(this, F)) ||
          s(this, F) === 0
        ) &&
          l(
            this,
            k,
            tt.setInterval(
              () => {
                (this.options.refetchIntervalInBackground || Bt.isFocused()) &&
                  f(this, c, $).call(this);
              },
              s(this, F),
            ),
          ));
    }),
    (ft = function () {
      (f(this, c, ut).call(this), f(this, c, dt).call(this, f(this, c, lt).call(this)));
    }),
    (pt = function () {
      s(this, L) !== void 0 && (tt.clearTimeout(s(this, L)), l(this, L, void 0));
    }),
    (mt = function () {
      s(this, k) !== void 0 && (tt.clearInterval(s(this, k)), l(this, k, void 0));
    }),
    (bt = function () {
      const t = s(this, R).getQueryCache().build(s(this, R), this.options);
      if (t === s(this, o)) return;
      const e = s(this, o);
      (l(this, o, t),
        l(this, J, t.state),
        this.hasListeners() && (e == null || e.removeObserver(this), t.addObserver(this)));
    }),
    (Lt = function (t) {
      rt.batch(() => {
        (t.listeners &&
          this.listeners.forEach((e) => {
            e(s(this, v));
          }),
          s(this, R)
            .getQueryCache()
            .notify({ query: s(this, o), type: "observerResultsUpdated" }));
      });
    }),
    _t);
function Ht(i, t) {
  return (
    T(t.enabled, i) !== !1 &&
    i.state.data === void 0 &&
    !(i.state.status === "error" && t.retryOnMount === !1)
  );
}
function Dt(i, t) {
  return Ht(i, t) || (i.state.data !== void 0 && gt(i, t, t.refetchOnMount));
}
function gt(i, t, e) {
  if (T(t.enabled, i) !== !1 && V(t.staleTime, i) !== "static") {
    const r = typeof e == "function" ? e(i) : e;
    return r === "always" || (r !== !1 && Rt(i, t));
  }
  return !1;
}
function Pt(i, t, e, r) {
  return (
    (i !== t || T(r.enabled, i) === !1) && (!e.suspense || i.state.status !== "error") && Rt(i, e)
  );
}
function Rt(i, t) {
  return T(t.enabled, i) !== !1 && i.isStaleByTime(V(t.staleTime, i));
}
function $t(i, t) {
  return !st(i.getCurrentResult(), t);
}
var j,
  _,
  x,
  I,
  D,
  et,
  yt,
  Ut,
  Vt =
    ((Ut = class extends Nt {
      constructor(t, e) {
        super();
        m(this, D);
        m(this, j);
        m(this, _);
        m(this, x);
        m(this, I);
        (l(this, j, t), this.setOptions(e), this.bindMethods(), f(this, D, et).call(this));
      }
      bindMethods() {
        ((this.mutate = this.mutate.bind(this)), (this.reset = this.reset.bind(this)));
      }
      setOptions(t) {
        var r;
        const e = this.options;
        ((this.options = s(this, j).defaultMutationOptions(t)),
          st(this.options, e) ||
            s(this, j)
              .getMutationCache()
              .notify({ type: "observerOptionsUpdated", mutation: s(this, x), observer: this }),
          e != null &&
          e.mutationKey &&
          this.options.mutationKey &&
          It(e.mutationKey) !== It(this.options.mutationKey)
            ? this.reset()
            : ((r = s(this, x)) == null ? void 0 : r.state.status) === "pending" &&
              s(this, x).setOptions(this.options));
      }
      onUnsubscribe() {
        var t;
        this.hasListeners() || (t = s(this, x)) == null || t.removeObserver(this);
      }
      onMutationUpdate(t) {
        (f(this, D, et).call(this), f(this, D, yt).call(this, t));
      }
      getCurrentResult() {
        return s(this, _);
      }
      reset() {
        var t;
        ((t = s(this, x)) == null || t.removeObserver(this),
          l(this, x, void 0),
          f(this, D, et).call(this),
          f(this, D, yt).call(this));
      }
      mutate(t, e) {
        var r;
        return (
          l(this, I, e),
          (r = s(this, x)) == null || r.removeObserver(this),
          l(this, x, s(this, j).getMutationCache().build(s(this, j), this.options)),
          s(this, x).addObserver(this),
          s(this, x).execute(t)
        );
      }
    }),
    (j = new WeakMap()),
    (_ = new WeakMap()),
    (x = new WeakMap()),
    (I = new WeakMap()),
    (D = new WeakSet()),
    (et = function () {
      var e;
      const t = ((e = s(this, x)) == null ? void 0 : e.state) ?? zt();
      l(this, _, {
        ...t,
        isPending: t.status === "pending",
        isSuccess: t.status === "success",
        isError: t.status === "error",
        isIdle: t.status === "idle",
        mutate: this.mutate,
        reset: this.reset,
      });
    }),
    (yt = function (t) {
      rt.batch(() => {
        var e, r, n, h, a, g, w, u;
        if (s(this, I) && this.hasListeners()) {
          const b = s(this, _).variables,
            p = s(this, _).context,
            C = {
              client: s(this, j),
              meta: this.options.meta,
              mutationKey: this.options.mutationKey,
            };
          if ((t == null ? void 0 : t.type) === "success") {
            try {
              (r = (e = s(this, I)).onSuccess) == null || r.call(e, t.data, b, p, C);
            } catch (d) {
              Promise.reject(d);
            }
            try {
              (h = (n = s(this, I)).onSettled) == null || h.call(n, t.data, null, b, p, C);
            } catch (d) {
              Promise.reject(d);
            }
          } else if ((t == null ? void 0 : t.type) === "error") {
            try {
              (g = (a = s(this, I)).onError) == null || g.call(a, t.error, b, p, C);
            } catch (d) {
              Promise.reject(d);
            }
            try {
              (u = (w = s(this, I)).onSettled) == null || u.call(w, void 0, t.error, b, p, C);
            } catch (d) {
              Promise.reject(d);
            }
          }
        }
        this.listeners.forEach((b) => {
          b(s(this, _));
        });
      });
    }),
    Ut),
  kt = S.createContext(!1),
  Jt = () => S.useContext(kt);
kt.Provider;
function Gt() {
  let i = !1;
  return {
    clearReset: () => {
      i = !1;
    },
    reset: () => {
      i = !0;
    },
    isReset: () => i,
  };
}
var Xt = S.createContext(Gt()),
  Yt = () => S.useContext(Xt),
  Zt = (i, t, e) => {
    const r =
      e != null && e.state.error && typeof i.throwOnError == "function"
        ? vt(i.throwOnError, [e.state.error, e])
        : i.throwOnError;
    (i.suspense || i.experimental_prefetchInRender || r) && (t.isReset() || (i.retryOnMount = !1));
  },
  qt = (i) => {
    S.useEffect(() => {
      i.clearReset();
    }, [i]);
  },
  te = ({ result: i, errorResetBoundary: t, throwOnError: e, query: r, suspense: n }) =>
    i.isError &&
    !t.isReset() &&
    !i.isFetching &&
    r &&
    ((n && i.data === void 0) || vt(e, [i.error, r])),
  ee = (i) => {
    if (i.suspense) {
      const e = (n) => (n === "static" ? n : Math.max(n ?? 1e3, 1e3)),
        r = i.staleTime;
      ((i.staleTime = typeof r == "function" ? (...n) => e(r(...n)) : e(r)),
        typeof i.gcTime == "number" && (i.gcTime = Math.max(i.gcTime, 1e3)));
    }
  },
  se = (i, t) => i.isLoading && i.isFetching && !t,
  ie = (i, t) => (i == null ? void 0 : i.suspense) && t.isPending,
  Qt = (i, t, e) =>
    t.fetchOptimistic(i).catch(() => {
      e.clearReset();
    });
function re(i, t, e) {
  var C, d, U, W;
  const r = Jt(),
    n = Yt(),
    h = St(),
    a = h.defaultQueryOptions(i);
  (d = (C = h.getDefaultOptions().queries) == null ? void 0 : C._experimental_beforeQuery) ==
    null || d.call(C, a);
  const g = h.getQueryCache().get(a.queryHash);
  ((a._optimisticResults = r ? "isRestoring" : "optimistic"), ee(a), Zt(a, n, g), qt(n));
  const w = !h.getQueryCache().get(a.queryHash),
    [u] = S.useState(() => new t(h, a)),
    b = u.getOptimisticResult(a),
    p = !r && i.subscribed !== !1;
  if (
    (S.useSyncExternalStore(
      S.useCallback(
        (E) => {
          const X = p ? u.subscribe(rt.batchCalls(E)) : it;
          return (u.updateResult(), X);
        },
        [u, p],
      ),
      () => u.getCurrentResult(),
      () => u.getCurrentResult(),
    ),
    S.useEffect(() => {
      u.setOptions(a);
    }, [a, u]),
    ie(a, b))
  )
    throw Qt(a, u, n);
  if (
    te({
      result: b,
      errorResetBoundary: n,
      throwOnError: a.throwOnError,
      query: g,
      suspense: a.suspense,
    })
  )
    throw b.error;
  if (
    ((W = (U = h.getDefaultOptions().queries) == null ? void 0 : U._experimental_afterQuery) ==
      null || W.call(U, a, b),
    a.experimental_prefetchInRender && !ct.isServer() && se(b, r))
  ) {
    const E = w ? Qt(a, u, n) : g == null ? void 0 : g.promise;
    E == null ||
      E.catch(it).finally(() => {
        u.updateResult();
      });
  }
  return a.notifyOnChangeProps ? b : u.trackResult(b);
}
function ne(i, t) {
  return re(i, Wt);
}
function Ft(i, t) {
  const e = St(),
    [r] = S.useState(() => new Vt(e, i));
  S.useEffect(() => {
    r.setOptions(i);
  }, [r, i]);
  const n = S.useSyncExternalStore(
      S.useCallback((a) => r.subscribe(rt.batchCalls(a)), [r]),
      () => r.getCurrentResult(),
      () => r.getCurrentResult(),
    ),
    h = S.useCallback(
      (a, g) => {
        r.mutate(a, g).catch(it);
      },
      [r],
    );
  if (n.error && vt(r.options.throwOnError, [n.error])) throw n.error;
  return { ...n, mutate: h, mutateAsync: n.mutate };
}
async function ae() {
  const i = await fetch("/api/things");
  if (!i.ok) throw new Error(`Failed to fetch things: ${i.status}`);
  return i.json();
}
async function oe(i) {
  const t = await fetch("/api/things", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: i }),
  });
  if (!t.ok) throw new Error(`Failed to create thing: ${t.status}`);
  return t.json();
}
async function he(i) {
  const t = await fetch(`/api/things/${i}`, { method: "DELETE" });
  if (!t.ok) throw new Error(`Failed to delete thing: ${t.status}`);
}
function de() {
  const i = St(),
    [t, e] = S.useState(""),
    { data: r, isPending: n, error: h } = ne({ queryKey: ["things"], queryFn: ae }),
    a = Ft({
      mutationFn: oe,
      onSuccess: () => {
        (i.invalidateQueries({ queryKey: ["things"] }), e(""));
      },
    }),
    g = Ft({
      mutationFn: he,
      onSuccess: () => {
        i.invalidateQueries({ queryKey: ["things"] });
      },
    }),
    w = (u) => {
      u.preventDefault();
      const b = t.trim();
      b && a.mutate(b);
    };
  return y.jsxs("main", {
    children: [
      y.jsx("h1", { children: "Things" }),
      y.jsx("p", {
        children:
          "CRUD demo backed by SQLite inside a Durable Object. Data persists across requests via the DO's embedded database.",
      }),
      y.jsxs("form", {
        onSubmit: w,
        style: { display: "flex", gap: "0.5rem", marginBottom: "1.5rem" },
        children: [
          y.jsx("input", {
            type: "text",
            value: t,
            onChange: (u) => e(u.target.value),
            placeholder: "New thing name...",
            disabled: a.isPending,
            style: { flex: 1 },
          }),
          y.jsx("button", {
            type: "submit",
            className: "btn-primary",
            disabled: a.isPending || !t.trim(),
            children: a.isPending ? "Creating..." : "Create",
          }),
        ],
      }),
      a.error &&
        y.jsx("div", {
          className: "error-box",
          style: { marginBottom: "1rem" },
          children: a.error.message,
        }),
      n && y.jsx("p", { style: { color: "#888" }, children: "Loading things..." }),
      h && y.jsx("div", { className: "error-box", children: h.message }),
      r &&
        r.length === 0 &&
        y.jsx("div", { className: "empty-state", children: "No things yet. Create one above." }),
      r &&
        r.length > 0 &&
        y.jsx("div", {
          style: { display: "flex", flexDirection: "column", gap: "0.5rem" },
          children: r.map((u) =>
            y.jsxs(
              "div",
              {
                className: "thing-item",
                children: [
                  y.jsxs("div", {
                    style: { minWidth: 0, flex: 1 },
                    children: [
                      y.jsx("div", {
                        style: { fontWeight: 500, color: "#e0e0e0" },
                        children: u.name,
                      }),
                      y.jsxs("div", {
                        style: { fontSize: "0.75rem", color: "#666", marginTop: "0.25rem" },
                        children: [u.id, " · ", new Date(u.createdAt).toLocaleString()],
                      }),
                    ],
                  }),
                  y.jsx("button", {
                    className: "btn-danger",
                    onClick: () => g.mutate(u.id),
                    disabled: g.isPending,
                    style: {
                      marginLeft: "0.75rem",
                      fontSize: "0.8rem",
                      padding: "0.35rem 0.75rem",
                    },
                    children: "Delete",
                  }),
                ],
              },
              u.id,
            ),
          ),
        }),
      y.jsxs("p", {
        style: { marginTop: "1.5rem", fontSize: "0.85rem" },
        children: [
          "The ",
          y.jsx("code", { style: { color: "#f59e0b" }, children: "/api/things" }),
          " endpoints are handled by the Durable Object wrapper, not TanStack server functions. The React client fetches data via ",
          y.jsx("code", { style: { color: "#f59e0b" }, children: "@tanstack/react-query" }),
          ".",
        ],
      }),
    ],
  });
}
export { de as component };
