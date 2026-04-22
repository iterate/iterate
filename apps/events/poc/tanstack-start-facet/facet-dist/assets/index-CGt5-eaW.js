var By = (n) => {
  throw TypeError(n);
};
var Vo = (n, l, u) => l.has(n) || By("Cannot " + u);
var V = (n, l, u) => (Vo(n, l, "read from private field"), u ? u.call(n) : l.get(n)),
  At = (n, l, u) =>
    l.has(n)
      ? By("Cannot add the same private member more than once")
      : l instanceof WeakSet
        ? l.add(n)
        : l.set(n, u),
  mt = (n, l, u, r) => (Vo(n, l, "write to private field"), r ? r.call(n, u) : l.set(n, u), u),
  me = (n, l, u) => (Vo(n, l, "access private method"), u);
var ns = (n, l, u, r) => ({
  set _(o) {
    mt(n, l, o, u);
  },
  get _() {
    return V(n, l, r);
  },
});
function GS(n) {
  return n && n.__esModule && Object.prototype.hasOwnProperty.call(n, "default") ? n.default : n;
}
var Xo = { exports: {} },
  fu = {};
/**
 * @license React
 * react-jsx-runtime.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Hy;
function VS() {
  if (Hy) return fu;
  Hy = 1;
  var n = Symbol.for("react.transitional.element"),
    l = Symbol.for("react.fragment");
  function u(r, o, f) {
    var d = null;
    if ((f !== void 0 && (d = "" + f), o.key !== void 0 && (d = "" + o.key), "key" in o)) {
      f = {};
      for (var m in o) m !== "key" && (f[m] = o[m]);
    } else f = o;
    return ((o = f.ref), { $$typeof: n, type: r, key: d, ref: o !== void 0 ? o : null, props: f });
  }
  return ((fu.Fragment = l), (fu.jsx = u), (fu.jsxs = u), fu);
}
var qy;
function XS() {
  return (qy || ((qy = 1), (Xo.exports = VS())), Xo.exports);
}
var $ = XS(),
  Zo = { exports: {} },
  yt = {};
/**
 * @license React
 * react.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Yy;
function ZS() {
  if (Yy) return yt;
  Yy = 1;
  var n = Symbol.for("react.transitional.element"),
    l = Symbol.for("react.portal"),
    u = Symbol.for("react.fragment"),
    r = Symbol.for("react.strict_mode"),
    o = Symbol.for("react.profiler"),
    f = Symbol.for("react.consumer"),
    d = Symbol.for("react.context"),
    m = Symbol.for("react.forward_ref"),
    y = Symbol.for("react.suspense"),
    v = Symbol.for("react.memo"),
    p = Symbol.for("react.lazy"),
    g = Symbol.for("react.activity"),
    b = Symbol.iterator;
  function E(O) {
    return O === null || typeof O != "object"
      ? null
      : ((O = (b && O[b]) || O["@@iterator"]), typeof O == "function" ? O : null);
  }
  var R = {
      isMounted: function () {
        return !1;
      },
      enqueueForceUpdate: function () {},
      enqueueReplaceState: function () {},
      enqueueSetState: function () {},
    },
    M = Object.assign,
    x = {};
  function U(O, Z, tt) {
    ((this.props = O), (this.context = Z), (this.refs = x), (this.updater = tt || R));
  }
  ((U.prototype.isReactComponent = {}),
    (U.prototype.setState = function (O, Z) {
      if (typeof O != "object" && typeof O != "function" && O != null)
        throw Error(
          "takes an object of state variables to update or a function which returns an object of state variables.",
        );
      this.updater.enqueueSetState(this, O, Z, "setState");
    }),
    (U.prototype.forceUpdate = function (O) {
      this.updater.enqueueForceUpdate(this, O, "forceUpdate");
    }));
  function G() {}
  G.prototype = U.prototype;
  function C(O, Z, tt) {
    ((this.props = O), (this.context = Z), (this.refs = x), (this.updater = tt || R));
  }
  var z = (C.prototype = new G());
  ((z.constructor = C), M(z, U.prototype), (z.isPureReactComponent = !0));
  var Y = Array.isArray;
  function I() {}
  var q = { H: null, A: null, T: null, S: null },
    k = Object.prototype.hasOwnProperty;
  function J(O, Z, tt) {
    var at = tt.ref;
    return { $$typeof: n, type: O, key: Z, ref: at !== void 0 ? at : null, props: tt };
  }
  function F(O, Z) {
    return J(O.type, Z, O.props);
  }
  function W(O) {
    return typeof O == "object" && O !== null && O.$$typeof === n;
  }
  function et(O) {
    var Z = { "=": "=0", ":": "=2" };
    return (
      "$" +
      O.replace(/[=:]/g, function (tt) {
        return Z[tt];
      })
    );
  }
  var rt = /\/+/g;
  function dt(O, Z) {
    return typeof O == "object" && O !== null && O.key != null ? et("" + O.key) : Z.toString(36);
  }
  function it(O) {
    switch (O.status) {
      case "fulfilled":
        return O.value;
      case "rejected":
        throw O.reason;
      default:
        switch (
          (typeof O.status == "string"
            ? O.then(I, I)
            : ((O.status = "pending"),
              O.then(
                function (Z) {
                  O.status === "pending" && ((O.status = "fulfilled"), (O.value = Z));
                },
                function (Z) {
                  O.status === "pending" && ((O.status = "rejected"), (O.reason = Z));
                },
              )),
          O.status)
        ) {
          case "fulfilled":
            return O.value;
          case "rejected":
            throw O.reason;
        }
    }
    throw O;
  }
  function j(O, Z, tt, at, ct) {
    var St = typeof O;
    (St === "undefined" || St === "boolean") && (O = null);
    var xt = !1;
    if (O === null) xt = !0;
    else
      switch (St) {
        case "bigint":
        case "string":
        case "number":
          xt = !0;
          break;
        case "object":
          switch (O.$$typeof) {
            case n:
            case l:
              xt = !0;
              break;
            case p:
              return ((xt = O._init), j(xt(O._payload), Z, tt, at, ct));
          }
      }
    if (xt)
      return (
        (ct = ct(O)),
        (xt = at === "" ? "." + dt(O, 0) : at),
        Y(ct)
          ? ((tt = ""),
            xt != null && (tt = xt.replace(rt, "$&/") + "/"),
            j(ct, Z, tt, "", function (vn) {
              return vn;
            }))
          : ct != null &&
            (W(ct) &&
              (ct = F(
                ct,
                tt +
                  (ct.key == null || (O && O.key === ct.key)
                    ? ""
                    : ("" + ct.key).replace(rt, "$&/") + "/") +
                  xt,
              )),
            Z.push(ct)),
        1
      );
    xt = 0;
    var Yt = at === "" ? "." : at + ":";
    if (Y(O))
      for (var Bt = 0; Bt < O.length; Bt++)
        ((at = O[Bt]), (St = Yt + dt(at, Bt)), (xt += j(at, Z, tt, St, ct)));
    else if (((Bt = E(O)), typeof Bt == "function"))
      for (O = Bt.call(O), Bt = 0; !(at = O.next()).done; )
        ((at = at.value), (St = Yt + dt(at, Bt++)), (xt += j(at, Z, tt, St, ct)));
    else if (St === "object") {
      if (typeof O.then == "function") return j(it(O), Z, tt, at, ct);
      throw (
        (Z = String(O)),
        Error(
          "Objects are not valid as a React child (found: " +
            (Z === "[object Object]" ? "object with keys {" + Object.keys(O).join(", ") + "}" : Z) +
            "). If you meant to render a collection of children, use an array instead.",
        )
      );
    }
    return xt;
  }
  function P(O, Z, tt) {
    if (O == null) return O;
    var at = [],
      ct = 0;
    return (
      j(O, at, "", "", function (St) {
        return Z.call(tt, St, ct++);
      }),
      at
    );
  }
  function nt(O) {
    if (O._status === -1) {
      var Z = O._result;
      ((Z = Z()),
        Z.then(
          function (tt) {
            (O._status === 0 || O._status === -1) && ((O._status = 1), (O._result = tt));
          },
          function (tt) {
            (O._status === 0 || O._status === -1) && ((O._status = 2), (O._result = tt));
          },
        ),
        O._status === -1 && ((O._status = 0), (O._result = Z)));
    }
    if (O._status === 1) return O._result.default;
    throw O._result;
  }
  var vt =
      typeof reportError == "function"
        ? reportError
        : function (O) {
            if (typeof window == "object" && typeof window.ErrorEvent == "function") {
              var Z = new window.ErrorEvent("error", {
                bubbles: !0,
                cancelable: !0,
                message:
                  typeof O == "object" && O !== null && typeof O.message == "string"
                    ? String(O.message)
                    : String(O),
                error: O,
              });
              if (!window.dispatchEvent(Z)) return;
            } else if (typeof process == "object" && typeof process.emit == "function") {
              process.emit("uncaughtException", O);
              return;
            }
            console.error(O);
          },
    ht = {
      map: P,
      forEach: function (O, Z, tt) {
        P(
          O,
          function () {
            Z.apply(this, arguments);
          },
          tt,
        );
      },
      count: function (O) {
        var Z = 0;
        return (
          P(O, function () {
            Z++;
          }),
          Z
        );
      },
      toArray: function (O) {
        return (
          P(O, function (Z) {
            return Z;
          }) || []
        );
      },
      only: function (O) {
        if (!W(O))
          throw Error("React.Children.only expected to receive a single React element child.");
        return O;
      },
    };
  return (
    (yt.Activity = g),
    (yt.Children = ht),
    (yt.Component = U),
    (yt.Fragment = u),
    (yt.Profiler = o),
    (yt.PureComponent = C),
    (yt.StrictMode = r),
    (yt.Suspense = y),
    (yt.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = q),
    (yt.__COMPILER_RUNTIME = {
      __proto__: null,
      c: function (O) {
        return q.H.useMemoCache(O);
      },
    }),
    (yt.cache = function (O) {
      return function () {
        return O.apply(null, arguments);
      };
    }),
    (yt.cacheSignal = function () {
      return null;
    }),
    (yt.cloneElement = function (O, Z, tt) {
      if (O == null) throw Error("The argument must be a React element, but you passed " + O + ".");
      var at = M({}, O.props),
        ct = O.key;
      if (Z != null)
        for (St in (Z.key !== void 0 && (ct = "" + Z.key), Z))
          !k.call(Z, St) ||
            St === "key" ||
            St === "__self" ||
            St === "__source" ||
            (St === "ref" && Z.ref === void 0) ||
            (at[St] = Z[St]);
      var St = arguments.length - 2;
      if (St === 1) at.children = tt;
      else if (1 < St) {
        for (var xt = Array(St), Yt = 0; Yt < St; Yt++) xt[Yt] = arguments[Yt + 2];
        at.children = xt;
      }
      return J(O.type, ct, at);
    }),
    (yt.createContext = function (O) {
      return (
        (O = {
          $$typeof: d,
          _currentValue: O,
          _currentValue2: O,
          _threadCount: 0,
          Provider: null,
          Consumer: null,
        }),
        (O.Provider = O),
        (O.Consumer = { $$typeof: f, _context: O }),
        O
      );
    }),
    (yt.createElement = function (O, Z, tt) {
      var at,
        ct = {},
        St = null;
      if (Z != null)
        for (at in (Z.key !== void 0 && (St = "" + Z.key), Z))
          k.call(Z, at) && at !== "key" && at !== "__self" && at !== "__source" && (ct[at] = Z[at]);
      var xt = arguments.length - 2;
      if (xt === 1) ct.children = tt;
      else if (1 < xt) {
        for (var Yt = Array(xt), Bt = 0; Bt < xt; Bt++) Yt[Bt] = arguments[Bt + 2];
        ct.children = Yt;
      }
      if (O && O.defaultProps)
        for (at in ((xt = O.defaultProps), xt)) ct[at] === void 0 && (ct[at] = xt[at]);
      return J(O, St, ct);
    }),
    (yt.createRef = function () {
      return { current: null };
    }),
    (yt.forwardRef = function (O) {
      return { $$typeof: m, render: O };
    }),
    (yt.isValidElement = W),
    (yt.lazy = function (O) {
      return { $$typeof: p, _payload: { _status: -1, _result: O }, _init: nt };
    }),
    (yt.memo = function (O, Z) {
      return { $$typeof: v, type: O, compare: Z === void 0 ? null : Z };
    }),
    (yt.startTransition = function (O) {
      var Z = q.T,
        tt = {};
      q.T = tt;
      try {
        var at = O(),
          ct = q.S;
        (ct !== null && ct(tt, at),
          typeof at == "object" && at !== null && typeof at.then == "function" && at.then(I, vt));
      } catch (St) {
        vt(St);
      } finally {
        (Z !== null && tt.types !== null && (Z.types = tt.types), (q.T = Z));
      }
    }),
    (yt.unstable_useCacheRefresh = function () {
      return q.H.useCacheRefresh();
    }),
    (yt.use = function (O) {
      return q.H.use(O);
    }),
    (yt.useActionState = function (O, Z, tt) {
      return q.H.useActionState(O, Z, tt);
    }),
    (yt.useCallback = function (O, Z) {
      return q.H.useCallback(O, Z);
    }),
    (yt.useContext = function (O) {
      return q.H.useContext(O);
    }),
    (yt.useDebugValue = function () {}),
    (yt.useDeferredValue = function (O, Z) {
      return q.H.useDeferredValue(O, Z);
    }),
    (yt.useEffect = function (O, Z) {
      return q.H.useEffect(O, Z);
    }),
    (yt.useEffectEvent = function (O) {
      return q.H.useEffectEvent(O);
    }),
    (yt.useId = function () {
      return q.H.useId();
    }),
    (yt.useImperativeHandle = function (O, Z, tt) {
      return q.H.useImperativeHandle(O, Z, tt);
    }),
    (yt.useInsertionEffect = function (O, Z) {
      return q.H.useInsertionEffect(O, Z);
    }),
    (yt.useLayoutEffect = function (O, Z) {
      return q.H.useLayoutEffect(O, Z);
    }),
    (yt.useMemo = function (O, Z) {
      return q.H.useMemo(O, Z);
    }),
    (yt.useOptimistic = function (O, Z) {
      return q.H.useOptimistic(O, Z);
    }),
    (yt.useReducer = function (O, Z, tt) {
      return q.H.useReducer(O, Z, tt);
    }),
    (yt.useRef = function (O) {
      return q.H.useRef(O);
    }),
    (yt.useState = function (O) {
      return q.H.useState(O);
    }),
    (yt.useSyncExternalStore = function (O, Z, tt) {
      return q.H.useSyncExternalStore(O, Z, tt);
    }),
    (yt.useTransition = function () {
      return q.H.useTransition();
    }),
    (yt.version = "19.2.5"),
    yt
  );
}
var Qy;
function Uu() {
  return (Qy || ((Qy = 1), (Zo.exports = ZS())), Zo.exports);
}
var st = Uu();
const Eu = GS(st);
var Ko = { exports: {} },
  du = {},
  Po = { exports: {} },
  Jo = {};
/**
 * @license React
 * scheduler.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Gy;
function KS() {
  return (
    Gy ||
      ((Gy = 1),
      (function (n) {
        function l(j, P) {
          var nt = j.length;
          j.push(P);
          t: for (; 0 < nt; ) {
            var vt = (nt - 1) >>> 1,
              ht = j[vt];
            if (0 < o(ht, P)) ((j[vt] = P), (j[nt] = ht), (nt = vt));
            else break t;
          }
        }
        function u(j) {
          return j.length === 0 ? null : j[0];
        }
        function r(j) {
          if (j.length === 0) return null;
          var P = j[0],
            nt = j.pop();
          if (nt !== P) {
            j[0] = nt;
            t: for (var vt = 0, ht = j.length, O = ht >>> 1; vt < O; ) {
              var Z = 2 * (vt + 1) - 1,
                tt = j[Z],
                at = Z + 1,
                ct = j[at];
              if (0 > o(tt, nt))
                at < ht && 0 > o(ct, tt)
                  ? ((j[vt] = ct), (j[at] = nt), (vt = at))
                  : ((j[vt] = tt), (j[Z] = nt), (vt = Z));
              else if (at < ht && 0 > o(ct, nt)) ((j[vt] = ct), (j[at] = nt), (vt = at));
              else break t;
            }
          }
          return P;
        }
        function o(j, P) {
          var nt = j.sortIndex - P.sortIndex;
          return nt !== 0 ? nt : j.id - P.id;
        }
        if (
          ((n.unstable_now = void 0),
          typeof performance == "object" && typeof performance.now == "function")
        ) {
          var f = performance;
          n.unstable_now = function () {
            return f.now();
          };
        } else {
          var d = Date,
            m = d.now();
          n.unstable_now = function () {
            return d.now() - m;
          };
        }
        var y = [],
          v = [],
          p = 1,
          g = null,
          b = 3,
          E = !1,
          R = !1,
          M = !1,
          x = !1,
          U = typeof setTimeout == "function" ? setTimeout : null,
          G = typeof clearTimeout == "function" ? clearTimeout : null,
          C = typeof setImmediate < "u" ? setImmediate : null;
        function z(j) {
          for (var P = u(v); P !== null; ) {
            if (P.callback === null) r(v);
            else if (P.startTime <= j) (r(v), (P.sortIndex = P.expirationTime), l(y, P));
            else break;
            P = u(v);
          }
        }
        function Y(j) {
          if (((M = !1), z(j), !R))
            if (u(y) !== null) ((R = !0), I || ((I = !0), et()));
            else {
              var P = u(v);
              P !== null && it(Y, P.startTime - j);
            }
        }
        var I = !1,
          q = -1,
          k = 5,
          J = -1;
        function F() {
          return x ? !0 : !(n.unstable_now() - J < k);
        }
        function W() {
          if (((x = !1), I)) {
            var j = n.unstable_now();
            J = j;
            var P = !0;
            try {
              t: {
                ((R = !1), M && ((M = !1), G(q), (q = -1)), (E = !0));
                var nt = b;
                try {
                  e: {
                    for (z(j), g = u(y); g !== null && !(g.expirationTime > j && F()); ) {
                      var vt = g.callback;
                      if (typeof vt == "function") {
                        ((g.callback = null), (b = g.priorityLevel));
                        var ht = vt(g.expirationTime <= j);
                        if (((j = n.unstable_now()), typeof ht == "function")) {
                          ((g.callback = ht), z(j), (P = !0));
                          break e;
                        }
                        (g === u(y) && r(y), z(j));
                      } else r(y);
                      g = u(y);
                    }
                    if (g !== null) P = !0;
                    else {
                      var O = u(v);
                      (O !== null && it(Y, O.startTime - j), (P = !1));
                    }
                  }
                  break t;
                } finally {
                  ((g = null), (b = nt), (E = !1));
                }
                P = void 0;
              }
            } finally {
              P ? et() : (I = !1);
            }
          }
        }
        var et;
        if (typeof C == "function")
          et = function () {
            C(W);
          };
        else if (typeof MessageChannel < "u") {
          var rt = new MessageChannel(),
            dt = rt.port2;
          ((rt.port1.onmessage = W),
            (et = function () {
              dt.postMessage(null);
            }));
        } else
          et = function () {
            U(W, 0);
          };
        function it(j, P) {
          q = U(function () {
            j(n.unstable_now());
          }, P);
        }
        ((n.unstable_IdlePriority = 5),
          (n.unstable_ImmediatePriority = 1),
          (n.unstable_LowPriority = 4),
          (n.unstable_NormalPriority = 3),
          (n.unstable_Profiling = null),
          (n.unstable_UserBlockingPriority = 2),
          (n.unstable_cancelCallback = function (j) {
            j.callback = null;
          }),
          (n.unstable_forceFrameRate = function (j) {
            0 > j || 125 < j
              ? console.error(
                  "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported",
                )
              : (k = 0 < j ? Math.floor(1e3 / j) : 5);
          }),
          (n.unstable_getCurrentPriorityLevel = function () {
            return b;
          }),
          (n.unstable_next = function (j) {
            switch (b) {
              case 1:
              case 2:
              case 3:
                var P = 3;
                break;
              default:
                P = b;
            }
            var nt = b;
            b = P;
            try {
              return j();
            } finally {
              b = nt;
            }
          }),
          (n.unstable_requestPaint = function () {
            x = !0;
          }),
          (n.unstable_runWithPriority = function (j, P) {
            switch (j) {
              case 1:
              case 2:
              case 3:
              case 4:
              case 5:
                break;
              default:
                j = 3;
            }
            var nt = b;
            b = j;
            try {
              return P();
            } finally {
              b = nt;
            }
          }),
          (n.unstable_scheduleCallback = function (j, P, nt) {
            var vt = n.unstable_now();
            switch (
              (typeof nt == "object" && nt !== null
                ? ((nt = nt.delay), (nt = typeof nt == "number" && 0 < nt ? vt + nt : vt))
                : (nt = vt),
              j)
            ) {
              case 1:
                var ht = -1;
                break;
              case 2:
                ht = 250;
                break;
              case 5:
                ht = 1073741823;
                break;
              case 4:
                ht = 1e4;
                break;
              default:
                ht = 5e3;
            }
            return (
              (ht = nt + ht),
              (j = {
                id: p++,
                callback: P,
                priorityLevel: j,
                startTime: nt,
                expirationTime: ht,
                sortIndex: -1,
              }),
              nt > vt
                ? ((j.sortIndex = nt),
                  l(v, j),
                  u(y) === null && j === u(v) && (M ? (G(q), (q = -1)) : (M = !0), it(Y, nt - vt)))
                : ((j.sortIndex = ht), l(y, j), R || E || ((R = !0), I || ((I = !0), et()))),
              j
            );
          }),
          (n.unstable_shouldYield = F),
          (n.unstable_wrapCallback = function (j) {
            var P = b;
            return function () {
              var nt = b;
              b = P;
              try {
                return j.apply(this, arguments);
              } finally {
                b = nt;
              }
            };
          }));
      })(Jo)),
    Jo
  );
}
var Vy;
function PS() {
  return (Vy || ((Vy = 1), (Po.exports = KS())), Po.exports);
}
var Fo = { exports: {} },
  ve = {};
/**
 * @license React
 * react-dom.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Xy;
function JS() {
  if (Xy) return ve;
  Xy = 1;
  var n = Uu();
  function l(y) {
    var v = "https://react.dev/errors/" + y;
    if (1 < arguments.length) {
      v += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var p = 2; p < arguments.length; p++) v += "&args[]=" + encodeURIComponent(arguments[p]);
    }
    return (
      "Minified React error #" +
      y +
      "; visit " +
      v +
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
    );
  }
  function u() {}
  var r = {
      d: {
        f: u,
        r: function () {
          throw Error(l(522));
        },
        D: u,
        C: u,
        L: u,
        m: u,
        X: u,
        S: u,
        M: u,
      },
      p: 0,
      findDOMNode: null,
    },
    o = Symbol.for("react.portal");
  function f(y, v, p) {
    var g = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: o,
      key: g == null ? null : "" + g,
      children: y,
      containerInfo: v,
      implementation: p,
    };
  }
  var d = n.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function m(y, v) {
    if (y === "font") return "";
    if (typeof v == "string") return v === "use-credentials" ? v : "";
  }
  return (
    (ve.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = r),
    (ve.createPortal = function (y, v) {
      var p = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
      if (!v || (v.nodeType !== 1 && v.nodeType !== 9 && v.nodeType !== 11)) throw Error(l(299));
      return f(y, v, null, p);
    }),
    (ve.flushSync = function (y) {
      var v = d.T,
        p = r.p;
      try {
        if (((d.T = null), (r.p = 2), y)) return y();
      } finally {
        ((d.T = v), (r.p = p), r.d.f());
      }
    }),
    (ve.preconnect = function (y, v) {
      typeof y == "string" &&
        (v
          ? ((v = v.crossOrigin),
            (v = typeof v == "string" ? (v === "use-credentials" ? v : "") : void 0))
          : (v = null),
        r.d.C(y, v));
    }),
    (ve.prefetchDNS = function (y) {
      typeof y == "string" && r.d.D(y);
    }),
    (ve.preinit = function (y, v) {
      if (typeof y == "string" && v && typeof v.as == "string") {
        var p = v.as,
          g = m(p, v.crossOrigin),
          b = typeof v.integrity == "string" ? v.integrity : void 0,
          E = typeof v.fetchPriority == "string" ? v.fetchPriority : void 0;
        p === "style"
          ? r.d.S(y, typeof v.precedence == "string" ? v.precedence : void 0, {
              crossOrigin: g,
              integrity: b,
              fetchPriority: E,
            })
          : p === "script" &&
            r.d.X(y, {
              crossOrigin: g,
              integrity: b,
              fetchPriority: E,
              nonce: typeof v.nonce == "string" ? v.nonce : void 0,
            });
      }
    }),
    (ve.preinitModule = function (y, v) {
      if (typeof y == "string")
        if (typeof v == "object" && v !== null) {
          if (v.as == null || v.as === "script") {
            var p = m(v.as, v.crossOrigin);
            r.d.M(y, {
              crossOrigin: p,
              integrity: typeof v.integrity == "string" ? v.integrity : void 0,
              nonce: typeof v.nonce == "string" ? v.nonce : void 0,
            });
          }
        } else v == null && r.d.M(y);
    }),
    (ve.preload = function (y, v) {
      if (typeof y == "string" && typeof v == "object" && v !== null && typeof v.as == "string") {
        var p = v.as,
          g = m(p, v.crossOrigin);
        r.d.L(y, p, {
          crossOrigin: g,
          integrity: typeof v.integrity == "string" ? v.integrity : void 0,
          nonce: typeof v.nonce == "string" ? v.nonce : void 0,
          type: typeof v.type == "string" ? v.type : void 0,
          fetchPriority: typeof v.fetchPriority == "string" ? v.fetchPriority : void 0,
          referrerPolicy: typeof v.referrerPolicy == "string" ? v.referrerPolicy : void 0,
          imageSrcSet: typeof v.imageSrcSet == "string" ? v.imageSrcSet : void 0,
          imageSizes: typeof v.imageSizes == "string" ? v.imageSizes : void 0,
          media: typeof v.media == "string" ? v.media : void 0,
        });
      }
    }),
    (ve.preloadModule = function (y, v) {
      if (typeof y == "string")
        if (v) {
          var p = m(v.as, v.crossOrigin);
          r.d.m(y, {
            as: typeof v.as == "string" && v.as !== "script" ? v.as : void 0,
            crossOrigin: p,
            integrity: typeof v.integrity == "string" ? v.integrity : void 0,
          });
        } else r.d.m(y);
    }),
    (ve.requestFormReset = function (y) {
      r.d.r(y);
    }),
    (ve.unstable_batchedUpdates = function (y, v) {
      return y(v);
    }),
    (ve.useFormState = function (y, v, p) {
      return d.H.useFormState(y, v, p);
    }),
    (ve.useFormStatus = function () {
      return d.H.useHostTransitionStatus();
    }),
    (ve.version = "19.2.5"),
    ve
  );
}
var Zy;
function eg() {
  if (Zy) return Fo.exports;
  Zy = 1;
  function n() {
    if (
      !(
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" ||
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"
      )
    )
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
      } catch (l) {
        console.error(l);
      }
  }
  return (n(), (Fo.exports = JS()), Fo.exports);
}
/**
 * @license React
 * react-dom-client.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Ky;
function FS() {
  if (Ky) return du;
  Ky = 1;
  var n = PS(),
    l = Uu(),
    u = eg();
  function r(t) {
    var e = "https://react.dev/errors/" + t;
    if (1 < arguments.length) {
      e += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var a = 2; a < arguments.length; a++) e += "&args[]=" + encodeURIComponent(arguments[a]);
    }
    return (
      "Minified React error #" +
      t +
      "; visit " +
      e +
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
    );
  }
  function o(t) {
    return !(!t || (t.nodeType !== 1 && t.nodeType !== 9 && t.nodeType !== 11));
  }
  function f(t) {
    var e = t,
      a = t;
    if (t.alternate) for (; e.return; ) e = e.return;
    else {
      t = e;
      do ((e = t), (e.flags & 4098) !== 0 && (a = e.return), (t = e.return));
      while (t);
    }
    return e.tag === 3 ? a : null;
  }
  function d(t) {
    if (t.tag === 13) {
      var e = t.memoizedState;
      if ((e === null && ((t = t.alternate), t !== null && (e = t.memoizedState)), e !== null))
        return e.dehydrated;
    }
    return null;
  }
  function m(t) {
    if (t.tag === 31) {
      var e = t.memoizedState;
      if ((e === null && ((t = t.alternate), t !== null && (e = t.memoizedState)), e !== null))
        return e.dehydrated;
    }
    return null;
  }
  function y(t) {
    if (f(t) !== t) throw Error(r(188));
  }
  function v(t) {
    var e = t.alternate;
    if (!e) {
      if (((e = f(t)), e === null)) throw Error(r(188));
      return e !== t ? null : t;
    }
    for (var a = t, i = e; ; ) {
      var s = a.return;
      if (s === null) break;
      var c = s.alternate;
      if (c === null) {
        if (((i = s.return), i !== null)) {
          a = i;
          continue;
        }
        break;
      }
      if (s.child === c.child) {
        for (c = s.child; c; ) {
          if (c === a) return (y(s), t);
          if (c === i) return (y(s), e);
          c = c.sibling;
        }
        throw Error(r(188));
      }
      if (a.return !== i.return) ((a = s), (i = c));
      else {
        for (var h = !1, S = s.child; S; ) {
          if (S === a) {
            ((h = !0), (a = s), (i = c));
            break;
          }
          if (S === i) {
            ((h = !0), (i = s), (a = c));
            break;
          }
          S = S.sibling;
        }
        if (!h) {
          for (S = c.child; S; ) {
            if (S === a) {
              ((h = !0), (a = c), (i = s));
              break;
            }
            if (S === i) {
              ((h = !0), (i = c), (a = s));
              break;
            }
            S = S.sibling;
          }
          if (!h) throw Error(r(189));
        }
      }
      if (a.alternate !== i) throw Error(r(190));
    }
    if (a.tag !== 3) throw Error(r(188));
    return a.stateNode.current === a ? t : e;
  }
  function p(t) {
    var e = t.tag;
    if (e === 5 || e === 26 || e === 27 || e === 6) return t;
    for (t = t.child; t !== null; ) {
      if (((e = p(t)), e !== null)) return e;
      t = t.sibling;
    }
    return null;
  }
  var g = Object.assign,
    b = Symbol.for("react.element"),
    E = Symbol.for("react.transitional.element"),
    R = Symbol.for("react.portal"),
    M = Symbol.for("react.fragment"),
    x = Symbol.for("react.strict_mode"),
    U = Symbol.for("react.profiler"),
    G = Symbol.for("react.consumer"),
    C = Symbol.for("react.context"),
    z = Symbol.for("react.forward_ref"),
    Y = Symbol.for("react.suspense"),
    I = Symbol.for("react.suspense_list"),
    q = Symbol.for("react.memo"),
    k = Symbol.for("react.lazy"),
    J = Symbol.for("react.activity"),
    F = Symbol.for("react.memo_cache_sentinel"),
    W = Symbol.iterator;
  function et(t) {
    return t === null || typeof t != "object"
      ? null
      : ((t = (W && t[W]) || t["@@iterator"]), typeof t == "function" ? t : null);
  }
  var rt = Symbol.for("react.client.reference");
  function dt(t) {
    if (t == null) return null;
    if (typeof t == "function") return t.$$typeof === rt ? null : t.displayName || t.name || null;
    if (typeof t == "string") return t;
    switch (t) {
      case M:
        return "Fragment";
      case U:
        return "Profiler";
      case x:
        return "StrictMode";
      case Y:
        return "Suspense";
      case I:
        return "SuspenseList";
      case J:
        return "Activity";
    }
    if (typeof t == "object")
      switch (t.$$typeof) {
        case R:
          return "Portal";
        case C:
          return t.displayName || "Context";
        case G:
          return (t._context.displayName || "Context") + ".Consumer";
        case z:
          var e = t.render;
          return (
            (t = t.displayName),
            t ||
              ((t = e.displayName || e.name || ""),
              (t = t !== "" ? "ForwardRef(" + t + ")" : "ForwardRef")),
            t
          );
        case q:
          return ((e = t.displayName || null), e !== null ? e : dt(t.type) || "Memo");
        case k:
          ((e = t._payload), (t = t._init));
          try {
            return dt(t(e));
          } catch {}
      }
    return null;
  }
  var it = Array.isArray,
    j = l.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    P = u.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    nt = { pending: !1, data: null, method: null, action: null },
    vt = [],
    ht = -1;
  function O(t) {
    return { current: t };
  }
  function Z(t) {
    0 > ht || ((t.current = vt[ht]), (vt[ht] = null), ht--);
  }
  function tt(t, e) {
    (ht++, (vt[ht] = t.current), (t.current = e));
  }
  var at = O(null),
    ct = O(null),
    St = O(null),
    xt = O(null);
  function Yt(t, e) {
    switch ((tt(St, e), tt(ct, t), tt(at, null), e.nodeType)) {
      case 9:
      case 11:
        t = (t = e.documentElement) && (t = t.namespaceURI) ? uy(t) : 0;
        break;
      default:
        if (((t = e.tagName), (e = e.namespaceURI))) ((e = uy(e)), (t = ry(e, t)));
        else
          switch (t) {
            case "svg":
              t = 1;
              break;
            case "math":
              t = 2;
              break;
            default:
              t = 0;
          }
    }
    (Z(at), tt(at, t));
  }
  function Bt() {
    (Z(at), Z(ct), Z(St));
  }
  function vn(t) {
    t.memoizedState !== null && tt(xt, t);
    var e = at.current,
      a = ry(e, t.type);
    e !== a && (tt(ct, t), tt(at, a));
  }
  function gn(t) {
    (ct.current === t && (Z(at), Z(ct)), xt.current === t && (Z(xt), (ru._currentValue = nt)));
  }
  var Vn, vi;
  function ln(t) {
    if (Vn === void 0)
      try {
        throw Error();
      } catch (a) {
        var e = a.stack.trim().match(/\n( *(at )?)/);
        ((Vn = (e && e[1]) || ""),
          (vi =
            -1 <
            a.stack.indexOf(`
    at`)
              ? " (<anonymous>)"
              : -1 < a.stack.indexOf("@")
                ? "@unknown:0:0"
                : ""));
      }
    return (
      `
` +
      Vn +
      t +
      vi
    );
  }
  var gi = !1;
  function ml(t, e) {
    if (!t || gi) return "";
    gi = !0;
    var a = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var i = {
        DetermineComponentFrameRoot: function () {
          try {
            if (e) {
              var K = function () {
                throw Error();
              };
              if (
                (Object.defineProperty(K.prototype, "props", {
                  set: function () {
                    throw Error();
                  },
                }),
                typeof Reflect == "object" && Reflect.construct)
              ) {
                try {
                  Reflect.construct(K, []);
                } catch (H) {
                  var B = H;
                }
                Reflect.construct(t, [], K);
              } else {
                try {
                  K.call();
                } catch (H) {
                  B = H;
                }
                t.call(K.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (H) {
                B = H;
              }
              (K = t()) && typeof K.catch == "function" && K.catch(function () {});
            }
          } catch (H) {
            if (H && B && typeof H.stack == "string") return [H.stack, B.stack];
          }
          return [null, null];
        },
      };
      i.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var s = Object.getOwnPropertyDescriptor(i.DetermineComponentFrameRoot, "name");
      s &&
        s.configurable &&
        Object.defineProperty(i.DetermineComponentFrameRoot, "name", {
          value: "DetermineComponentFrameRoot",
        });
      var c = i.DetermineComponentFrameRoot(),
        h = c[0],
        S = c[1];
      if (h && S) {
        var A = h.split(`
`),
          N = S.split(`
`);
        for (s = i = 0; i < A.length && !A[i].includes("DetermineComponentFrameRoot"); ) i++;
        for (; s < N.length && !N[s].includes("DetermineComponentFrameRoot"); ) s++;
        if (i === A.length || s === N.length)
          for (i = A.length - 1, s = N.length - 1; 1 <= i && 0 <= s && A[i] !== N[s]; ) s--;
        for (; 1 <= i && 0 <= s; i--, s--)
          if (A[i] !== N[s]) {
            if (i !== 1 || s !== 1)
              do
                if ((i--, s--, 0 > s || A[i] !== N[s])) {
                  var Q =
                    `
` + A[i].replace(" at new ", " at ");
                  return (
                    t.displayName &&
                      Q.includes("<anonymous>") &&
                      (Q = Q.replace("<anonymous>", t.displayName)),
                    Q
                  );
                }
              while (1 <= i && 0 <= s);
            break;
          }
      }
    } finally {
      ((gi = !1), (Error.prepareStackTrace = a));
    }
    return (a = t ? t.displayName || t.name : "") ? ln(a) : "";
  }
  function Hu(t, e) {
    switch (t.tag) {
      case 26:
      case 27:
      case 5:
        return ln(t.type);
      case 16:
        return ln("Lazy");
      case 13:
        return t.child !== e && e !== null ? ln("Suspense Fallback") : ln("Suspense");
      case 19:
        return ln("SuspenseList");
      case 0:
      case 15:
        return ml(t.type, !1);
      case 11:
        return ml(t.type.render, !1);
      case 1:
        return ml(t.type, !0);
      case 31:
        return ln("Activity");
      default:
        return "";
    }
  }
  function pn(t) {
    try {
      var e = "",
        a = null;
      do ((e += Hu(t, a)), (a = t), (t = t.return));
      while (t);
      return e;
    } catch (i) {
      return (
        `
Error generating stack: ` +
        i.message +
        `
` +
        i.stack
      );
    }
  }
  var Da = Object.prototype.hasOwnProperty,
    $e = n.unstable_scheduleCallback,
    pi = n.unstable_cancelCallback,
    qu = n.unstable_shouldYield,
    Os = n.unstable_requestPaint,
    ye = n.unstable_now,
    Ut = n.unstable_getCurrentPriorityLevel,
    se = n.unstable_ImmediatePriority,
    un = n.unstable_UserBlockingPriority,
    yl = n.unstable_NormalPriority,
    Rp = n.unstable_LowPriority,
    Yf = n.unstable_IdlePriority,
    Tp = n.log,
    Ap = n.unstable_setDisableYieldValue,
    Si = null,
    ze = null;
  function Xn(t) {
    if ((typeof Tp == "function" && Ap(t), ze && typeof ze.setStrictMode == "function"))
      try {
        ze.setStrictMode(Si, t);
      } catch {}
  }
  var De = Math.clz32 ? Math.clz32 : wp,
    xp = Math.log,
    Mp = Math.LN2;
  function wp(t) {
    return ((t >>>= 0), t === 0 ? 32 : (31 - ((xp(t) / Mp) | 0)) | 0);
  }
  var Yu = 256,
    Qu = 262144,
    Gu = 4194304;
  function Ua(t) {
    var e = t & 42;
    if (e !== 0) return e;
    switch (t & -t) {
      case 1:
        return 1;
      case 2:
        return 2;
      case 4:
        return 4;
      case 8:
        return 8;
      case 16:
        return 16;
      case 32:
        return 32;
      case 64:
        return 64;
      case 128:
        return 128;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
        return t & 261888;
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return t & 3932160;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return t & 62914560;
      case 67108864:
        return 67108864;
      case 134217728:
        return 134217728;
      case 268435456:
        return 268435456;
      case 536870912:
        return 536870912;
      case 1073741824:
        return 0;
      default:
        return t;
    }
  }
  function Vu(t, e, a) {
    var i = t.pendingLanes;
    if (i === 0) return 0;
    var s = 0,
      c = t.suspendedLanes,
      h = t.pingedLanes;
    t = t.warmLanes;
    var S = i & 134217727;
    return (
      S !== 0
        ? ((i = S & ~c),
          i !== 0
            ? (s = Ua(i))
            : ((h &= S), h !== 0 ? (s = Ua(h)) : a || ((a = S & ~t), a !== 0 && (s = Ua(a)))))
        : ((S = i & ~c),
          S !== 0
            ? (s = Ua(S))
            : h !== 0
              ? (s = Ua(h))
              : a || ((a = i & ~t), a !== 0 && (s = Ua(a)))),
      s === 0
        ? 0
        : e !== 0 &&
            e !== s &&
            (e & c) === 0 &&
            ((c = s & -s), (a = e & -e), c >= a || (c === 32 && (a & 4194048) !== 0))
          ? e
          : s
    );
  }
  function bi(t, e) {
    return (t.pendingLanes & ~(t.suspendedLanes & ~t.pingedLanes) & e) === 0;
  }
  function Op(t, e) {
    switch (t) {
      case 1:
      case 2:
      case 4:
      case 8:
      case 64:
        return e + 250;
      case 16:
      case 32:
      case 128:
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return e + 5e3;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return -1;
      case 67108864:
      case 134217728:
      case 268435456:
      case 536870912:
      case 1073741824:
        return -1;
      default:
        return -1;
    }
  }
  function Qf() {
    var t = Gu;
    return ((Gu <<= 1), (Gu & 62914560) === 0 && (Gu = 4194304), t);
  }
  function Cs(t) {
    for (var e = [], a = 0; 31 > a; a++) e.push(t);
    return e;
  }
  function _i(t, e) {
    ((t.pendingLanes |= e),
      e !== 268435456 && ((t.suspendedLanes = 0), (t.pingedLanes = 0), (t.warmLanes = 0)));
  }
  function Cp(t, e, a, i, s, c) {
    var h = t.pendingLanes;
    ((t.pendingLanes = a),
      (t.suspendedLanes = 0),
      (t.pingedLanes = 0),
      (t.warmLanes = 0),
      (t.expiredLanes &= a),
      (t.entangledLanes &= a),
      (t.errorRecoveryDisabledLanes &= a),
      (t.shellSuspendCounter = 0));
    var S = t.entanglements,
      A = t.expirationTimes,
      N = t.hiddenUpdates;
    for (a = h & ~a; 0 < a; ) {
      var Q = 31 - De(a),
        K = 1 << Q;
      ((S[Q] = 0), (A[Q] = -1));
      var B = N[Q];
      if (B !== null)
        for (N[Q] = null, Q = 0; Q < B.length; Q++) {
          var H = B[Q];
          H !== null && (H.lane &= -536870913);
        }
      a &= ~K;
    }
    (i !== 0 && Gf(t, i, 0),
      c !== 0 && s === 0 && t.tag !== 0 && (t.suspendedLanes |= c & ~(h & ~e)));
  }
  function Gf(t, e, a) {
    ((t.pendingLanes |= e), (t.suspendedLanes &= ~e));
    var i = 31 - De(e);
    ((t.entangledLanes |= e),
      (t.entanglements[i] = t.entanglements[i] | 1073741824 | (a & 261930)));
  }
  function Vf(t, e) {
    var a = (t.entangledLanes |= e);
    for (t = t.entanglements; a; ) {
      var i = 31 - De(a),
        s = 1 << i;
      ((s & e) | (t[i] & e) && (t[i] |= e), (a &= ~s));
    }
  }
  function Xf(t, e) {
    var a = e & -e;
    return ((a = (a & 42) !== 0 ? 1 : zs(a)), (a & (t.suspendedLanes | e)) !== 0 ? 0 : a);
  }
  function zs(t) {
    switch (t) {
      case 2:
        t = 1;
        break;
      case 8:
        t = 4;
        break;
      case 32:
        t = 16;
        break;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        t = 128;
        break;
      case 268435456:
        t = 134217728;
        break;
      default:
        t = 0;
    }
    return t;
  }
  function Ds(t) {
    return ((t &= -t), 2 < t ? (8 < t ? ((t & 134217727) !== 0 ? 32 : 268435456) : 8) : 2);
  }
  function Zf() {
    var t = P.p;
    return t !== 0 ? t : ((t = window.event), t === void 0 ? 32 : Cy(t.type));
  }
  function Kf(t, e) {
    var a = P.p;
    try {
      return ((P.p = t), e());
    } finally {
      P.p = a;
    }
  }
  var Zn = Math.random().toString(36).slice(2),
    ce = "__reactFiber$" + Zn,
    Ee = "__reactProps$" + Zn,
    vl = "__reactContainer$" + Zn,
    Us = "__reactEvents$" + Zn,
    zp = "__reactListeners$" + Zn,
    Dp = "__reactHandles$" + Zn,
    Pf = "__reactResources$" + Zn,
    Ei = "__reactMarker$" + Zn;
  function Ls(t) {
    (delete t[ce], delete t[Ee], delete t[Us], delete t[zp], delete t[Dp]);
  }
  function gl(t) {
    var e = t[ce];
    if (e) return e;
    for (var a = t.parentNode; a; ) {
      if ((e = a[vl] || a[ce])) {
        if (((a = e.alternate), e.child !== null || (a !== null && a.child !== null)))
          for (t = my(t); t !== null; ) {
            if ((a = t[ce])) return a;
            t = my(t);
          }
        return e;
      }
      ((t = a), (a = t.parentNode));
    }
    return null;
  }
  function pl(t) {
    if ((t = t[ce] || t[vl])) {
      var e = t.tag;
      if (e === 5 || e === 6 || e === 13 || e === 31 || e === 26 || e === 27 || e === 3) return t;
    }
    return null;
  }
  function Ri(t) {
    var e = t.tag;
    if (e === 5 || e === 26 || e === 27 || e === 6) return t.stateNode;
    throw Error(r(33));
  }
  function Sl(t) {
    var e = t[Pf];
    return (e || (e = t[Pf] = { hoistableStyles: new Map(), hoistableScripts: new Map() }), e);
  }
  function le(t) {
    t[Ei] = !0;
  }
  var Jf = new Set(),
    Ff = {};
  function La(t, e) {
    (bl(t, e), bl(t + "Capture", e));
  }
  function bl(t, e) {
    for (Ff[t] = e, t = 0; t < e.length; t++) Jf.add(e[t]);
  }
  var Up = RegExp(
      "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$",
    ),
    kf = {},
    If = {};
  function Lp(t) {
    return Da.call(If, t)
      ? !0
      : Da.call(kf, t)
        ? !1
        : Up.test(t)
          ? (If[t] = !0)
          : ((kf[t] = !0), !1);
  }
  function Xu(t, e, a) {
    if (Lp(e))
      if (a === null) t.removeAttribute(e);
      else {
        switch (typeof a) {
          case "undefined":
          case "function":
          case "symbol":
            t.removeAttribute(e);
            return;
          case "boolean":
            var i = e.toLowerCase().slice(0, 5);
            if (i !== "data-" && i !== "aria-") {
              t.removeAttribute(e);
              return;
            }
        }
        t.setAttribute(e, "" + a);
      }
  }
  function Zu(t, e, a) {
    if (a === null) t.removeAttribute(e);
    else {
      switch (typeof a) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          t.removeAttribute(e);
          return;
      }
      t.setAttribute(e, "" + a);
    }
  }
  function Sn(t, e, a, i) {
    if (i === null) t.removeAttribute(a);
    else {
      switch (typeof i) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          t.removeAttribute(a);
          return;
      }
      t.setAttributeNS(e, a, "" + i);
    }
  }
  function Qe(t) {
    switch (typeof t) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "undefined":
        return t;
      case "object":
        return t;
      default:
        return "";
    }
  }
  function $f(t) {
    var e = t.type;
    return (t = t.nodeName) && t.toLowerCase() === "input" && (e === "checkbox" || e === "radio");
  }
  function Np(t, e, a) {
    var i = Object.getOwnPropertyDescriptor(t.constructor.prototype, e);
    if (
      !t.hasOwnProperty(e) &&
      typeof i < "u" &&
      typeof i.get == "function" &&
      typeof i.set == "function"
    ) {
      var s = i.get,
        c = i.set;
      return (
        Object.defineProperty(t, e, {
          configurable: !0,
          get: function () {
            return s.call(this);
          },
          set: function (h) {
            ((a = "" + h), c.call(this, h));
          },
        }),
        Object.defineProperty(t, e, { enumerable: i.enumerable }),
        {
          getValue: function () {
            return a;
          },
          setValue: function (h) {
            a = "" + h;
          },
          stopTracking: function () {
            ((t._valueTracker = null), delete t[e]);
          },
        }
      );
    }
  }
  function Ns(t) {
    if (!t._valueTracker) {
      var e = $f(t) ? "checked" : "value";
      t._valueTracker = Np(t, e, "" + t[e]);
    }
  }
  function Wf(t) {
    if (!t) return !1;
    var e = t._valueTracker;
    if (!e) return !0;
    var a = e.getValue(),
      i = "";
    return (
      t && (i = $f(t) ? (t.checked ? "true" : "false") : t.value),
      (t = i),
      t !== a ? (e.setValue(t), !0) : !1
    );
  }
  function Ku(t) {
    if (((t = t || (typeof document < "u" ? document : void 0)), typeof t > "u")) return null;
    try {
      return t.activeElement || t.body;
    } catch {
      return t.body;
    }
  }
  var jp = /[\n"\\]/g;
  function Ge(t) {
    return t.replace(jp, function (e) {
      return "\\" + e.charCodeAt(0).toString(16) + " ";
    });
  }
  function js(t, e, a, i, s, c, h, S) {
    ((t.name = ""),
      h != null && typeof h != "function" && typeof h != "symbol" && typeof h != "boolean"
        ? (t.type = h)
        : t.removeAttribute("type"),
      e != null
        ? h === "number"
          ? ((e === 0 && t.value === "") || t.value != e) && (t.value = "" + Qe(e))
          : t.value !== "" + Qe(e) && (t.value = "" + Qe(e))
        : (h !== "submit" && h !== "reset") || t.removeAttribute("value"),
      e != null
        ? Bs(t, h, Qe(e))
        : a != null
          ? Bs(t, h, Qe(a))
          : i != null && t.removeAttribute("value"),
      s == null && c != null && (t.defaultChecked = !!c),
      s != null && (t.checked = s && typeof s != "function" && typeof s != "symbol"),
      S != null && typeof S != "function" && typeof S != "symbol" && typeof S != "boolean"
        ? (t.name = "" + Qe(S))
        : t.removeAttribute("name"));
  }
  function td(t, e, a, i, s, c, h, S) {
    if (
      (c != null &&
        typeof c != "function" &&
        typeof c != "symbol" &&
        typeof c != "boolean" &&
        (t.type = c),
      e != null || a != null)
    ) {
      if (!((c !== "submit" && c !== "reset") || e != null)) {
        Ns(t);
        return;
      }
      ((a = a != null ? "" + Qe(a) : ""),
        (e = e != null ? "" + Qe(e) : a),
        S || e === t.value || (t.value = e),
        (t.defaultValue = e));
    }
    ((i = i ?? s),
      (i = typeof i != "function" && typeof i != "symbol" && !!i),
      (t.checked = S ? t.checked : !!i),
      (t.defaultChecked = !!i),
      h != null &&
        typeof h != "function" &&
        typeof h != "symbol" &&
        typeof h != "boolean" &&
        (t.name = h),
      Ns(t));
  }
  function Bs(t, e, a) {
    (e === "number" && Ku(t.ownerDocument) === t) ||
      t.defaultValue === "" + a ||
      (t.defaultValue = "" + a);
  }
  function _l(t, e, a, i) {
    if (((t = t.options), e)) {
      e = {};
      for (var s = 0; s < a.length; s++) e["$" + a[s]] = !0;
      for (a = 0; a < t.length; a++)
        ((s = e.hasOwnProperty("$" + t[a].value)),
          t[a].selected !== s && (t[a].selected = s),
          s && i && (t[a].defaultSelected = !0));
    } else {
      for (a = "" + Qe(a), e = null, s = 0; s < t.length; s++) {
        if (t[s].value === a) {
          ((t[s].selected = !0), i && (t[s].defaultSelected = !0));
          return;
        }
        e !== null || t[s].disabled || (e = t[s]);
      }
      e !== null && (e.selected = !0);
    }
  }
  function ed(t, e, a) {
    if (e != null && ((e = "" + Qe(e)), e !== t.value && (t.value = e), a == null)) {
      t.defaultValue !== e && (t.defaultValue = e);
      return;
    }
    t.defaultValue = a != null ? "" + Qe(a) : "";
  }
  function nd(t, e, a, i) {
    if (e == null) {
      if (i != null) {
        if (a != null) throw Error(r(92));
        if (it(i)) {
          if (1 < i.length) throw Error(r(93));
          i = i[0];
        }
        a = i;
      }
      (a == null && (a = ""), (e = a));
    }
    ((a = Qe(e)),
      (t.defaultValue = a),
      (i = t.textContent),
      i === a && i !== "" && i !== null && (t.value = i),
      Ns(t));
  }
  function El(t, e) {
    if (e) {
      var a = t.firstChild;
      if (a && a === t.lastChild && a.nodeType === 3) {
        a.nodeValue = e;
        return;
      }
    }
    t.textContent = e;
  }
  var Bp = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " ",
    ),
  );
  function ad(t, e, a) {
    var i = e.indexOf("--") === 0;
    a == null || typeof a == "boolean" || a === ""
      ? i
        ? t.setProperty(e, "")
        : e === "float"
          ? (t.cssFloat = "")
          : (t[e] = "")
      : i
        ? t.setProperty(e, a)
        : typeof a != "number" || a === 0 || Bp.has(e)
          ? e === "float"
            ? (t.cssFloat = a)
            : (t[e] = ("" + a).trim())
          : (t[e] = a + "px");
  }
  function ld(t, e, a) {
    if (e != null && typeof e != "object") throw Error(r(62));
    if (((t = t.style), a != null)) {
      for (var i in a)
        !a.hasOwnProperty(i) ||
          (e != null && e.hasOwnProperty(i)) ||
          (i.indexOf("--") === 0
            ? t.setProperty(i, "")
            : i === "float"
              ? (t.cssFloat = "")
              : (t[i] = ""));
      for (var s in e) ((i = e[s]), e.hasOwnProperty(s) && a[s] !== i && ad(t, s, i));
    } else for (var c in e) e.hasOwnProperty(c) && ad(t, c, e[c]);
  }
  function Hs(t) {
    if (t.indexOf("-") === -1) return !1;
    switch (t) {
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        return !1;
      default:
        return !0;
    }
  }
  var Hp = new Map([
      ["acceptCharset", "accept-charset"],
      ["htmlFor", "for"],
      ["httpEquiv", "http-equiv"],
      ["crossOrigin", "crossorigin"],
      ["accentHeight", "accent-height"],
      ["alignmentBaseline", "alignment-baseline"],
      ["arabicForm", "arabic-form"],
      ["baselineShift", "baseline-shift"],
      ["capHeight", "cap-height"],
      ["clipPath", "clip-path"],
      ["clipRule", "clip-rule"],
      ["colorInterpolation", "color-interpolation"],
      ["colorInterpolationFilters", "color-interpolation-filters"],
      ["colorProfile", "color-profile"],
      ["colorRendering", "color-rendering"],
      ["dominantBaseline", "dominant-baseline"],
      ["enableBackground", "enable-background"],
      ["fillOpacity", "fill-opacity"],
      ["fillRule", "fill-rule"],
      ["floodColor", "flood-color"],
      ["floodOpacity", "flood-opacity"],
      ["fontFamily", "font-family"],
      ["fontSize", "font-size"],
      ["fontSizeAdjust", "font-size-adjust"],
      ["fontStretch", "font-stretch"],
      ["fontStyle", "font-style"],
      ["fontVariant", "font-variant"],
      ["fontWeight", "font-weight"],
      ["glyphName", "glyph-name"],
      ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
      ["glyphOrientationVertical", "glyph-orientation-vertical"],
      ["horizAdvX", "horiz-adv-x"],
      ["horizOriginX", "horiz-origin-x"],
      ["imageRendering", "image-rendering"],
      ["letterSpacing", "letter-spacing"],
      ["lightingColor", "lighting-color"],
      ["markerEnd", "marker-end"],
      ["markerMid", "marker-mid"],
      ["markerStart", "marker-start"],
      ["overlinePosition", "overline-position"],
      ["overlineThickness", "overline-thickness"],
      ["paintOrder", "paint-order"],
      ["panose-1", "panose-1"],
      ["pointerEvents", "pointer-events"],
      ["renderingIntent", "rendering-intent"],
      ["shapeRendering", "shape-rendering"],
      ["stopColor", "stop-color"],
      ["stopOpacity", "stop-opacity"],
      ["strikethroughPosition", "strikethrough-position"],
      ["strikethroughThickness", "strikethrough-thickness"],
      ["strokeDasharray", "stroke-dasharray"],
      ["strokeDashoffset", "stroke-dashoffset"],
      ["strokeLinecap", "stroke-linecap"],
      ["strokeLinejoin", "stroke-linejoin"],
      ["strokeMiterlimit", "stroke-miterlimit"],
      ["strokeOpacity", "stroke-opacity"],
      ["strokeWidth", "stroke-width"],
      ["textAnchor", "text-anchor"],
      ["textDecoration", "text-decoration"],
      ["textRendering", "text-rendering"],
      ["transformOrigin", "transform-origin"],
      ["underlinePosition", "underline-position"],
      ["underlineThickness", "underline-thickness"],
      ["unicodeBidi", "unicode-bidi"],
      ["unicodeRange", "unicode-range"],
      ["unitsPerEm", "units-per-em"],
      ["vAlphabetic", "v-alphabetic"],
      ["vHanging", "v-hanging"],
      ["vIdeographic", "v-ideographic"],
      ["vMathematical", "v-mathematical"],
      ["vectorEffect", "vector-effect"],
      ["vertAdvY", "vert-adv-y"],
      ["vertOriginX", "vert-origin-x"],
      ["vertOriginY", "vert-origin-y"],
      ["wordSpacing", "word-spacing"],
      ["writingMode", "writing-mode"],
      ["xmlnsXlink", "xmlns:xlink"],
      ["xHeight", "x-height"],
    ]),
    qp =
      /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Pu(t) {
    return qp.test("" + t)
      ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
      : t;
  }
  function bn() {}
  var qs = null;
  function Ys(t) {
    return (
      (t = t.target || t.srcElement || window),
      t.correspondingUseElement && (t = t.correspondingUseElement),
      t.nodeType === 3 ? t.parentNode : t
    );
  }
  var Rl = null,
    Tl = null;
  function id(t) {
    var e = pl(t);
    if (e && (t = e.stateNode)) {
      var a = t[Ee] || null;
      t: switch (((t = e.stateNode), e.type)) {
        case "input":
          if (
            (js(
              t,
              a.value,
              a.defaultValue,
              a.defaultValue,
              a.checked,
              a.defaultChecked,
              a.type,
              a.name,
            ),
            (e = a.name),
            a.type === "radio" && e != null)
          ) {
            for (a = t; a.parentNode; ) a = a.parentNode;
            for (
              a = a.querySelectorAll('input[name="' + Ge("" + e) + '"][type="radio"]'), e = 0;
              e < a.length;
              e++
            ) {
              var i = a[e];
              if (i !== t && i.form === t.form) {
                var s = i[Ee] || null;
                if (!s) throw Error(r(90));
                js(
                  i,
                  s.value,
                  s.defaultValue,
                  s.defaultValue,
                  s.checked,
                  s.defaultChecked,
                  s.type,
                  s.name,
                );
              }
            }
            for (e = 0; e < a.length; e++) ((i = a[e]), i.form === t.form && Wf(i));
          }
          break t;
        case "textarea":
          ed(t, a.value, a.defaultValue);
          break t;
        case "select":
          ((e = a.value), e != null && _l(t, !!a.multiple, e, !1));
      }
    }
  }
  var Qs = !1;
  function ud(t, e, a) {
    if (Qs) return t(e, a);
    Qs = !0;
    try {
      var i = t(e);
      return i;
    } finally {
      if (
        ((Qs = !1),
        (Rl !== null || Tl !== null) &&
          (Lr(), Rl && ((e = Rl), (t = Tl), (Tl = Rl = null), id(e), t)))
      )
        for (e = 0; e < t.length; e++) id(t[e]);
    }
  }
  function Ti(t, e) {
    var a = t.stateNode;
    if (a === null) return null;
    var i = a[Ee] || null;
    if (i === null) return null;
    a = i[e];
    t: switch (e) {
      case "onClick":
      case "onClickCapture":
      case "onDoubleClick":
      case "onDoubleClickCapture":
      case "onMouseDown":
      case "onMouseDownCapture":
      case "onMouseMove":
      case "onMouseMoveCapture":
      case "onMouseUp":
      case "onMouseUpCapture":
      case "onMouseEnter":
        ((i = !i.disabled) ||
          ((t = t.type),
          (i = !(t === "button" || t === "input" || t === "select" || t === "textarea"))),
          (t = !i));
        break t;
      default:
        t = !1;
    }
    if (t) return null;
    if (a && typeof a != "function") throw Error(r(231, e, typeof a));
    return a;
  }
  var _n = !(
      typeof window > "u" ||
      typeof window.document > "u" ||
      typeof window.document.createElement > "u"
    ),
    Gs = !1;
  if (_n)
    try {
      var Ai = {};
      (Object.defineProperty(Ai, "passive", {
        get: function () {
          Gs = !0;
        },
      }),
        window.addEventListener("test", Ai, Ai),
        window.removeEventListener("test", Ai, Ai));
    } catch {
      Gs = !1;
    }
  var Kn = null,
    Vs = null,
    Ju = null;
  function rd() {
    if (Ju) return Ju;
    var t,
      e = Vs,
      a = e.length,
      i,
      s = "value" in Kn ? Kn.value : Kn.textContent,
      c = s.length;
    for (t = 0; t < a && e[t] === s[t]; t++);
    var h = a - t;
    for (i = 1; i <= h && e[a - i] === s[c - i]; i++);
    return (Ju = s.slice(t, 1 < i ? 1 - i : void 0));
  }
  function Fu(t) {
    var e = t.keyCode;
    return (
      "charCode" in t ? ((t = t.charCode), t === 0 && e === 13 && (t = 13)) : (t = e),
      t === 10 && (t = 13),
      32 <= t || t === 13 ? t : 0
    );
  }
  function ku() {
    return !0;
  }
  function sd() {
    return !1;
  }
  function Re(t) {
    function e(a, i, s, c, h) {
      ((this._reactName = a),
        (this._targetInst = s),
        (this.type = i),
        (this.nativeEvent = c),
        (this.target = h),
        (this.currentTarget = null));
      for (var S in t) t.hasOwnProperty(S) && ((a = t[S]), (this[S] = a ? a(c) : c[S]));
      return (
        (this.isDefaultPrevented = (
          c.defaultPrevented != null ? c.defaultPrevented : c.returnValue === !1
        )
          ? ku
          : sd),
        (this.isPropagationStopped = sd),
        this
      );
    }
    return (
      g(e.prototype, {
        preventDefault: function () {
          this.defaultPrevented = !0;
          var a = this.nativeEvent;
          a &&
            (a.preventDefault
              ? a.preventDefault()
              : typeof a.returnValue != "unknown" && (a.returnValue = !1),
            (this.isDefaultPrevented = ku));
        },
        stopPropagation: function () {
          var a = this.nativeEvent;
          a &&
            (a.stopPropagation
              ? a.stopPropagation()
              : typeof a.cancelBubble != "unknown" && (a.cancelBubble = !0),
            (this.isPropagationStopped = ku));
        },
        persist: function () {},
        isPersistent: ku,
      }),
      e
    );
  }
  var Na = {
      eventPhase: 0,
      bubbles: 0,
      cancelable: 0,
      timeStamp: function (t) {
        return t.timeStamp || Date.now();
      },
      defaultPrevented: 0,
      isTrusted: 0,
    },
    Iu = Re(Na),
    xi = g({}, Na, { view: 0, detail: 0 }),
    Yp = Re(xi),
    Xs,
    Zs,
    Mi,
    $u = g({}, xi, {
      screenX: 0,
      screenY: 0,
      clientX: 0,
      clientY: 0,
      pageX: 0,
      pageY: 0,
      ctrlKey: 0,
      shiftKey: 0,
      altKey: 0,
      metaKey: 0,
      getModifierState: Ps,
      button: 0,
      buttons: 0,
      relatedTarget: function (t) {
        return t.relatedTarget === void 0
          ? t.fromElement === t.srcElement
            ? t.toElement
            : t.fromElement
          : t.relatedTarget;
      },
      movementX: function (t) {
        return "movementX" in t
          ? t.movementX
          : (t !== Mi &&
              (Mi && t.type === "mousemove"
                ? ((Xs = t.screenX - Mi.screenX), (Zs = t.screenY - Mi.screenY))
                : (Zs = Xs = 0),
              (Mi = t)),
            Xs);
      },
      movementY: function (t) {
        return "movementY" in t ? t.movementY : Zs;
      },
    }),
    cd = Re($u),
    Qp = g({}, $u, { dataTransfer: 0 }),
    Gp = Re(Qp),
    Vp = g({}, xi, { relatedTarget: 0 }),
    Ks = Re(Vp),
    Xp = g({}, Na, { animationName: 0, elapsedTime: 0, pseudoElement: 0 }),
    Zp = Re(Xp),
    Kp = g({}, Na, {
      clipboardData: function (t) {
        return "clipboardData" in t ? t.clipboardData : window.clipboardData;
      },
    }),
    Pp = Re(Kp),
    Jp = g({}, Na, { data: 0 }),
    od = Re(Jp),
    Fp = {
      Esc: "Escape",
      Spacebar: " ",
      Left: "ArrowLeft",
      Up: "ArrowUp",
      Right: "ArrowRight",
      Down: "ArrowDown",
      Del: "Delete",
      Win: "OS",
      Menu: "ContextMenu",
      Apps: "ContextMenu",
      Scroll: "ScrollLock",
      MozPrintableKey: "Unidentified",
    },
    kp = {
      8: "Backspace",
      9: "Tab",
      12: "Clear",
      13: "Enter",
      16: "Shift",
      17: "Control",
      18: "Alt",
      19: "Pause",
      20: "CapsLock",
      27: "Escape",
      32: " ",
      33: "PageUp",
      34: "PageDown",
      35: "End",
      36: "Home",
      37: "ArrowLeft",
      38: "ArrowUp",
      39: "ArrowRight",
      40: "ArrowDown",
      45: "Insert",
      46: "Delete",
      112: "F1",
      113: "F2",
      114: "F3",
      115: "F4",
      116: "F5",
      117: "F6",
      118: "F7",
      119: "F8",
      120: "F9",
      121: "F10",
      122: "F11",
      123: "F12",
      144: "NumLock",
      145: "ScrollLock",
      224: "Meta",
    },
    Ip = { Alt: "altKey", Control: "ctrlKey", Meta: "metaKey", Shift: "shiftKey" };
  function $p(t) {
    var e = this.nativeEvent;
    return e.getModifierState ? e.getModifierState(t) : (t = Ip[t]) ? !!e[t] : !1;
  }
  function Ps() {
    return $p;
  }
  var Wp = g({}, xi, {
      key: function (t) {
        if (t.key) {
          var e = Fp[t.key] || t.key;
          if (e !== "Unidentified") return e;
        }
        return t.type === "keypress"
          ? ((t = Fu(t)), t === 13 ? "Enter" : String.fromCharCode(t))
          : t.type === "keydown" || t.type === "keyup"
            ? kp[t.keyCode] || "Unidentified"
            : "";
      },
      code: 0,
      location: 0,
      ctrlKey: 0,
      shiftKey: 0,
      altKey: 0,
      metaKey: 0,
      repeat: 0,
      locale: 0,
      getModifierState: Ps,
      charCode: function (t) {
        return t.type === "keypress" ? Fu(t) : 0;
      },
      keyCode: function (t) {
        return t.type === "keydown" || t.type === "keyup" ? t.keyCode : 0;
      },
      which: function (t) {
        return t.type === "keypress"
          ? Fu(t)
          : t.type === "keydown" || t.type === "keyup"
            ? t.keyCode
            : 0;
      },
    }),
    t0 = Re(Wp),
    e0 = g({}, $u, {
      pointerId: 0,
      width: 0,
      height: 0,
      pressure: 0,
      tangentialPressure: 0,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      pointerType: 0,
      isPrimary: 0,
    }),
    fd = Re(e0),
    n0 = g({}, xi, {
      touches: 0,
      targetTouches: 0,
      changedTouches: 0,
      altKey: 0,
      metaKey: 0,
      ctrlKey: 0,
      shiftKey: 0,
      getModifierState: Ps,
    }),
    a0 = Re(n0),
    l0 = g({}, Na, { propertyName: 0, elapsedTime: 0, pseudoElement: 0 }),
    i0 = Re(l0),
    u0 = g({}, $u, {
      deltaX: function (t) {
        return "deltaX" in t ? t.deltaX : "wheelDeltaX" in t ? -t.wheelDeltaX : 0;
      },
      deltaY: function (t) {
        return "deltaY" in t
          ? t.deltaY
          : "wheelDeltaY" in t
            ? -t.wheelDeltaY
            : "wheelDelta" in t
              ? -t.wheelDelta
              : 0;
      },
      deltaZ: 0,
      deltaMode: 0,
    }),
    r0 = Re(u0),
    s0 = g({}, Na, { newState: 0, oldState: 0 }),
    c0 = Re(s0),
    o0 = [9, 13, 27, 32],
    Js = _n && "CompositionEvent" in window,
    wi = null;
  _n && "documentMode" in document && (wi = document.documentMode);
  var f0 = _n && "TextEvent" in window && !wi,
    dd = _n && (!Js || (wi && 8 < wi && 11 >= wi)),
    hd = " ",
    md = !1;
  function yd(t, e) {
    switch (t) {
      case "keyup":
        return o0.indexOf(e.keyCode) !== -1;
      case "keydown":
        return e.keyCode !== 229;
      case "keypress":
      case "mousedown":
      case "focusout":
        return !0;
      default:
        return !1;
    }
  }
  function vd(t) {
    return ((t = t.detail), typeof t == "object" && "data" in t ? t.data : null);
  }
  var Al = !1;
  function d0(t, e) {
    switch (t) {
      case "compositionend":
        return vd(e);
      case "keypress":
        return e.which !== 32 ? null : ((md = !0), hd);
      case "textInput":
        return ((t = e.data), t === hd && md ? null : t);
      default:
        return null;
    }
  }
  function h0(t, e) {
    if (Al)
      return t === "compositionend" || (!Js && yd(t, e))
        ? ((t = rd()), (Ju = Vs = Kn = null), (Al = !1), t)
        : null;
    switch (t) {
      case "paste":
        return null;
      case "keypress":
        if (!(e.ctrlKey || e.altKey || e.metaKey) || (e.ctrlKey && e.altKey)) {
          if (e.char && 1 < e.char.length) return e.char;
          if (e.which) return String.fromCharCode(e.which);
        }
        return null;
      case "compositionend":
        return dd && e.locale !== "ko" ? null : e.data;
      default:
        return null;
    }
  }
  var m0 = {
    color: !0,
    date: !0,
    datetime: !0,
    "datetime-local": !0,
    email: !0,
    month: !0,
    number: !0,
    password: !0,
    range: !0,
    search: !0,
    tel: !0,
    text: !0,
    time: !0,
    url: !0,
    week: !0,
  };
  function gd(t) {
    var e = t && t.nodeName && t.nodeName.toLowerCase();
    return e === "input" ? !!m0[t.type] : e === "textarea";
  }
  function pd(t, e, a, i) {
    (Rl ? (Tl ? Tl.push(i) : (Tl = [i])) : (Rl = i),
      (e = Qr(e, "onChange")),
      0 < e.length &&
        ((a = new Iu("onChange", "change", null, a, i)), t.push({ event: a, listeners: e })));
  }
  var Oi = null,
    Ci = null;
  function y0(t) {
    ty(t, 0);
  }
  function Wu(t) {
    var e = Ri(t);
    if (Wf(e)) return t;
  }
  function Sd(t, e) {
    if (t === "change") return e;
  }
  var bd = !1;
  if (_n) {
    var Fs;
    if (_n) {
      var ks = "oninput" in document;
      if (!ks) {
        var _d = document.createElement("div");
        (_d.setAttribute("oninput", "return;"), (ks = typeof _d.oninput == "function"));
      }
      Fs = ks;
    } else Fs = !1;
    bd = Fs && (!document.documentMode || 9 < document.documentMode);
  }
  function Ed() {
    Oi && (Oi.detachEvent("onpropertychange", Rd), (Ci = Oi = null));
  }
  function Rd(t) {
    if (t.propertyName === "value" && Wu(Ci)) {
      var e = [];
      (pd(e, Ci, t, Ys(t)), ud(y0, e));
    }
  }
  function v0(t, e, a) {
    t === "focusin"
      ? (Ed(), (Oi = e), (Ci = a), Oi.attachEvent("onpropertychange", Rd))
      : t === "focusout" && Ed();
  }
  function g0(t) {
    if (t === "selectionchange" || t === "keyup" || t === "keydown") return Wu(Ci);
  }
  function p0(t, e) {
    if (t === "click") return Wu(e);
  }
  function S0(t, e) {
    if (t === "input" || t === "change") return Wu(e);
  }
  function b0(t, e) {
    return (t === e && (t !== 0 || 1 / t === 1 / e)) || (t !== t && e !== e);
  }
  var Ue = typeof Object.is == "function" ? Object.is : b0;
  function zi(t, e) {
    if (Ue(t, e)) return !0;
    if (typeof t != "object" || t === null || typeof e != "object" || e === null) return !1;
    var a = Object.keys(t),
      i = Object.keys(e);
    if (a.length !== i.length) return !1;
    for (i = 0; i < a.length; i++) {
      var s = a[i];
      if (!Da.call(e, s) || !Ue(t[s], e[s])) return !1;
    }
    return !0;
  }
  function Td(t) {
    for (; t && t.firstChild; ) t = t.firstChild;
    return t;
  }
  function Ad(t, e) {
    var a = Td(t);
    t = 0;
    for (var i; a; ) {
      if (a.nodeType === 3) {
        if (((i = t + a.textContent.length), t <= e && i >= e)) return { node: a, offset: e - t };
        t = i;
      }
      t: {
        for (; a; ) {
          if (a.nextSibling) {
            a = a.nextSibling;
            break t;
          }
          a = a.parentNode;
        }
        a = void 0;
      }
      a = Td(a);
    }
  }
  function xd(t, e) {
    return t && e
      ? t === e
        ? !0
        : t && t.nodeType === 3
          ? !1
          : e && e.nodeType === 3
            ? xd(t, e.parentNode)
            : "contains" in t
              ? t.contains(e)
              : t.compareDocumentPosition
                ? !!(t.compareDocumentPosition(e) & 16)
                : !1
      : !1;
  }
  function Md(t) {
    t =
      t != null && t.ownerDocument != null && t.ownerDocument.defaultView != null
        ? t.ownerDocument.defaultView
        : window;
    for (var e = Ku(t.document); e instanceof t.HTMLIFrameElement; ) {
      try {
        var a = typeof e.contentWindow.location.href == "string";
      } catch {
        a = !1;
      }
      if (a) t = e.contentWindow;
      else break;
      e = Ku(t.document);
    }
    return e;
  }
  function Is(t) {
    var e = t && t.nodeName && t.nodeName.toLowerCase();
    return (
      e &&
      ((e === "input" &&
        (t.type === "text" ||
          t.type === "search" ||
          t.type === "tel" ||
          t.type === "url" ||
          t.type === "password")) ||
        e === "textarea" ||
        t.contentEditable === "true")
    );
  }
  var _0 = _n && "documentMode" in document && 11 >= document.documentMode,
    xl = null,
    $s = null,
    Di = null,
    Ws = !1;
  function wd(t, e, a) {
    var i = a.window === a ? a.document : a.nodeType === 9 ? a : a.ownerDocument;
    Ws ||
      xl == null ||
      xl !== Ku(i) ||
      ((i = xl),
      "selectionStart" in i && Is(i)
        ? (i = { start: i.selectionStart, end: i.selectionEnd })
        : ((i = ((i.ownerDocument && i.ownerDocument.defaultView) || window).getSelection()),
          (i = {
            anchorNode: i.anchorNode,
            anchorOffset: i.anchorOffset,
            focusNode: i.focusNode,
            focusOffset: i.focusOffset,
          })),
      (Di && zi(Di, i)) ||
        ((Di = i),
        (i = Qr($s, "onSelect")),
        0 < i.length &&
          ((e = new Iu("onSelect", "select", null, e, a)),
          t.push({ event: e, listeners: i }),
          (e.target = xl))));
  }
  function ja(t, e) {
    var a = {};
    return (
      (a[t.toLowerCase()] = e.toLowerCase()),
      (a["Webkit" + t] = "webkit" + e),
      (a["Moz" + t] = "moz" + e),
      a
    );
  }
  var Ml = {
      animationend: ja("Animation", "AnimationEnd"),
      animationiteration: ja("Animation", "AnimationIteration"),
      animationstart: ja("Animation", "AnimationStart"),
      transitionrun: ja("Transition", "TransitionRun"),
      transitionstart: ja("Transition", "TransitionStart"),
      transitioncancel: ja("Transition", "TransitionCancel"),
      transitionend: ja("Transition", "TransitionEnd"),
    },
    tc = {},
    Od = {};
  _n &&
    ((Od = document.createElement("div").style),
    "AnimationEvent" in window ||
      (delete Ml.animationend.animation,
      delete Ml.animationiteration.animation,
      delete Ml.animationstart.animation),
    "TransitionEvent" in window || delete Ml.transitionend.transition);
  function Ba(t) {
    if (tc[t]) return tc[t];
    if (!Ml[t]) return t;
    var e = Ml[t],
      a;
    for (a in e) if (e.hasOwnProperty(a) && a in Od) return (tc[t] = e[a]);
    return t;
  }
  var Cd = Ba("animationend"),
    zd = Ba("animationiteration"),
    Dd = Ba("animationstart"),
    E0 = Ba("transitionrun"),
    R0 = Ba("transitionstart"),
    T0 = Ba("transitioncancel"),
    Ud = Ba("transitionend"),
    Ld = new Map(),
    ec =
      "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
        " ",
      );
  ec.push("scrollEnd");
  function We(t, e) {
    (Ld.set(t, e), La(e, [t]));
  }
  var tr =
      typeof reportError == "function"
        ? reportError
        : function (t) {
            if (typeof window == "object" && typeof window.ErrorEvent == "function") {
              var e = new window.ErrorEvent("error", {
                bubbles: !0,
                cancelable: !0,
                message:
                  typeof t == "object" && t !== null && typeof t.message == "string"
                    ? String(t.message)
                    : String(t),
                error: t,
              });
              if (!window.dispatchEvent(e)) return;
            } else if (typeof process == "object" && typeof process.emit == "function") {
              process.emit("uncaughtException", t);
              return;
            }
            console.error(t);
          },
    Ve = [],
    wl = 0,
    nc = 0;
  function er() {
    for (var t = wl, e = (nc = wl = 0); e < t; ) {
      var a = Ve[e];
      Ve[e++] = null;
      var i = Ve[e];
      Ve[e++] = null;
      var s = Ve[e];
      Ve[e++] = null;
      var c = Ve[e];
      if (((Ve[e++] = null), i !== null && s !== null)) {
        var h = i.pending;
        (h === null ? (s.next = s) : ((s.next = h.next), (h.next = s)), (i.pending = s));
      }
      c !== 0 && Nd(a, s, c);
    }
  }
  function nr(t, e, a, i) {
    ((Ve[wl++] = t),
      (Ve[wl++] = e),
      (Ve[wl++] = a),
      (Ve[wl++] = i),
      (nc |= i),
      (t.lanes |= i),
      (t = t.alternate),
      t !== null && (t.lanes |= i));
  }
  function ac(t, e, a, i) {
    return (nr(t, e, a, i), ar(t));
  }
  function Ha(t, e) {
    return (nr(t, null, null, e), ar(t));
  }
  function Nd(t, e, a) {
    t.lanes |= a;
    var i = t.alternate;
    i !== null && (i.lanes |= a);
    for (var s = !1, c = t.return; c !== null; )
      ((c.childLanes |= a),
        (i = c.alternate),
        i !== null && (i.childLanes |= a),
        c.tag === 22 && ((t = c.stateNode), t === null || t._visibility & 1 || (s = !0)),
        (t = c),
        (c = c.return));
    return t.tag === 3
      ? ((c = t.stateNode),
        s &&
          e !== null &&
          ((s = 31 - De(a)),
          (t = c.hiddenUpdates),
          (i = t[s]),
          i === null ? (t[s] = [e]) : i.push(e),
          (e.lane = a | 536870912)),
        c)
      : null;
  }
  function ar(t) {
    if (50 < tu) throw ((tu = 0), (ho = null), Error(r(185)));
    for (var e = t.return; e !== null; ) ((t = e), (e = t.return));
    return t.tag === 3 ? t.stateNode : null;
  }
  var Ol = {};
  function A0(t, e, a, i) {
    ((this.tag = t),
      (this.key = a),
      (this.sibling =
        this.child =
        this.return =
        this.stateNode =
        this.type =
        this.elementType =
          null),
      (this.index = 0),
      (this.refCleanup = this.ref = null),
      (this.pendingProps = e),
      (this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null),
      (this.mode = i),
      (this.subtreeFlags = this.flags = 0),
      (this.deletions = null),
      (this.childLanes = this.lanes = 0),
      (this.alternate = null));
  }
  function Le(t, e, a, i) {
    return new A0(t, e, a, i);
  }
  function lc(t) {
    return ((t = t.prototype), !(!t || !t.isReactComponent));
  }
  function En(t, e) {
    var a = t.alternate;
    return (
      a === null
        ? ((a = Le(t.tag, e, t.key, t.mode)),
          (a.elementType = t.elementType),
          (a.type = t.type),
          (a.stateNode = t.stateNode),
          (a.alternate = t),
          (t.alternate = a))
        : ((a.pendingProps = e),
          (a.type = t.type),
          (a.flags = 0),
          (a.subtreeFlags = 0),
          (a.deletions = null)),
      (a.flags = t.flags & 65011712),
      (a.childLanes = t.childLanes),
      (a.lanes = t.lanes),
      (a.child = t.child),
      (a.memoizedProps = t.memoizedProps),
      (a.memoizedState = t.memoizedState),
      (a.updateQueue = t.updateQueue),
      (e = t.dependencies),
      (a.dependencies = e === null ? null : { lanes: e.lanes, firstContext: e.firstContext }),
      (a.sibling = t.sibling),
      (a.index = t.index),
      (a.ref = t.ref),
      (a.refCleanup = t.refCleanup),
      a
    );
  }
  function jd(t, e) {
    t.flags &= 65011714;
    var a = t.alternate;
    return (
      a === null
        ? ((t.childLanes = 0),
          (t.lanes = e),
          (t.child = null),
          (t.subtreeFlags = 0),
          (t.memoizedProps = null),
          (t.memoizedState = null),
          (t.updateQueue = null),
          (t.dependencies = null),
          (t.stateNode = null))
        : ((t.childLanes = a.childLanes),
          (t.lanes = a.lanes),
          (t.child = a.child),
          (t.subtreeFlags = 0),
          (t.deletions = null),
          (t.memoizedProps = a.memoizedProps),
          (t.memoizedState = a.memoizedState),
          (t.updateQueue = a.updateQueue),
          (t.type = a.type),
          (e = a.dependencies),
          (t.dependencies = e === null ? null : { lanes: e.lanes, firstContext: e.firstContext })),
      t
    );
  }
  function lr(t, e, a, i, s, c) {
    var h = 0;
    if (((i = t), typeof t == "function")) lc(t) && (h = 1);
    else if (typeof t == "string")
      h = CS(t, a, at.current) ? 26 : t === "html" || t === "head" || t === "body" ? 27 : 5;
    else
      t: switch (t) {
        case J:
          return ((t = Le(31, a, e, s)), (t.elementType = J), (t.lanes = c), t);
        case M:
          return qa(a.children, s, c, e);
        case x:
          ((h = 8), (s |= 24));
          break;
        case U:
          return ((t = Le(12, a, e, s | 2)), (t.elementType = U), (t.lanes = c), t);
        case Y:
          return ((t = Le(13, a, e, s)), (t.elementType = Y), (t.lanes = c), t);
        case I:
          return ((t = Le(19, a, e, s)), (t.elementType = I), (t.lanes = c), t);
        default:
          if (typeof t == "object" && t !== null)
            switch (t.$$typeof) {
              case C:
                h = 10;
                break t;
              case G:
                h = 9;
                break t;
              case z:
                h = 11;
                break t;
              case q:
                h = 14;
                break t;
              case k:
                ((h = 16), (i = null));
                break t;
            }
          ((h = 29), (a = Error(r(130, t === null ? "null" : typeof t, ""))), (i = null));
      }
    return ((e = Le(h, a, e, s)), (e.elementType = t), (e.type = i), (e.lanes = c), e);
  }
  function qa(t, e, a, i) {
    return ((t = Le(7, t, i, e)), (t.lanes = a), t);
  }
  function ic(t, e, a) {
    return ((t = Le(6, t, null, e)), (t.lanes = a), t);
  }
  function Bd(t) {
    var e = Le(18, null, null, 0);
    return ((e.stateNode = t), e);
  }
  function uc(t, e, a) {
    return (
      (e = Le(4, t.children !== null ? t.children : [], t.key, e)),
      (e.lanes = a),
      (e.stateNode = {
        containerInfo: t.containerInfo,
        pendingChildren: null,
        implementation: t.implementation,
      }),
      e
    );
  }
  var Hd = new WeakMap();
  function Xe(t, e) {
    if (typeof t == "object" && t !== null) {
      var a = Hd.get(t);
      return a !== void 0 ? a : ((e = { value: t, source: e, stack: pn(e) }), Hd.set(t, e), e);
    }
    return { value: t, source: e, stack: pn(e) };
  }
  var Cl = [],
    zl = 0,
    ir = null,
    Ui = 0,
    Ze = [],
    Ke = 0,
    Pn = null,
    rn = 1,
    sn = "";
  function Rn(t, e) {
    ((Cl[zl++] = Ui), (Cl[zl++] = ir), (ir = t), (Ui = e));
  }
  function qd(t, e, a) {
    ((Ze[Ke++] = rn), (Ze[Ke++] = sn), (Ze[Ke++] = Pn), (Pn = t));
    var i = rn;
    t = sn;
    var s = 32 - De(i) - 1;
    ((i &= ~(1 << s)), (a += 1));
    var c = 32 - De(e) + s;
    if (30 < c) {
      var h = s - (s % 5);
      ((c = (i & ((1 << h) - 1)).toString(32)),
        (i >>= h),
        (s -= h),
        (rn = (1 << (32 - De(e) + s)) | (a << s) | i),
        (sn = c + t));
    } else ((rn = (1 << c) | (a << s) | i), (sn = t));
  }
  function rc(t) {
    t.return !== null && (Rn(t, 1), qd(t, 1, 0));
  }
  function sc(t) {
    for (; t === ir; ) ((ir = Cl[--zl]), (Cl[zl] = null), (Ui = Cl[--zl]), (Cl[zl] = null));
    for (; t === Pn; )
      ((Pn = Ze[--Ke]),
        (Ze[Ke] = null),
        (sn = Ze[--Ke]),
        (Ze[Ke] = null),
        (rn = Ze[--Ke]),
        (Ze[Ke] = null));
  }
  function Yd(t, e) {
    ((Ze[Ke++] = rn), (Ze[Ke++] = sn), (Ze[Ke++] = Pn), (rn = e.id), (sn = e.overflow), (Pn = t));
  }
  var oe = null,
    Qt = null,
    Tt = !1,
    Jn = null,
    Pe = !1,
    cc = Error(r(519));
  function Fn(t) {
    var e = Error(
      r(418, 1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML", ""),
    );
    throw (Li(Xe(e, t)), cc);
  }
  function Qd(t) {
    var e = t.stateNode,
      a = t.type,
      i = t.memoizedProps;
    switch (((e[ce] = t), (e[Ee] = i), a)) {
      case "dialog":
        (_t("cancel", e), _t("close", e));
        break;
      case "iframe":
      case "object":
      case "embed":
        _t("load", e);
        break;
      case "video":
      case "audio":
        for (a = 0; a < nu.length; a++) _t(nu[a], e);
        break;
      case "source":
        _t("error", e);
        break;
      case "img":
      case "image":
      case "link":
        (_t("error", e), _t("load", e));
        break;
      case "details":
        _t("toggle", e);
        break;
      case "input":
        (_t("invalid", e),
          td(e, i.value, i.defaultValue, i.checked, i.defaultChecked, i.type, i.name, !0));
        break;
      case "select":
        _t("invalid", e);
        break;
      case "textarea":
        (_t("invalid", e), nd(e, i.value, i.defaultValue, i.children));
    }
    ((a = i.children),
      (typeof a != "string" && typeof a != "number" && typeof a != "bigint") ||
      e.textContent === "" + a ||
      i.suppressHydrationWarning === !0 ||
      ly(e.textContent, a)
        ? (i.popover != null && (_t("beforetoggle", e), _t("toggle", e)),
          i.onScroll != null && _t("scroll", e),
          i.onScrollEnd != null && _t("scrollend", e),
          i.onClick != null && (e.onclick = bn),
          (e = !0))
        : (e = !1),
      e || Fn(t, !0));
  }
  function Gd(t) {
    for (oe = t.return; oe; )
      switch (oe.tag) {
        case 5:
        case 31:
        case 13:
          Pe = !1;
          return;
        case 27:
        case 3:
          Pe = !0;
          return;
        default:
          oe = oe.return;
      }
  }
  function Dl(t) {
    if (t !== oe) return !1;
    if (!Tt) return (Gd(t), (Tt = !0), !1);
    var e = t.tag,
      a;
    if (
      ((a = e !== 3 && e !== 27) &&
        ((a = e === 5) &&
          ((a = t.type), (a = !(a !== "form" && a !== "button") || wo(t.type, t.memoizedProps))),
        (a = !a)),
      a && Qt && Fn(t),
      Gd(t),
      e === 13)
    ) {
      if (((t = t.memoizedState), (t = t !== null ? t.dehydrated : null), !t)) throw Error(r(317));
      Qt = hy(t);
    } else if (e === 31) {
      if (((t = t.memoizedState), (t = t !== null ? t.dehydrated : null), !t)) throw Error(r(317));
      Qt = hy(t);
    } else
      e === 27
        ? ((e = Qt), ca(t.type) ? ((t = Uo), (Uo = null), (Qt = t)) : (Qt = e))
        : (Qt = oe ? Fe(t.stateNode.nextSibling) : null);
    return !0;
  }
  function Ya() {
    ((Qt = oe = null), (Tt = !1));
  }
  function oc() {
    var t = Jn;
    return (t !== null && (Me === null ? (Me = t) : Me.push.apply(Me, t), (Jn = null)), t);
  }
  function Li(t) {
    Jn === null ? (Jn = [t]) : Jn.push(t);
  }
  var fc = O(null),
    Qa = null,
    Tn = null;
  function kn(t, e, a) {
    (tt(fc, e._currentValue), (e._currentValue = a));
  }
  function An(t) {
    ((t._currentValue = fc.current), Z(fc));
  }
  function dc(t, e, a) {
    for (; t !== null; ) {
      var i = t.alternate;
      if (
        ((t.childLanes & e) !== e
          ? ((t.childLanes |= e), i !== null && (i.childLanes |= e))
          : i !== null && (i.childLanes & e) !== e && (i.childLanes |= e),
        t === a)
      )
        break;
      t = t.return;
    }
  }
  function hc(t, e, a, i) {
    var s = t.child;
    for (s !== null && (s.return = t); s !== null; ) {
      var c = s.dependencies;
      if (c !== null) {
        var h = s.child;
        c = c.firstContext;
        t: for (; c !== null; ) {
          var S = c;
          c = s;
          for (var A = 0; A < e.length; A++)
            if (S.context === e[A]) {
              ((c.lanes |= a),
                (S = c.alternate),
                S !== null && (S.lanes |= a),
                dc(c.return, a, t),
                i || (h = null));
              break t;
            }
          c = S.next;
        }
      } else if (s.tag === 18) {
        if (((h = s.return), h === null)) throw Error(r(341));
        ((h.lanes |= a), (c = h.alternate), c !== null && (c.lanes |= a), dc(h, a, t), (h = null));
      } else h = s.child;
      if (h !== null) h.return = s;
      else
        for (h = s; h !== null; ) {
          if (h === t) {
            h = null;
            break;
          }
          if (((s = h.sibling), s !== null)) {
            ((s.return = h.return), (h = s));
            break;
          }
          h = h.return;
        }
      s = h;
    }
  }
  function Ul(t, e, a, i) {
    t = null;
    for (var s = e, c = !1; s !== null; ) {
      if (!c) {
        if ((s.flags & 524288) !== 0) c = !0;
        else if ((s.flags & 262144) !== 0) break;
      }
      if (s.tag === 10) {
        var h = s.alternate;
        if (h === null) throw Error(r(387));
        if (((h = h.memoizedProps), h !== null)) {
          var S = s.type;
          Ue(s.pendingProps.value, h.value) || (t !== null ? t.push(S) : (t = [S]));
        }
      } else if (s === xt.current) {
        if (((h = s.alternate), h === null)) throw Error(r(387));
        h.memoizedState.memoizedState !== s.memoizedState.memoizedState &&
          (t !== null ? t.push(ru) : (t = [ru]));
      }
      s = s.return;
    }
    (t !== null && hc(e, t, a, i), (e.flags |= 262144));
  }
  function ur(t) {
    for (t = t.firstContext; t !== null; ) {
      if (!Ue(t.context._currentValue, t.memoizedValue)) return !0;
      t = t.next;
    }
    return !1;
  }
  function Ga(t) {
    ((Qa = t), (Tn = null), (t = t.dependencies), t !== null && (t.firstContext = null));
  }
  function fe(t) {
    return Vd(Qa, t);
  }
  function rr(t, e) {
    return (Qa === null && Ga(t), Vd(t, e));
  }
  function Vd(t, e) {
    var a = e._currentValue;
    if (((e = { context: e, memoizedValue: a, next: null }), Tn === null)) {
      if (t === null) throw Error(r(308));
      ((Tn = e), (t.dependencies = { lanes: 0, firstContext: e }), (t.flags |= 524288));
    } else Tn = Tn.next = e;
    return a;
  }
  var x0 =
      typeof AbortController < "u"
        ? AbortController
        : function () {
            var t = [],
              e = (this.signal = {
                aborted: !1,
                addEventListener: function (a, i) {
                  t.push(i);
                },
              });
            this.abort = function () {
              ((e.aborted = !0),
                t.forEach(function (a) {
                  return a();
                }));
            };
          },
    M0 = n.unstable_scheduleCallback,
    w0 = n.unstable_NormalPriority,
    kt = {
      $$typeof: C,
      Consumer: null,
      Provider: null,
      _currentValue: null,
      _currentValue2: null,
      _threadCount: 0,
    };
  function mc() {
    return { controller: new x0(), data: new Map(), refCount: 0 };
  }
  function Ni(t) {
    (t.refCount--,
      t.refCount === 0 &&
        M0(w0, function () {
          t.controller.abort();
        }));
  }
  var ji = null,
    yc = 0,
    Ll = 0,
    Nl = null;
  function O0(t, e) {
    if (ji === null) {
      var a = (ji = []);
      ((yc = 0),
        (Ll = So()),
        (Nl = {
          status: "pending",
          value: void 0,
          then: function (i) {
            a.push(i);
          },
        }));
    }
    return (yc++, e.then(Xd, Xd), e);
  }
  function Xd() {
    if (--yc === 0 && ji !== null) {
      Nl !== null && (Nl.status = "fulfilled");
      var t = ji;
      ((ji = null), (Ll = 0), (Nl = null));
      for (var e = 0; e < t.length; e++) (0, t[e])();
    }
  }
  function C0(t, e) {
    var a = [],
      i = {
        status: "pending",
        value: null,
        reason: null,
        then: function (s) {
          a.push(s);
        },
      };
    return (
      t.then(
        function () {
          ((i.status = "fulfilled"), (i.value = e));
          for (var s = 0; s < a.length; s++) (0, a[s])(e);
        },
        function (s) {
          for (i.status = "rejected", i.reason = s, s = 0; s < a.length; s++) (0, a[s])(void 0);
        },
      ),
      i
    );
  }
  var Zd = j.S;
  j.S = function (t, e) {
    ((wm = ye()),
      typeof e == "object" && e !== null && typeof e.then == "function" && O0(t, e),
      Zd !== null && Zd(t, e));
  };
  var Va = O(null);
  function vc() {
    var t = Va.current;
    return t !== null ? t : Ht.pooledCache;
  }
  function sr(t, e) {
    e === null ? tt(Va, Va.current) : tt(Va, e.pool);
  }
  function Kd() {
    var t = vc();
    return t === null ? null : { parent: kt._currentValue, pool: t };
  }
  var jl = Error(r(460)),
    gc = Error(r(474)),
    cr = Error(r(542)),
    or = { then: function () {} };
  function Pd(t) {
    return ((t = t.status), t === "fulfilled" || t === "rejected");
  }
  function Jd(t, e, a) {
    switch (
      ((a = t[a]), a === void 0 ? t.push(e) : a !== e && (e.then(bn, bn), (e = a)), e.status)
    ) {
      case "fulfilled":
        return e.value;
      case "rejected":
        throw ((t = e.reason), kd(t), t);
      default:
        if (typeof e.status == "string") e.then(bn, bn);
        else {
          if (((t = Ht), t !== null && 100 < t.shellSuspendCounter)) throw Error(r(482));
          ((t = e),
            (t.status = "pending"),
            t.then(
              function (i) {
                if (e.status === "pending") {
                  var s = e;
                  ((s.status = "fulfilled"), (s.value = i));
                }
              },
              function (i) {
                if (e.status === "pending") {
                  var s = e;
                  ((s.status = "rejected"), (s.reason = i));
                }
              },
            ));
        }
        switch (e.status) {
          case "fulfilled":
            return e.value;
          case "rejected":
            throw ((t = e.reason), kd(t), t);
        }
        throw ((Za = e), jl);
    }
  }
  function Xa(t) {
    try {
      var e = t._init;
      return e(t._payload);
    } catch (a) {
      throw a !== null && typeof a == "object" && typeof a.then == "function" ? ((Za = a), jl) : a;
    }
  }
  var Za = null;
  function Fd() {
    if (Za === null) throw Error(r(459));
    var t = Za;
    return ((Za = null), t);
  }
  function kd(t) {
    if (t === jl || t === cr) throw Error(r(483));
  }
  var Bl = null,
    Bi = 0;
  function fr(t) {
    var e = Bi;
    return ((Bi += 1), Bl === null && (Bl = []), Jd(Bl, t, e));
  }
  function Hi(t, e) {
    ((e = e.props.ref), (t.ref = e !== void 0 ? e : null));
  }
  function dr(t, e) {
    throw e.$$typeof === b
      ? Error(r(525))
      : ((t = Object.prototype.toString.call(e)),
        Error(
          r(
            31,
            t === "[object Object]" ? "object with keys {" + Object.keys(e).join(", ") + "}" : t,
          ),
        ));
  }
  function Id(t) {
    function e(D, w) {
      if (t) {
        var L = D.deletions;
        L === null ? ((D.deletions = [w]), (D.flags |= 16)) : L.push(w);
      }
    }
    function a(D, w) {
      if (!t) return null;
      for (; w !== null; ) (e(D, w), (w = w.sibling));
      return null;
    }
    function i(D) {
      for (var w = new Map(); D !== null; )
        (D.key !== null ? w.set(D.key, D) : w.set(D.index, D), (D = D.sibling));
      return w;
    }
    function s(D, w) {
      return ((D = En(D, w)), (D.index = 0), (D.sibling = null), D);
    }
    function c(D, w, L) {
      return (
        (D.index = L),
        t
          ? ((L = D.alternate),
            L !== null
              ? ((L = L.index), L < w ? ((D.flags |= 67108866), w) : L)
              : ((D.flags |= 67108866), w))
          : ((D.flags |= 1048576), w)
      );
    }
    function h(D) {
      return (t && D.alternate === null && (D.flags |= 67108866), D);
    }
    function S(D, w, L, X) {
      return w === null || w.tag !== 6
        ? ((w = ic(L, D.mode, X)), (w.return = D), w)
        : ((w = s(w, L)), (w.return = D), w);
    }
    function A(D, w, L, X) {
      var ot = L.type;
      return ot === M
        ? Q(D, w, L.props.children, X, L.key)
        : w !== null &&
            (w.elementType === ot ||
              (typeof ot == "object" && ot !== null && ot.$$typeof === k && Xa(ot) === w.type))
          ? ((w = s(w, L.props)), Hi(w, L), (w.return = D), w)
          : ((w = lr(L.type, L.key, L.props, null, D.mode, X)), Hi(w, L), (w.return = D), w);
    }
    function N(D, w, L, X) {
      return w === null ||
        w.tag !== 4 ||
        w.stateNode.containerInfo !== L.containerInfo ||
        w.stateNode.implementation !== L.implementation
        ? ((w = uc(L, D.mode, X)), (w.return = D), w)
        : ((w = s(w, L.children || [])), (w.return = D), w);
    }
    function Q(D, w, L, X, ot) {
      return w === null || w.tag !== 7
        ? ((w = qa(L, D.mode, X, ot)), (w.return = D), w)
        : ((w = s(w, L)), (w.return = D), w);
    }
    function K(D, w, L) {
      if ((typeof w == "string" && w !== "") || typeof w == "number" || typeof w == "bigint")
        return ((w = ic("" + w, D.mode, L)), (w.return = D), w);
      if (typeof w == "object" && w !== null) {
        switch (w.$$typeof) {
          case E:
            return ((L = lr(w.type, w.key, w.props, null, D.mode, L)), Hi(L, w), (L.return = D), L);
          case R:
            return ((w = uc(w, D.mode, L)), (w.return = D), w);
          case k:
            return ((w = Xa(w)), K(D, w, L));
        }
        if (it(w) || et(w)) return ((w = qa(w, D.mode, L, null)), (w.return = D), w);
        if (typeof w.then == "function") return K(D, fr(w), L);
        if (w.$$typeof === C) return K(D, rr(D, w), L);
        dr(D, w);
      }
      return null;
    }
    function B(D, w, L, X) {
      var ot = w !== null ? w.key : null;
      if ((typeof L == "string" && L !== "") || typeof L == "number" || typeof L == "bigint")
        return ot !== null ? null : S(D, w, "" + L, X);
      if (typeof L == "object" && L !== null) {
        switch (L.$$typeof) {
          case E:
            return L.key === ot ? A(D, w, L, X) : null;
          case R:
            return L.key === ot ? N(D, w, L, X) : null;
          case k:
            return ((L = Xa(L)), B(D, w, L, X));
        }
        if (it(L) || et(L)) return ot !== null ? null : Q(D, w, L, X, null);
        if (typeof L.then == "function") return B(D, w, fr(L), X);
        if (L.$$typeof === C) return B(D, w, rr(D, L), X);
        dr(D, L);
      }
      return null;
    }
    function H(D, w, L, X, ot) {
      if ((typeof X == "string" && X !== "") || typeof X == "number" || typeof X == "bigint")
        return ((D = D.get(L) || null), S(w, D, "" + X, ot));
      if (typeof X == "object" && X !== null) {
        switch (X.$$typeof) {
          case E:
            return ((D = D.get(X.key === null ? L : X.key) || null), A(w, D, X, ot));
          case R:
            return ((D = D.get(X.key === null ? L : X.key) || null), N(w, D, X, ot));
          case k:
            return ((X = Xa(X)), H(D, w, L, X, ot));
        }
        if (it(X) || et(X)) return ((D = D.get(L) || null), Q(w, D, X, ot, null));
        if (typeof X.then == "function") return H(D, w, L, fr(X), ot);
        if (X.$$typeof === C) return H(D, w, L, rr(w, X), ot);
        dr(w, X);
      }
      return null;
    }
    function lt(D, w, L, X) {
      for (
        var ot = null, Mt = null, ut = w, pt = (w = 0), Rt = null;
        ut !== null && pt < L.length;
        pt++
      ) {
        ut.index > pt ? ((Rt = ut), (ut = null)) : (Rt = ut.sibling);
        var wt = B(D, ut, L[pt], X);
        if (wt === null) {
          ut === null && (ut = Rt);
          break;
        }
        (t && ut && wt.alternate === null && e(D, ut),
          (w = c(wt, w, pt)),
          Mt === null ? (ot = wt) : (Mt.sibling = wt),
          (Mt = wt),
          (ut = Rt));
      }
      if (pt === L.length) return (a(D, ut), Tt && Rn(D, pt), ot);
      if (ut === null) {
        for (; pt < L.length; pt++)
          ((ut = K(D, L[pt], X)),
            ut !== null &&
              ((w = c(ut, w, pt)), Mt === null ? (ot = ut) : (Mt.sibling = ut), (Mt = ut)));
        return (Tt && Rn(D, pt), ot);
      }
      for (ut = i(ut); pt < L.length; pt++)
        ((Rt = H(ut, D, pt, L[pt], X)),
          Rt !== null &&
            (t && Rt.alternate !== null && ut.delete(Rt.key === null ? pt : Rt.key),
            (w = c(Rt, w, pt)),
            Mt === null ? (ot = Rt) : (Mt.sibling = Rt),
            (Mt = Rt)));
      return (
        t &&
          ut.forEach(function (ma) {
            return e(D, ma);
          }),
        Tt && Rn(D, pt),
        ot
      );
    }
    function ft(D, w, L, X) {
      if (L == null) throw Error(r(151));
      for (
        var ot = null, Mt = null, ut = w, pt = (w = 0), Rt = null, wt = L.next();
        ut !== null && !wt.done;
        pt++, wt = L.next()
      ) {
        ut.index > pt ? ((Rt = ut), (ut = null)) : (Rt = ut.sibling);
        var ma = B(D, ut, wt.value, X);
        if (ma === null) {
          ut === null && (ut = Rt);
          break;
        }
        (t && ut && ma.alternate === null && e(D, ut),
          (w = c(ma, w, pt)),
          Mt === null ? (ot = ma) : (Mt.sibling = ma),
          (Mt = ma),
          (ut = Rt));
      }
      if (wt.done) return (a(D, ut), Tt && Rn(D, pt), ot);
      if (ut === null) {
        for (; !wt.done; pt++, wt = L.next())
          ((wt = K(D, wt.value, X)),
            wt !== null &&
              ((w = c(wt, w, pt)), Mt === null ? (ot = wt) : (Mt.sibling = wt), (Mt = wt)));
        return (Tt && Rn(D, pt), ot);
      }
      for (ut = i(ut); !wt.done; pt++, wt = L.next())
        ((wt = H(ut, D, pt, wt.value, X)),
          wt !== null &&
            (t && wt.alternate !== null && ut.delete(wt.key === null ? pt : wt.key),
            (w = c(wt, w, pt)),
            Mt === null ? (ot = wt) : (Mt.sibling = wt),
            (Mt = wt)));
      return (
        t &&
          ut.forEach(function (QS) {
            return e(D, QS);
          }),
        Tt && Rn(D, pt),
        ot
      );
    }
    function jt(D, w, L, X) {
      if (
        (typeof L == "object" &&
          L !== null &&
          L.type === M &&
          L.key === null &&
          (L = L.props.children),
        typeof L == "object" && L !== null)
      ) {
        switch (L.$$typeof) {
          case E:
            t: {
              for (var ot = L.key; w !== null; ) {
                if (w.key === ot) {
                  if (((ot = L.type), ot === M)) {
                    if (w.tag === 7) {
                      (a(D, w.sibling), (X = s(w, L.props.children)), (X.return = D), (D = X));
                      break t;
                    }
                  } else if (
                    w.elementType === ot ||
                    (typeof ot == "object" && ot !== null && ot.$$typeof === k && Xa(ot) === w.type)
                  ) {
                    (a(D, w.sibling), (X = s(w, L.props)), Hi(X, L), (X.return = D), (D = X));
                    break t;
                  }
                  a(D, w);
                  break;
                } else e(D, w);
                w = w.sibling;
              }
              L.type === M
                ? ((X = qa(L.props.children, D.mode, X, L.key)), (X.return = D), (D = X))
                : ((X = lr(L.type, L.key, L.props, null, D.mode, X)),
                  Hi(X, L),
                  (X.return = D),
                  (D = X));
            }
            return h(D);
          case R:
            t: {
              for (ot = L.key; w !== null; ) {
                if (w.key === ot)
                  if (
                    w.tag === 4 &&
                    w.stateNode.containerInfo === L.containerInfo &&
                    w.stateNode.implementation === L.implementation
                  ) {
                    (a(D, w.sibling), (X = s(w, L.children || [])), (X.return = D), (D = X));
                    break t;
                  } else {
                    a(D, w);
                    break;
                  }
                else e(D, w);
                w = w.sibling;
              }
              ((X = uc(L, D.mode, X)), (X.return = D), (D = X));
            }
            return h(D);
          case k:
            return ((L = Xa(L)), jt(D, w, L, X));
        }
        if (it(L)) return lt(D, w, L, X);
        if (et(L)) {
          if (((ot = et(L)), typeof ot != "function")) throw Error(r(150));
          return ((L = ot.call(L)), ft(D, w, L, X));
        }
        if (typeof L.then == "function") return jt(D, w, fr(L), X);
        if (L.$$typeof === C) return jt(D, w, rr(D, L), X);
        dr(D, L);
      }
      return (typeof L == "string" && L !== "") || typeof L == "number" || typeof L == "bigint"
        ? ((L = "" + L),
          w !== null && w.tag === 6
            ? (a(D, w.sibling), (X = s(w, L)), (X.return = D), (D = X))
            : (a(D, w), (X = ic(L, D.mode, X)), (X.return = D), (D = X)),
          h(D))
        : a(D, w);
    }
    return function (D, w, L, X) {
      try {
        Bi = 0;
        var ot = jt(D, w, L, X);
        return ((Bl = null), ot);
      } catch (ut) {
        if (ut === jl || ut === cr) throw ut;
        var Mt = Le(29, ut, null, D.mode);
        return ((Mt.lanes = X), (Mt.return = D), Mt);
      } finally {
      }
    };
  }
  var Ka = Id(!0),
    $d = Id(!1),
    In = !1;
  function pc(t) {
    t.updateQueue = {
      baseState: t.memoizedState,
      firstBaseUpdate: null,
      lastBaseUpdate: null,
      shared: { pending: null, lanes: 0, hiddenCallbacks: null },
      callbacks: null,
    };
  }
  function Sc(t, e) {
    ((t = t.updateQueue),
      e.updateQueue === t &&
        (e.updateQueue = {
          baseState: t.baseState,
          firstBaseUpdate: t.firstBaseUpdate,
          lastBaseUpdate: t.lastBaseUpdate,
          shared: t.shared,
          callbacks: null,
        }));
  }
  function $n(t) {
    return { lane: t, tag: 0, payload: null, callback: null, next: null };
  }
  function Wn(t, e, a) {
    var i = t.updateQueue;
    if (i === null) return null;
    if (((i = i.shared), (Ct & 2) !== 0)) {
      var s = i.pending;
      return (
        s === null ? (e.next = e) : ((e.next = s.next), (s.next = e)),
        (i.pending = e),
        (e = ar(t)),
        Nd(t, null, a),
        e
      );
    }
    return (nr(t, i, e, a), ar(t));
  }
  function qi(t, e, a) {
    if (((e = e.updateQueue), e !== null && ((e = e.shared), (a & 4194048) !== 0))) {
      var i = e.lanes;
      ((i &= t.pendingLanes), (a |= i), (e.lanes = a), Vf(t, a));
    }
  }
  function bc(t, e) {
    var a = t.updateQueue,
      i = t.alternate;
    if (i !== null && ((i = i.updateQueue), a === i)) {
      var s = null,
        c = null;
      if (((a = a.firstBaseUpdate), a !== null)) {
        do {
          var h = { lane: a.lane, tag: a.tag, payload: a.payload, callback: null, next: null };
          (c === null ? (s = c = h) : (c = c.next = h), (a = a.next));
        } while (a !== null);
        c === null ? (s = c = e) : (c = c.next = e);
      } else s = c = e;
      ((a = {
        baseState: i.baseState,
        firstBaseUpdate: s,
        lastBaseUpdate: c,
        shared: i.shared,
        callbacks: i.callbacks,
      }),
        (t.updateQueue = a));
      return;
    }
    ((t = a.lastBaseUpdate),
      t === null ? (a.firstBaseUpdate = e) : (t.next = e),
      (a.lastBaseUpdate = e));
  }
  var _c = !1;
  function Yi() {
    if (_c) {
      var t = Nl;
      if (t !== null) throw t;
    }
  }
  function Qi(t, e, a, i) {
    _c = !1;
    var s = t.updateQueue;
    In = !1;
    var c = s.firstBaseUpdate,
      h = s.lastBaseUpdate,
      S = s.shared.pending;
    if (S !== null) {
      s.shared.pending = null;
      var A = S,
        N = A.next;
      ((A.next = null), h === null ? (c = N) : (h.next = N), (h = A));
      var Q = t.alternate;
      Q !== null &&
        ((Q = Q.updateQueue),
        (S = Q.lastBaseUpdate),
        S !== h && (S === null ? (Q.firstBaseUpdate = N) : (S.next = N), (Q.lastBaseUpdate = A)));
    }
    if (c !== null) {
      var K = s.baseState;
      ((h = 0), (Q = N = A = null), (S = c));
      do {
        var B = S.lane & -536870913,
          H = B !== S.lane;
        if (H ? (Et & B) === B : (i & B) === B) {
          (B !== 0 && B === Ll && (_c = !0),
            Q !== null &&
              (Q = Q.next =
                { lane: 0, tag: S.tag, payload: S.payload, callback: null, next: null }));
          t: {
            var lt = t,
              ft = S;
            B = e;
            var jt = a;
            switch (ft.tag) {
              case 1:
                if (((lt = ft.payload), typeof lt == "function")) {
                  K = lt.call(jt, K, B);
                  break t;
                }
                K = lt;
                break t;
              case 3:
                lt.flags = (lt.flags & -65537) | 128;
              case 0:
                if (
                  ((lt = ft.payload),
                  (B = typeof lt == "function" ? lt.call(jt, K, B) : lt),
                  B == null)
                )
                  break t;
                K = g({}, K, B);
                break t;
              case 2:
                In = !0;
            }
          }
          ((B = S.callback),
            B !== null &&
              ((t.flags |= 64),
              H && (t.flags |= 8192),
              (H = s.callbacks),
              H === null ? (s.callbacks = [B]) : H.push(B)));
        } else
          ((H = { lane: B, tag: S.tag, payload: S.payload, callback: S.callback, next: null }),
            Q === null ? ((N = Q = H), (A = K)) : (Q = Q.next = H),
            (h |= B));
        if (((S = S.next), S === null)) {
          if (((S = s.shared.pending), S === null)) break;
          ((H = S),
            (S = H.next),
            (H.next = null),
            (s.lastBaseUpdate = H),
            (s.shared.pending = null));
        }
      } while (!0);
      (Q === null && (A = K),
        (s.baseState = A),
        (s.firstBaseUpdate = N),
        (s.lastBaseUpdate = Q),
        c === null && (s.shared.lanes = 0),
        (la |= h),
        (t.lanes = h),
        (t.memoizedState = K));
    }
  }
  function Wd(t, e) {
    if (typeof t != "function") throw Error(r(191, t));
    t.call(e);
  }
  function th(t, e) {
    var a = t.callbacks;
    if (a !== null) for (t.callbacks = null, t = 0; t < a.length; t++) Wd(a[t], e);
  }
  var Hl = O(null),
    hr = O(0);
  function eh(t, e) {
    ((t = Ln), tt(hr, t), tt(Hl, e), (Ln = t | e.baseLanes));
  }
  function Ec() {
    (tt(hr, Ln), tt(Hl, Hl.current));
  }
  function Rc() {
    ((Ln = hr.current), Z(Hl), Z(hr));
  }
  var Ne = O(null),
    Je = null;
  function ta(t) {
    var e = t.alternate;
    (tt(Jt, Jt.current & 1),
      tt(Ne, t),
      Je === null && (e === null || Hl.current !== null || e.memoizedState !== null) && (Je = t));
  }
  function Tc(t) {
    (tt(Jt, Jt.current), tt(Ne, t), Je === null && (Je = t));
  }
  function nh(t) {
    t.tag === 22 ? (tt(Jt, Jt.current), tt(Ne, t), Je === null && (Je = t)) : ea();
  }
  function ea() {
    (tt(Jt, Jt.current), tt(Ne, Ne.current));
  }
  function je(t) {
    (Z(Ne), Je === t && (Je = null), Z(Jt));
  }
  var Jt = O(0);
  function mr(t) {
    for (var e = t; e !== null; ) {
      if (e.tag === 13) {
        var a = e.memoizedState;
        if (a !== null && ((a = a.dehydrated), a === null || zo(a) || Do(a))) return e;
      } else if (
        e.tag === 19 &&
        (e.memoizedProps.revealOrder === "forwards" ||
          e.memoizedProps.revealOrder === "backwards" ||
          e.memoizedProps.revealOrder === "unstable_legacy-backwards" ||
          e.memoizedProps.revealOrder === "together")
      ) {
        if ((e.flags & 128) !== 0) return e;
      } else if (e.child !== null) {
        ((e.child.return = e), (e = e.child));
        continue;
      }
      if (e === t) break;
      for (; e.sibling === null; ) {
        if (e.return === null || e.return === t) return null;
        e = e.return;
      }
      ((e.sibling.return = e.return), (e = e.sibling));
    }
    return null;
  }
  var xn = 0,
    gt = null,
    Lt = null,
    It = null,
    yr = !1,
    ql = !1,
    Pa = !1,
    vr = 0,
    Gi = 0,
    Yl = null,
    z0 = 0;
  function Zt() {
    throw Error(r(321));
  }
  function Ac(t, e) {
    if (e === null) return !1;
    for (var a = 0; a < e.length && a < t.length; a++) if (!Ue(t[a], e[a])) return !1;
    return !0;
  }
  function xc(t, e, a, i, s, c) {
    return (
      (xn = c),
      (gt = e),
      (e.memoizedState = null),
      (e.updateQueue = null),
      (e.lanes = 0),
      (j.H = t === null || t.memoizedState === null ? qh : Qc),
      (Pa = !1),
      (c = a(i, s)),
      (Pa = !1),
      ql && (c = lh(e, a, i, s)),
      ah(t),
      c
    );
  }
  function ah(t) {
    j.H = Zi;
    var e = Lt !== null && Lt.next !== null;
    if (((xn = 0), (It = Lt = gt = null), (yr = !1), (Gi = 0), (Yl = null), e)) throw Error(r(300));
    t === null || $t || ((t = t.dependencies), t !== null && ur(t) && ($t = !0));
  }
  function lh(t, e, a, i) {
    gt = t;
    var s = 0;
    do {
      if ((ql && (Yl = null), (Gi = 0), (ql = !1), 25 <= s)) throw Error(r(301));
      if (((s += 1), (It = Lt = null), t.updateQueue != null)) {
        var c = t.updateQueue;
        ((c.lastEffect = null),
          (c.events = null),
          (c.stores = null),
          c.memoCache != null && (c.memoCache.index = 0));
      }
      ((j.H = Yh), (c = e(a, i)));
    } while (ql);
    return c;
  }
  function D0() {
    var t = j.H,
      e = t.useState()[0];
    return (
      (e = typeof e.then == "function" ? Vi(e) : e),
      (t = t.useState()[0]),
      (Lt !== null ? Lt.memoizedState : null) !== t && (gt.flags |= 1024),
      e
    );
  }
  function Mc() {
    var t = vr !== 0;
    return ((vr = 0), t);
  }
  function wc(t, e, a) {
    ((e.updateQueue = t.updateQueue), (e.flags &= -2053), (t.lanes &= ~a));
  }
  function Oc(t) {
    if (yr) {
      for (t = t.memoizedState; t !== null; ) {
        var e = t.queue;
        (e !== null && (e.pending = null), (t = t.next));
      }
      yr = !1;
    }
    ((xn = 0), (It = Lt = gt = null), (ql = !1), (Gi = vr = 0), (Yl = null));
  }
  function Se() {
    var t = { memoizedState: null, baseState: null, baseQueue: null, queue: null, next: null };
    return (It === null ? (gt.memoizedState = It = t) : (It = It.next = t), It);
  }
  function Ft() {
    if (Lt === null) {
      var t = gt.alternate;
      t = t !== null ? t.memoizedState : null;
    } else t = Lt.next;
    var e = It === null ? gt.memoizedState : It.next;
    if (e !== null) ((It = e), (Lt = t));
    else {
      if (t === null) throw gt.alternate === null ? Error(r(467)) : Error(r(310));
      ((Lt = t),
        (t = {
          memoizedState: Lt.memoizedState,
          baseState: Lt.baseState,
          baseQueue: Lt.baseQueue,
          queue: Lt.queue,
          next: null,
        }),
        It === null ? (gt.memoizedState = It = t) : (It = It.next = t));
    }
    return It;
  }
  function gr() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function Vi(t) {
    var e = Gi;
    return (
      (Gi += 1),
      Yl === null && (Yl = []),
      (t = Jd(Yl, t, e)),
      (e = gt),
      (It === null ? e.memoizedState : It.next) === null &&
        ((e = e.alternate), (j.H = e === null || e.memoizedState === null ? qh : Qc)),
      t
    );
  }
  function pr(t) {
    if (t !== null && typeof t == "object") {
      if (typeof t.then == "function") return Vi(t);
      if (t.$$typeof === C) return fe(t);
    }
    throw Error(r(438, String(t)));
  }
  function Cc(t) {
    var e = null,
      a = gt.updateQueue;
    if ((a !== null && (e = a.memoCache), e == null)) {
      var i = gt.alternate;
      i !== null &&
        ((i = i.updateQueue),
        i !== null &&
          ((i = i.memoCache),
          i != null &&
            (e = {
              data: i.data.map(function (s) {
                return s.slice();
              }),
              index: 0,
            })));
    }
    if (
      (e == null && (e = { data: [], index: 0 }),
      a === null && ((a = gr()), (gt.updateQueue = a)),
      (a.memoCache = e),
      (a = e.data[e.index]),
      a === void 0)
    )
      for (a = e.data[e.index] = Array(t), i = 0; i < t; i++) a[i] = F;
    return (e.index++, a);
  }
  function Mn(t, e) {
    return typeof e == "function" ? e(t) : e;
  }
  function Sr(t) {
    var e = Ft();
    return zc(e, Lt, t);
  }
  function zc(t, e, a) {
    var i = t.queue;
    if (i === null) throw Error(r(311));
    i.lastRenderedReducer = a;
    var s = t.baseQueue,
      c = i.pending;
    if (c !== null) {
      if (s !== null) {
        var h = s.next;
        ((s.next = c.next), (c.next = h));
      }
      ((e.baseQueue = s = c), (i.pending = null));
    }
    if (((c = t.baseState), s === null)) t.memoizedState = c;
    else {
      e = s.next;
      var S = (h = null),
        A = null,
        N = e,
        Q = !1;
      do {
        var K = N.lane & -536870913;
        if (K !== N.lane ? (Et & K) === K : (xn & K) === K) {
          var B = N.revertLane;
          if (B === 0)
            (A !== null &&
              (A = A.next =
                {
                  lane: 0,
                  revertLane: 0,
                  gesture: null,
                  action: N.action,
                  hasEagerState: N.hasEagerState,
                  eagerState: N.eagerState,
                  next: null,
                }),
              K === Ll && (Q = !0));
          else if ((xn & B) === B) {
            ((N = N.next), B === Ll && (Q = !0));
            continue;
          } else
            ((K = {
              lane: 0,
              revertLane: N.revertLane,
              gesture: null,
              action: N.action,
              hasEagerState: N.hasEagerState,
              eagerState: N.eagerState,
              next: null,
            }),
              A === null ? ((S = A = K), (h = c)) : (A = A.next = K),
              (gt.lanes |= B),
              (la |= B));
          ((K = N.action), Pa && a(c, K), (c = N.hasEagerState ? N.eagerState : a(c, K)));
        } else
          ((B = {
            lane: K,
            revertLane: N.revertLane,
            gesture: N.gesture,
            action: N.action,
            hasEagerState: N.hasEagerState,
            eagerState: N.eagerState,
            next: null,
          }),
            A === null ? ((S = A = B), (h = c)) : (A = A.next = B),
            (gt.lanes |= K),
            (la |= K));
        N = N.next;
      } while (N !== null && N !== e);
      if (
        (A === null ? (h = c) : (A.next = S),
        !Ue(c, t.memoizedState) && (($t = !0), Q && ((a = Nl), a !== null)))
      )
        throw a;
      ((t.memoizedState = c), (t.baseState = h), (t.baseQueue = A), (i.lastRenderedState = c));
    }
    return (s === null && (i.lanes = 0), [t.memoizedState, i.dispatch]);
  }
  function Dc(t) {
    var e = Ft(),
      a = e.queue;
    if (a === null) throw Error(r(311));
    a.lastRenderedReducer = t;
    var i = a.dispatch,
      s = a.pending,
      c = e.memoizedState;
    if (s !== null) {
      a.pending = null;
      var h = (s = s.next);
      do ((c = t(c, h.action)), (h = h.next));
      while (h !== s);
      (Ue(c, e.memoizedState) || ($t = !0),
        (e.memoizedState = c),
        e.baseQueue === null && (e.baseState = c),
        (a.lastRenderedState = c));
    }
    return [c, i];
  }
  function ih(t, e, a) {
    var i = gt,
      s = Ft(),
      c = Tt;
    if (c) {
      if (a === void 0) throw Error(r(407));
      a = a();
    } else a = e();
    var h = !Ue((Lt || s).memoizedState, a);
    if (
      (h && ((s.memoizedState = a), ($t = !0)),
      (s = s.queue),
      Nc(sh.bind(null, i, s, t), [t]),
      s.getSnapshot !== e || h || (It !== null && It.memoizedState.tag & 1))
    ) {
      if (
        ((i.flags |= 2048),
        Ql(9, { destroy: void 0 }, rh.bind(null, i, s, a, e), null),
        Ht === null)
      )
        throw Error(r(349));
      c || (xn & 127) !== 0 || uh(i, e, a);
    }
    return a;
  }
  function uh(t, e, a) {
    ((t.flags |= 16384),
      (t = { getSnapshot: e, value: a }),
      (e = gt.updateQueue),
      e === null
        ? ((e = gr()), (gt.updateQueue = e), (e.stores = [t]))
        : ((a = e.stores), a === null ? (e.stores = [t]) : a.push(t)));
  }
  function rh(t, e, a, i) {
    ((e.value = a), (e.getSnapshot = i), ch(e) && oh(t));
  }
  function sh(t, e, a) {
    return a(function () {
      ch(e) && oh(t);
    });
  }
  function ch(t) {
    var e = t.getSnapshot;
    t = t.value;
    try {
      var a = e();
      return !Ue(t, a);
    } catch {
      return !0;
    }
  }
  function oh(t) {
    var e = Ha(t, 2);
    e !== null && we(e, t, 2);
  }
  function Uc(t) {
    var e = Se();
    if (typeof t == "function") {
      var a = t;
      if (((t = a()), Pa)) {
        Xn(!0);
        try {
          a();
        } finally {
          Xn(!1);
        }
      }
    }
    return (
      (e.memoizedState = e.baseState = t),
      (e.queue = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Mn,
        lastRenderedState: t,
      }),
      e
    );
  }
  function fh(t, e, a, i) {
    return ((t.baseState = a), zc(t, Lt, typeof i == "function" ? i : Mn));
  }
  function U0(t, e, a, i, s) {
    if (Er(t)) throw Error(r(485));
    if (((t = e.action), t !== null)) {
      var c = {
        payload: s,
        action: t,
        next: null,
        isTransition: !0,
        status: "pending",
        value: null,
        reason: null,
        listeners: [],
        then: function (h) {
          c.listeners.push(h);
        },
      };
      (j.T !== null ? a(!0) : (c.isTransition = !1),
        i(c),
        (a = e.pending),
        a === null
          ? ((c.next = e.pending = c), dh(e, c))
          : ((c.next = a.next), (e.pending = a.next = c)));
    }
  }
  function dh(t, e) {
    var a = e.action,
      i = e.payload,
      s = t.state;
    if (e.isTransition) {
      var c = j.T,
        h = {};
      j.T = h;
      try {
        var S = a(s, i),
          A = j.S;
        (A !== null && A(h, S), hh(t, e, S));
      } catch (N) {
        Lc(t, e, N);
      } finally {
        (c !== null && h.types !== null && (c.types = h.types), (j.T = c));
      }
    } else
      try {
        ((c = a(s, i)), hh(t, e, c));
      } catch (N) {
        Lc(t, e, N);
      }
  }
  function hh(t, e, a) {
    a !== null && typeof a == "object" && typeof a.then == "function"
      ? a.then(
          function (i) {
            mh(t, e, i);
          },
          function (i) {
            return Lc(t, e, i);
          },
        )
      : mh(t, e, a);
  }
  function mh(t, e, a) {
    ((e.status = "fulfilled"),
      (e.value = a),
      yh(e),
      (t.state = a),
      (e = t.pending),
      e !== null &&
        ((a = e.next), a === e ? (t.pending = null) : ((a = a.next), (e.next = a), dh(t, a))));
  }
  function Lc(t, e, a) {
    var i = t.pending;
    if (((t.pending = null), i !== null)) {
      i = i.next;
      do ((e.status = "rejected"), (e.reason = a), yh(e), (e = e.next));
      while (e !== i);
    }
    t.action = null;
  }
  function yh(t) {
    t = t.listeners;
    for (var e = 0; e < t.length; e++) (0, t[e])();
  }
  function vh(t, e) {
    return e;
  }
  function gh(t, e) {
    if (Tt) {
      var a = Ht.formState;
      if (a !== null) {
        t: {
          var i = gt;
          if (Tt) {
            if (Qt) {
              e: {
                for (var s = Qt, c = Pe; s.nodeType !== 8; ) {
                  if (!c) {
                    s = null;
                    break e;
                  }
                  if (((s = Fe(s.nextSibling)), s === null)) {
                    s = null;
                    break e;
                  }
                }
                ((c = s.data), (s = c === "F!" || c === "F" ? s : null));
              }
              if (s) {
                ((Qt = Fe(s.nextSibling)), (i = s.data === "F!"));
                break t;
              }
            }
            Fn(i);
          }
          i = !1;
        }
        i && (e = a[0]);
      }
    }
    return (
      (a = Se()),
      (a.memoizedState = a.baseState = e),
      (i = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: vh,
        lastRenderedState: e,
      }),
      (a.queue = i),
      (a = jh.bind(null, gt, i)),
      (i.dispatch = a),
      (i = Uc(!1)),
      (c = Yc.bind(null, gt, !1, i.queue)),
      (i = Se()),
      (s = { state: e, dispatch: null, action: t, pending: null }),
      (i.queue = s),
      (a = U0.bind(null, gt, s, c, a)),
      (s.dispatch = a),
      (i.memoizedState = t),
      [e, a, !1]
    );
  }
  function ph(t) {
    var e = Ft();
    return Sh(e, Lt, t);
  }
  function Sh(t, e, a) {
    if (
      ((e = zc(t, e, vh)[0]),
      (t = Sr(Mn)[0]),
      typeof e == "object" && e !== null && typeof e.then == "function")
    )
      try {
        var i = Vi(e);
      } catch (h) {
        throw h === jl ? cr : h;
      }
    else i = e;
    e = Ft();
    var s = e.queue,
      c = s.dispatch;
    return (
      a !== e.memoizedState &&
        ((gt.flags |= 2048), Ql(9, { destroy: void 0 }, L0.bind(null, s, a), null)),
      [i, c, t]
    );
  }
  function L0(t, e) {
    t.action = e;
  }
  function bh(t) {
    var e = Ft(),
      a = Lt;
    if (a !== null) return Sh(e, a, t);
    (Ft(), (e = e.memoizedState), (a = Ft()));
    var i = a.queue.dispatch;
    return ((a.memoizedState = t), [e, i, !1]);
  }
  function Ql(t, e, a, i) {
    return (
      (t = { tag: t, create: a, deps: i, inst: e, next: null }),
      (e = gt.updateQueue),
      e === null && ((e = gr()), (gt.updateQueue = e)),
      (a = e.lastEffect),
      a === null
        ? (e.lastEffect = t.next = t)
        : ((i = a.next), (a.next = t), (t.next = i), (e.lastEffect = t)),
      t
    );
  }
  function _h() {
    return Ft().memoizedState;
  }
  function br(t, e, a, i) {
    var s = Se();
    ((gt.flags |= t),
      (s.memoizedState = Ql(1 | e, { destroy: void 0 }, a, i === void 0 ? null : i)));
  }
  function _r(t, e, a, i) {
    var s = Ft();
    i = i === void 0 ? null : i;
    var c = s.memoizedState.inst;
    Lt !== null && i !== null && Ac(i, Lt.memoizedState.deps)
      ? (s.memoizedState = Ql(e, c, a, i))
      : ((gt.flags |= t), (s.memoizedState = Ql(1 | e, c, a, i)));
  }
  function Eh(t, e) {
    br(8390656, 8, t, e);
  }
  function Nc(t, e) {
    _r(2048, 8, t, e);
  }
  function N0(t) {
    gt.flags |= 4;
    var e = gt.updateQueue;
    if (e === null) ((e = gr()), (gt.updateQueue = e), (e.events = [t]));
    else {
      var a = e.events;
      a === null ? (e.events = [t]) : a.push(t);
    }
  }
  function Rh(t) {
    var e = Ft().memoizedState;
    return (
      N0({ ref: e, nextImpl: t }),
      function () {
        if ((Ct & 2) !== 0) throw Error(r(440));
        return e.impl.apply(void 0, arguments);
      }
    );
  }
  function Th(t, e) {
    return _r(4, 2, t, e);
  }
  function Ah(t, e) {
    return _r(4, 4, t, e);
  }
  function xh(t, e) {
    if (typeof e == "function") {
      t = t();
      var a = e(t);
      return function () {
        typeof a == "function" ? a() : e(null);
      };
    }
    if (e != null)
      return (
        (t = t()),
        (e.current = t),
        function () {
          e.current = null;
        }
      );
  }
  function Mh(t, e, a) {
    ((a = a != null ? a.concat([t]) : null), _r(4, 4, xh.bind(null, e, t), a));
  }
  function jc() {}
  function wh(t, e) {
    var a = Ft();
    e = e === void 0 ? null : e;
    var i = a.memoizedState;
    return e !== null && Ac(e, i[1]) ? i[0] : ((a.memoizedState = [t, e]), t);
  }
  function Oh(t, e) {
    var a = Ft();
    e = e === void 0 ? null : e;
    var i = a.memoizedState;
    if (e !== null && Ac(e, i[1])) return i[0];
    if (((i = t()), Pa)) {
      Xn(!0);
      try {
        t();
      } finally {
        Xn(!1);
      }
    }
    return ((a.memoizedState = [i, e]), i);
  }
  function Bc(t, e, a) {
    return a === void 0 || ((xn & 1073741824) !== 0 && (Et & 261930) === 0)
      ? (t.memoizedState = e)
      : ((t.memoizedState = a), (t = Cm()), (gt.lanes |= t), (la |= t), a);
  }
  function Ch(t, e, a, i) {
    return Ue(a, e)
      ? a
      : Hl.current !== null
        ? ((t = Bc(t, a, i)), Ue(t, e) || ($t = !0), t)
        : (xn & 42) === 0 || ((xn & 1073741824) !== 0 && (Et & 261930) === 0)
          ? (($t = !0), (t.memoizedState = a))
          : ((t = Cm()), (gt.lanes |= t), (la |= t), e);
  }
  function zh(t, e, a, i, s) {
    var c = P.p;
    P.p = c !== 0 && 8 > c ? c : 8;
    var h = j.T,
      S = {};
    ((j.T = S), Yc(t, !1, e, a));
    try {
      var A = s(),
        N = j.S;
      if (
        (N !== null && N(S, A), A !== null && typeof A == "object" && typeof A.then == "function")
      ) {
        var Q = C0(A, i);
        Xi(t, e, Q, qe(t));
      } else Xi(t, e, i, qe(t));
    } catch (K) {
      Xi(t, e, { then: function () {}, status: "rejected", reason: K }, qe());
    } finally {
      ((P.p = c), h !== null && S.types !== null && (h.types = S.types), (j.T = h));
    }
  }
  function j0() {}
  function Hc(t, e, a, i) {
    if (t.tag !== 5) throw Error(r(476));
    var s = Dh(t).queue;
    zh(
      t,
      s,
      e,
      nt,
      a === null
        ? j0
        : function () {
            return (Uh(t), a(i));
          },
    );
  }
  function Dh(t) {
    var e = t.memoizedState;
    if (e !== null) return e;
    e = {
      memoizedState: nt,
      baseState: nt,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Mn,
        lastRenderedState: nt,
      },
      next: null,
    };
    var a = {};
    return (
      (e.next = {
        memoizedState: a,
        baseState: a,
        baseQueue: null,
        queue: {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: Mn,
          lastRenderedState: a,
        },
        next: null,
      }),
      (t.memoizedState = e),
      (t = t.alternate),
      t !== null && (t.memoizedState = e),
      e
    );
  }
  function Uh(t) {
    var e = Dh(t);
    (e.next === null && (e = t.alternate.memoizedState), Xi(t, e.next.queue, {}, qe()));
  }
  function qc() {
    return fe(ru);
  }
  function Lh() {
    return Ft().memoizedState;
  }
  function Nh() {
    return Ft().memoizedState;
  }
  function B0(t) {
    for (var e = t.return; e !== null; ) {
      switch (e.tag) {
        case 24:
        case 3:
          var a = qe();
          t = $n(a);
          var i = Wn(e, t, a);
          (i !== null && (we(i, e, a), qi(i, e, a)), (e = { cache: mc() }), (t.payload = e));
          return;
      }
      e = e.return;
    }
  }
  function H0(t, e, a) {
    var i = qe();
    ((a = {
      lane: i,
      revertLane: 0,
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null,
    }),
      Er(t) ? Bh(e, a) : ((a = ac(t, e, a, i)), a !== null && (we(a, t, i), Hh(a, e, i))));
  }
  function jh(t, e, a) {
    var i = qe();
    Xi(t, e, a, i);
  }
  function Xi(t, e, a, i) {
    var s = {
      lane: i,
      revertLane: 0,
      gesture: null,
      action: a,
      hasEagerState: !1,
      eagerState: null,
      next: null,
    };
    if (Er(t)) Bh(e, s);
    else {
      var c = t.alternate;
      if (
        t.lanes === 0 &&
        (c === null || c.lanes === 0) &&
        ((c = e.lastRenderedReducer), c !== null)
      )
        try {
          var h = e.lastRenderedState,
            S = c(h, a);
          if (((s.hasEagerState = !0), (s.eagerState = S), Ue(S, h)))
            return (nr(t, e, s, 0), Ht === null && er(), !1);
        } catch {
        } finally {
        }
      if (((a = ac(t, e, s, i)), a !== null)) return (we(a, t, i), Hh(a, e, i), !0);
    }
    return !1;
  }
  function Yc(t, e, a, i) {
    if (
      ((i = {
        lane: 2,
        revertLane: So(),
        gesture: null,
        action: i,
        hasEagerState: !1,
        eagerState: null,
        next: null,
      }),
      Er(t))
    ) {
      if (e) throw Error(r(479));
    } else ((e = ac(t, a, i, 2)), e !== null && we(e, t, 2));
  }
  function Er(t) {
    var e = t.alternate;
    return t === gt || (e !== null && e === gt);
  }
  function Bh(t, e) {
    ql = yr = !0;
    var a = t.pending;
    (a === null ? (e.next = e) : ((e.next = a.next), (a.next = e)), (t.pending = e));
  }
  function Hh(t, e, a) {
    if ((a & 4194048) !== 0) {
      var i = e.lanes;
      ((i &= t.pendingLanes), (a |= i), (e.lanes = a), Vf(t, a));
    }
  }
  var Zi = {
    readContext: fe,
    use: pr,
    useCallback: Zt,
    useContext: Zt,
    useEffect: Zt,
    useImperativeHandle: Zt,
    useLayoutEffect: Zt,
    useInsertionEffect: Zt,
    useMemo: Zt,
    useReducer: Zt,
    useRef: Zt,
    useState: Zt,
    useDebugValue: Zt,
    useDeferredValue: Zt,
    useTransition: Zt,
    useSyncExternalStore: Zt,
    useId: Zt,
    useHostTransitionStatus: Zt,
    useFormState: Zt,
    useActionState: Zt,
    useOptimistic: Zt,
    useMemoCache: Zt,
    useCacheRefresh: Zt,
  };
  Zi.useEffectEvent = Zt;
  var qh = {
      readContext: fe,
      use: pr,
      useCallback: function (t, e) {
        return ((Se().memoizedState = [t, e === void 0 ? null : e]), t);
      },
      useContext: fe,
      useEffect: Eh,
      useImperativeHandle: function (t, e, a) {
        ((a = a != null ? a.concat([t]) : null), br(4194308, 4, xh.bind(null, e, t), a));
      },
      useLayoutEffect: function (t, e) {
        return br(4194308, 4, t, e);
      },
      useInsertionEffect: function (t, e) {
        br(4, 2, t, e);
      },
      useMemo: function (t, e) {
        var a = Se();
        e = e === void 0 ? null : e;
        var i = t();
        if (Pa) {
          Xn(!0);
          try {
            t();
          } finally {
            Xn(!1);
          }
        }
        return ((a.memoizedState = [i, e]), i);
      },
      useReducer: function (t, e, a) {
        var i = Se();
        if (a !== void 0) {
          var s = a(e);
          if (Pa) {
            Xn(!0);
            try {
              a(e);
            } finally {
              Xn(!1);
            }
          }
        } else s = e;
        return (
          (i.memoizedState = i.baseState = s),
          (t = {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: t,
            lastRenderedState: s,
          }),
          (i.queue = t),
          (t = t.dispatch = H0.bind(null, gt, t)),
          [i.memoizedState, t]
        );
      },
      useRef: function (t) {
        var e = Se();
        return ((t = { current: t }), (e.memoizedState = t));
      },
      useState: function (t) {
        t = Uc(t);
        var e = t.queue,
          a = jh.bind(null, gt, e);
        return ((e.dispatch = a), [t.memoizedState, a]);
      },
      useDebugValue: jc,
      useDeferredValue: function (t, e) {
        var a = Se();
        return Bc(a, t, e);
      },
      useTransition: function () {
        var t = Uc(!1);
        return ((t = zh.bind(null, gt, t.queue, !0, !1)), (Se().memoizedState = t), [!1, t]);
      },
      useSyncExternalStore: function (t, e, a) {
        var i = gt,
          s = Se();
        if (Tt) {
          if (a === void 0) throw Error(r(407));
          a = a();
        } else {
          if (((a = e()), Ht === null)) throw Error(r(349));
          (Et & 127) !== 0 || uh(i, e, a);
        }
        s.memoizedState = a;
        var c = { value: a, getSnapshot: e };
        return (
          (s.queue = c),
          Eh(sh.bind(null, i, c, t), [t]),
          (i.flags |= 2048),
          Ql(9, { destroy: void 0 }, rh.bind(null, i, c, a, e), null),
          a
        );
      },
      useId: function () {
        var t = Se(),
          e = Ht.identifierPrefix;
        if (Tt) {
          var a = sn,
            i = rn;
          ((a = (i & ~(1 << (32 - De(i) - 1))).toString(32) + a),
            (e = "_" + e + "R_" + a),
            (a = vr++),
            0 < a && (e += "H" + a.toString(32)),
            (e += "_"));
        } else ((a = z0++), (e = "_" + e + "r_" + a.toString(32) + "_"));
        return (t.memoizedState = e);
      },
      useHostTransitionStatus: qc,
      useFormState: gh,
      useActionState: gh,
      useOptimistic: function (t) {
        var e = Se();
        e.memoizedState = e.baseState = t;
        var a = {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: null,
          lastRenderedState: null,
        };
        return ((e.queue = a), (e = Yc.bind(null, gt, !0, a)), (a.dispatch = e), [t, e]);
      },
      useMemoCache: Cc,
      useCacheRefresh: function () {
        return (Se().memoizedState = B0.bind(null, gt));
      },
      useEffectEvent: function (t) {
        var e = Se(),
          a = { impl: t };
        return (
          (e.memoizedState = a),
          function () {
            if ((Ct & 2) !== 0) throw Error(r(440));
            return a.impl.apply(void 0, arguments);
          }
        );
      },
    },
    Qc = {
      readContext: fe,
      use: pr,
      useCallback: wh,
      useContext: fe,
      useEffect: Nc,
      useImperativeHandle: Mh,
      useInsertionEffect: Th,
      useLayoutEffect: Ah,
      useMemo: Oh,
      useReducer: Sr,
      useRef: _h,
      useState: function () {
        return Sr(Mn);
      },
      useDebugValue: jc,
      useDeferredValue: function (t, e) {
        var a = Ft();
        return Ch(a, Lt.memoizedState, t, e);
      },
      useTransition: function () {
        var t = Sr(Mn)[0],
          e = Ft().memoizedState;
        return [typeof t == "boolean" ? t : Vi(t), e];
      },
      useSyncExternalStore: ih,
      useId: Lh,
      useHostTransitionStatus: qc,
      useFormState: ph,
      useActionState: ph,
      useOptimistic: function (t, e) {
        var a = Ft();
        return fh(a, Lt, t, e);
      },
      useMemoCache: Cc,
      useCacheRefresh: Nh,
    };
  Qc.useEffectEvent = Rh;
  var Yh = {
    readContext: fe,
    use: pr,
    useCallback: wh,
    useContext: fe,
    useEffect: Nc,
    useImperativeHandle: Mh,
    useInsertionEffect: Th,
    useLayoutEffect: Ah,
    useMemo: Oh,
    useReducer: Dc,
    useRef: _h,
    useState: function () {
      return Dc(Mn);
    },
    useDebugValue: jc,
    useDeferredValue: function (t, e) {
      var a = Ft();
      return Lt === null ? Bc(a, t, e) : Ch(a, Lt.memoizedState, t, e);
    },
    useTransition: function () {
      var t = Dc(Mn)[0],
        e = Ft().memoizedState;
      return [typeof t == "boolean" ? t : Vi(t), e];
    },
    useSyncExternalStore: ih,
    useId: Lh,
    useHostTransitionStatus: qc,
    useFormState: bh,
    useActionState: bh,
    useOptimistic: function (t, e) {
      var a = Ft();
      return Lt !== null ? fh(a, Lt, t, e) : ((a.baseState = t), [t, a.queue.dispatch]);
    },
    useMemoCache: Cc,
    useCacheRefresh: Nh,
  };
  Yh.useEffectEvent = Rh;
  function Gc(t, e, a, i) {
    ((e = t.memoizedState),
      (a = a(i, e)),
      (a = a == null ? e : g({}, e, a)),
      (t.memoizedState = a),
      t.lanes === 0 && (t.updateQueue.baseState = a));
  }
  var Vc = {
    enqueueSetState: function (t, e, a) {
      t = t._reactInternals;
      var i = qe(),
        s = $n(i);
      ((s.payload = e),
        a != null && (s.callback = a),
        (e = Wn(t, s, i)),
        e !== null && (we(e, t, i), qi(e, t, i)));
    },
    enqueueReplaceState: function (t, e, a) {
      t = t._reactInternals;
      var i = qe(),
        s = $n(i);
      ((s.tag = 1),
        (s.payload = e),
        a != null && (s.callback = a),
        (e = Wn(t, s, i)),
        e !== null && (we(e, t, i), qi(e, t, i)));
    },
    enqueueForceUpdate: function (t, e) {
      t = t._reactInternals;
      var a = qe(),
        i = $n(a);
      ((i.tag = 2),
        e != null && (i.callback = e),
        (e = Wn(t, i, a)),
        e !== null && (we(e, t, a), qi(e, t, a)));
    },
  };
  function Qh(t, e, a, i, s, c, h) {
    return (
      (t = t.stateNode),
      typeof t.shouldComponentUpdate == "function"
        ? t.shouldComponentUpdate(i, c, h)
        : e.prototype && e.prototype.isPureReactComponent
          ? !zi(a, i) || !zi(s, c)
          : !0
    );
  }
  function Gh(t, e, a, i) {
    ((t = e.state),
      typeof e.componentWillReceiveProps == "function" && e.componentWillReceiveProps(a, i),
      typeof e.UNSAFE_componentWillReceiveProps == "function" &&
        e.UNSAFE_componentWillReceiveProps(a, i),
      e.state !== t && Vc.enqueueReplaceState(e, e.state, null));
  }
  function Ja(t, e) {
    var a = e;
    if ("ref" in e) {
      a = {};
      for (var i in e) i !== "ref" && (a[i] = e[i]);
    }
    if ((t = t.defaultProps)) {
      a === e && (a = g({}, a));
      for (var s in t) a[s] === void 0 && (a[s] = t[s]);
    }
    return a;
  }
  function Vh(t) {
    tr(t);
  }
  function Xh(t) {
    console.error(t);
  }
  function Zh(t) {
    tr(t);
  }
  function Rr(t, e) {
    try {
      var a = t.onUncaughtError;
      a(e.value, { componentStack: e.stack });
    } catch (i) {
      setTimeout(function () {
        throw i;
      });
    }
  }
  function Kh(t, e, a) {
    try {
      var i = t.onCaughtError;
      i(a.value, { componentStack: a.stack, errorBoundary: e.tag === 1 ? e.stateNode : null });
    } catch (s) {
      setTimeout(function () {
        throw s;
      });
    }
  }
  function Xc(t, e, a) {
    return (
      (a = $n(a)),
      (a.tag = 3),
      (a.payload = { element: null }),
      (a.callback = function () {
        Rr(t, e);
      }),
      a
    );
  }
  function Ph(t) {
    return ((t = $n(t)), (t.tag = 3), t);
  }
  function Jh(t, e, a, i) {
    var s = a.type.getDerivedStateFromError;
    if (typeof s == "function") {
      var c = i.value;
      ((t.payload = function () {
        return s(c);
      }),
        (t.callback = function () {
          Kh(e, a, i);
        }));
    }
    var h = a.stateNode;
    h !== null &&
      typeof h.componentDidCatch == "function" &&
      (t.callback = function () {
        (Kh(e, a, i),
          typeof s != "function" && (ia === null ? (ia = new Set([this])) : ia.add(this)));
        var S = i.stack;
        this.componentDidCatch(i.value, { componentStack: S !== null ? S : "" });
      });
  }
  function q0(t, e, a, i, s) {
    if (((a.flags |= 32768), i !== null && typeof i == "object" && typeof i.then == "function")) {
      if (((e = a.alternate), e !== null && Ul(e, a, s, !0), (a = Ne.current), a !== null)) {
        switch (a.tag) {
          case 31:
          case 13:
            return (
              Je === null ? Nr() : a.alternate === null && Kt === 0 && (Kt = 3),
              (a.flags &= -257),
              (a.flags |= 65536),
              (a.lanes = s),
              i === or
                ? (a.flags |= 16384)
                : ((e = a.updateQueue),
                  e === null ? (a.updateQueue = new Set([i])) : e.add(i),
                  vo(t, i, s)),
              !1
            );
          case 22:
            return (
              (a.flags |= 65536),
              i === or
                ? (a.flags |= 16384)
                : ((e = a.updateQueue),
                  e === null
                    ? ((e = { transitions: null, markerInstances: null, retryQueue: new Set([i]) }),
                      (a.updateQueue = e))
                    : ((a = e.retryQueue), a === null ? (e.retryQueue = new Set([i])) : a.add(i)),
                  vo(t, i, s)),
              !1
            );
        }
        throw Error(r(435, a.tag));
      }
      return (vo(t, i, s), Nr(), !1);
    }
    if (Tt)
      return (
        (e = Ne.current),
        e !== null
          ? ((e.flags & 65536) === 0 && (e.flags |= 256),
            (e.flags |= 65536),
            (e.lanes = s),
            i !== cc && ((t = Error(r(422), { cause: i })), Li(Xe(t, a))))
          : (i !== cc && ((e = Error(r(423), { cause: i })), Li(Xe(e, a))),
            (t = t.current.alternate),
            (t.flags |= 65536),
            (s &= -s),
            (t.lanes |= s),
            (i = Xe(i, a)),
            (s = Xc(t.stateNode, i, s)),
            bc(t, s),
            Kt !== 4 && (Kt = 2)),
        !1
      );
    var c = Error(r(520), { cause: i });
    if (((c = Xe(c, a)), Wi === null ? (Wi = [c]) : Wi.push(c), Kt !== 4 && (Kt = 2), e === null))
      return !0;
    ((i = Xe(i, a)), (a = e));
    do {
      switch (a.tag) {
        case 3:
          return (
            (a.flags |= 65536),
            (t = s & -s),
            (a.lanes |= t),
            (t = Xc(a.stateNode, i, t)),
            bc(a, t),
            !1
          );
        case 1:
          if (
            ((e = a.type),
            (c = a.stateNode),
            (a.flags & 128) === 0 &&
              (typeof e.getDerivedStateFromError == "function" ||
                (c !== null &&
                  typeof c.componentDidCatch == "function" &&
                  (ia === null || !ia.has(c)))))
          )
            return (
              (a.flags |= 65536),
              (s &= -s),
              (a.lanes |= s),
              (s = Ph(s)),
              Jh(s, t, a, i),
              bc(a, s),
              !1
            );
      }
      a = a.return;
    } while (a !== null);
    return !1;
  }
  var Zc = Error(r(461)),
    $t = !1;
  function de(t, e, a, i) {
    e.child = t === null ? $d(e, null, a, i) : Ka(e, t.child, a, i);
  }
  function Fh(t, e, a, i, s) {
    a = a.render;
    var c = e.ref;
    if ("ref" in i) {
      var h = {};
      for (var S in i) S !== "ref" && (h[S] = i[S]);
    } else h = i;
    return (
      Ga(e),
      (i = xc(t, e, a, h, c, s)),
      (S = Mc()),
      t !== null && !$t
        ? (wc(t, e, s), wn(t, e, s))
        : (Tt && S && rc(e), (e.flags |= 1), de(t, e, i, s), e.child)
    );
  }
  function kh(t, e, a, i, s) {
    if (t === null) {
      var c = a.type;
      return typeof c == "function" && !lc(c) && c.defaultProps === void 0 && a.compare === null
        ? ((e.tag = 15), (e.type = c), Ih(t, e, c, i, s))
        : ((t = lr(a.type, null, i, e, e.mode, s)), (t.ref = e.ref), (t.return = e), (e.child = t));
    }
    if (((c = t.child), !Wc(t, s))) {
      var h = c.memoizedProps;
      if (((a = a.compare), (a = a !== null ? a : zi), a(h, i) && t.ref === e.ref))
        return wn(t, e, s);
    }
    return ((e.flags |= 1), (t = En(c, i)), (t.ref = e.ref), (t.return = e), (e.child = t));
  }
  function Ih(t, e, a, i, s) {
    if (t !== null) {
      var c = t.memoizedProps;
      if (zi(c, i) && t.ref === e.ref)
        if ((($t = !1), (e.pendingProps = i = c), Wc(t, s))) (t.flags & 131072) !== 0 && ($t = !0);
        else return ((e.lanes = t.lanes), wn(t, e, s));
    }
    return Kc(t, e, a, i, s);
  }
  function $h(t, e, a, i) {
    var s = i.children,
      c = t !== null ? t.memoizedState : null;
    if (
      (t === null &&
        e.stateNode === null &&
        (e.stateNode = {
          _visibility: 1,
          _pendingMarkers: null,
          _retryCache: null,
          _transitions: null,
        }),
      i.mode === "hidden")
    ) {
      if ((e.flags & 128) !== 0) {
        if (((c = c !== null ? c.baseLanes | a : a), t !== null)) {
          for (i = e.child = t.child, s = 0; i !== null; )
            ((s = s | i.lanes | i.childLanes), (i = i.sibling));
          i = s & ~c;
        } else ((i = 0), (e.child = null));
        return Wh(t, e, c, a, i);
      }
      if ((a & 536870912) !== 0)
        ((e.memoizedState = { baseLanes: 0, cachePool: null }),
          t !== null && sr(e, c !== null ? c.cachePool : null),
          c !== null ? eh(e, c) : Ec(),
          nh(e));
      else return ((i = e.lanes = 536870912), Wh(t, e, c !== null ? c.baseLanes | a : a, a, i));
    } else
      c !== null
        ? (sr(e, c.cachePool), eh(e, c), ea(), (e.memoizedState = null))
        : (t !== null && sr(e, null), Ec(), ea());
    return (de(t, e, s, a), e.child);
  }
  function Ki(t, e) {
    return (
      (t !== null && t.tag === 22) ||
        e.stateNode !== null ||
        (e.stateNode = {
          _visibility: 1,
          _pendingMarkers: null,
          _retryCache: null,
          _transitions: null,
        }),
      e.sibling
    );
  }
  function Wh(t, e, a, i, s) {
    var c = vc();
    return (
      (c = c === null ? null : { parent: kt._currentValue, pool: c }),
      (e.memoizedState = { baseLanes: a, cachePool: c }),
      t !== null && sr(e, null),
      Ec(),
      nh(e),
      t !== null && Ul(t, e, i, !0),
      (e.childLanes = s),
      null
    );
  }
  function Tr(t, e) {
    return (
      (e = xr({ mode: e.mode, children: e.children }, t.mode)),
      (e.ref = t.ref),
      (t.child = e),
      (e.return = t),
      e
    );
  }
  function tm(t, e, a) {
    return (
      Ka(e, t.child, null, a),
      (t = Tr(e, e.pendingProps)),
      (t.flags |= 2),
      je(e),
      (e.memoizedState = null),
      t
    );
  }
  function Y0(t, e, a) {
    var i = e.pendingProps,
      s = (e.flags & 128) !== 0;
    if (((e.flags &= -129), t === null)) {
      if (Tt) {
        if (i.mode === "hidden") return ((t = Tr(e, i)), (e.lanes = 536870912), Ki(null, t));
        if (
          (Tc(e),
          (t = Qt)
            ? ((t = dy(t, Pe)),
              (t = t !== null && t.data === "&" ? t : null),
              t !== null &&
                ((e.memoizedState = {
                  dehydrated: t,
                  treeContext: Pn !== null ? { id: rn, overflow: sn } : null,
                  retryLane: 536870912,
                  hydrationErrors: null,
                }),
                (a = Bd(t)),
                (a.return = e),
                (e.child = a),
                (oe = e),
                (Qt = null)))
            : (t = null),
          t === null)
        )
          throw Fn(e);
        return ((e.lanes = 536870912), null);
      }
      return Tr(e, i);
    }
    var c = t.memoizedState;
    if (c !== null) {
      var h = c.dehydrated;
      if ((Tc(e), s))
        if (e.flags & 256) ((e.flags &= -257), (e = tm(t, e, a)));
        else if (e.memoizedState !== null) ((e.child = t.child), (e.flags |= 128), (e = null));
        else throw Error(r(558));
      else if (($t || Ul(t, e, a, !1), (s = (a & t.childLanes) !== 0), $t || s)) {
        if (((i = Ht), i !== null && ((h = Xf(i, a)), h !== 0 && h !== c.retryLane)))
          throw ((c.retryLane = h), Ha(t, h), we(i, t, h), Zc);
        (Nr(), (e = tm(t, e, a)));
      } else
        ((t = c.treeContext),
          (Qt = Fe(h.nextSibling)),
          (oe = e),
          (Tt = !0),
          (Jn = null),
          (Pe = !1),
          t !== null && Yd(e, t),
          (e = Tr(e, i)),
          (e.flags |= 4096));
      return e;
    }
    return (
      (t = En(t.child, { mode: i.mode, children: i.children })),
      (t.ref = e.ref),
      (e.child = t),
      (t.return = e),
      t
    );
  }
  function Ar(t, e) {
    var a = e.ref;
    if (a === null) t !== null && t.ref !== null && (e.flags |= 4194816);
    else {
      if (typeof a != "function" && typeof a != "object") throw Error(r(284));
      (t === null || t.ref !== a) && (e.flags |= 4194816);
    }
  }
  function Kc(t, e, a, i, s) {
    return (
      Ga(e),
      (a = xc(t, e, a, i, void 0, s)),
      (i = Mc()),
      t !== null && !$t
        ? (wc(t, e, s), wn(t, e, s))
        : (Tt && i && rc(e), (e.flags |= 1), de(t, e, a, s), e.child)
    );
  }
  function em(t, e, a, i, s, c) {
    return (
      Ga(e),
      (e.updateQueue = null),
      (a = lh(e, i, a, s)),
      ah(t),
      (i = Mc()),
      t !== null && !$t
        ? (wc(t, e, c), wn(t, e, c))
        : (Tt && i && rc(e), (e.flags |= 1), de(t, e, a, c), e.child)
    );
  }
  function nm(t, e, a, i, s) {
    if ((Ga(e), e.stateNode === null)) {
      var c = Ol,
        h = a.contextType;
      (typeof h == "object" && h !== null && (c = fe(h)),
        (c = new a(i, c)),
        (e.memoizedState = c.state !== null && c.state !== void 0 ? c.state : null),
        (c.updater = Vc),
        (e.stateNode = c),
        (c._reactInternals = e),
        (c = e.stateNode),
        (c.props = i),
        (c.state = e.memoizedState),
        (c.refs = {}),
        pc(e),
        (h = a.contextType),
        (c.context = typeof h == "object" && h !== null ? fe(h) : Ol),
        (c.state = e.memoizedState),
        (h = a.getDerivedStateFromProps),
        typeof h == "function" && (Gc(e, a, h, i), (c.state = e.memoizedState)),
        typeof a.getDerivedStateFromProps == "function" ||
          typeof c.getSnapshotBeforeUpdate == "function" ||
          (typeof c.UNSAFE_componentWillMount != "function" &&
            typeof c.componentWillMount != "function") ||
          ((h = c.state),
          typeof c.componentWillMount == "function" && c.componentWillMount(),
          typeof c.UNSAFE_componentWillMount == "function" && c.UNSAFE_componentWillMount(),
          h !== c.state && Vc.enqueueReplaceState(c, c.state, null),
          Qi(e, i, c, s),
          Yi(),
          (c.state = e.memoizedState)),
        typeof c.componentDidMount == "function" && (e.flags |= 4194308),
        (i = !0));
    } else if (t === null) {
      c = e.stateNode;
      var S = e.memoizedProps,
        A = Ja(a, S);
      c.props = A;
      var N = c.context,
        Q = a.contextType;
      ((h = Ol), typeof Q == "object" && Q !== null && (h = fe(Q)));
      var K = a.getDerivedStateFromProps;
      ((Q = typeof K == "function" || typeof c.getSnapshotBeforeUpdate == "function"),
        (S = e.pendingProps !== S),
        Q ||
          (typeof c.UNSAFE_componentWillReceiveProps != "function" &&
            typeof c.componentWillReceiveProps != "function") ||
          ((S || N !== h) && Gh(e, c, i, h)),
        (In = !1));
      var B = e.memoizedState;
      ((c.state = B),
        Qi(e, i, c, s),
        Yi(),
        (N = e.memoizedState),
        S || B !== N || In
          ? (typeof K == "function" && (Gc(e, a, K, i), (N = e.memoizedState)),
            (A = In || Qh(e, a, A, i, B, N, h))
              ? (Q ||
                  (typeof c.UNSAFE_componentWillMount != "function" &&
                    typeof c.componentWillMount != "function") ||
                  (typeof c.componentWillMount == "function" && c.componentWillMount(),
                  typeof c.UNSAFE_componentWillMount == "function" &&
                    c.UNSAFE_componentWillMount()),
                typeof c.componentDidMount == "function" && (e.flags |= 4194308))
              : (typeof c.componentDidMount == "function" && (e.flags |= 4194308),
                (e.memoizedProps = i),
                (e.memoizedState = N)),
            (c.props = i),
            (c.state = N),
            (c.context = h),
            (i = A))
          : (typeof c.componentDidMount == "function" && (e.flags |= 4194308), (i = !1)));
    } else {
      ((c = e.stateNode),
        Sc(t, e),
        (h = e.memoizedProps),
        (Q = Ja(a, h)),
        (c.props = Q),
        (K = e.pendingProps),
        (B = c.context),
        (N = a.contextType),
        (A = Ol),
        typeof N == "object" && N !== null && (A = fe(N)),
        (S = a.getDerivedStateFromProps),
        (N = typeof S == "function" || typeof c.getSnapshotBeforeUpdate == "function") ||
          (typeof c.UNSAFE_componentWillReceiveProps != "function" &&
            typeof c.componentWillReceiveProps != "function") ||
          ((h !== K || B !== A) && Gh(e, c, i, A)),
        (In = !1),
        (B = e.memoizedState),
        (c.state = B),
        Qi(e, i, c, s),
        Yi());
      var H = e.memoizedState;
      h !== K || B !== H || In || (t !== null && t.dependencies !== null && ur(t.dependencies))
        ? (typeof S == "function" && (Gc(e, a, S, i), (H = e.memoizedState)),
          (Q =
            In ||
            Qh(e, a, Q, i, B, H, A) ||
            (t !== null && t.dependencies !== null && ur(t.dependencies)))
            ? (N ||
                (typeof c.UNSAFE_componentWillUpdate != "function" &&
                  typeof c.componentWillUpdate != "function") ||
                (typeof c.componentWillUpdate == "function" && c.componentWillUpdate(i, H, A),
                typeof c.UNSAFE_componentWillUpdate == "function" &&
                  c.UNSAFE_componentWillUpdate(i, H, A)),
              typeof c.componentDidUpdate == "function" && (e.flags |= 4),
              typeof c.getSnapshotBeforeUpdate == "function" && (e.flags |= 1024))
            : (typeof c.componentDidUpdate != "function" ||
                (h === t.memoizedProps && B === t.memoizedState) ||
                (e.flags |= 4),
              typeof c.getSnapshotBeforeUpdate != "function" ||
                (h === t.memoizedProps && B === t.memoizedState) ||
                (e.flags |= 1024),
              (e.memoizedProps = i),
              (e.memoizedState = H)),
          (c.props = i),
          (c.state = H),
          (c.context = A),
          (i = Q))
        : (typeof c.componentDidUpdate != "function" ||
            (h === t.memoizedProps && B === t.memoizedState) ||
            (e.flags |= 4),
          typeof c.getSnapshotBeforeUpdate != "function" ||
            (h === t.memoizedProps && B === t.memoizedState) ||
            (e.flags |= 1024),
          (i = !1));
    }
    return (
      (c = i),
      Ar(t, e),
      (i = (e.flags & 128) !== 0),
      c || i
        ? ((c = e.stateNode),
          (a = i && typeof a.getDerivedStateFromError != "function" ? null : c.render()),
          (e.flags |= 1),
          t !== null && i
            ? ((e.child = Ka(e, t.child, null, s)), (e.child = Ka(e, null, a, s)))
            : de(t, e, a, s),
          (e.memoizedState = c.state),
          (t = e.child))
        : (t = wn(t, e, s)),
      t
    );
  }
  function am(t, e, a, i) {
    return (Ya(), (e.flags |= 256), de(t, e, a, i), e.child);
  }
  var Pc = { dehydrated: null, treeContext: null, retryLane: 0, hydrationErrors: null };
  function Jc(t) {
    return { baseLanes: t, cachePool: Kd() };
  }
  function Fc(t, e, a) {
    return ((t = t !== null ? t.childLanes & ~a : 0), e && (t |= He), t);
  }
  function lm(t, e, a) {
    var i = e.pendingProps,
      s = !1,
      c = (e.flags & 128) !== 0,
      h;
    if (
      ((h = c) || (h = t !== null && t.memoizedState === null ? !1 : (Jt.current & 2) !== 0),
      h && ((s = !0), (e.flags &= -129)),
      (h = (e.flags & 32) !== 0),
      (e.flags &= -33),
      t === null)
    ) {
      if (Tt) {
        if (
          (s ? ta(e) : ea(),
          (t = Qt)
            ? ((t = dy(t, Pe)),
              (t = t !== null && t.data !== "&" ? t : null),
              t !== null &&
                ((e.memoizedState = {
                  dehydrated: t,
                  treeContext: Pn !== null ? { id: rn, overflow: sn } : null,
                  retryLane: 536870912,
                  hydrationErrors: null,
                }),
                (a = Bd(t)),
                (a.return = e),
                (e.child = a),
                (oe = e),
                (Qt = null)))
            : (t = null),
          t === null)
        )
          throw Fn(e);
        return (Do(t) ? (e.lanes = 32) : (e.lanes = 536870912), null);
      }
      var S = i.children;
      return (
        (i = i.fallback),
        s
          ? (ea(),
            (s = e.mode),
            (S = xr({ mode: "hidden", children: S }, s)),
            (i = qa(i, s, a, null)),
            (S.return = e),
            (i.return = e),
            (S.sibling = i),
            (e.child = S),
            (i = e.child),
            (i.memoizedState = Jc(a)),
            (i.childLanes = Fc(t, h, a)),
            (e.memoizedState = Pc),
            Ki(null, i))
          : (ta(e), kc(e, S))
      );
    }
    var A = t.memoizedState;
    if (A !== null && ((S = A.dehydrated), S !== null)) {
      if (c)
        e.flags & 256
          ? (ta(e), (e.flags &= -257), (e = Ic(t, e, a)))
          : e.memoizedState !== null
            ? (ea(), (e.child = t.child), (e.flags |= 128), (e = null))
            : (ea(),
              (S = i.fallback),
              (s = e.mode),
              (i = xr({ mode: "visible", children: i.children }, s)),
              (S = qa(S, s, a, null)),
              (S.flags |= 2),
              (i.return = e),
              (S.return = e),
              (i.sibling = S),
              (e.child = i),
              Ka(e, t.child, null, a),
              (i = e.child),
              (i.memoizedState = Jc(a)),
              (i.childLanes = Fc(t, h, a)),
              (e.memoizedState = Pc),
              (e = Ki(null, i)));
      else if ((ta(e), Do(S))) {
        if (((h = S.nextSibling && S.nextSibling.dataset), h)) var N = h.dgst;
        ((h = N),
          (i = Error(r(419))),
          (i.stack = ""),
          (i.digest = h),
          Li({ value: i, source: null, stack: null }),
          (e = Ic(t, e, a)));
      } else if (($t || Ul(t, e, a, !1), (h = (a & t.childLanes) !== 0), $t || h)) {
        if (((h = Ht), h !== null && ((i = Xf(h, a)), i !== 0 && i !== A.retryLane)))
          throw ((A.retryLane = i), Ha(t, i), we(h, t, i), Zc);
        (zo(S) || Nr(), (e = Ic(t, e, a)));
      } else
        zo(S)
          ? ((e.flags |= 192), (e.child = t.child), (e = null))
          : ((t = A.treeContext),
            (Qt = Fe(S.nextSibling)),
            (oe = e),
            (Tt = !0),
            (Jn = null),
            (Pe = !1),
            t !== null && Yd(e, t),
            (e = kc(e, i.children)),
            (e.flags |= 4096));
      return e;
    }
    return s
      ? (ea(),
        (S = i.fallback),
        (s = e.mode),
        (A = t.child),
        (N = A.sibling),
        (i = En(A, { mode: "hidden", children: i.children })),
        (i.subtreeFlags = A.subtreeFlags & 65011712),
        N !== null ? (S = En(N, S)) : ((S = qa(S, s, a, null)), (S.flags |= 2)),
        (S.return = e),
        (i.return = e),
        (i.sibling = S),
        (e.child = i),
        Ki(null, i),
        (i = e.child),
        (S = t.child.memoizedState),
        S === null
          ? (S = Jc(a))
          : ((s = S.cachePool),
            s !== null
              ? ((A = kt._currentValue), (s = s.parent !== A ? { parent: A, pool: A } : s))
              : (s = Kd()),
            (S = { baseLanes: S.baseLanes | a, cachePool: s })),
        (i.memoizedState = S),
        (i.childLanes = Fc(t, h, a)),
        (e.memoizedState = Pc),
        Ki(t.child, i))
      : (ta(e),
        (a = t.child),
        (t = a.sibling),
        (a = En(a, { mode: "visible", children: i.children })),
        (a.return = e),
        (a.sibling = null),
        t !== null &&
          ((h = e.deletions), h === null ? ((e.deletions = [t]), (e.flags |= 16)) : h.push(t)),
        (e.child = a),
        (e.memoizedState = null),
        a);
  }
  function kc(t, e) {
    return ((e = xr({ mode: "visible", children: e }, t.mode)), (e.return = t), (t.child = e));
  }
  function xr(t, e) {
    return ((t = Le(22, t, null, e)), (t.lanes = 0), t);
  }
  function Ic(t, e, a) {
    return (
      Ka(e, t.child, null, a),
      (t = kc(e, e.pendingProps.children)),
      (t.flags |= 2),
      (e.memoizedState = null),
      t
    );
  }
  function im(t, e, a) {
    t.lanes |= e;
    var i = t.alternate;
    (i !== null && (i.lanes |= e), dc(t.return, e, a));
  }
  function $c(t, e, a, i, s, c) {
    var h = t.memoizedState;
    h === null
      ? (t.memoizedState = {
          isBackwards: e,
          rendering: null,
          renderingStartTime: 0,
          last: i,
          tail: a,
          tailMode: s,
          treeForkCount: c,
        })
      : ((h.isBackwards = e),
        (h.rendering = null),
        (h.renderingStartTime = 0),
        (h.last = i),
        (h.tail = a),
        (h.tailMode = s),
        (h.treeForkCount = c));
  }
  function um(t, e, a) {
    var i = e.pendingProps,
      s = i.revealOrder,
      c = i.tail;
    i = i.children;
    var h = Jt.current,
      S = (h & 2) !== 0;
    if (
      (S ? ((h = (h & 1) | 2), (e.flags |= 128)) : (h &= 1),
      tt(Jt, h),
      de(t, e, i, a),
      (i = Tt ? Ui : 0),
      !S && t !== null && (t.flags & 128) !== 0)
    )
      t: for (t = e.child; t !== null; ) {
        if (t.tag === 13) t.memoizedState !== null && im(t, a, e);
        else if (t.tag === 19) im(t, a, e);
        else if (t.child !== null) {
          ((t.child.return = t), (t = t.child));
          continue;
        }
        if (t === e) break t;
        for (; t.sibling === null; ) {
          if (t.return === null || t.return === e) break t;
          t = t.return;
        }
        ((t.sibling.return = t.return), (t = t.sibling));
      }
    switch (s) {
      case "forwards":
        for (a = e.child, s = null; a !== null; )
          ((t = a.alternate), t !== null && mr(t) === null && (s = a), (a = a.sibling));
        ((a = s),
          a === null ? ((s = e.child), (e.child = null)) : ((s = a.sibling), (a.sibling = null)),
          $c(e, !1, s, a, c, i));
        break;
      case "backwards":
      case "unstable_legacy-backwards":
        for (a = null, s = e.child, e.child = null; s !== null; ) {
          if (((t = s.alternate), t !== null && mr(t) === null)) {
            e.child = s;
            break;
          }
          ((t = s.sibling), (s.sibling = a), (a = s), (s = t));
        }
        $c(e, !0, a, null, c, i);
        break;
      case "together":
        $c(e, !1, null, null, void 0, i);
        break;
      default:
        e.memoizedState = null;
    }
    return e.child;
  }
  function wn(t, e, a) {
    if (
      (t !== null && (e.dependencies = t.dependencies), (la |= e.lanes), (a & e.childLanes) === 0)
    )
      if (t !== null) {
        if ((Ul(t, e, a, !1), (a & e.childLanes) === 0)) return null;
      } else return null;
    if (t !== null && e.child !== t.child) throw Error(r(153));
    if (e.child !== null) {
      for (t = e.child, a = En(t, t.pendingProps), e.child = a, a.return = e; t.sibling !== null; )
        ((t = t.sibling), (a = a.sibling = En(t, t.pendingProps)), (a.return = e));
      a.sibling = null;
    }
    return e.child;
  }
  function Wc(t, e) {
    return (t.lanes & e) !== 0 ? !0 : ((t = t.dependencies), !!(t !== null && ur(t)));
  }
  function Q0(t, e, a) {
    switch (e.tag) {
      case 3:
        (Yt(e, e.stateNode.containerInfo), kn(e, kt, t.memoizedState.cache), Ya());
        break;
      case 27:
      case 5:
        vn(e);
        break;
      case 4:
        Yt(e, e.stateNode.containerInfo);
        break;
      case 10:
        kn(e, e.type, e.memoizedProps.value);
        break;
      case 31:
        if (e.memoizedState !== null) return ((e.flags |= 128), Tc(e), null);
        break;
      case 13:
        var i = e.memoizedState;
        if (i !== null)
          return i.dehydrated !== null
            ? (ta(e), (e.flags |= 128), null)
            : (a & e.child.childLanes) !== 0
              ? lm(t, e, a)
              : (ta(e), (t = wn(t, e, a)), t !== null ? t.sibling : null);
        ta(e);
        break;
      case 19:
        var s = (t.flags & 128) !== 0;
        if (
          ((i = (a & e.childLanes) !== 0),
          i || (Ul(t, e, a, !1), (i = (a & e.childLanes) !== 0)),
          s)
        ) {
          if (i) return um(t, e, a);
          e.flags |= 128;
        }
        if (
          ((s = e.memoizedState),
          s !== null && ((s.rendering = null), (s.tail = null), (s.lastEffect = null)),
          tt(Jt, Jt.current),
          i)
        )
          break;
        return null;
      case 22:
        return ((e.lanes = 0), $h(t, e, a, e.pendingProps));
      case 24:
        kn(e, kt, t.memoizedState.cache);
    }
    return wn(t, e, a);
  }
  function rm(t, e, a) {
    if (t !== null)
      if (t.memoizedProps !== e.pendingProps) $t = !0;
      else {
        if (!Wc(t, a) && (e.flags & 128) === 0) return (($t = !1), Q0(t, e, a));
        $t = (t.flags & 131072) !== 0;
      }
    else (($t = !1), Tt && (e.flags & 1048576) !== 0 && qd(e, Ui, e.index));
    switch (((e.lanes = 0), e.tag)) {
      case 16:
        t: {
          var i = e.pendingProps;
          if (((t = Xa(e.elementType)), (e.type = t), typeof t == "function"))
            lc(t)
              ? ((i = Ja(t, i)), (e.tag = 1), (e = nm(null, e, t, i, a)))
              : ((e.tag = 0), (e = Kc(null, e, t, i, a)));
          else {
            if (t != null) {
              var s = t.$$typeof;
              if (s === z) {
                ((e.tag = 11), (e = Fh(null, e, t, i, a)));
                break t;
              } else if (s === q) {
                ((e.tag = 14), (e = kh(null, e, t, i, a)));
                break t;
              }
            }
            throw ((e = dt(t) || t), Error(r(306, e, "")));
          }
        }
        return e;
      case 0:
        return Kc(t, e, e.type, e.pendingProps, a);
      case 1:
        return ((i = e.type), (s = Ja(i, e.pendingProps)), nm(t, e, i, s, a));
      case 3:
        t: {
          if ((Yt(e, e.stateNode.containerInfo), t === null)) throw Error(r(387));
          i = e.pendingProps;
          var c = e.memoizedState;
          ((s = c.element), Sc(t, e), Qi(e, i, null, a));
          var h = e.memoizedState;
          if (
            ((i = h.cache),
            kn(e, kt, i),
            i !== c.cache && hc(e, [kt], a, !0),
            Yi(),
            (i = h.element),
            c.isDehydrated)
          )
            if (
              ((c = { element: i, isDehydrated: !1, cache: h.cache }),
              (e.updateQueue.baseState = c),
              (e.memoizedState = c),
              e.flags & 256)
            ) {
              e = am(t, e, i, a);
              break t;
            } else if (i !== s) {
              ((s = Xe(Error(r(424)), e)), Li(s), (e = am(t, e, i, a)));
              break t;
            } else {
              switch (((t = e.stateNode.containerInfo), t.nodeType)) {
                case 9:
                  t = t.body;
                  break;
                default:
                  t = t.nodeName === "HTML" ? t.ownerDocument.body : t;
              }
              for (
                Qt = Fe(t.firstChild),
                  oe = e,
                  Tt = !0,
                  Jn = null,
                  Pe = !0,
                  a = $d(e, null, i, a),
                  e.child = a;
                a;
              )
                ((a.flags = (a.flags & -3) | 4096), (a = a.sibling));
            }
          else {
            if ((Ya(), i === s)) {
              e = wn(t, e, a);
              break t;
            }
            de(t, e, i, a);
          }
          e = e.child;
        }
        return e;
      case 26:
        return (
          Ar(t, e),
          t === null
            ? (a = py(e.type, null, e.pendingProps, null))
              ? (e.memoizedState = a)
              : Tt ||
                ((a = e.type),
                (t = e.pendingProps),
                (i = Gr(St.current).createElement(a)),
                (i[ce] = e),
                (i[Ee] = t),
                he(i, a, t),
                le(i),
                (e.stateNode = i))
            : (e.memoizedState = py(e.type, t.memoizedProps, e.pendingProps, t.memoizedState)),
          null
        );
      case 27:
        return (
          vn(e),
          t === null &&
            Tt &&
            ((i = e.stateNode = yy(e.type, e.pendingProps, St.current)),
            (oe = e),
            (Pe = !0),
            (s = Qt),
            ca(e.type) ? ((Uo = s), (Qt = Fe(i.firstChild))) : (Qt = s)),
          de(t, e, e.pendingProps.children, a),
          Ar(t, e),
          t === null && (e.flags |= 4194304),
          e.child
        );
      case 5:
        return (
          t === null &&
            Tt &&
            ((s = i = Qt) &&
              ((i = gS(i, e.type, e.pendingProps, Pe)),
              i !== null
                ? ((e.stateNode = i), (oe = e), (Qt = Fe(i.firstChild)), (Pe = !1), (s = !0))
                : (s = !1)),
            s || Fn(e)),
          vn(e),
          (s = e.type),
          (c = e.pendingProps),
          (h = t !== null ? t.memoizedProps : null),
          (i = c.children),
          wo(s, c) ? (i = null) : h !== null && wo(s, h) && (e.flags |= 32),
          e.memoizedState !== null && ((s = xc(t, e, D0, null, null, a)), (ru._currentValue = s)),
          Ar(t, e),
          de(t, e, i, a),
          e.child
        );
      case 6:
        return (
          t === null &&
            Tt &&
            ((t = a = Qt) &&
              ((a = pS(a, e.pendingProps, Pe)),
              a !== null ? ((e.stateNode = a), (oe = e), (Qt = null), (t = !0)) : (t = !1)),
            t || Fn(e)),
          null
        );
      case 13:
        return lm(t, e, a);
      case 4:
        return (
          Yt(e, e.stateNode.containerInfo),
          (i = e.pendingProps),
          t === null ? (e.child = Ka(e, null, i, a)) : de(t, e, i, a),
          e.child
        );
      case 11:
        return Fh(t, e, e.type, e.pendingProps, a);
      case 7:
        return (de(t, e, e.pendingProps, a), e.child);
      case 8:
        return (de(t, e, e.pendingProps.children, a), e.child);
      case 12:
        return (de(t, e, e.pendingProps.children, a), e.child);
      case 10:
        return ((i = e.pendingProps), kn(e, e.type, i.value), de(t, e, i.children, a), e.child);
      case 9:
        return (
          (s = e.type._context),
          (i = e.pendingProps.children),
          Ga(e),
          (s = fe(s)),
          (i = i(s)),
          (e.flags |= 1),
          de(t, e, i, a),
          e.child
        );
      case 14:
        return kh(t, e, e.type, e.pendingProps, a);
      case 15:
        return Ih(t, e, e.type, e.pendingProps, a);
      case 19:
        return um(t, e, a);
      case 31:
        return Y0(t, e, a);
      case 22:
        return $h(t, e, a, e.pendingProps);
      case 24:
        return (
          Ga(e),
          (i = fe(kt)),
          t === null
            ? ((s = vc()),
              s === null &&
                ((s = Ht),
                (c = mc()),
                (s.pooledCache = c),
                c.refCount++,
                c !== null && (s.pooledCacheLanes |= a),
                (s = c)),
              (e.memoizedState = { parent: i, cache: s }),
              pc(e),
              kn(e, kt, s))
            : ((t.lanes & a) !== 0 && (Sc(t, e), Qi(e, null, null, a), Yi()),
              (s = t.memoizedState),
              (c = e.memoizedState),
              s.parent !== i
                ? ((s = { parent: i, cache: i }),
                  (e.memoizedState = s),
                  e.lanes === 0 && (e.memoizedState = e.updateQueue.baseState = s),
                  kn(e, kt, i))
                : ((i = c.cache), kn(e, kt, i), i !== s.cache && hc(e, [kt], a, !0))),
          de(t, e, e.pendingProps.children, a),
          e.child
        );
      case 29:
        throw e.pendingProps;
    }
    throw Error(r(156, e.tag));
  }
  function On(t) {
    t.flags |= 4;
  }
  function to(t, e, a, i, s) {
    if (((e = (t.mode & 32) !== 0) && (e = !1), e)) {
      if (((t.flags |= 16777216), (s & 335544128) === s))
        if (t.stateNode.complete) t.flags |= 8192;
        else if (Lm()) t.flags |= 8192;
        else throw ((Za = or), gc);
    } else t.flags &= -16777217;
  }
  function sm(t, e) {
    if (e.type !== "stylesheet" || (e.state.loading & 4) !== 0) t.flags &= -16777217;
    else if (((t.flags |= 16777216), !Ry(e)))
      if (Lm()) t.flags |= 8192;
      else throw ((Za = or), gc);
  }
  function Mr(t, e) {
    (e !== null && (t.flags |= 4),
      t.flags & 16384 && ((e = t.tag !== 22 ? Qf() : 536870912), (t.lanes |= e), (Zl |= e)));
  }
  function Pi(t, e) {
    if (!Tt)
      switch (t.tailMode) {
        case "hidden":
          e = t.tail;
          for (var a = null; e !== null; ) (e.alternate !== null && (a = e), (e = e.sibling));
          a === null ? (t.tail = null) : (a.sibling = null);
          break;
        case "collapsed":
          a = t.tail;
          for (var i = null; a !== null; ) (a.alternate !== null && (i = a), (a = a.sibling));
          i === null
            ? e || t.tail === null
              ? (t.tail = null)
              : (t.tail.sibling = null)
            : (i.sibling = null);
      }
  }
  function Gt(t) {
    var e = t.alternate !== null && t.alternate.child === t.child,
      a = 0,
      i = 0;
    if (e)
      for (var s = t.child; s !== null; )
        ((a |= s.lanes | s.childLanes),
          (i |= s.subtreeFlags & 65011712),
          (i |= s.flags & 65011712),
          (s.return = t),
          (s = s.sibling));
    else
      for (s = t.child; s !== null; )
        ((a |= s.lanes | s.childLanes),
          (i |= s.subtreeFlags),
          (i |= s.flags),
          (s.return = t),
          (s = s.sibling));
    return ((t.subtreeFlags |= i), (t.childLanes = a), e);
  }
  function G0(t, e, a) {
    var i = e.pendingProps;
    switch ((sc(e), e.tag)) {
      case 16:
      case 15:
      case 0:
      case 11:
      case 7:
      case 8:
      case 12:
      case 9:
      case 14:
        return (Gt(e), null);
      case 1:
        return (Gt(e), null);
      case 3:
        return (
          (a = e.stateNode),
          (i = null),
          t !== null && (i = t.memoizedState.cache),
          e.memoizedState.cache !== i && (e.flags |= 2048),
          An(kt),
          Bt(),
          a.pendingContext && ((a.context = a.pendingContext), (a.pendingContext = null)),
          (t === null || t.child === null) &&
            (Dl(e)
              ? On(e)
              : t === null ||
                (t.memoizedState.isDehydrated && (e.flags & 256) === 0) ||
                ((e.flags |= 1024), oc())),
          Gt(e),
          null
        );
      case 26:
        var s = e.type,
          c = e.memoizedState;
        return (
          t === null
            ? (On(e), c !== null ? (Gt(e), sm(e, c)) : (Gt(e), to(e, s, null, i, a)))
            : c
              ? c !== t.memoizedState
                ? (On(e), Gt(e), sm(e, c))
                : (Gt(e), (e.flags &= -16777217))
              : ((t = t.memoizedProps), t !== i && On(e), Gt(e), to(e, s, t, i, a)),
          null
        );
      case 27:
        if ((gn(e), (a = St.current), (s = e.type), t !== null && e.stateNode != null))
          t.memoizedProps !== i && On(e);
        else {
          if (!i) {
            if (e.stateNode === null) throw Error(r(166));
            return (Gt(e), null);
          }
          ((t = at.current), Dl(e) ? Qd(e) : ((t = yy(s, i, a)), (e.stateNode = t), On(e)));
        }
        return (Gt(e), null);
      case 5:
        if ((gn(e), (s = e.type), t !== null && e.stateNode != null))
          t.memoizedProps !== i && On(e);
        else {
          if (!i) {
            if (e.stateNode === null) throw Error(r(166));
            return (Gt(e), null);
          }
          if (((c = at.current), Dl(e))) Qd(e);
          else {
            var h = Gr(St.current);
            switch (c) {
              case 1:
                c = h.createElementNS("http://www.w3.org/2000/svg", s);
                break;
              case 2:
                c = h.createElementNS("http://www.w3.org/1998/Math/MathML", s);
                break;
              default:
                switch (s) {
                  case "svg":
                    c = h.createElementNS("http://www.w3.org/2000/svg", s);
                    break;
                  case "math":
                    c = h.createElementNS("http://www.w3.org/1998/Math/MathML", s);
                    break;
                  case "script":
                    ((c = h.createElement("div")),
                      (c.innerHTML = "<script><\/script>"),
                      (c = c.removeChild(c.firstChild)));
                    break;
                  case "select":
                    ((c =
                      typeof i.is == "string"
                        ? h.createElement("select", { is: i.is })
                        : h.createElement("select")),
                      i.multiple ? (c.multiple = !0) : i.size && (c.size = i.size));
                    break;
                  default:
                    c =
                      typeof i.is == "string"
                        ? h.createElement(s, { is: i.is })
                        : h.createElement(s);
                }
            }
            ((c[ce] = e), (c[Ee] = i));
            t: for (h = e.child; h !== null; ) {
              if (h.tag === 5 || h.tag === 6) c.appendChild(h.stateNode);
              else if (h.tag !== 4 && h.tag !== 27 && h.child !== null) {
                ((h.child.return = h), (h = h.child));
                continue;
              }
              if (h === e) break t;
              for (; h.sibling === null; ) {
                if (h.return === null || h.return === e) break t;
                h = h.return;
              }
              ((h.sibling.return = h.return), (h = h.sibling));
            }
            e.stateNode = c;
            t: switch ((he(c, s, i), s)) {
              case "button":
              case "input":
              case "select":
              case "textarea":
                i = !!i.autoFocus;
                break t;
              case "img":
                i = !0;
                break t;
              default:
                i = !1;
            }
            i && On(e);
          }
        }
        return (Gt(e), to(e, e.type, t === null ? null : t.memoizedProps, e.pendingProps, a), null);
      case 6:
        if (t && e.stateNode != null) t.memoizedProps !== i && On(e);
        else {
          if (typeof i != "string" && e.stateNode === null) throw Error(r(166));
          if (((t = St.current), Dl(e))) {
            if (((t = e.stateNode), (a = e.memoizedProps), (i = null), (s = oe), s !== null))
              switch (s.tag) {
                case 27:
                case 5:
                  i = s.memoizedProps;
              }
            ((t[ce] = e),
              (t = !!(
                t.nodeValue === a ||
                (i !== null && i.suppressHydrationWarning === !0) ||
                ly(t.nodeValue, a)
              )),
              t || Fn(e, !0));
          } else ((t = Gr(t).createTextNode(i)), (t[ce] = e), (e.stateNode = t));
        }
        return (Gt(e), null);
      case 31:
        if (((a = e.memoizedState), t === null || t.memoizedState !== null)) {
          if (((i = Dl(e)), a !== null)) {
            if (t === null) {
              if (!i) throw Error(r(318));
              if (((t = e.memoizedState), (t = t !== null ? t.dehydrated : null), !t))
                throw Error(r(557));
              t[ce] = e;
            } else (Ya(), (e.flags & 128) === 0 && (e.memoizedState = null), (e.flags |= 4));
            (Gt(e), (t = !1));
          } else
            ((a = oc()),
              t !== null && t.memoizedState !== null && (t.memoizedState.hydrationErrors = a),
              (t = !0));
          if (!t) return e.flags & 256 ? (je(e), e) : (je(e), null);
          if ((e.flags & 128) !== 0) throw Error(r(558));
        }
        return (Gt(e), null);
      case 13:
        if (
          ((i = e.memoizedState),
          t === null || (t.memoizedState !== null && t.memoizedState.dehydrated !== null))
        ) {
          if (((s = Dl(e)), i !== null && i.dehydrated !== null)) {
            if (t === null) {
              if (!s) throw Error(r(318));
              if (((s = e.memoizedState), (s = s !== null ? s.dehydrated : null), !s))
                throw Error(r(317));
              s[ce] = e;
            } else (Ya(), (e.flags & 128) === 0 && (e.memoizedState = null), (e.flags |= 4));
            (Gt(e), (s = !1));
          } else
            ((s = oc()),
              t !== null && t.memoizedState !== null && (t.memoizedState.hydrationErrors = s),
              (s = !0));
          if (!s) return e.flags & 256 ? (je(e), e) : (je(e), null);
        }
        return (
          je(e),
          (e.flags & 128) !== 0
            ? ((e.lanes = a), e)
            : ((a = i !== null),
              (t = t !== null && t.memoizedState !== null),
              a &&
                ((i = e.child),
                (s = null),
                i.alternate !== null &&
                  i.alternate.memoizedState !== null &&
                  i.alternate.memoizedState.cachePool !== null &&
                  (s = i.alternate.memoizedState.cachePool.pool),
                (c = null),
                i.memoizedState !== null &&
                  i.memoizedState.cachePool !== null &&
                  (c = i.memoizedState.cachePool.pool),
                c !== s && (i.flags |= 2048)),
              a !== t && a && (e.child.flags |= 8192),
              Mr(e, e.updateQueue),
              Gt(e),
              null)
        );
      case 4:
        return (Bt(), t === null && Ro(e.stateNode.containerInfo), Gt(e), null);
      case 10:
        return (An(e.type), Gt(e), null);
      case 19:
        if ((Z(Jt), (i = e.memoizedState), i === null)) return (Gt(e), null);
        if (((s = (e.flags & 128) !== 0), (c = i.rendering), c === null))
          if (s) Pi(i, !1);
          else {
            if (Kt !== 0 || (t !== null && (t.flags & 128) !== 0))
              for (t = e.child; t !== null; ) {
                if (((c = mr(t)), c !== null)) {
                  for (
                    e.flags |= 128,
                      Pi(i, !1),
                      t = c.updateQueue,
                      e.updateQueue = t,
                      Mr(e, t),
                      e.subtreeFlags = 0,
                      t = a,
                      a = e.child;
                    a !== null;
                  )
                    (jd(a, t), (a = a.sibling));
                  return (tt(Jt, (Jt.current & 1) | 2), Tt && Rn(e, i.treeForkCount), e.child);
                }
                t = t.sibling;
              }
            i.tail !== null &&
              ye() > Dr &&
              ((e.flags |= 128), (s = !0), Pi(i, !1), (e.lanes = 4194304));
          }
        else {
          if (!s)
            if (((t = mr(c)), t !== null)) {
              if (
                ((e.flags |= 128),
                (s = !0),
                (t = t.updateQueue),
                (e.updateQueue = t),
                Mr(e, t),
                Pi(i, !0),
                i.tail === null && i.tailMode === "hidden" && !c.alternate && !Tt)
              )
                return (Gt(e), null);
            } else
              2 * ye() - i.renderingStartTime > Dr &&
                a !== 536870912 &&
                ((e.flags |= 128), (s = !0), Pi(i, !1), (e.lanes = 4194304));
          i.isBackwards
            ? ((c.sibling = e.child), (e.child = c))
            : ((t = i.last), t !== null ? (t.sibling = c) : (e.child = c), (i.last = c));
        }
        return i.tail !== null
          ? ((t = i.tail),
            (i.rendering = t),
            (i.tail = t.sibling),
            (i.renderingStartTime = ye()),
            (t.sibling = null),
            (a = Jt.current),
            tt(Jt, s ? (a & 1) | 2 : a & 1),
            Tt && Rn(e, i.treeForkCount),
            t)
          : (Gt(e), null);
      case 22:
      case 23:
        return (
          je(e),
          Rc(),
          (i = e.memoizedState !== null),
          t !== null
            ? (t.memoizedState !== null) !== i && (e.flags |= 8192)
            : i && (e.flags |= 8192),
          i
            ? (a & 536870912) !== 0 &&
              (e.flags & 128) === 0 &&
              (Gt(e), e.subtreeFlags & 6 && (e.flags |= 8192))
            : Gt(e),
          (a = e.updateQueue),
          a !== null && Mr(e, a.retryQueue),
          (a = null),
          t !== null &&
            t.memoizedState !== null &&
            t.memoizedState.cachePool !== null &&
            (a = t.memoizedState.cachePool.pool),
          (i = null),
          e.memoizedState !== null &&
            e.memoizedState.cachePool !== null &&
            (i = e.memoizedState.cachePool.pool),
          i !== a && (e.flags |= 2048),
          t !== null && Z(Va),
          null
        );
      case 24:
        return (
          (a = null),
          t !== null && (a = t.memoizedState.cache),
          e.memoizedState.cache !== a && (e.flags |= 2048),
          An(kt),
          Gt(e),
          null
        );
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(r(156, e.tag));
  }
  function V0(t, e) {
    switch ((sc(e), e.tag)) {
      case 1:
        return ((t = e.flags), t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null);
      case 3:
        return (
          An(kt),
          Bt(),
          (t = e.flags),
          (t & 65536) !== 0 && (t & 128) === 0 ? ((e.flags = (t & -65537) | 128), e) : null
        );
      case 26:
      case 27:
      case 5:
        return (gn(e), null);
      case 31:
        if (e.memoizedState !== null) {
          if ((je(e), e.alternate === null)) throw Error(r(340));
          Ya();
        }
        return ((t = e.flags), t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null);
      case 13:
        if ((je(e), (t = e.memoizedState), t !== null && t.dehydrated !== null)) {
          if (e.alternate === null) throw Error(r(340));
          Ya();
        }
        return ((t = e.flags), t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null);
      case 19:
        return (Z(Jt), null);
      case 4:
        return (Bt(), null);
      case 10:
        return (An(e.type), null);
      case 22:
      case 23:
        return (
          je(e),
          Rc(),
          t !== null && Z(Va),
          (t = e.flags),
          t & 65536 ? ((e.flags = (t & -65537) | 128), e) : null
        );
      case 24:
        return (An(kt), null);
      case 25:
        return null;
      default:
        return null;
    }
  }
  function cm(t, e) {
    switch ((sc(e), e.tag)) {
      case 3:
        (An(kt), Bt());
        break;
      case 26:
      case 27:
      case 5:
        gn(e);
        break;
      case 4:
        Bt();
        break;
      case 31:
        e.memoizedState !== null && je(e);
        break;
      case 13:
        je(e);
        break;
      case 19:
        Z(Jt);
        break;
      case 10:
        An(e.type);
        break;
      case 22:
      case 23:
        (je(e), Rc(), t !== null && Z(Va));
        break;
      case 24:
        An(kt);
    }
  }
  function Ji(t, e) {
    try {
      var a = e.updateQueue,
        i = a !== null ? a.lastEffect : null;
      if (i !== null) {
        var s = i.next;
        a = s;
        do {
          if ((a.tag & t) === t) {
            i = void 0;
            var c = a.create,
              h = a.inst;
            ((i = c()), (h.destroy = i));
          }
          a = a.next;
        } while (a !== s);
      }
    } catch (S) {
      Dt(e, e.return, S);
    }
  }
  function na(t, e, a) {
    try {
      var i = e.updateQueue,
        s = i !== null ? i.lastEffect : null;
      if (s !== null) {
        var c = s.next;
        i = c;
        do {
          if ((i.tag & t) === t) {
            var h = i.inst,
              S = h.destroy;
            if (S !== void 0) {
              ((h.destroy = void 0), (s = e));
              var A = a,
                N = S;
              try {
                N();
              } catch (Q) {
                Dt(s, A, Q);
              }
            }
          }
          i = i.next;
        } while (i !== c);
      }
    } catch (Q) {
      Dt(e, e.return, Q);
    }
  }
  function om(t) {
    var e = t.updateQueue;
    if (e !== null) {
      var a = t.stateNode;
      try {
        th(e, a);
      } catch (i) {
        Dt(t, t.return, i);
      }
    }
  }
  function fm(t, e, a) {
    ((a.props = Ja(t.type, t.memoizedProps)), (a.state = t.memoizedState));
    try {
      a.componentWillUnmount();
    } catch (i) {
      Dt(t, e, i);
    }
  }
  function Fi(t, e) {
    try {
      var a = t.ref;
      if (a !== null) {
        switch (t.tag) {
          case 26:
          case 27:
          case 5:
            var i = t.stateNode;
            break;
          case 30:
            i = t.stateNode;
            break;
          default:
            i = t.stateNode;
        }
        typeof a == "function" ? (t.refCleanup = a(i)) : (a.current = i);
      }
    } catch (s) {
      Dt(t, e, s);
    }
  }
  function cn(t, e) {
    var a = t.ref,
      i = t.refCleanup;
    if (a !== null)
      if (typeof i == "function")
        try {
          i();
        } catch (s) {
          Dt(t, e, s);
        } finally {
          ((t.refCleanup = null), (t = t.alternate), t != null && (t.refCleanup = null));
        }
      else if (typeof a == "function")
        try {
          a(null);
        } catch (s) {
          Dt(t, e, s);
        }
      else a.current = null;
  }
  function dm(t) {
    var e = t.type,
      a = t.memoizedProps,
      i = t.stateNode;
    try {
      t: switch (e) {
        case "button":
        case "input":
        case "select":
        case "textarea":
          a.autoFocus && i.focus();
          break t;
        case "img":
          a.src ? (i.src = a.src) : a.srcSet && (i.srcset = a.srcSet);
      }
    } catch (s) {
      Dt(t, t.return, s);
    }
  }
  function eo(t, e, a) {
    try {
      var i = t.stateNode;
      (fS(i, t.type, a, e), (i[Ee] = e));
    } catch (s) {
      Dt(t, t.return, s);
    }
  }
  function hm(t) {
    return (
      t.tag === 5 || t.tag === 3 || t.tag === 26 || (t.tag === 27 && ca(t.type)) || t.tag === 4
    );
  }
  function no(t) {
    t: for (;;) {
      for (; t.sibling === null; ) {
        if (t.return === null || hm(t.return)) return null;
        t = t.return;
      }
      for (
        t.sibling.return = t.return, t = t.sibling;
        t.tag !== 5 && t.tag !== 6 && t.tag !== 18;
      ) {
        if ((t.tag === 27 && ca(t.type)) || t.flags & 2 || t.child === null || t.tag === 4)
          continue t;
        ((t.child.return = t), (t = t.child));
      }
      if (!(t.flags & 2)) return t.stateNode;
    }
  }
  function ao(t, e, a) {
    var i = t.tag;
    if (i === 5 || i === 6)
      ((t = t.stateNode),
        e
          ? (a.nodeType === 9
              ? a.body
              : a.nodeName === "HTML"
                ? a.ownerDocument.body
                : a
            ).insertBefore(t, e)
          : ((e = a.nodeType === 9 ? a.body : a.nodeName === "HTML" ? a.ownerDocument.body : a),
            e.appendChild(t),
            (a = a._reactRootContainer),
            a != null || e.onclick !== null || (e.onclick = bn)));
    else if (
      i !== 4 &&
      (i === 27 && ca(t.type) && ((a = t.stateNode), (e = null)), (t = t.child), t !== null)
    )
      for (ao(t, e, a), t = t.sibling; t !== null; ) (ao(t, e, a), (t = t.sibling));
  }
  function wr(t, e, a) {
    var i = t.tag;
    if (i === 5 || i === 6) ((t = t.stateNode), e ? a.insertBefore(t, e) : a.appendChild(t));
    else if (i !== 4 && (i === 27 && ca(t.type) && (a = t.stateNode), (t = t.child), t !== null))
      for (wr(t, e, a), t = t.sibling; t !== null; ) (wr(t, e, a), (t = t.sibling));
  }
  function mm(t) {
    var e = t.stateNode,
      a = t.memoizedProps;
    try {
      for (var i = t.type, s = e.attributes; s.length; ) e.removeAttributeNode(s[0]);
      (he(e, i, a), (e[ce] = t), (e[Ee] = a));
    } catch (c) {
      Dt(t, t.return, c);
    }
  }
  var Cn = !1,
    Wt = !1,
    lo = !1,
    ym = typeof WeakSet == "function" ? WeakSet : Set,
    ie = null;
  function X0(t, e) {
    if (((t = t.containerInfo), (xo = Fr), (t = Md(t)), Is(t))) {
      if ("selectionStart" in t) var a = { start: t.selectionStart, end: t.selectionEnd };
      else
        t: {
          a = ((a = t.ownerDocument) && a.defaultView) || window;
          var i = a.getSelection && a.getSelection();
          if (i && i.rangeCount !== 0) {
            a = i.anchorNode;
            var s = i.anchorOffset,
              c = i.focusNode;
            i = i.focusOffset;
            try {
              (a.nodeType, c.nodeType);
            } catch {
              a = null;
              break t;
            }
            var h = 0,
              S = -1,
              A = -1,
              N = 0,
              Q = 0,
              K = t,
              B = null;
            e: for (;;) {
              for (
                var H;
                K !== a || (s !== 0 && K.nodeType !== 3) || (S = h + s),
                  K !== c || (i !== 0 && K.nodeType !== 3) || (A = h + i),
                  K.nodeType === 3 && (h += K.nodeValue.length),
                  (H = K.firstChild) !== null;
              )
                ((B = K), (K = H));
              for (;;) {
                if (K === t) break e;
                if (
                  (B === a && ++N === s && (S = h),
                  B === c && ++Q === i && (A = h),
                  (H = K.nextSibling) !== null)
                )
                  break;
                ((K = B), (B = K.parentNode));
              }
              K = H;
            }
            a = S === -1 || A === -1 ? null : { start: S, end: A };
          } else a = null;
        }
      a = a || { start: 0, end: 0 };
    } else a = null;
    for (Mo = { focusedElem: t, selectionRange: a }, Fr = !1, ie = e; ie !== null; )
      if (((e = ie), (t = e.child), (e.subtreeFlags & 1028) !== 0 && t !== null))
        ((t.return = e), (ie = t));
      else
        for (; ie !== null; ) {
          switch (((e = ie), (c = e.alternate), (t = e.flags), e.tag)) {
            case 0:
              if (
                (t & 4) !== 0 &&
                ((t = e.updateQueue), (t = t !== null ? t.events : null), t !== null)
              )
                for (a = 0; a < t.length; a++) ((s = t[a]), (s.ref.impl = s.nextImpl));
              break;
            case 11:
            case 15:
              break;
            case 1:
              if ((t & 1024) !== 0 && c !== null) {
                ((t = void 0),
                  (a = e),
                  (s = c.memoizedProps),
                  (c = c.memoizedState),
                  (i = a.stateNode));
                try {
                  var lt = Ja(a.type, s);
                  ((t = i.getSnapshotBeforeUpdate(lt, c)),
                    (i.__reactInternalSnapshotBeforeUpdate = t));
                } catch (ft) {
                  Dt(a, a.return, ft);
                }
              }
              break;
            case 3:
              if ((t & 1024) !== 0) {
                if (((t = e.stateNode.containerInfo), (a = t.nodeType), a === 9)) Co(t);
                else if (a === 1)
                  switch (t.nodeName) {
                    case "HEAD":
                    case "HTML":
                    case "BODY":
                      Co(t);
                      break;
                    default:
                      t.textContent = "";
                  }
              }
              break;
            case 5:
            case 26:
            case 27:
            case 6:
            case 4:
            case 17:
              break;
            default:
              if ((t & 1024) !== 0) throw Error(r(163));
          }
          if (((t = e.sibling), t !== null)) {
            ((t.return = e.return), (ie = t));
            break;
          }
          ie = e.return;
        }
  }
  function vm(t, e, a) {
    var i = a.flags;
    switch (a.tag) {
      case 0:
      case 11:
      case 15:
        (Dn(t, a), i & 4 && Ji(5, a));
        break;
      case 1:
        if ((Dn(t, a), i & 4))
          if (((t = a.stateNode), e === null))
            try {
              t.componentDidMount();
            } catch (h) {
              Dt(a, a.return, h);
            }
          else {
            var s = Ja(a.type, e.memoizedProps);
            e = e.memoizedState;
            try {
              t.componentDidUpdate(s, e, t.__reactInternalSnapshotBeforeUpdate);
            } catch (h) {
              Dt(a, a.return, h);
            }
          }
        (i & 64 && om(a), i & 512 && Fi(a, a.return));
        break;
      case 3:
        if ((Dn(t, a), i & 64 && ((t = a.updateQueue), t !== null))) {
          if (((e = null), a.child !== null))
            switch (a.child.tag) {
              case 27:
              case 5:
                e = a.child.stateNode;
                break;
              case 1:
                e = a.child.stateNode;
            }
          try {
            th(t, e);
          } catch (h) {
            Dt(a, a.return, h);
          }
        }
        break;
      case 27:
        e === null && i & 4 && mm(a);
      case 26:
      case 5:
        (Dn(t, a), e === null && i & 4 && dm(a), i & 512 && Fi(a, a.return));
        break;
      case 12:
        Dn(t, a);
        break;
      case 31:
        (Dn(t, a), i & 4 && Sm(t, a));
        break;
      case 13:
        (Dn(t, a),
          i & 4 && bm(t, a),
          i & 64 &&
            ((t = a.memoizedState),
            t !== null && ((t = t.dehydrated), t !== null && ((a = W0.bind(null, a)), SS(t, a)))));
        break;
      case 22:
        if (((i = a.memoizedState !== null || Cn), !i)) {
          ((e = (e !== null && e.memoizedState !== null) || Wt), (s = Cn));
          var c = Wt;
          ((Cn = i),
            (Wt = e) && !c ? Un(t, a, (a.subtreeFlags & 8772) !== 0) : Dn(t, a),
            (Cn = s),
            (Wt = c));
        }
        break;
      case 30:
        break;
      default:
        Dn(t, a);
    }
  }
  function gm(t) {
    var e = t.alternate;
    (e !== null && ((t.alternate = null), gm(e)),
      (t.child = null),
      (t.deletions = null),
      (t.sibling = null),
      t.tag === 5 && ((e = t.stateNode), e !== null && Ls(e)),
      (t.stateNode = null),
      (t.return = null),
      (t.dependencies = null),
      (t.memoizedProps = null),
      (t.memoizedState = null),
      (t.pendingProps = null),
      (t.stateNode = null),
      (t.updateQueue = null));
  }
  var Vt = null,
    Te = !1;
  function zn(t, e, a) {
    for (a = a.child; a !== null; ) (pm(t, e, a), (a = a.sibling));
  }
  function pm(t, e, a) {
    if (ze && typeof ze.onCommitFiberUnmount == "function")
      try {
        ze.onCommitFiberUnmount(Si, a);
      } catch {}
    switch (a.tag) {
      case 26:
        (Wt || cn(a, e),
          zn(t, e, a),
          a.memoizedState
            ? a.memoizedState.count--
            : a.stateNode && ((a = a.stateNode), a.parentNode.removeChild(a)));
        break;
      case 27:
        Wt || cn(a, e);
        var i = Vt,
          s = Te;
        (ca(a.type) && ((Vt = a.stateNode), (Te = !1)),
          zn(t, e, a),
          lu(a.stateNode),
          (Vt = i),
          (Te = s));
        break;
      case 5:
        Wt || cn(a, e);
      case 6:
        if (((i = Vt), (s = Te), (Vt = null), zn(t, e, a), (Vt = i), (Te = s), Vt !== null))
          if (Te)
            try {
              (Vt.nodeType === 9
                ? Vt.body
                : Vt.nodeName === "HTML"
                  ? Vt.ownerDocument.body
                  : Vt
              ).removeChild(a.stateNode);
            } catch (c) {
              Dt(a, e, c);
            }
          else
            try {
              Vt.removeChild(a.stateNode);
            } catch (c) {
              Dt(a, e, c);
            }
        break;
      case 18:
        Vt !== null &&
          (Te
            ? ((t = Vt),
              oy(
                t.nodeType === 9 ? t.body : t.nodeName === "HTML" ? t.ownerDocument.body : t,
                a.stateNode,
              ),
              Wl(t))
            : oy(Vt, a.stateNode));
        break;
      case 4:
        ((i = Vt),
          (s = Te),
          (Vt = a.stateNode.containerInfo),
          (Te = !0),
          zn(t, e, a),
          (Vt = i),
          (Te = s));
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        (na(2, a, e), Wt || na(4, a, e), zn(t, e, a));
        break;
      case 1:
        (Wt ||
          (cn(a, e), (i = a.stateNode), typeof i.componentWillUnmount == "function" && fm(a, e, i)),
          zn(t, e, a));
        break;
      case 21:
        zn(t, e, a);
        break;
      case 22:
        ((Wt = (i = Wt) || a.memoizedState !== null), zn(t, e, a), (Wt = i));
        break;
      default:
        zn(t, e, a);
    }
  }
  function Sm(t, e) {
    if (
      e.memoizedState === null &&
      ((t = e.alternate), t !== null && ((t = t.memoizedState), t !== null))
    ) {
      t = t.dehydrated;
      try {
        Wl(t);
      } catch (a) {
        Dt(e, e.return, a);
      }
    }
  }
  function bm(t, e) {
    if (
      e.memoizedState === null &&
      ((t = e.alternate),
      t !== null && ((t = t.memoizedState), t !== null && ((t = t.dehydrated), t !== null)))
    )
      try {
        Wl(t);
      } catch (a) {
        Dt(e, e.return, a);
      }
  }
  function Z0(t) {
    switch (t.tag) {
      case 31:
      case 13:
      case 19:
        var e = t.stateNode;
        return (e === null && (e = t.stateNode = new ym()), e);
      case 22:
        return (
          (t = t.stateNode), (e = t._retryCache), e === null && (e = t._retryCache = new ym()), e
        );
      default:
        throw Error(r(435, t.tag));
    }
  }
  function Or(t, e) {
    var a = Z0(t);
    e.forEach(function (i) {
      if (!a.has(i)) {
        a.add(i);
        var s = tS.bind(null, t, i);
        i.then(s, s);
      }
    });
  }
  function Ae(t, e) {
    var a = e.deletions;
    if (a !== null)
      for (var i = 0; i < a.length; i++) {
        var s = a[i],
          c = t,
          h = e,
          S = h;
        t: for (; S !== null; ) {
          switch (S.tag) {
            case 27:
              if (ca(S.type)) {
                ((Vt = S.stateNode), (Te = !1));
                break t;
              }
              break;
            case 5:
              ((Vt = S.stateNode), (Te = !1));
              break t;
            case 3:
            case 4:
              ((Vt = S.stateNode.containerInfo), (Te = !0));
              break t;
          }
          S = S.return;
        }
        if (Vt === null) throw Error(r(160));
        (pm(c, h, s),
          (Vt = null),
          (Te = !1),
          (c = s.alternate),
          c !== null && (c.return = null),
          (s.return = null));
      }
    if (e.subtreeFlags & 13886) for (e = e.child; e !== null; ) (_m(e, t), (e = e.sibling));
  }
  var tn = null;
  function _m(t, e) {
    var a = t.alternate,
      i = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        (Ae(e, t), xe(t), i & 4 && (na(3, t, t.return), Ji(3, t), na(5, t, t.return)));
        break;
      case 1:
        (Ae(e, t),
          xe(t),
          i & 512 && (Wt || a === null || cn(a, a.return)),
          i & 64 &&
            Cn &&
            ((t = t.updateQueue),
            t !== null &&
              ((i = t.callbacks),
              i !== null &&
                ((a = t.shared.hiddenCallbacks),
                (t.shared.hiddenCallbacks = a === null ? i : a.concat(i))))));
        break;
      case 26:
        var s = tn;
        if ((Ae(e, t), xe(t), i & 512 && (Wt || a === null || cn(a, a.return)), i & 4)) {
          var c = a !== null ? a.memoizedState : null;
          if (((i = t.memoizedState), a === null))
            if (i === null)
              if (t.stateNode === null) {
                t: {
                  ((i = t.type), (a = t.memoizedProps), (s = s.ownerDocument || s));
                  e: switch (i) {
                    case "title":
                      ((c = s.getElementsByTagName("title")[0]),
                        (!c ||
                          c[Ei] ||
                          c[ce] ||
                          c.namespaceURI === "http://www.w3.org/2000/svg" ||
                          c.hasAttribute("itemprop")) &&
                          ((c = s.createElement(i)),
                          s.head.insertBefore(c, s.querySelector("head > title"))),
                        he(c, i, a),
                        (c[ce] = t),
                        le(c),
                        (i = c));
                      break t;
                    case "link":
                      var h = _y("link", "href", s).get(i + (a.href || ""));
                      if (h) {
                        for (var S = 0; S < h.length; S++)
                          if (
                            ((c = h[S]),
                            c.getAttribute("href") ===
                              (a.href == null || a.href === "" ? null : a.href) &&
                              c.getAttribute("rel") === (a.rel == null ? null : a.rel) &&
                              c.getAttribute("title") === (a.title == null ? null : a.title) &&
                              c.getAttribute("crossorigin") ===
                                (a.crossOrigin == null ? null : a.crossOrigin))
                          ) {
                            h.splice(S, 1);
                            break e;
                          }
                      }
                      ((c = s.createElement(i)), he(c, i, a), s.head.appendChild(c));
                      break;
                    case "meta":
                      if ((h = _y("meta", "content", s).get(i + (a.content || "")))) {
                        for (S = 0; S < h.length; S++)
                          if (
                            ((c = h[S]),
                            c.getAttribute("content") ===
                              (a.content == null ? null : "" + a.content) &&
                              c.getAttribute("name") === (a.name == null ? null : a.name) &&
                              c.getAttribute("property") ===
                                (a.property == null ? null : a.property) &&
                              c.getAttribute("http-equiv") ===
                                (a.httpEquiv == null ? null : a.httpEquiv) &&
                              c.getAttribute("charset") === (a.charSet == null ? null : a.charSet))
                          ) {
                            h.splice(S, 1);
                            break e;
                          }
                      }
                      ((c = s.createElement(i)), he(c, i, a), s.head.appendChild(c));
                      break;
                    default:
                      throw Error(r(468, i));
                  }
                  ((c[ce] = t), le(c), (i = c));
                }
                t.stateNode = i;
              } else Ey(s, t.type, t.stateNode);
            else t.stateNode = by(s, i, t.memoizedProps);
          else
            c !== i
              ? (c === null
                  ? a.stateNode !== null && ((a = a.stateNode), a.parentNode.removeChild(a))
                  : c.count--,
                i === null ? Ey(s, t.type, t.stateNode) : by(s, i, t.memoizedProps))
              : i === null && t.stateNode !== null && eo(t, t.memoizedProps, a.memoizedProps);
        }
        break;
      case 27:
        (Ae(e, t),
          xe(t),
          i & 512 && (Wt || a === null || cn(a, a.return)),
          a !== null && i & 4 && eo(t, t.memoizedProps, a.memoizedProps));
        break;
      case 5:
        if ((Ae(e, t), xe(t), i & 512 && (Wt || a === null || cn(a, a.return)), t.flags & 32)) {
          s = t.stateNode;
          try {
            El(s, "");
          } catch (lt) {
            Dt(t, t.return, lt);
          }
        }
        (i & 4 &&
          t.stateNode != null &&
          ((s = t.memoizedProps), eo(t, s, a !== null ? a.memoizedProps : s)),
          i & 1024 && (lo = !0));
        break;
      case 6:
        if ((Ae(e, t), xe(t), i & 4)) {
          if (t.stateNode === null) throw Error(r(162));
          ((i = t.memoizedProps), (a = t.stateNode));
          try {
            a.nodeValue = i;
          } catch (lt) {
            Dt(t, t.return, lt);
          }
        }
        break;
      case 3:
        if (
          ((Zr = null),
          (s = tn),
          (tn = Vr(e.containerInfo)),
          Ae(e, t),
          (tn = s),
          xe(t),
          i & 4 && a !== null && a.memoizedState.isDehydrated)
        )
          try {
            Wl(e.containerInfo);
          } catch (lt) {
            Dt(t, t.return, lt);
          }
        lo && ((lo = !1), Em(t));
        break;
      case 4:
        ((i = tn), (tn = Vr(t.stateNode.containerInfo)), Ae(e, t), xe(t), (tn = i));
        break;
      case 12:
        (Ae(e, t), xe(t));
        break;
      case 31:
        (Ae(e, t),
          xe(t),
          i & 4 && ((i = t.updateQueue), i !== null && ((t.updateQueue = null), Or(t, i))));
        break;
      case 13:
        (Ae(e, t),
          xe(t),
          t.child.flags & 8192 &&
            (t.memoizedState !== null) != (a !== null && a.memoizedState !== null) &&
            (zr = ye()),
          i & 4 && ((i = t.updateQueue), i !== null && ((t.updateQueue = null), Or(t, i))));
        break;
      case 22:
        s = t.memoizedState !== null;
        var A = a !== null && a.memoizedState !== null,
          N = Cn,
          Q = Wt;
        if (((Cn = N || s), (Wt = Q || A), Ae(e, t), (Wt = Q), (Cn = N), xe(t), i & 8192))
          t: for (
            e = t.stateNode,
              e._visibility = s ? e._visibility & -2 : e._visibility | 1,
              s && (a === null || A || Cn || Wt || Fa(t)),
              a = null,
              e = t;
            ;
          ) {
            if (e.tag === 5 || e.tag === 26) {
              if (a === null) {
                A = a = e;
                try {
                  if (((c = A.stateNode), s))
                    ((h = c.style),
                      typeof h.setProperty == "function"
                        ? h.setProperty("display", "none", "important")
                        : (h.display = "none"));
                  else {
                    S = A.stateNode;
                    var K = A.memoizedProps.style,
                      B = K != null && K.hasOwnProperty("display") ? K.display : null;
                    S.style.display = B == null || typeof B == "boolean" ? "" : ("" + B).trim();
                  }
                } catch (lt) {
                  Dt(A, A.return, lt);
                }
              }
            } else if (e.tag === 6) {
              if (a === null) {
                A = e;
                try {
                  A.stateNode.nodeValue = s ? "" : A.memoizedProps;
                } catch (lt) {
                  Dt(A, A.return, lt);
                }
              }
            } else if (e.tag === 18) {
              if (a === null) {
                A = e;
                try {
                  var H = A.stateNode;
                  s ? fy(H, !0) : fy(A.stateNode, !1);
                } catch (lt) {
                  Dt(A, A.return, lt);
                }
              }
            } else if (
              ((e.tag !== 22 && e.tag !== 23) || e.memoizedState === null || e === t) &&
              e.child !== null
            ) {
              ((e.child.return = e), (e = e.child));
              continue;
            }
            if (e === t) break t;
            for (; e.sibling === null; ) {
              if (e.return === null || e.return === t) break t;
              (a === e && (a = null), (e = e.return));
            }
            (a === e && (a = null), (e.sibling.return = e.return), (e = e.sibling));
          }
        i & 4 &&
          ((i = t.updateQueue),
          i !== null && ((a = i.retryQueue), a !== null && ((i.retryQueue = null), Or(t, a))));
        break;
      case 19:
        (Ae(e, t),
          xe(t),
          i & 4 && ((i = t.updateQueue), i !== null && ((t.updateQueue = null), Or(t, i))));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        (Ae(e, t), xe(t));
    }
  }
  function xe(t) {
    var e = t.flags;
    if (e & 2) {
      try {
        for (var a, i = t.return; i !== null; ) {
          if (hm(i)) {
            a = i;
            break;
          }
          i = i.return;
        }
        if (a == null) throw Error(r(160));
        switch (a.tag) {
          case 27:
            var s = a.stateNode,
              c = no(t);
            wr(t, c, s);
            break;
          case 5:
            var h = a.stateNode;
            a.flags & 32 && (El(h, ""), (a.flags &= -33));
            var S = no(t);
            wr(t, S, h);
            break;
          case 3:
          case 4:
            var A = a.stateNode.containerInfo,
              N = no(t);
            ao(t, N, A);
            break;
          default:
            throw Error(r(161));
        }
      } catch (Q) {
        Dt(t, t.return, Q);
      }
      t.flags &= -3;
    }
    e & 4096 && (t.flags &= -4097);
  }
  function Em(t) {
    if (t.subtreeFlags & 1024)
      for (t = t.child; t !== null; ) {
        var e = t;
        (Em(e), e.tag === 5 && e.flags & 1024 && e.stateNode.reset(), (t = t.sibling));
      }
  }
  function Dn(t, e) {
    if (e.subtreeFlags & 8772)
      for (e = e.child; e !== null; ) (vm(t, e.alternate, e), (e = e.sibling));
  }
  function Fa(t) {
    for (t = t.child; t !== null; ) {
      var e = t;
      switch (e.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          (na(4, e, e.return), Fa(e));
          break;
        case 1:
          cn(e, e.return);
          var a = e.stateNode;
          (typeof a.componentWillUnmount == "function" && fm(e, e.return, a), Fa(e));
          break;
        case 27:
          lu(e.stateNode);
        case 26:
        case 5:
          (cn(e, e.return), Fa(e));
          break;
        case 22:
          e.memoizedState === null && Fa(e);
          break;
        case 30:
          Fa(e);
          break;
        default:
          Fa(e);
      }
      t = t.sibling;
    }
  }
  function Un(t, e, a) {
    for (a = a && (e.subtreeFlags & 8772) !== 0, e = e.child; e !== null; ) {
      var i = e.alternate,
        s = t,
        c = e,
        h = c.flags;
      switch (c.tag) {
        case 0:
        case 11:
        case 15:
          (Un(s, c, a), Ji(4, c));
          break;
        case 1:
          if ((Un(s, c, a), (i = c), (s = i.stateNode), typeof s.componentDidMount == "function"))
            try {
              s.componentDidMount();
            } catch (N) {
              Dt(i, i.return, N);
            }
          if (((i = c), (s = i.updateQueue), s !== null)) {
            var S = i.stateNode;
            try {
              var A = s.shared.hiddenCallbacks;
              if (A !== null)
                for (s.shared.hiddenCallbacks = null, s = 0; s < A.length; s++) Wd(A[s], S);
            } catch (N) {
              Dt(i, i.return, N);
            }
          }
          (a && h & 64 && om(c), Fi(c, c.return));
          break;
        case 27:
          mm(c);
        case 26:
        case 5:
          (Un(s, c, a), a && i === null && h & 4 && dm(c), Fi(c, c.return));
          break;
        case 12:
          Un(s, c, a);
          break;
        case 31:
          (Un(s, c, a), a && h & 4 && Sm(s, c));
          break;
        case 13:
          (Un(s, c, a), a && h & 4 && bm(s, c));
          break;
        case 22:
          (c.memoizedState === null && Un(s, c, a), Fi(c, c.return));
          break;
        case 30:
          break;
        default:
          Un(s, c, a);
      }
      e = e.sibling;
    }
  }
  function io(t, e) {
    var a = null;
    (t !== null &&
      t.memoizedState !== null &&
      t.memoizedState.cachePool !== null &&
      (a = t.memoizedState.cachePool.pool),
      (t = null),
      e.memoizedState !== null &&
        e.memoizedState.cachePool !== null &&
        (t = e.memoizedState.cachePool.pool),
      t !== a && (t != null && t.refCount++, a != null && Ni(a)));
  }
  function uo(t, e) {
    ((t = null),
      e.alternate !== null && (t = e.alternate.memoizedState.cache),
      (e = e.memoizedState.cache),
      e !== t && (e.refCount++, t != null && Ni(t)));
  }
  function en(t, e, a, i) {
    if (e.subtreeFlags & 10256) for (e = e.child; e !== null; ) (Rm(t, e, a, i), (e = e.sibling));
  }
  function Rm(t, e, a, i) {
    var s = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        (en(t, e, a, i), s & 2048 && Ji(9, e));
        break;
      case 1:
        en(t, e, a, i);
        break;
      case 3:
        (en(t, e, a, i),
          s & 2048 &&
            ((t = null),
            e.alternate !== null && (t = e.alternate.memoizedState.cache),
            (e = e.memoizedState.cache),
            e !== t && (e.refCount++, t != null && Ni(t))));
        break;
      case 12:
        if (s & 2048) {
          (en(t, e, a, i), (t = e.stateNode));
          try {
            var c = e.memoizedProps,
              h = c.id,
              S = c.onPostCommit;
            typeof S == "function" &&
              S(h, e.alternate === null ? "mount" : "update", t.passiveEffectDuration, -0);
          } catch (A) {
            Dt(e, e.return, A);
          }
        } else en(t, e, a, i);
        break;
      case 31:
        en(t, e, a, i);
        break;
      case 13:
        en(t, e, a, i);
        break;
      case 23:
        break;
      case 22:
        ((c = e.stateNode),
          (h = e.alternate),
          e.memoizedState !== null
            ? c._visibility & 2
              ? en(t, e, a, i)
              : ki(t, e)
            : c._visibility & 2
              ? en(t, e, a, i)
              : ((c._visibility |= 2), Gl(t, e, a, i, (e.subtreeFlags & 10256) !== 0 || !1)),
          s & 2048 && io(h, e));
        break;
      case 24:
        (en(t, e, a, i), s & 2048 && uo(e.alternate, e));
        break;
      default:
        en(t, e, a, i);
    }
  }
  function Gl(t, e, a, i, s) {
    for (s = s && ((e.subtreeFlags & 10256) !== 0 || !1), e = e.child; e !== null; ) {
      var c = t,
        h = e,
        S = a,
        A = i,
        N = h.flags;
      switch (h.tag) {
        case 0:
        case 11:
        case 15:
          (Gl(c, h, S, A, s), Ji(8, h));
          break;
        case 23:
          break;
        case 22:
          var Q = h.stateNode;
          (h.memoizedState !== null
            ? Q._visibility & 2
              ? Gl(c, h, S, A, s)
              : ki(c, h)
            : ((Q._visibility |= 2), Gl(c, h, S, A, s)),
            s && N & 2048 && io(h.alternate, h));
          break;
        case 24:
          (Gl(c, h, S, A, s), s && N & 2048 && uo(h.alternate, h));
          break;
        default:
          Gl(c, h, S, A, s);
      }
      e = e.sibling;
    }
  }
  function ki(t, e) {
    if (e.subtreeFlags & 10256)
      for (e = e.child; e !== null; ) {
        var a = t,
          i = e,
          s = i.flags;
        switch (i.tag) {
          case 22:
            (ki(a, i), s & 2048 && io(i.alternate, i));
            break;
          case 24:
            (ki(a, i), s & 2048 && uo(i.alternate, i));
            break;
          default:
            ki(a, i);
        }
        e = e.sibling;
      }
  }
  var Ii = 8192;
  function Vl(t, e, a) {
    if (t.subtreeFlags & Ii) for (t = t.child; t !== null; ) (Tm(t, e, a), (t = t.sibling));
  }
  function Tm(t, e, a) {
    switch (t.tag) {
      case 26:
        (Vl(t, e, a),
          t.flags & Ii && t.memoizedState !== null && zS(a, tn, t.memoizedState, t.memoizedProps));
        break;
      case 5:
        Vl(t, e, a);
        break;
      case 3:
      case 4:
        var i = tn;
        ((tn = Vr(t.stateNode.containerInfo)), Vl(t, e, a), (tn = i));
        break;
      case 22:
        t.memoizedState === null &&
          ((i = t.alternate),
          i !== null && i.memoizedState !== null
            ? ((i = Ii), (Ii = 16777216), Vl(t, e, a), (Ii = i))
            : Vl(t, e, a));
        break;
      default:
        Vl(t, e, a);
    }
  }
  function Am(t) {
    var e = t.alternate;
    if (e !== null && ((t = e.child), t !== null)) {
      e.child = null;
      do ((e = t.sibling), (t.sibling = null), (t = e));
      while (t !== null);
    }
  }
  function $i(t) {
    var e = t.deletions;
    if ((t.flags & 16) !== 0) {
      if (e !== null)
        for (var a = 0; a < e.length; a++) {
          var i = e[a];
          ((ie = i), Mm(i, t));
        }
      Am(t);
    }
    if (t.subtreeFlags & 10256) for (t = t.child; t !== null; ) (xm(t), (t = t.sibling));
  }
  function xm(t) {
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        ($i(t), t.flags & 2048 && na(9, t, t.return));
        break;
      case 3:
        $i(t);
        break;
      case 12:
        $i(t);
        break;
      case 22:
        var e = t.stateNode;
        t.memoizedState !== null && e._visibility & 2 && (t.return === null || t.return.tag !== 13)
          ? ((e._visibility &= -3), Cr(t))
          : $i(t);
        break;
      default:
        $i(t);
    }
  }
  function Cr(t) {
    var e = t.deletions;
    if ((t.flags & 16) !== 0) {
      if (e !== null)
        for (var a = 0; a < e.length; a++) {
          var i = e[a];
          ((ie = i), Mm(i, t));
        }
      Am(t);
    }
    for (t = t.child; t !== null; ) {
      switch (((e = t), e.tag)) {
        case 0:
        case 11:
        case 15:
          (na(8, e, e.return), Cr(e));
          break;
        case 22:
          ((a = e.stateNode), a._visibility & 2 && ((a._visibility &= -3), Cr(e)));
          break;
        default:
          Cr(e);
      }
      t = t.sibling;
    }
  }
  function Mm(t, e) {
    for (; ie !== null; ) {
      var a = ie;
      switch (a.tag) {
        case 0:
        case 11:
        case 15:
          na(8, a, e);
          break;
        case 23:
        case 22:
          if (a.memoizedState !== null && a.memoizedState.cachePool !== null) {
            var i = a.memoizedState.cachePool.pool;
            i != null && i.refCount++;
          }
          break;
        case 24:
          Ni(a.memoizedState.cache);
      }
      if (((i = a.child), i !== null)) ((i.return = a), (ie = i));
      else
        t: for (a = t; ie !== null; ) {
          i = ie;
          var s = i.sibling,
            c = i.return;
          if ((gm(i), i === a)) {
            ie = null;
            break t;
          }
          if (s !== null) {
            ((s.return = c), (ie = s));
            break t;
          }
          ie = c;
        }
    }
  }
  var K0 = {
      getCacheForType: function (t) {
        var e = fe(kt),
          a = e.data.get(t);
        return (a === void 0 && ((a = t()), e.data.set(t, a)), a);
      },
      cacheSignal: function () {
        return fe(kt).controller.signal;
      },
    },
    P0 = typeof WeakMap == "function" ? WeakMap : Map,
    Ct = 0,
    Ht = null,
    bt = null,
    Et = 0,
    zt = 0,
    Be = null,
    aa = !1,
    Xl = !1,
    ro = !1,
    Ln = 0,
    Kt = 0,
    la = 0,
    ka = 0,
    so = 0,
    He = 0,
    Zl = 0,
    Wi = null,
    Me = null,
    co = !1,
    zr = 0,
    wm = 0,
    Dr = 1 / 0,
    Ur = null,
    ia = null,
    ee = 0,
    ua = null,
    Kl = null,
    Nn = 0,
    oo = 0,
    fo = null,
    Om = null,
    tu = 0,
    ho = null;
  function qe() {
    return (Ct & 2) !== 0 && Et !== 0 ? Et & -Et : j.T !== null ? So() : Zf();
  }
  function Cm() {
    if (He === 0)
      if ((Et & 536870912) === 0 || Tt) {
        var t = Qu;
        ((Qu <<= 1), (Qu & 3932160) === 0 && (Qu = 262144), (He = t));
      } else He = 536870912;
    return ((t = Ne.current), t !== null && (t.flags |= 32), He);
  }
  function we(t, e, a) {
    (((t === Ht && (zt === 2 || zt === 9)) || t.cancelPendingCommit !== null) &&
      (Pl(t, 0), ra(t, Et, He, !1)),
      _i(t, a),
      ((Ct & 2) === 0 || t !== Ht) &&
        (t === Ht && ((Ct & 2) === 0 && (ka |= a), Kt === 4 && ra(t, Et, He, !1)), on(t)));
  }
  function zm(t, e, a) {
    if ((Ct & 6) !== 0) throw Error(r(327));
    var i = (!a && (e & 127) === 0 && (e & t.expiredLanes) === 0) || bi(t, e),
      s = i ? k0(t, e) : yo(t, e, !0),
      c = i;
    do {
      if (s === 0) {
        Xl && !i && ra(t, e, 0, !1);
        break;
      } else {
        if (((a = t.current.alternate), c && !J0(a))) {
          ((s = yo(t, e, !1)), (c = !1));
          continue;
        }
        if (s === 2) {
          if (((c = e), t.errorRecoveryDisabledLanes & c)) var h = 0;
          else
            ((h = t.pendingLanes & -536870913), (h = h !== 0 ? h : h & 536870912 ? 536870912 : 0));
          if (h !== 0) {
            e = h;
            t: {
              var S = t;
              s = Wi;
              var A = S.current.memoizedState.isDehydrated;
              if ((A && (Pl(S, h).flags |= 256), (h = yo(S, h, !1)), h !== 2)) {
                if (ro && !A) {
                  ((S.errorRecoveryDisabledLanes |= c), (ka |= c), (s = 4));
                  break t;
                }
                ((c = Me), (Me = s), c !== null && (Me === null ? (Me = c) : Me.push.apply(Me, c)));
              }
              s = h;
            }
            if (((c = !1), s !== 2)) continue;
          }
        }
        if (s === 1) {
          (Pl(t, 0), ra(t, e, 0, !0));
          break;
        }
        t: {
          switch (((i = t), (c = s), c)) {
            case 0:
            case 1:
              throw Error(r(345));
            case 4:
              if ((e & 4194048) !== e) break;
            case 6:
              ra(i, e, He, !aa);
              break t;
            case 2:
              Me = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(r(329));
          }
          if ((e & 62914560) === e && ((s = zr + 300 - ye()), 10 < s)) {
            if ((ra(i, e, He, !aa), Vu(i, 0, !0) !== 0)) break t;
            ((Nn = e),
              (i.timeoutHandle = sy(
                Dm.bind(null, i, a, Me, Ur, co, e, He, ka, Zl, aa, c, "Throttled", -0, 0),
                s,
              )));
            break t;
          }
          Dm(i, a, Me, Ur, co, e, He, ka, Zl, aa, c, null, -0, 0);
        }
      }
      break;
    } while (!0);
    on(t);
  }
  function Dm(t, e, a, i, s, c, h, S, A, N, Q, K, B, H) {
    if (((t.timeoutHandle = -1), (K = e.subtreeFlags), K & 8192 || (K & 16785408) === 16785408)) {
      ((K = {
        stylesheets: null,
        count: 0,
        imgCount: 0,
        imgBytes: 0,
        suspenseyImages: [],
        waitingForImages: !0,
        waitingForViewTransition: !1,
        unsuspend: bn,
      }),
        Tm(e, c, K));
      var lt = (c & 62914560) === c ? zr - ye() : (c & 4194048) === c ? wm - ye() : 0;
      if (((lt = DS(K, lt)), lt !== null)) {
        ((Nn = c),
          (t.cancelPendingCommit = lt(Ym.bind(null, t, e, c, a, i, s, h, S, A, Q, K, null, B, H))),
          ra(t, c, h, !N));
        return;
      }
    }
    Ym(t, e, c, a, i, s, h, S, A);
  }
  function J0(t) {
    for (var e = t; ; ) {
      var a = e.tag;
      if (
        (a === 0 || a === 11 || a === 15) &&
        e.flags & 16384 &&
        ((a = e.updateQueue), a !== null && ((a = a.stores), a !== null))
      )
        for (var i = 0; i < a.length; i++) {
          var s = a[i],
            c = s.getSnapshot;
          s = s.value;
          try {
            if (!Ue(c(), s)) return !1;
          } catch {
            return !1;
          }
        }
      if (((a = e.child), e.subtreeFlags & 16384 && a !== null)) ((a.return = e), (e = a));
      else {
        if (e === t) break;
        for (; e.sibling === null; ) {
          if (e.return === null || e.return === t) return !0;
          e = e.return;
        }
        ((e.sibling.return = e.return), (e = e.sibling));
      }
    }
    return !0;
  }
  function ra(t, e, a, i) {
    ((e &= ~so),
      (e &= ~ka),
      (t.suspendedLanes |= e),
      (t.pingedLanes &= ~e),
      i && (t.warmLanes |= e),
      (i = t.expirationTimes));
    for (var s = e; 0 < s; ) {
      var c = 31 - De(s),
        h = 1 << c;
      ((i[c] = -1), (s &= ~h));
    }
    a !== 0 && Gf(t, a, e);
  }
  function Lr() {
    return (Ct & 6) === 0 ? (eu(0), !1) : !0;
  }
  function mo() {
    if (bt !== null) {
      if (zt === 0) var t = bt.return;
      else ((t = bt), (Tn = Qa = null), Oc(t), (Bl = null), (Bi = 0), (t = bt));
      for (; t !== null; ) (cm(t.alternate, t), (t = t.return));
      bt = null;
    }
  }
  function Pl(t, e) {
    var a = t.timeoutHandle;
    (a !== -1 && ((t.timeoutHandle = -1), mS(a)),
      (a = t.cancelPendingCommit),
      a !== null && ((t.cancelPendingCommit = null), a()),
      (Nn = 0),
      mo(),
      (Ht = t),
      (bt = a = En(t.current, null)),
      (Et = e),
      (zt = 0),
      (Be = null),
      (aa = !1),
      (Xl = bi(t, e)),
      (ro = !1),
      (Zl = He = so = ka = la = Kt = 0),
      (Me = Wi = null),
      (co = !1),
      (e & 8) !== 0 && (e |= e & 32));
    var i = t.entangledLanes;
    if (i !== 0)
      for (t = t.entanglements, i &= e; 0 < i; ) {
        var s = 31 - De(i),
          c = 1 << s;
        ((e |= t[s]), (i &= ~c));
      }
    return ((Ln = e), er(), a);
  }
  function Um(t, e) {
    ((gt = null),
      (j.H = Zi),
      e === jl || e === cr
        ? ((e = Fd()), (zt = 3))
        : e === gc
          ? ((e = Fd()), (zt = 4))
          : (zt =
              e === Zc
                ? 8
                : e !== null && typeof e == "object" && typeof e.then == "function"
                  ? 6
                  : 1),
      (Be = e),
      bt === null && ((Kt = 1), Rr(t, Xe(e, t.current))));
  }
  function Lm() {
    var t = Ne.current;
    return t === null
      ? !0
      : (Et & 4194048) === Et
        ? Je === null
        : (Et & 62914560) === Et || (Et & 536870912) !== 0
          ? t === Je
          : !1;
  }
  function Nm() {
    var t = j.H;
    return ((j.H = Zi), t === null ? Zi : t);
  }
  function jm() {
    var t = j.A;
    return ((j.A = K0), t);
  }
  function Nr() {
    ((Kt = 4),
      aa || ((Et & 4194048) !== Et && Ne.current !== null) || (Xl = !0),
      ((la & 134217727) === 0 && (ka & 134217727) === 0) || Ht === null || ra(Ht, Et, He, !1));
  }
  function yo(t, e, a) {
    var i = Ct;
    Ct |= 2;
    var s = Nm(),
      c = jm();
    ((Ht !== t || Et !== e) && ((Ur = null), Pl(t, e)), (e = !1));
    var h = Kt;
    t: do
      try {
        if (zt !== 0 && bt !== null) {
          var S = bt,
            A = Be;
          switch (zt) {
            case 8:
              (mo(), (h = 6));
              break t;
            case 3:
            case 2:
            case 9:
            case 6:
              Ne.current === null && (e = !0);
              var N = zt;
              if (((zt = 0), (Be = null), Jl(t, S, A, N), a && Xl)) {
                h = 0;
                break t;
              }
              break;
            default:
              ((N = zt), (zt = 0), (Be = null), Jl(t, S, A, N));
          }
        }
        (F0(), (h = Kt));
        break;
      } catch (Q) {
        Um(t, Q);
      }
    while (!0);
    return (
      e && t.shellSuspendCounter++,
      (Tn = Qa = null),
      (Ct = i),
      (j.H = s),
      (j.A = c),
      bt === null && ((Ht = null), (Et = 0), er()),
      h
    );
  }
  function F0() {
    for (; bt !== null; ) Bm(bt);
  }
  function k0(t, e) {
    var a = Ct;
    Ct |= 2;
    var i = Nm(),
      s = jm();
    Ht !== t || Et !== e ? ((Ur = null), (Dr = ye() + 500), Pl(t, e)) : (Xl = bi(t, e));
    t: do
      try {
        if (zt !== 0 && bt !== null) {
          e = bt;
          var c = Be;
          e: switch (zt) {
            case 1:
              ((zt = 0), (Be = null), Jl(t, e, c, 1));
              break;
            case 2:
            case 9:
              if (Pd(c)) {
                ((zt = 0), (Be = null), Hm(e));
                break;
              }
              ((e = function () {
                ((zt !== 2 && zt !== 9) || Ht !== t || (zt = 7), on(t));
              }),
                c.then(e, e));
              break t;
            case 3:
              zt = 7;
              break t;
            case 4:
              zt = 5;
              break t;
            case 7:
              Pd(c) ? ((zt = 0), (Be = null), Hm(e)) : ((zt = 0), (Be = null), Jl(t, e, c, 7));
              break;
            case 5:
              var h = null;
              switch (bt.tag) {
                case 26:
                  h = bt.memoizedState;
                case 5:
                case 27:
                  var S = bt;
                  if (h ? Ry(h) : S.stateNode.complete) {
                    ((zt = 0), (Be = null));
                    var A = S.sibling;
                    if (A !== null) bt = A;
                    else {
                      var N = S.return;
                      N !== null ? ((bt = N), jr(N)) : (bt = null);
                    }
                    break e;
                  }
              }
              ((zt = 0), (Be = null), Jl(t, e, c, 5));
              break;
            case 6:
              ((zt = 0), (Be = null), Jl(t, e, c, 6));
              break;
            case 8:
              (mo(), (Kt = 6));
              break t;
            default:
              throw Error(r(462));
          }
        }
        I0();
        break;
      } catch (Q) {
        Um(t, Q);
      }
    while (!0);
    return (
      (Tn = Qa = null),
      (j.H = i),
      (j.A = s),
      (Ct = a),
      bt !== null ? 0 : ((Ht = null), (Et = 0), er(), Kt)
    );
  }
  function I0() {
    for (; bt !== null && !qu(); ) Bm(bt);
  }
  function Bm(t) {
    var e = rm(t.alternate, t, Ln);
    ((t.memoizedProps = t.pendingProps), e === null ? jr(t) : (bt = e));
  }
  function Hm(t) {
    var e = t,
      a = e.alternate;
    switch (e.tag) {
      case 15:
      case 0:
        e = em(a, e, e.pendingProps, e.type, void 0, Et);
        break;
      case 11:
        e = em(a, e, e.pendingProps, e.type.render, e.ref, Et);
        break;
      case 5:
        Oc(e);
      default:
        (cm(a, e), (e = bt = jd(e, Ln)), (e = rm(a, e, Ln)));
    }
    ((t.memoizedProps = t.pendingProps), e === null ? jr(t) : (bt = e));
  }
  function Jl(t, e, a, i) {
    ((Tn = Qa = null), Oc(e), (Bl = null), (Bi = 0));
    var s = e.return;
    try {
      if (q0(t, s, e, a, Et)) {
        ((Kt = 1), Rr(t, Xe(a, t.current)), (bt = null));
        return;
      }
    } catch (c) {
      if (s !== null) throw ((bt = s), c);
      ((Kt = 1), Rr(t, Xe(a, t.current)), (bt = null));
      return;
    }
    e.flags & 32768
      ? (Tt || i === 1
          ? (t = !0)
          : Xl || (Et & 536870912) !== 0
            ? (t = !1)
            : ((aa = t = !0),
              (i === 2 || i === 9 || i === 3 || i === 6) &&
                ((i = Ne.current), i !== null && i.tag === 13 && (i.flags |= 16384))),
        qm(e, t))
      : jr(e);
  }
  function jr(t) {
    var e = t;
    do {
      if ((e.flags & 32768) !== 0) {
        qm(e, aa);
        return;
      }
      t = e.return;
      var a = G0(e.alternate, e, Ln);
      if (a !== null) {
        bt = a;
        return;
      }
      if (((e = e.sibling), e !== null)) {
        bt = e;
        return;
      }
      bt = e = t;
    } while (e !== null);
    Kt === 0 && (Kt = 5);
  }
  function qm(t, e) {
    do {
      var a = V0(t.alternate, t);
      if (a !== null) {
        ((a.flags &= 32767), (bt = a));
        return;
      }
      if (
        ((a = t.return),
        a !== null && ((a.flags |= 32768), (a.subtreeFlags = 0), (a.deletions = null)),
        !e && ((t = t.sibling), t !== null))
      ) {
        bt = t;
        return;
      }
      bt = t = a;
    } while (t !== null);
    ((Kt = 6), (bt = null));
  }
  function Ym(t, e, a, i, s, c, h, S, A) {
    t.cancelPendingCommit = null;
    do Br();
    while (ee !== 0);
    if ((Ct & 6) !== 0) throw Error(r(327));
    if (e !== null) {
      if (e === t.current) throw Error(r(177));
      if (
        ((c = e.lanes | e.childLanes),
        (c |= nc),
        Cp(t, a, c, h, S, A),
        t === Ht && ((bt = Ht = null), (Et = 0)),
        (Kl = e),
        (ua = t),
        (Nn = a),
        (oo = c),
        (fo = s),
        (Om = i),
        (e.subtreeFlags & 10256) !== 0 || (e.flags & 10256) !== 0
          ? ((t.callbackNode = null),
            (t.callbackPriority = 0),
            eS(yl, function () {
              return (Zm(), null);
            }))
          : ((t.callbackNode = null), (t.callbackPriority = 0)),
        (i = (e.flags & 13878) !== 0),
        (e.subtreeFlags & 13878) !== 0 || i)
      ) {
        ((i = j.T), (j.T = null), (s = P.p), (P.p = 2), (h = Ct), (Ct |= 4));
        try {
          X0(t, e, a);
        } finally {
          ((Ct = h), (P.p = s), (j.T = i));
        }
      }
      ((ee = 1), Qm(), Gm(), Vm());
    }
  }
  function Qm() {
    if (ee === 1) {
      ee = 0;
      var t = ua,
        e = Kl,
        a = (e.flags & 13878) !== 0;
      if ((e.subtreeFlags & 13878) !== 0 || a) {
        ((a = j.T), (j.T = null));
        var i = P.p;
        P.p = 2;
        var s = Ct;
        Ct |= 4;
        try {
          _m(e, t);
          var c = Mo,
            h = Md(t.containerInfo),
            S = c.focusedElem,
            A = c.selectionRange;
          if (h !== S && S && S.ownerDocument && xd(S.ownerDocument.documentElement, S)) {
            if (A !== null && Is(S)) {
              var N = A.start,
                Q = A.end;
              if ((Q === void 0 && (Q = N), "selectionStart" in S))
                ((S.selectionStart = N), (S.selectionEnd = Math.min(Q, S.value.length)));
              else {
                var K = S.ownerDocument || document,
                  B = (K && K.defaultView) || window;
                if (B.getSelection) {
                  var H = B.getSelection(),
                    lt = S.textContent.length,
                    ft = Math.min(A.start, lt),
                    jt = A.end === void 0 ? ft : Math.min(A.end, lt);
                  !H.extend && ft > jt && ((h = jt), (jt = ft), (ft = h));
                  var D = Ad(S, ft),
                    w = Ad(S, jt);
                  if (
                    D &&
                    w &&
                    (H.rangeCount !== 1 ||
                      H.anchorNode !== D.node ||
                      H.anchorOffset !== D.offset ||
                      H.focusNode !== w.node ||
                      H.focusOffset !== w.offset)
                  ) {
                    var L = K.createRange();
                    (L.setStart(D.node, D.offset),
                      H.removeAllRanges(),
                      ft > jt
                        ? (H.addRange(L), H.extend(w.node, w.offset))
                        : (L.setEnd(w.node, w.offset), H.addRange(L)));
                  }
                }
              }
            }
            for (K = [], H = S; (H = H.parentNode); )
              H.nodeType === 1 && K.push({ element: H, left: H.scrollLeft, top: H.scrollTop });
            for (typeof S.focus == "function" && S.focus(), S = 0; S < K.length; S++) {
              var X = K[S];
              ((X.element.scrollLeft = X.left), (X.element.scrollTop = X.top));
            }
          }
          ((Fr = !!xo), (Mo = xo = null));
        } finally {
          ((Ct = s), (P.p = i), (j.T = a));
        }
      }
      ((t.current = e), (ee = 2));
    }
  }
  function Gm() {
    if (ee === 2) {
      ee = 0;
      var t = ua,
        e = Kl,
        a = (e.flags & 8772) !== 0;
      if ((e.subtreeFlags & 8772) !== 0 || a) {
        ((a = j.T), (j.T = null));
        var i = P.p;
        P.p = 2;
        var s = Ct;
        Ct |= 4;
        try {
          vm(t, e.alternate, e);
        } finally {
          ((Ct = s), (P.p = i), (j.T = a));
        }
      }
      ee = 3;
    }
  }
  function Vm() {
    if (ee === 4 || ee === 3) {
      ((ee = 0), Os());
      var t = ua,
        e = Kl,
        a = Nn,
        i = Om;
      (e.subtreeFlags & 10256) !== 0 || (e.flags & 10256) !== 0
        ? (ee = 5)
        : ((ee = 0), (Kl = ua = null), Xm(t, t.pendingLanes));
      var s = t.pendingLanes;
      if (
        (s === 0 && (ia = null),
        Ds(a),
        (e = e.stateNode),
        ze && typeof ze.onCommitFiberRoot == "function")
      )
        try {
          ze.onCommitFiberRoot(Si, e, void 0, (e.current.flags & 128) === 128);
        } catch {}
      if (i !== null) {
        ((e = j.T), (s = P.p), (P.p = 2), (j.T = null));
        try {
          for (var c = t.onRecoverableError, h = 0; h < i.length; h++) {
            var S = i[h];
            c(S.value, { componentStack: S.stack });
          }
        } finally {
          ((j.T = e), (P.p = s));
        }
      }
      ((Nn & 3) !== 0 && Br(),
        on(t),
        (s = t.pendingLanes),
        (a & 261930) !== 0 && (s & 42) !== 0 ? (t === ho ? tu++ : ((tu = 0), (ho = t))) : (tu = 0),
        eu(0));
    }
  }
  function Xm(t, e) {
    (t.pooledCacheLanes &= e) === 0 &&
      ((e = t.pooledCache), e != null && ((t.pooledCache = null), Ni(e)));
  }
  function Br() {
    return (Qm(), Gm(), Vm(), Zm());
  }
  function Zm() {
    if (ee !== 5) return !1;
    var t = ua,
      e = oo;
    oo = 0;
    var a = Ds(Nn),
      i = j.T,
      s = P.p;
    try {
      ((P.p = 32 > a ? 32 : a), (j.T = null), (a = fo), (fo = null));
      var c = ua,
        h = Nn;
      if (((ee = 0), (Kl = ua = null), (Nn = 0), (Ct & 6) !== 0)) throw Error(r(331));
      var S = Ct;
      if (
        ((Ct |= 4),
        xm(c.current),
        Rm(c, c.current, h, a),
        (Ct = S),
        eu(0, !1),
        ze && typeof ze.onPostCommitFiberRoot == "function")
      )
        try {
          ze.onPostCommitFiberRoot(Si, c);
        } catch {}
      return !0;
    } finally {
      ((P.p = s), (j.T = i), Xm(t, e));
    }
  }
  function Km(t, e, a) {
    ((e = Xe(a, e)),
      (e = Xc(t.stateNode, e, 2)),
      (t = Wn(t, e, 2)),
      t !== null && (_i(t, 2), on(t)));
  }
  function Dt(t, e, a) {
    if (t.tag === 3) Km(t, t, a);
    else
      for (; e !== null; ) {
        if (e.tag === 3) {
          Km(e, t, a);
          break;
        } else if (e.tag === 1) {
          var i = e.stateNode;
          if (
            typeof e.type.getDerivedStateFromError == "function" ||
            (typeof i.componentDidCatch == "function" && (ia === null || !ia.has(i)))
          ) {
            ((t = Xe(a, t)),
              (a = Ph(2)),
              (i = Wn(e, a, 2)),
              i !== null && (Jh(a, i, e, t), _i(i, 2), on(i)));
            break;
          }
        }
        e = e.return;
      }
  }
  function vo(t, e, a) {
    var i = t.pingCache;
    if (i === null) {
      i = t.pingCache = new P0();
      var s = new Set();
      i.set(e, s);
    } else ((s = i.get(e)), s === void 0 && ((s = new Set()), i.set(e, s)));
    s.has(a) || ((ro = !0), s.add(a), (t = $0.bind(null, t, e, a)), e.then(t, t));
  }
  function $0(t, e, a) {
    var i = t.pingCache;
    (i !== null && i.delete(e),
      (t.pingedLanes |= t.suspendedLanes & a),
      (t.warmLanes &= ~a),
      Ht === t &&
        (Et & a) === a &&
        (Kt === 4 || (Kt === 3 && (Et & 62914560) === Et && 300 > ye() - zr)
          ? (Ct & 2) === 0 && Pl(t, 0)
          : (so |= a),
        Zl === Et && (Zl = 0)),
      on(t));
  }
  function Pm(t, e) {
    (e === 0 && (e = Qf()), (t = Ha(t, e)), t !== null && (_i(t, e), on(t)));
  }
  function W0(t) {
    var e = t.memoizedState,
      a = 0;
    (e !== null && (a = e.retryLane), Pm(t, a));
  }
  function tS(t, e) {
    var a = 0;
    switch (t.tag) {
      case 31:
      case 13:
        var i = t.stateNode,
          s = t.memoizedState;
        s !== null && (a = s.retryLane);
        break;
      case 19:
        i = t.stateNode;
        break;
      case 22:
        i = t.stateNode._retryCache;
        break;
      default:
        throw Error(r(314));
    }
    (i !== null && i.delete(e), Pm(t, a));
  }
  function eS(t, e) {
    return $e(t, e);
  }
  var Hr = null,
    Fl = null,
    go = !1,
    qr = !1,
    po = !1,
    sa = 0;
  function on(t) {
    (t !== Fl && t.next === null && (Fl === null ? (Hr = Fl = t) : (Fl = Fl.next = t)),
      (qr = !0),
      go || ((go = !0), aS()));
  }
  function eu(t, e) {
    if (!po && qr) {
      po = !0;
      do
        for (var a = !1, i = Hr; i !== null; ) {
          if (t !== 0) {
            var s = i.pendingLanes;
            if (s === 0) var c = 0;
            else {
              var h = i.suspendedLanes,
                S = i.pingedLanes;
              ((c = (1 << (31 - De(42 | t) + 1)) - 1),
                (c &= s & ~(h & ~S)),
                (c = c & 201326741 ? (c & 201326741) | 1 : c ? c | 2 : 0));
            }
            c !== 0 && ((a = !0), Im(i, c));
          } else
            ((c = Et),
              (c = Vu(
                i,
                i === Ht ? c : 0,
                i.cancelPendingCommit !== null || i.timeoutHandle !== -1,
              )),
              (c & 3) === 0 || bi(i, c) || ((a = !0), Im(i, c)));
          i = i.next;
        }
      while (a);
      po = !1;
    }
  }
  function nS() {
    Jm();
  }
  function Jm() {
    qr = go = !1;
    var t = 0;
    sa !== 0 && hS() && (t = sa);
    for (var e = ye(), a = null, i = Hr; i !== null; ) {
      var s = i.next,
        c = Fm(i, e);
      (c === 0
        ? ((i.next = null), a === null ? (Hr = s) : (a.next = s), s === null && (Fl = a))
        : ((a = i), (t !== 0 || (c & 3) !== 0) && (qr = !0)),
        (i = s));
    }
    ((ee !== 0 && ee !== 5) || eu(t), sa !== 0 && (sa = 0));
  }
  function Fm(t, e) {
    for (
      var a = t.suspendedLanes,
        i = t.pingedLanes,
        s = t.expirationTimes,
        c = t.pendingLanes & -62914561;
      0 < c;
    ) {
      var h = 31 - De(c),
        S = 1 << h,
        A = s[h];
      (A === -1
        ? ((S & a) === 0 || (S & i) !== 0) && (s[h] = Op(S, e))
        : A <= e && (t.expiredLanes |= S),
        (c &= ~S));
    }
    if (
      ((e = Ht),
      (a = Et),
      (a = Vu(t, t === e ? a : 0, t.cancelPendingCommit !== null || t.timeoutHandle !== -1)),
      (i = t.callbackNode),
      a === 0 || (t === e && (zt === 2 || zt === 9)) || t.cancelPendingCommit !== null)
    )
      return (i !== null && i !== null && pi(i), (t.callbackNode = null), (t.callbackPriority = 0));
    if ((a & 3) === 0 || bi(t, a)) {
      if (((e = a & -a), e === t.callbackPriority)) return e;
      switch ((i !== null && pi(i), Ds(a))) {
        case 2:
        case 8:
          a = un;
          break;
        case 32:
          a = yl;
          break;
        case 268435456:
          a = Yf;
          break;
        default:
          a = yl;
      }
      return (
        (i = km.bind(null, t)), (a = $e(a, i)), (t.callbackPriority = e), (t.callbackNode = a), e
      );
    }
    return (
      i !== null && i !== null && pi(i), (t.callbackPriority = 2), (t.callbackNode = null), 2
    );
  }
  function km(t, e) {
    if (ee !== 0 && ee !== 5) return ((t.callbackNode = null), (t.callbackPriority = 0), null);
    var a = t.callbackNode;
    if (Br() && t.callbackNode !== a) return null;
    var i = Et;
    return (
      (i = Vu(t, t === Ht ? i : 0, t.cancelPendingCommit !== null || t.timeoutHandle !== -1)),
      i === 0
        ? null
        : (zm(t, i, e),
          Fm(t, ye()),
          t.callbackNode != null && t.callbackNode === a ? km.bind(null, t) : null)
    );
  }
  function Im(t, e) {
    if (Br()) return null;
    zm(t, e, !0);
  }
  function aS() {
    yS(function () {
      (Ct & 6) !== 0 ? $e(se, nS) : Jm();
    });
  }
  function So() {
    if (sa === 0) {
      var t = Ll;
      (t === 0 && ((t = Yu), (Yu <<= 1), (Yu & 261888) === 0 && (Yu = 256)), (sa = t));
    }
    return sa;
  }
  function $m(t) {
    return t == null || typeof t == "symbol" || typeof t == "boolean"
      ? null
      : typeof t == "function"
        ? t
        : Pu("" + t);
  }
  function Wm(t, e) {
    var a = e.ownerDocument.createElement("input");
    return (
      (a.name = e.name),
      (a.value = e.value),
      t.id && a.setAttribute("form", t.id),
      e.parentNode.insertBefore(a, e),
      (t = new FormData(t)),
      a.parentNode.removeChild(a),
      t
    );
  }
  function lS(t, e, a, i, s) {
    if (e === "submit" && a && a.stateNode === s) {
      var c = $m((s[Ee] || null).action),
        h = i.submitter;
      h &&
        ((e = (e = h[Ee] || null) ? $m(e.formAction) : h.getAttribute("formAction")),
        e !== null && ((c = e), (h = null)));
      var S = new Iu("action", "action", null, i, s);
      t.push({
        event: S,
        listeners: [
          {
            instance: null,
            listener: function () {
              if (i.defaultPrevented) {
                if (sa !== 0) {
                  var A = h ? Wm(s, h) : new FormData(s);
                  Hc(a, { pending: !0, data: A, method: s.method, action: c }, null, A);
                }
              } else
                typeof c == "function" &&
                  (S.preventDefault(),
                  (A = h ? Wm(s, h) : new FormData(s)),
                  Hc(a, { pending: !0, data: A, method: s.method, action: c }, c, A));
            },
            currentTarget: s,
          },
        ],
      });
    }
  }
  for (var bo = 0; bo < ec.length; bo++) {
    var _o = ec[bo],
      iS = _o.toLowerCase(),
      uS = _o[0].toUpperCase() + _o.slice(1);
    We(iS, "on" + uS);
  }
  (We(Cd, "onAnimationEnd"),
    We(zd, "onAnimationIteration"),
    We(Dd, "onAnimationStart"),
    We("dblclick", "onDoubleClick"),
    We("focusin", "onFocus"),
    We("focusout", "onBlur"),
    We(E0, "onTransitionRun"),
    We(R0, "onTransitionStart"),
    We(T0, "onTransitionCancel"),
    We(Ud, "onTransitionEnd"),
    bl("onMouseEnter", ["mouseout", "mouseover"]),
    bl("onMouseLeave", ["mouseout", "mouseover"]),
    bl("onPointerEnter", ["pointerout", "pointerover"]),
    bl("onPointerLeave", ["pointerout", "pointerover"]),
    La("onChange", "change click focusin focusout input keydown keyup selectionchange".split(" ")),
    La(
      "onSelect",
      "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
        " ",
      ),
    ),
    La("onBeforeInput", ["compositionend", "keypress", "textInput", "paste"]),
    La("onCompositionEnd", "compositionend focusout keydown keypress keyup mousedown".split(" ")),
    La(
      "onCompositionStart",
      "compositionstart focusout keydown keypress keyup mousedown".split(" "),
    ),
    La(
      "onCompositionUpdate",
      "compositionupdate focusout keydown keypress keyup mousedown".split(" "),
    ));
  var nu =
      "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
        " ",
      ),
    rS = new Set(
      "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(nu),
    );
  function ty(t, e) {
    e = (e & 4) !== 0;
    for (var a = 0; a < t.length; a++) {
      var i = t[a],
        s = i.event;
      i = i.listeners;
      t: {
        var c = void 0;
        if (e)
          for (var h = i.length - 1; 0 <= h; h--) {
            var S = i[h],
              A = S.instance,
              N = S.currentTarget;
            if (((S = S.listener), A !== c && s.isPropagationStopped())) break t;
            ((c = S), (s.currentTarget = N));
            try {
              c(s);
            } catch (Q) {
              tr(Q);
            }
            ((s.currentTarget = null), (c = A));
          }
        else
          for (h = 0; h < i.length; h++) {
            if (
              ((S = i[h]),
              (A = S.instance),
              (N = S.currentTarget),
              (S = S.listener),
              A !== c && s.isPropagationStopped())
            )
              break t;
            ((c = S), (s.currentTarget = N));
            try {
              c(s);
            } catch (Q) {
              tr(Q);
            }
            ((s.currentTarget = null), (c = A));
          }
      }
    }
  }
  function _t(t, e) {
    var a = e[Us];
    a === void 0 && (a = e[Us] = new Set());
    var i = t + "__bubble";
    a.has(i) || (ey(e, t, 2, !1), a.add(i));
  }
  function Eo(t, e, a) {
    var i = 0;
    (e && (i |= 4), ey(a, t, i, e));
  }
  var Yr = "_reactListening" + Math.random().toString(36).slice(2);
  function Ro(t) {
    if (!t[Yr]) {
      ((t[Yr] = !0),
        Jf.forEach(function (a) {
          a !== "selectionchange" && (rS.has(a) || Eo(a, !1, t), Eo(a, !0, t));
        }));
      var e = t.nodeType === 9 ? t : t.ownerDocument;
      e === null || e[Yr] || ((e[Yr] = !0), Eo("selectionchange", !1, e));
    }
  }
  function ey(t, e, a, i) {
    switch (Cy(e)) {
      case 2:
        var s = NS;
        break;
      case 8:
        s = jS;
        break;
      default:
        s = Ho;
    }
    ((a = s.bind(null, e, a, t)),
      (s = void 0),
      !Gs || (e !== "touchstart" && e !== "touchmove" && e !== "wheel") || (s = !0),
      i
        ? s !== void 0
          ? t.addEventListener(e, a, { capture: !0, passive: s })
          : t.addEventListener(e, a, !0)
        : s !== void 0
          ? t.addEventListener(e, a, { passive: s })
          : t.addEventListener(e, a, !1));
  }
  function To(t, e, a, i, s) {
    var c = i;
    if ((e & 1) === 0 && (e & 2) === 0 && i !== null)
      t: for (;;) {
        if (i === null) return;
        var h = i.tag;
        if (h === 3 || h === 4) {
          var S = i.stateNode.containerInfo;
          if (S === s) break;
          if (h === 4)
            for (h = i.return; h !== null; ) {
              var A = h.tag;
              if ((A === 3 || A === 4) && h.stateNode.containerInfo === s) return;
              h = h.return;
            }
          for (; S !== null; ) {
            if (((h = gl(S)), h === null)) return;
            if (((A = h.tag), A === 5 || A === 6 || A === 26 || A === 27)) {
              i = c = h;
              continue t;
            }
            S = S.parentNode;
          }
        }
        i = i.return;
      }
    ud(function () {
      var N = c,
        Q = Ys(a),
        K = [];
      t: {
        var B = Ld.get(t);
        if (B !== void 0) {
          var H = Iu,
            lt = t;
          switch (t) {
            case "keypress":
              if (Fu(a) === 0) break t;
            case "keydown":
            case "keyup":
              H = t0;
              break;
            case "focusin":
              ((lt = "focus"), (H = Ks));
              break;
            case "focusout":
              ((lt = "blur"), (H = Ks));
              break;
            case "beforeblur":
            case "afterblur":
              H = Ks;
              break;
            case "click":
              if (a.button === 2) break t;
            case "auxclick":
            case "dblclick":
            case "mousedown":
            case "mousemove":
            case "mouseup":
            case "mouseout":
            case "mouseover":
            case "contextmenu":
              H = cd;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              H = Gp;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              H = a0;
              break;
            case Cd:
            case zd:
            case Dd:
              H = Zp;
              break;
            case Ud:
              H = i0;
              break;
            case "scroll":
            case "scrollend":
              H = Yp;
              break;
            case "wheel":
              H = r0;
              break;
            case "copy":
            case "cut":
            case "paste":
              H = Pp;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              H = fd;
              break;
            case "toggle":
            case "beforetoggle":
              H = c0;
          }
          var ft = (e & 4) !== 0,
            jt = !ft && (t === "scroll" || t === "scrollend"),
            D = ft ? (B !== null ? B + "Capture" : null) : B;
          ft = [];
          for (var w = N, L; w !== null; ) {
            var X = w;
            if (
              ((L = X.stateNode),
              (X = X.tag),
              (X !== 5 && X !== 26 && X !== 27) ||
                L === null ||
                D === null ||
                ((X = Ti(w, D)), X != null && ft.push(au(w, X, L))),
              jt)
            )
              break;
            w = w.return;
          }
          0 < ft.length && ((B = new H(B, lt, null, a, Q)), K.push({ event: B, listeners: ft }));
        }
      }
      if ((e & 7) === 0) {
        t: {
          if (
            ((B = t === "mouseover" || t === "pointerover"),
            (H = t === "mouseout" || t === "pointerout"),
            B && a !== qs && (lt = a.relatedTarget || a.fromElement) && (gl(lt) || lt[vl]))
          )
            break t;
          if (
            (H || B) &&
            ((B =
              Q.window === Q
                ? Q
                : (B = Q.ownerDocument)
                  ? B.defaultView || B.parentWindow
                  : window),
            H
              ? ((lt = a.relatedTarget || a.toElement),
                (H = N),
                (lt = lt ? gl(lt) : null),
                lt !== null &&
                  ((jt = f(lt)), (ft = lt.tag), lt !== jt || (ft !== 5 && ft !== 27 && ft !== 6)) &&
                  (lt = null))
              : ((H = null), (lt = N)),
            H !== lt)
          ) {
            if (
              ((ft = cd),
              (X = "onMouseLeave"),
              (D = "onMouseEnter"),
              (w = "mouse"),
              (t === "pointerout" || t === "pointerover") &&
                ((ft = fd), (X = "onPointerLeave"), (D = "onPointerEnter"), (w = "pointer")),
              (jt = H == null ? B : Ri(H)),
              (L = lt == null ? B : Ri(lt)),
              (B = new ft(X, w + "leave", H, a, Q)),
              (B.target = jt),
              (B.relatedTarget = L),
              (X = null),
              gl(Q) === N &&
                ((ft = new ft(D, w + "enter", lt, a, Q)),
                (ft.target = L),
                (ft.relatedTarget = jt),
                (X = ft)),
              (jt = X),
              H && lt)
            )
              e: {
                for (ft = sS, D = H, w = lt, L = 0, X = D; X; X = ft(X)) L++;
                X = 0;
                for (var ot = w; ot; ot = ft(ot)) X++;
                for (; 0 < L - X; ) ((D = ft(D)), L--);
                for (; 0 < X - L; ) ((w = ft(w)), X--);
                for (; L--; ) {
                  if (D === w || (w !== null && D === w.alternate)) {
                    ft = D;
                    break e;
                  }
                  ((D = ft(D)), (w = ft(w)));
                }
                ft = null;
              }
            else ft = null;
            (H !== null && ny(K, B, H, ft, !1),
              lt !== null && jt !== null && ny(K, jt, lt, ft, !0));
          }
        }
        t: {
          if (
            ((B = N ? Ri(N) : window),
            (H = B.nodeName && B.nodeName.toLowerCase()),
            H === "select" || (H === "input" && B.type === "file"))
          )
            var Mt = Sd;
          else if (gd(B))
            if (bd) Mt = S0;
            else {
              Mt = g0;
              var ut = v0;
            }
          else
            ((H = B.nodeName),
              !H || H.toLowerCase() !== "input" || (B.type !== "checkbox" && B.type !== "radio")
                ? N && Hs(N.elementType) && (Mt = Sd)
                : (Mt = p0));
          if (Mt && (Mt = Mt(t, N))) {
            pd(K, Mt, a, Q);
            break t;
          }
          (ut && ut(t, B, N),
            t === "focusout" &&
              N &&
              B.type === "number" &&
              N.memoizedProps.value != null &&
              Bs(B, "number", B.value));
        }
        switch (((ut = N ? Ri(N) : window), t)) {
          case "focusin":
            (gd(ut) || ut.contentEditable === "true") && ((xl = ut), ($s = N), (Di = null));
            break;
          case "focusout":
            Di = $s = xl = null;
            break;
          case "mousedown":
            Ws = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            ((Ws = !1), wd(K, a, Q));
            break;
          case "selectionchange":
            if (_0) break;
          case "keydown":
          case "keyup":
            wd(K, a, Q);
        }
        var pt;
        if (Js)
          t: {
            switch (t) {
              case "compositionstart":
                var Rt = "onCompositionStart";
                break t;
              case "compositionend":
                Rt = "onCompositionEnd";
                break t;
              case "compositionupdate":
                Rt = "onCompositionUpdate";
                break t;
            }
            Rt = void 0;
          }
        else
          Al
            ? yd(t, a) && (Rt = "onCompositionEnd")
            : t === "keydown" && a.keyCode === 229 && (Rt = "onCompositionStart");
        (Rt &&
          (dd &&
            a.locale !== "ko" &&
            (Al || Rt !== "onCompositionStart"
              ? Rt === "onCompositionEnd" && Al && (pt = rd())
              : ((Kn = Q), (Vs = "value" in Kn ? Kn.value : Kn.textContent), (Al = !0))),
          (ut = Qr(N, Rt)),
          0 < ut.length &&
            ((Rt = new od(Rt, t, null, a, Q)),
            K.push({ event: Rt, listeners: ut }),
            pt ? (Rt.data = pt) : ((pt = vd(a)), pt !== null && (Rt.data = pt)))),
          (pt = f0 ? d0(t, a) : h0(t, a)) &&
            ((Rt = Qr(N, "onBeforeInput")),
            0 < Rt.length &&
              ((ut = new od("onBeforeInput", "beforeinput", null, a, Q)),
              K.push({ event: ut, listeners: Rt }),
              (ut.data = pt))),
          lS(K, t, N, a, Q));
      }
      ty(K, e);
    });
  }
  function au(t, e, a) {
    return { instance: t, listener: e, currentTarget: a };
  }
  function Qr(t, e) {
    for (var a = e + "Capture", i = []; t !== null; ) {
      var s = t,
        c = s.stateNode;
      if (
        ((s = s.tag),
        (s !== 5 && s !== 26 && s !== 27) ||
          c === null ||
          ((s = Ti(t, a)),
          s != null && i.unshift(au(t, s, c)),
          (s = Ti(t, e)),
          s != null && i.push(au(t, s, c))),
        t.tag === 3)
      )
        return i;
      t = t.return;
    }
    return [];
  }
  function sS(t) {
    if (t === null) return null;
    do t = t.return;
    while (t && t.tag !== 5 && t.tag !== 27);
    return t || null;
  }
  function ny(t, e, a, i, s) {
    for (var c = e._reactName, h = []; a !== null && a !== i; ) {
      var S = a,
        A = S.alternate,
        N = S.stateNode;
      if (((S = S.tag), A !== null && A === i)) break;
      ((S !== 5 && S !== 26 && S !== 27) ||
        N === null ||
        ((A = N),
        s
          ? ((N = Ti(a, c)), N != null && h.unshift(au(a, N, A)))
          : s || ((N = Ti(a, c)), N != null && h.push(au(a, N, A)))),
        (a = a.return));
    }
    h.length !== 0 && t.push({ event: e, listeners: h });
  }
  var cS = /\r\n?/g,
    oS = /\u0000|\uFFFD/g;
  function ay(t) {
    return (typeof t == "string" ? t : "" + t)
      .replace(
        cS,
        `
`,
      )
      .replace(oS, "");
  }
  function ly(t, e) {
    return ((e = ay(e)), ay(t) === e);
  }
  function Nt(t, e, a, i, s, c) {
    switch (a) {
      case "children":
        typeof i == "string"
          ? e === "body" || (e === "textarea" && i === "") || El(t, i)
          : (typeof i == "number" || typeof i == "bigint") && e !== "body" && El(t, "" + i);
        break;
      case "className":
        Zu(t, "class", i);
        break;
      case "tabIndex":
        Zu(t, "tabindex", i);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        Zu(t, a, i);
        break;
      case "style":
        ld(t, i, c);
        break;
      case "data":
        if (e !== "object") {
          Zu(t, "data", i);
          break;
        }
      case "src":
      case "href":
        if (i === "" && (e !== "a" || a !== "href")) {
          t.removeAttribute(a);
          break;
        }
        if (i == null || typeof i == "function" || typeof i == "symbol" || typeof i == "boolean") {
          t.removeAttribute(a);
          break;
        }
        ((i = Pu("" + i)), t.setAttribute(a, i));
        break;
      case "action":
      case "formAction":
        if (typeof i == "function") {
          t.setAttribute(
            a,
            "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')",
          );
          break;
        } else
          typeof c == "function" &&
            (a === "formAction"
              ? (e !== "input" && Nt(t, e, "name", s.name, s, null),
                Nt(t, e, "formEncType", s.formEncType, s, null),
                Nt(t, e, "formMethod", s.formMethod, s, null),
                Nt(t, e, "formTarget", s.formTarget, s, null))
              : (Nt(t, e, "encType", s.encType, s, null),
                Nt(t, e, "method", s.method, s, null),
                Nt(t, e, "target", s.target, s, null)));
        if (i == null || typeof i == "symbol" || typeof i == "boolean") {
          t.removeAttribute(a);
          break;
        }
        ((i = Pu("" + i)), t.setAttribute(a, i));
        break;
      case "onClick":
        i != null && (t.onclick = bn);
        break;
      case "onScroll":
        i != null && _t("scroll", t);
        break;
      case "onScrollEnd":
        i != null && _t("scrollend", t);
        break;
      case "dangerouslySetInnerHTML":
        if (i != null) {
          if (typeof i != "object" || !("__html" in i)) throw Error(r(61));
          if (((a = i.__html), a != null)) {
            if (s.children != null) throw Error(r(60));
            t.innerHTML = a;
          }
        }
        break;
      case "multiple":
        t.multiple = i && typeof i != "function" && typeof i != "symbol";
        break;
      case "muted":
        t.muted = i && typeof i != "function" && typeof i != "symbol";
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "ref":
        break;
      case "autoFocus":
        break;
      case "xlinkHref":
        if (i == null || typeof i == "function" || typeof i == "boolean" || typeof i == "symbol") {
          t.removeAttribute("xlink:href");
          break;
        }
        ((a = Pu("" + i)), t.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", a));
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        i != null && typeof i != "function" && typeof i != "symbol"
          ? t.setAttribute(a, "" + i)
          : t.removeAttribute(a);
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        i && typeof i != "function" && typeof i != "symbol"
          ? t.setAttribute(a, "")
          : t.removeAttribute(a);
        break;
      case "capture":
      case "download":
        i === !0
          ? t.setAttribute(a, "")
          : i !== !1 && i != null && typeof i != "function" && typeof i != "symbol"
            ? t.setAttribute(a, i)
            : t.removeAttribute(a);
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        i != null && typeof i != "function" && typeof i != "symbol" && !isNaN(i) && 1 <= i
          ? t.setAttribute(a, i)
          : t.removeAttribute(a);
        break;
      case "rowSpan":
      case "start":
        i == null || typeof i == "function" || typeof i == "symbol" || isNaN(i)
          ? t.removeAttribute(a)
          : t.setAttribute(a, i);
        break;
      case "popover":
        (_t("beforetoggle", t), _t("toggle", t), Xu(t, "popover", i));
        break;
      case "xlinkActuate":
        Sn(t, "http://www.w3.org/1999/xlink", "xlink:actuate", i);
        break;
      case "xlinkArcrole":
        Sn(t, "http://www.w3.org/1999/xlink", "xlink:arcrole", i);
        break;
      case "xlinkRole":
        Sn(t, "http://www.w3.org/1999/xlink", "xlink:role", i);
        break;
      case "xlinkShow":
        Sn(t, "http://www.w3.org/1999/xlink", "xlink:show", i);
        break;
      case "xlinkTitle":
        Sn(t, "http://www.w3.org/1999/xlink", "xlink:title", i);
        break;
      case "xlinkType":
        Sn(t, "http://www.w3.org/1999/xlink", "xlink:type", i);
        break;
      case "xmlBase":
        Sn(t, "http://www.w3.org/XML/1998/namespace", "xml:base", i);
        break;
      case "xmlLang":
        Sn(t, "http://www.w3.org/XML/1998/namespace", "xml:lang", i);
        break;
      case "xmlSpace":
        Sn(t, "http://www.w3.org/XML/1998/namespace", "xml:space", i);
        break;
      case "is":
        Xu(t, "is", i);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < a.length) || (a[0] !== "o" && a[0] !== "O") || (a[1] !== "n" && a[1] !== "N")) &&
          ((a = Hp.get(a) || a), Xu(t, a, i));
    }
  }
  function Ao(t, e, a, i, s, c) {
    switch (a) {
      case "style":
        ld(t, i, c);
        break;
      case "dangerouslySetInnerHTML":
        if (i != null) {
          if (typeof i != "object" || !("__html" in i)) throw Error(r(61));
          if (((a = i.__html), a != null)) {
            if (s.children != null) throw Error(r(60));
            t.innerHTML = a;
          }
        }
        break;
      case "children":
        typeof i == "string"
          ? El(t, i)
          : (typeof i == "number" || typeof i == "bigint") && El(t, "" + i);
        break;
      case "onScroll":
        i != null && _t("scroll", t);
        break;
      case "onScrollEnd":
        i != null && _t("scrollend", t);
        break;
      case "onClick":
        i != null && (t.onclick = bn);
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "innerHTML":
      case "ref":
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        if (!Ff.hasOwnProperty(a))
          t: {
            if (
              a[0] === "o" &&
              a[1] === "n" &&
              ((s = a.endsWith("Capture")),
              (e = a.slice(2, s ? a.length - 7 : void 0)),
              (c = t[Ee] || null),
              (c = c != null ? c[a] : null),
              typeof c == "function" && t.removeEventListener(e, c, s),
              typeof i == "function")
            ) {
              (typeof c != "function" &&
                c !== null &&
                (a in t ? (t[a] = null) : t.hasAttribute(a) && t.removeAttribute(a)),
                t.addEventListener(e, i, s));
              break t;
            }
            a in t ? (t[a] = i) : i === !0 ? t.setAttribute(a, "") : Xu(t, a, i);
          }
    }
  }
  function he(t, e, a) {
    switch (e) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "img":
        (_t("error", t), _t("load", t));
        var i = !1,
          s = !1,
          c;
        for (c in a)
          if (a.hasOwnProperty(c)) {
            var h = a[c];
            if (h != null)
              switch (c) {
                case "src":
                  i = !0;
                  break;
                case "srcSet":
                  s = !0;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(r(137, e));
                default:
                  Nt(t, e, c, h, a, null);
              }
          }
        (s && Nt(t, e, "srcSet", a.srcSet, a, null), i && Nt(t, e, "src", a.src, a, null));
        return;
      case "input":
        _t("invalid", t);
        var S = (c = h = s = null),
          A = null,
          N = null;
        for (i in a)
          if (a.hasOwnProperty(i)) {
            var Q = a[i];
            if (Q != null)
              switch (i) {
                case "name":
                  s = Q;
                  break;
                case "type":
                  h = Q;
                  break;
                case "checked":
                  A = Q;
                  break;
                case "defaultChecked":
                  N = Q;
                  break;
                case "value":
                  c = Q;
                  break;
                case "defaultValue":
                  S = Q;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (Q != null) throw Error(r(137, e));
                  break;
                default:
                  Nt(t, e, i, Q, a, null);
              }
          }
        td(t, c, S, A, N, h, s, !1);
        return;
      case "select":
        (_t("invalid", t), (i = h = c = null));
        for (s in a)
          if (a.hasOwnProperty(s) && ((S = a[s]), S != null))
            switch (s) {
              case "value":
                c = S;
                break;
              case "defaultValue":
                h = S;
                break;
              case "multiple":
                i = S;
              default:
                Nt(t, e, s, S, a, null);
            }
        ((e = c),
          (a = h),
          (t.multiple = !!i),
          e != null ? _l(t, !!i, e, !1) : a != null && _l(t, !!i, a, !0));
        return;
      case "textarea":
        (_t("invalid", t), (c = s = i = null));
        for (h in a)
          if (a.hasOwnProperty(h) && ((S = a[h]), S != null))
            switch (h) {
              case "value":
                i = S;
                break;
              case "defaultValue":
                s = S;
                break;
              case "children":
                c = S;
                break;
              case "dangerouslySetInnerHTML":
                if (S != null) throw Error(r(91));
                break;
              default:
                Nt(t, e, h, S, a, null);
            }
        nd(t, i, s, c);
        return;
      case "option":
        for (A in a)
          if (a.hasOwnProperty(A) && ((i = a[A]), i != null))
            switch (A) {
              case "selected":
                t.selected = i && typeof i != "function" && typeof i != "symbol";
                break;
              default:
                Nt(t, e, A, i, a, null);
            }
        return;
      case "dialog":
        (_t("beforetoggle", t), _t("toggle", t), _t("cancel", t), _t("close", t));
        break;
      case "iframe":
      case "object":
        _t("load", t);
        break;
      case "video":
      case "audio":
        for (i = 0; i < nu.length; i++) _t(nu[i], t);
        break;
      case "image":
        (_t("error", t), _t("load", t));
        break;
      case "details":
        _t("toggle", t);
        break;
      case "embed":
      case "source":
      case "link":
        (_t("error", t), _t("load", t));
      case "area":
      case "base":
      case "br":
      case "col":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "track":
      case "wbr":
      case "menuitem":
        for (N in a)
          if (a.hasOwnProperty(N) && ((i = a[N]), i != null))
            switch (N) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(r(137, e));
              default:
                Nt(t, e, N, i, a, null);
            }
        return;
      default:
        if (Hs(e)) {
          for (Q in a)
            a.hasOwnProperty(Q) && ((i = a[Q]), i !== void 0 && Ao(t, e, Q, i, a, void 0));
          return;
        }
    }
    for (S in a) a.hasOwnProperty(S) && ((i = a[S]), i != null && Nt(t, e, S, i, a, null));
  }
  function fS(t, e, a, i) {
    switch (e) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "input":
        var s = null,
          c = null,
          h = null,
          S = null,
          A = null,
          N = null,
          Q = null;
        for (H in a) {
          var K = a[H];
          if (a.hasOwnProperty(H) && K != null)
            switch (H) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                A = K;
              default:
                i.hasOwnProperty(H) || Nt(t, e, H, null, i, K);
            }
        }
        for (var B in i) {
          var H = i[B];
          if (((K = a[B]), i.hasOwnProperty(B) && (H != null || K != null)))
            switch (B) {
              case "type":
                c = H;
                break;
              case "name":
                s = H;
                break;
              case "checked":
                N = H;
                break;
              case "defaultChecked":
                Q = H;
                break;
              case "value":
                h = H;
                break;
              case "defaultValue":
                S = H;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (H != null) throw Error(r(137, e));
                break;
              default:
                H !== K && Nt(t, e, B, H, i, K);
            }
        }
        js(t, h, S, A, N, Q, c, s);
        return;
      case "select":
        H = h = S = B = null;
        for (c in a)
          if (((A = a[c]), a.hasOwnProperty(c) && A != null))
            switch (c) {
              case "value":
                break;
              case "multiple":
                H = A;
              default:
                i.hasOwnProperty(c) || Nt(t, e, c, null, i, A);
            }
        for (s in i)
          if (((c = i[s]), (A = a[s]), i.hasOwnProperty(s) && (c != null || A != null)))
            switch (s) {
              case "value":
                B = c;
                break;
              case "defaultValue":
                S = c;
                break;
              case "multiple":
                h = c;
              default:
                c !== A && Nt(t, e, s, c, i, A);
            }
        ((e = S),
          (a = h),
          (i = H),
          B != null
            ? _l(t, !!a, B, !1)
            : !!i != !!a && (e != null ? _l(t, !!a, e, !0) : _l(t, !!a, a ? [] : "", !1)));
        return;
      case "textarea":
        H = B = null;
        for (S in a)
          if (((s = a[S]), a.hasOwnProperty(S) && s != null && !i.hasOwnProperty(S)))
            switch (S) {
              case "value":
                break;
              case "children":
                break;
              default:
                Nt(t, e, S, null, i, s);
            }
        for (h in i)
          if (((s = i[h]), (c = a[h]), i.hasOwnProperty(h) && (s != null || c != null)))
            switch (h) {
              case "value":
                B = s;
                break;
              case "defaultValue":
                H = s;
                break;
              case "children":
                break;
              case "dangerouslySetInnerHTML":
                if (s != null) throw Error(r(91));
                break;
              default:
                s !== c && Nt(t, e, h, s, i, c);
            }
        ed(t, B, H);
        return;
      case "option":
        for (var lt in a)
          if (((B = a[lt]), a.hasOwnProperty(lt) && B != null && !i.hasOwnProperty(lt)))
            switch (lt) {
              case "selected":
                t.selected = !1;
                break;
              default:
                Nt(t, e, lt, null, i, B);
            }
        for (A in i)
          if (((B = i[A]), (H = a[A]), i.hasOwnProperty(A) && B !== H && (B != null || H != null)))
            switch (A) {
              case "selected":
                t.selected = B && typeof B != "function" && typeof B != "symbol";
                break;
              default:
                Nt(t, e, A, B, i, H);
            }
        return;
      case "img":
      case "link":
      case "area":
      case "base":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "source":
      case "track":
      case "wbr":
      case "menuitem":
        for (var ft in a)
          ((B = a[ft]),
            a.hasOwnProperty(ft) && B != null && !i.hasOwnProperty(ft) && Nt(t, e, ft, null, i, B));
        for (N in i)
          if (((B = i[N]), (H = a[N]), i.hasOwnProperty(N) && B !== H && (B != null || H != null)))
            switch (N) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (B != null) throw Error(r(137, e));
                break;
              default:
                Nt(t, e, N, B, i, H);
            }
        return;
      default:
        if (Hs(e)) {
          for (var jt in a)
            ((B = a[jt]),
              a.hasOwnProperty(jt) &&
                B !== void 0 &&
                !i.hasOwnProperty(jt) &&
                Ao(t, e, jt, void 0, i, B));
          for (Q in i)
            ((B = i[Q]),
              (H = a[Q]),
              !i.hasOwnProperty(Q) ||
                B === H ||
                (B === void 0 && H === void 0) ||
                Ao(t, e, Q, B, i, H));
          return;
        }
    }
    for (var D in a)
      ((B = a[D]),
        a.hasOwnProperty(D) && B != null && !i.hasOwnProperty(D) && Nt(t, e, D, null, i, B));
    for (K in i)
      ((B = i[K]),
        (H = a[K]),
        !i.hasOwnProperty(K) || B === H || (B == null && H == null) || Nt(t, e, K, B, i, H));
  }
  function iy(t) {
    switch (t) {
      case "css":
      case "script":
      case "font":
      case "img":
      case "image":
      case "input":
      case "link":
        return !0;
      default:
        return !1;
    }
  }
  function dS() {
    if (typeof performance.getEntriesByType == "function") {
      for (
        var t = 0, e = 0, a = performance.getEntriesByType("resource"), i = 0;
        i < a.length;
        i++
      ) {
        var s = a[i],
          c = s.transferSize,
          h = s.initiatorType,
          S = s.duration;
        if (c && S && iy(h)) {
          for (h = 0, S = s.responseEnd, i += 1; i < a.length; i++) {
            var A = a[i],
              N = A.startTime;
            if (N > S) break;
            var Q = A.transferSize,
              K = A.initiatorType;
            Q && iy(K) && ((A = A.responseEnd), (h += Q * (A < S ? 1 : (S - N) / (A - N))));
          }
          if ((--i, (e += (8 * (c + h)) / (s.duration / 1e3)), t++, 10 < t)) break;
        }
      }
      if (0 < t) return e / t / 1e6;
    }
    return navigator.connection && ((t = navigator.connection.downlink), typeof t == "number")
      ? t
      : 5;
  }
  var xo = null,
    Mo = null;
  function Gr(t) {
    return t.nodeType === 9 ? t : t.ownerDocument;
  }
  function uy(t) {
    switch (t) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function ry(t, e) {
    if (t === 0)
      switch (e) {
        case "svg":
          return 1;
        case "math":
          return 2;
        default:
          return 0;
      }
    return t === 1 && e === "foreignObject" ? 0 : t;
  }
  function wo(t, e) {
    return (
      t === "textarea" ||
      t === "noscript" ||
      typeof e.children == "string" ||
      typeof e.children == "number" ||
      typeof e.children == "bigint" ||
      (typeof e.dangerouslySetInnerHTML == "object" &&
        e.dangerouslySetInnerHTML !== null &&
        e.dangerouslySetInnerHTML.__html != null)
    );
  }
  var Oo = null;
  function hS() {
    var t = window.event;
    return t && t.type === "popstate" ? (t === Oo ? !1 : ((Oo = t), !0)) : ((Oo = null), !1);
  }
  var sy = typeof setTimeout == "function" ? setTimeout : void 0,
    mS = typeof clearTimeout == "function" ? clearTimeout : void 0,
    cy = typeof Promise == "function" ? Promise : void 0,
    yS =
      typeof queueMicrotask == "function"
        ? queueMicrotask
        : typeof cy < "u"
          ? function (t) {
              return cy.resolve(null).then(t).catch(vS);
            }
          : sy;
  function vS(t) {
    setTimeout(function () {
      throw t;
    });
  }
  function ca(t) {
    return t === "head";
  }
  function oy(t, e) {
    var a = e,
      i = 0;
    do {
      var s = a.nextSibling;
      if ((t.removeChild(a), s && s.nodeType === 8))
        if (((a = s.data), a === "/$" || a === "/&")) {
          if (i === 0) {
            (t.removeChild(s), Wl(e));
            return;
          }
          i--;
        } else if (a === "$" || a === "$?" || a === "$~" || a === "$!" || a === "&") i++;
        else if (a === "html") lu(t.ownerDocument.documentElement);
        else if (a === "head") {
          ((a = t.ownerDocument.head), lu(a));
          for (var c = a.firstChild; c; ) {
            var h = c.nextSibling,
              S = c.nodeName;
            (c[Ei] ||
              S === "SCRIPT" ||
              S === "STYLE" ||
              (S === "LINK" && c.rel.toLowerCase() === "stylesheet") ||
              a.removeChild(c),
              (c = h));
          }
        } else a === "body" && lu(t.ownerDocument.body);
      a = s;
    } while (a);
    Wl(e);
  }
  function fy(t, e) {
    var a = t;
    t = 0;
    do {
      var i = a.nextSibling;
      if (
        (a.nodeType === 1
          ? e
            ? ((a._stashedDisplay = a.style.display), (a.style.display = "none"))
            : ((a.style.display = a._stashedDisplay || ""),
              a.getAttribute("style") === "" && a.removeAttribute("style"))
          : a.nodeType === 3 &&
            (e
              ? ((a._stashedText = a.nodeValue), (a.nodeValue = ""))
              : (a.nodeValue = a._stashedText || "")),
        i && i.nodeType === 8)
      )
        if (((a = i.data), a === "/$")) {
          if (t === 0) break;
          t--;
        } else (a !== "$" && a !== "$?" && a !== "$~" && a !== "$!") || t++;
      a = i;
    } while (a);
  }
  function Co(t) {
    var e = t.firstChild;
    for (e && e.nodeType === 10 && (e = e.nextSibling); e; ) {
      var a = e;
      switch (((e = e.nextSibling), a.nodeName)) {
        case "HTML":
        case "HEAD":
        case "BODY":
          (Co(a), Ls(a));
          continue;
        case "SCRIPT":
        case "STYLE":
          continue;
        case "LINK":
          if (a.rel.toLowerCase() === "stylesheet") continue;
      }
      t.removeChild(a);
    }
  }
  function gS(t, e, a, i) {
    for (; t.nodeType === 1; ) {
      var s = a;
      if (t.nodeName.toLowerCase() !== e.toLowerCase()) {
        if (!i && (t.nodeName !== "INPUT" || t.type !== "hidden")) break;
      } else if (i) {
        if (!t[Ei])
          switch (e) {
            case "meta":
              if (!t.hasAttribute("itemprop")) break;
              return t;
            case "link":
              if (
                ((c = t.getAttribute("rel")),
                c === "stylesheet" && t.hasAttribute("data-precedence"))
              )
                break;
              if (
                c !== s.rel ||
                t.getAttribute("href") !== (s.href == null || s.href === "" ? null : s.href) ||
                t.getAttribute("crossorigin") !== (s.crossOrigin == null ? null : s.crossOrigin) ||
                t.getAttribute("title") !== (s.title == null ? null : s.title)
              )
                break;
              return t;
            case "style":
              if (t.hasAttribute("data-precedence")) break;
              return t;
            case "script":
              if (
                ((c = t.getAttribute("src")),
                (c !== (s.src == null ? null : s.src) ||
                  t.getAttribute("type") !== (s.type == null ? null : s.type) ||
                  t.getAttribute("crossorigin") !==
                    (s.crossOrigin == null ? null : s.crossOrigin)) &&
                  c &&
                  t.hasAttribute("async") &&
                  !t.hasAttribute("itemprop"))
              )
                break;
              return t;
            default:
              return t;
          }
      } else if (e === "input" && t.type === "hidden") {
        var c = s.name == null ? null : "" + s.name;
        if (s.type === "hidden" && t.getAttribute("name") === c) return t;
      } else return t;
      if (((t = Fe(t.nextSibling)), t === null)) break;
    }
    return null;
  }
  function pS(t, e, a) {
    if (e === "") return null;
    for (; t.nodeType !== 3; )
      if (
        ((t.nodeType !== 1 || t.nodeName !== "INPUT" || t.type !== "hidden") && !a) ||
        ((t = Fe(t.nextSibling)), t === null)
      )
        return null;
    return t;
  }
  function dy(t, e) {
    for (; t.nodeType !== 8; )
      if (
        ((t.nodeType !== 1 || t.nodeName !== "INPUT" || t.type !== "hidden") && !e) ||
        ((t = Fe(t.nextSibling)), t === null)
      )
        return null;
    return t;
  }
  function zo(t) {
    return t.data === "$?" || t.data === "$~";
  }
  function Do(t) {
    return t.data === "$!" || (t.data === "$?" && t.ownerDocument.readyState !== "loading");
  }
  function SS(t, e) {
    var a = t.ownerDocument;
    if (t.data === "$~") t._reactRetry = e;
    else if (t.data !== "$?" || a.readyState !== "loading") e();
    else {
      var i = function () {
        (e(), a.removeEventListener("DOMContentLoaded", i));
      };
      (a.addEventListener("DOMContentLoaded", i), (t._reactRetry = i));
    }
  }
  function Fe(t) {
    for (; t != null; t = t.nextSibling) {
      var e = t.nodeType;
      if (e === 1 || e === 3) break;
      if (e === 8) {
        if (
          ((e = t.data),
          e === "$" ||
            e === "$!" ||
            e === "$?" ||
            e === "$~" ||
            e === "&" ||
            e === "F!" ||
            e === "F")
        )
          break;
        if (e === "/$" || e === "/&") return null;
      }
    }
    return t;
  }
  var Uo = null;
  function hy(t) {
    t = t.nextSibling;
    for (var e = 0; t; ) {
      if (t.nodeType === 8) {
        var a = t.data;
        if (a === "/$" || a === "/&") {
          if (e === 0) return Fe(t.nextSibling);
          e--;
        } else (a !== "$" && a !== "$!" && a !== "$?" && a !== "$~" && a !== "&") || e++;
      }
      t = t.nextSibling;
    }
    return null;
  }
  function my(t) {
    t = t.previousSibling;
    for (var e = 0; t; ) {
      if (t.nodeType === 8) {
        var a = t.data;
        if (a === "$" || a === "$!" || a === "$?" || a === "$~" || a === "&") {
          if (e === 0) return t;
          e--;
        } else (a !== "/$" && a !== "/&") || e++;
      }
      t = t.previousSibling;
    }
    return null;
  }
  function yy(t, e, a) {
    switch (((e = Gr(a)), t)) {
      case "html":
        if (((t = e.documentElement), !t)) throw Error(r(452));
        return t;
      case "head":
        if (((t = e.head), !t)) throw Error(r(453));
        return t;
      case "body":
        if (((t = e.body), !t)) throw Error(r(454));
        return t;
      default:
        throw Error(r(451));
    }
  }
  function lu(t) {
    for (var e = t.attributes; e.length; ) t.removeAttributeNode(e[0]);
    Ls(t);
  }
  var ke = new Map(),
    vy = new Set();
  function Vr(t) {
    return typeof t.getRootNode == "function"
      ? t.getRootNode()
      : t.nodeType === 9
        ? t
        : t.ownerDocument;
  }
  var jn = P.d;
  P.d = { f: bS, r: _S, D: ES, C: RS, L: TS, m: AS, X: MS, S: xS, M: wS };
  function bS() {
    var t = jn.f(),
      e = Lr();
    return t || e;
  }
  function _S(t) {
    var e = pl(t);
    e !== null && e.tag === 5 && e.type === "form" ? Uh(e) : jn.r(t);
  }
  var kl = typeof document > "u" ? null : document;
  function gy(t, e, a) {
    var i = kl;
    if (i && typeof e == "string" && e) {
      var s = Ge(e);
      ((s = 'link[rel="' + t + '"][href="' + s + '"]'),
        typeof a == "string" && (s += '[crossorigin="' + a + '"]'),
        vy.has(s) ||
          (vy.add(s),
          (t = { rel: t, crossOrigin: a, href: e }),
          i.querySelector(s) === null &&
            ((e = i.createElement("link")), he(e, "link", t), le(e), i.head.appendChild(e))));
    }
  }
  function ES(t) {
    (jn.D(t), gy("dns-prefetch", t, null));
  }
  function RS(t, e) {
    (jn.C(t, e), gy("preconnect", t, e));
  }
  function TS(t, e, a) {
    jn.L(t, e, a);
    var i = kl;
    if (i && t && e) {
      var s = 'link[rel="preload"][as="' + Ge(e) + '"]';
      e === "image" && a && a.imageSrcSet
        ? ((s += '[imagesrcset="' + Ge(a.imageSrcSet) + '"]'),
          typeof a.imageSizes == "string" && (s += '[imagesizes="' + Ge(a.imageSizes) + '"]'))
        : (s += '[href="' + Ge(t) + '"]');
      var c = s;
      switch (e) {
        case "style":
          c = Il(t);
          break;
        case "script":
          c = $l(t);
      }
      ke.has(c) ||
        ((t = g(
          { rel: "preload", href: e === "image" && a && a.imageSrcSet ? void 0 : t, as: e },
          a,
        )),
        ke.set(c, t),
        i.querySelector(s) !== null ||
          (e === "style" && i.querySelector(iu(c))) ||
          (e === "script" && i.querySelector(uu(c))) ||
          ((e = i.createElement("link")), he(e, "link", t), le(e), i.head.appendChild(e)));
    }
  }
  function AS(t, e) {
    jn.m(t, e);
    var a = kl;
    if (a && t) {
      var i = e && typeof e.as == "string" ? e.as : "script",
        s = 'link[rel="modulepreload"][as="' + Ge(i) + '"][href="' + Ge(t) + '"]',
        c = s;
      switch (i) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          c = $l(t);
      }
      if (
        !ke.has(c) &&
        ((t = g({ rel: "modulepreload", href: t }, e)), ke.set(c, t), a.querySelector(s) === null)
      ) {
        switch (i) {
          case "audioworklet":
          case "paintworklet":
          case "serviceworker":
          case "sharedworker":
          case "worker":
          case "script":
            if (a.querySelector(uu(c))) return;
        }
        ((i = a.createElement("link")), he(i, "link", t), le(i), a.head.appendChild(i));
      }
    }
  }
  function xS(t, e, a) {
    jn.S(t, e, a);
    var i = kl;
    if (i && t) {
      var s = Sl(i).hoistableStyles,
        c = Il(t);
      e = e || "default";
      var h = s.get(c);
      if (!h) {
        var S = { loading: 0, preload: null };
        if ((h = i.querySelector(iu(c)))) S.loading = 5;
        else {
          ((t = g({ rel: "stylesheet", href: t, "data-precedence": e }, a)),
            (a = ke.get(c)) && Lo(t, a));
          var A = (h = i.createElement("link"));
          (le(A),
            he(A, "link", t),
            (A._p = new Promise(function (N, Q) {
              ((A.onload = N), (A.onerror = Q));
            })),
            A.addEventListener("load", function () {
              S.loading |= 1;
            }),
            A.addEventListener("error", function () {
              S.loading |= 2;
            }),
            (S.loading |= 4),
            Xr(h, e, i));
        }
        ((h = { type: "stylesheet", instance: h, count: 1, state: S }), s.set(c, h));
      }
    }
  }
  function MS(t, e) {
    jn.X(t, e);
    var a = kl;
    if (a && t) {
      var i = Sl(a).hoistableScripts,
        s = $l(t),
        c = i.get(s);
      c ||
        ((c = a.querySelector(uu(s))),
        c ||
          ((t = g({ src: t, async: !0 }, e)),
          (e = ke.get(s)) && No(t, e),
          (c = a.createElement("script")),
          le(c),
          he(c, "link", t),
          a.head.appendChild(c)),
        (c = { type: "script", instance: c, count: 1, state: null }),
        i.set(s, c));
    }
  }
  function wS(t, e) {
    jn.M(t, e);
    var a = kl;
    if (a && t) {
      var i = Sl(a).hoistableScripts,
        s = $l(t),
        c = i.get(s);
      c ||
        ((c = a.querySelector(uu(s))),
        c ||
          ((t = g({ src: t, async: !0, type: "module" }, e)),
          (e = ke.get(s)) && No(t, e),
          (c = a.createElement("script")),
          le(c),
          he(c, "link", t),
          a.head.appendChild(c)),
        (c = { type: "script", instance: c, count: 1, state: null }),
        i.set(s, c));
    }
  }
  function py(t, e, a, i) {
    var s = (s = St.current) ? Vr(s) : null;
    if (!s) throw Error(r(446));
    switch (t) {
      case "meta":
      case "title":
        return null;
      case "style":
        return typeof a.precedence == "string" && typeof a.href == "string"
          ? ((e = Il(a.href)),
            (a = Sl(s).hoistableStyles),
            (i = a.get(e)),
            i || ((i = { type: "style", instance: null, count: 0, state: null }), a.set(e, i)),
            i)
          : { type: "void", instance: null, count: 0, state: null };
      case "link":
        if (
          a.rel === "stylesheet" &&
          typeof a.href == "string" &&
          typeof a.precedence == "string"
        ) {
          t = Il(a.href);
          var c = Sl(s).hoistableStyles,
            h = c.get(t);
          if (
            (h ||
              ((s = s.ownerDocument || s),
              (h = {
                type: "stylesheet",
                instance: null,
                count: 0,
                state: { loading: 0, preload: null },
              }),
              c.set(t, h),
              (c = s.querySelector(iu(t))) && !c._p && ((h.instance = c), (h.state.loading = 5)),
              ke.has(t) ||
                ((a = {
                  rel: "preload",
                  as: "style",
                  href: a.href,
                  crossOrigin: a.crossOrigin,
                  integrity: a.integrity,
                  media: a.media,
                  hrefLang: a.hrefLang,
                  referrerPolicy: a.referrerPolicy,
                }),
                ke.set(t, a),
                c || OS(s, t, a, h.state))),
            e && i === null)
          )
            throw Error(r(528, ""));
          return h;
        }
        if (e && i !== null) throw Error(r(529, ""));
        return null;
      case "script":
        return (
          (e = a.async),
          (a = a.src),
          typeof a == "string" && e && typeof e != "function" && typeof e != "symbol"
            ? ((e = $l(a)),
              (a = Sl(s).hoistableScripts),
              (i = a.get(e)),
              i || ((i = { type: "script", instance: null, count: 0, state: null }), a.set(e, i)),
              i)
            : { type: "void", instance: null, count: 0, state: null }
        );
      default:
        throw Error(r(444, t));
    }
  }
  function Il(t) {
    return 'href="' + Ge(t) + '"';
  }
  function iu(t) {
    return 'link[rel="stylesheet"][' + t + "]";
  }
  function Sy(t) {
    return g({}, t, { "data-precedence": t.precedence, precedence: null });
  }
  function OS(t, e, a, i) {
    t.querySelector('link[rel="preload"][as="style"][' + e + "]")
      ? (i.loading = 1)
      : ((e = t.createElement("link")),
        (i.preload = e),
        e.addEventListener("load", function () {
          return (i.loading |= 1);
        }),
        e.addEventListener("error", function () {
          return (i.loading |= 2);
        }),
        he(e, "link", a),
        le(e),
        t.head.appendChild(e));
  }
  function $l(t) {
    return '[src="' + Ge(t) + '"]';
  }
  function uu(t) {
    return "script[async]" + t;
  }
  function by(t, e, a) {
    if ((e.count++, e.instance === null))
      switch (e.type) {
        case "style":
          var i = t.querySelector('style[data-href~="' + Ge(a.href) + '"]');
          if (i) return ((e.instance = i), le(i), i);
          var s = g({}, a, {
            "data-href": a.href,
            "data-precedence": a.precedence,
            href: null,
            precedence: null,
          });
          return (
            (i = (t.ownerDocument || t).createElement("style")),
            le(i),
            he(i, "style", s),
            Xr(i, a.precedence, t),
            (e.instance = i)
          );
        case "stylesheet":
          s = Il(a.href);
          var c = t.querySelector(iu(s));
          if (c) return ((e.state.loading |= 4), (e.instance = c), le(c), c);
          ((i = Sy(a)),
            (s = ke.get(s)) && Lo(i, s),
            (c = (t.ownerDocument || t).createElement("link")),
            le(c));
          var h = c;
          return (
            (h._p = new Promise(function (S, A) {
              ((h.onload = S), (h.onerror = A));
            })),
            he(c, "link", i),
            (e.state.loading |= 4),
            Xr(c, a.precedence, t),
            (e.instance = c)
          );
        case "script":
          return (
            (c = $l(a.src)),
            (s = t.querySelector(uu(c)))
              ? ((e.instance = s), le(s), s)
              : ((i = a),
                (s = ke.get(c)) && ((i = g({}, a)), No(i, s)),
                (t = t.ownerDocument || t),
                (s = t.createElement("script")),
                le(s),
                he(s, "link", i),
                t.head.appendChild(s),
                (e.instance = s))
          );
        case "void":
          return null;
        default:
          throw Error(r(443, e.type));
      }
    else
      e.type === "stylesheet" &&
        (e.state.loading & 4) === 0 &&
        ((i = e.instance), (e.state.loading |= 4), Xr(i, a.precedence, t));
    return e.instance;
  }
  function Xr(t, e, a) {
    for (
      var i = a.querySelectorAll('link[rel="stylesheet"][data-precedence],style[data-precedence]'),
        s = i.length ? i[i.length - 1] : null,
        c = s,
        h = 0;
      h < i.length;
      h++
    ) {
      var S = i[h];
      if (S.dataset.precedence === e) c = S;
      else if (c !== s) break;
    }
    c
      ? c.parentNode.insertBefore(t, c.nextSibling)
      : ((e = a.nodeType === 9 ? a.head : a), e.insertBefore(t, e.firstChild));
  }
  function Lo(t, e) {
    (t.crossOrigin == null && (t.crossOrigin = e.crossOrigin),
      t.referrerPolicy == null && (t.referrerPolicy = e.referrerPolicy),
      t.title == null && (t.title = e.title));
  }
  function No(t, e) {
    (t.crossOrigin == null && (t.crossOrigin = e.crossOrigin),
      t.referrerPolicy == null && (t.referrerPolicy = e.referrerPolicy),
      t.integrity == null && (t.integrity = e.integrity));
  }
  var Zr = null;
  function _y(t, e, a) {
    if (Zr === null) {
      var i = new Map(),
        s = (Zr = new Map());
      s.set(a, i);
    } else ((s = Zr), (i = s.get(a)), i || ((i = new Map()), s.set(a, i)));
    if (i.has(t)) return i;
    for (i.set(t, null), a = a.getElementsByTagName(t), s = 0; s < a.length; s++) {
      var c = a[s];
      if (
        !(c[Ei] || c[ce] || (t === "link" && c.getAttribute("rel") === "stylesheet")) &&
        c.namespaceURI !== "http://www.w3.org/2000/svg"
      ) {
        var h = c.getAttribute(e) || "";
        h = t + h;
        var S = i.get(h);
        S ? S.push(c) : i.set(h, [c]);
      }
    }
    return i;
  }
  function Ey(t, e, a) {
    ((t = t.ownerDocument || t),
      t.head.insertBefore(a, e === "title" ? t.querySelector("head > title") : null));
  }
  function CS(t, e, a) {
    if (a === 1 || e.itemProp != null) return !1;
    switch (t) {
      case "meta":
      case "title":
        return !0;
      case "style":
        if (typeof e.precedence != "string" || typeof e.href != "string" || e.href === "") break;
        return !0;
      case "link":
        if (
          typeof e.rel != "string" ||
          typeof e.href != "string" ||
          e.href === "" ||
          e.onLoad ||
          e.onError
        )
          break;
        switch (e.rel) {
          case "stylesheet":
            return ((t = e.disabled), typeof e.precedence == "string" && t == null);
          default:
            return !0;
        }
      case "script":
        if (
          e.async &&
          typeof e.async != "function" &&
          typeof e.async != "symbol" &&
          !e.onLoad &&
          !e.onError &&
          e.src &&
          typeof e.src == "string"
        )
          return !0;
    }
    return !1;
  }
  function Ry(t) {
    return !(t.type === "stylesheet" && (t.state.loading & 3) === 0);
  }
  function zS(t, e, a, i) {
    if (
      a.type === "stylesheet" &&
      (typeof i.media != "string" || matchMedia(i.media).matches !== !1) &&
      (a.state.loading & 4) === 0
    ) {
      if (a.instance === null) {
        var s = Il(i.href),
          c = e.querySelector(iu(s));
        if (c) {
          ((e = c._p),
            e !== null &&
              typeof e == "object" &&
              typeof e.then == "function" &&
              (t.count++, (t = Kr.bind(t)), e.then(t, t)),
            (a.state.loading |= 4),
            (a.instance = c),
            le(c));
          return;
        }
        ((c = e.ownerDocument || e),
          (i = Sy(i)),
          (s = ke.get(s)) && Lo(i, s),
          (c = c.createElement("link")),
          le(c));
        var h = c;
        ((h._p = new Promise(function (S, A) {
          ((h.onload = S), (h.onerror = A));
        })),
          he(c, "link", i),
          (a.instance = c));
      }
      (t.stylesheets === null && (t.stylesheets = new Map()),
        t.stylesheets.set(a, e),
        (e = a.state.preload) &&
          (a.state.loading & 3) === 0 &&
          (t.count++,
          (a = Kr.bind(t)),
          e.addEventListener("load", a),
          e.addEventListener("error", a)));
    }
  }
  var jo = 0;
  function DS(t, e) {
    return (
      t.stylesheets && t.count === 0 && Jr(t, t.stylesheets),
      0 < t.count || 0 < t.imgCount
        ? function (a) {
            var i = setTimeout(function () {
              if ((t.stylesheets && Jr(t, t.stylesheets), t.unsuspend)) {
                var c = t.unsuspend;
                ((t.unsuspend = null), c());
              }
            }, 6e4 + e);
            0 < t.imgBytes && jo === 0 && (jo = 62500 * dS());
            var s = setTimeout(
              function () {
                if (
                  ((t.waitingForImages = !1),
                  t.count === 0 && (t.stylesheets && Jr(t, t.stylesheets), t.unsuspend))
                ) {
                  var c = t.unsuspend;
                  ((t.unsuspend = null), c());
                }
              },
              (t.imgBytes > jo ? 50 : 800) + e,
            );
            return (
              (t.unsuspend = a),
              function () {
                ((t.unsuspend = null), clearTimeout(i), clearTimeout(s));
              }
            );
          }
        : null
    );
  }
  function Kr() {
    if ((this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages))) {
      if (this.stylesheets) Jr(this, this.stylesheets);
      else if (this.unsuspend) {
        var t = this.unsuspend;
        ((this.unsuspend = null), t());
      }
    }
  }
  var Pr = null;
  function Jr(t, e) {
    ((t.stylesheets = null),
      t.unsuspend !== null &&
        (t.count++, (Pr = new Map()), e.forEach(US, t), (Pr = null), Kr.call(t)));
  }
  function US(t, e) {
    if (!(e.state.loading & 4)) {
      var a = Pr.get(t);
      if (a) var i = a.get(null);
      else {
        ((a = new Map()), Pr.set(t, a));
        for (
          var s = t.querySelectorAll("link[data-precedence],style[data-precedence]"), c = 0;
          c < s.length;
          c++
        ) {
          var h = s[c];
          (h.nodeName === "LINK" || h.getAttribute("media") !== "not all") &&
            (a.set(h.dataset.precedence, h), (i = h));
        }
        i && a.set(null, i);
      }
      ((s = e.instance),
        (h = s.getAttribute("data-precedence")),
        (c = a.get(h) || i),
        c === i && a.set(null, s),
        a.set(h, s),
        this.count++,
        (i = Kr.bind(this)),
        s.addEventListener("load", i),
        s.addEventListener("error", i),
        c
          ? c.parentNode.insertBefore(s, c.nextSibling)
          : ((t = t.nodeType === 9 ? t.head : t), t.insertBefore(s, t.firstChild)),
        (e.state.loading |= 4));
    }
  }
  var ru = {
    $$typeof: C,
    Provider: null,
    Consumer: null,
    _currentValue: nt,
    _currentValue2: nt,
    _threadCount: 0,
  };
  function LS(t, e, a, i, s, c, h, S, A) {
    ((this.tag = 1),
      (this.containerInfo = t),
      (this.pingCache = this.current = this.pendingChildren = null),
      (this.timeoutHandle = -1),
      (this.callbackNode =
        this.next =
        this.pendingContext =
        this.context =
        this.cancelPendingCommit =
          null),
      (this.callbackPriority = 0),
      (this.expirationTimes = Cs(-1)),
      (this.entangledLanes =
        this.shellSuspendCounter =
        this.errorRecoveryDisabledLanes =
        this.expiredLanes =
        this.warmLanes =
        this.pingedLanes =
        this.suspendedLanes =
        this.pendingLanes =
          0),
      (this.entanglements = Cs(0)),
      (this.hiddenUpdates = Cs(null)),
      (this.identifierPrefix = i),
      (this.onUncaughtError = s),
      (this.onCaughtError = c),
      (this.onRecoverableError = h),
      (this.pooledCache = null),
      (this.pooledCacheLanes = 0),
      (this.formState = A),
      (this.incompleteTransitions = new Map()));
  }
  function Ty(t, e, a, i, s, c, h, S, A, N, Q, K) {
    return (
      (t = new LS(t, e, a, h, A, N, Q, K, S)),
      (e = 1),
      c === !0 && (e |= 24),
      (c = Le(3, null, null, e)),
      (t.current = c),
      (c.stateNode = t),
      (e = mc()),
      e.refCount++,
      (t.pooledCache = e),
      e.refCount++,
      (c.memoizedState = { element: i, isDehydrated: a, cache: e }),
      pc(c),
      t
    );
  }
  function Ay(t) {
    return t ? ((t = Ol), t) : Ol;
  }
  function xy(t, e, a, i, s, c) {
    ((s = Ay(s)),
      i.context === null ? (i.context = s) : (i.pendingContext = s),
      (i = $n(e)),
      (i.payload = { element: a }),
      (c = c === void 0 ? null : c),
      c !== null && (i.callback = c),
      (a = Wn(t, i, e)),
      a !== null && (we(a, t, e), qi(a, t, e)));
  }
  function My(t, e) {
    if (((t = t.memoizedState), t !== null && t.dehydrated !== null)) {
      var a = t.retryLane;
      t.retryLane = a !== 0 && a < e ? a : e;
    }
  }
  function Bo(t, e) {
    (My(t, e), (t = t.alternate) && My(t, e));
  }
  function wy(t) {
    if (t.tag === 13 || t.tag === 31) {
      var e = Ha(t, 67108864);
      (e !== null && we(e, t, 67108864), Bo(t, 67108864));
    }
  }
  function Oy(t) {
    if (t.tag === 13 || t.tag === 31) {
      var e = qe();
      e = zs(e);
      var a = Ha(t, e);
      (a !== null && we(a, t, e), Bo(t, e));
    }
  }
  var Fr = !0;
  function NS(t, e, a, i) {
    var s = j.T;
    j.T = null;
    var c = P.p;
    try {
      ((P.p = 2), Ho(t, e, a, i));
    } finally {
      ((P.p = c), (j.T = s));
    }
  }
  function jS(t, e, a, i) {
    var s = j.T;
    j.T = null;
    var c = P.p;
    try {
      ((P.p = 8), Ho(t, e, a, i));
    } finally {
      ((P.p = c), (j.T = s));
    }
  }
  function Ho(t, e, a, i) {
    if (Fr) {
      var s = qo(i);
      if (s === null) (To(t, e, i, kr, a), zy(t, i));
      else if (HS(s, t, e, a, i)) i.stopPropagation();
      else if ((zy(t, i), e & 4 && -1 < BS.indexOf(t))) {
        for (; s !== null; ) {
          var c = pl(s);
          if (c !== null)
            switch (c.tag) {
              case 3:
                if (((c = c.stateNode), c.current.memoizedState.isDehydrated)) {
                  var h = Ua(c.pendingLanes);
                  if (h !== 0) {
                    var S = c;
                    for (S.pendingLanes |= 2, S.entangledLanes |= 2; h; ) {
                      var A = 1 << (31 - De(h));
                      ((S.entanglements[1] |= A), (h &= ~A));
                    }
                    (on(c), (Ct & 6) === 0 && ((Dr = ye() + 500), eu(0)));
                  }
                }
                break;
              case 31:
              case 13:
                ((S = Ha(c, 2)), S !== null && we(S, c, 2), Lr(), Bo(c, 2));
            }
          if (((c = qo(i)), c === null && To(t, e, i, kr, a), c === s)) break;
          s = c;
        }
        s !== null && i.stopPropagation();
      } else To(t, e, i, null, a);
    }
  }
  function qo(t) {
    return ((t = Ys(t)), Yo(t));
  }
  var kr = null;
  function Yo(t) {
    if (((kr = null), (t = gl(t)), t !== null)) {
      var e = f(t);
      if (e === null) t = null;
      else {
        var a = e.tag;
        if (a === 13) {
          if (((t = d(e)), t !== null)) return t;
          t = null;
        } else if (a === 31) {
          if (((t = m(e)), t !== null)) return t;
          t = null;
        } else if (a === 3) {
          if (e.stateNode.current.memoizedState.isDehydrated)
            return e.tag === 3 ? e.stateNode.containerInfo : null;
          t = null;
        } else e !== t && (t = null);
      }
    }
    return ((kr = t), null);
  }
  function Cy(t) {
    switch (t) {
      case "beforetoggle":
      case "cancel":
      case "click":
      case "close":
      case "contextmenu":
      case "copy":
      case "cut":
      case "auxclick":
      case "dblclick":
      case "dragend":
      case "dragstart":
      case "drop":
      case "focusin":
      case "focusout":
      case "input":
      case "invalid":
      case "keydown":
      case "keypress":
      case "keyup":
      case "mousedown":
      case "mouseup":
      case "paste":
      case "pause":
      case "play":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
      case "ratechange":
      case "reset":
      case "resize":
      case "seeked":
      case "submit":
      case "toggle":
      case "touchcancel":
      case "touchend":
      case "touchstart":
      case "volumechange":
      case "change":
      case "selectionchange":
      case "textInput":
      case "compositionstart":
      case "compositionend":
      case "compositionupdate":
      case "beforeblur":
      case "afterblur":
      case "beforeinput":
      case "blur":
      case "fullscreenchange":
      case "focus":
      case "hashchange":
      case "popstate":
      case "select":
      case "selectstart":
        return 2;
      case "drag":
      case "dragenter":
      case "dragexit":
      case "dragleave":
      case "dragover":
      case "mousemove":
      case "mouseout":
      case "mouseover":
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "scroll":
      case "touchmove":
      case "wheel":
      case "mouseenter":
      case "mouseleave":
      case "pointerenter":
      case "pointerleave":
        return 8;
      case "message":
        switch (Ut()) {
          case se:
            return 2;
          case un:
            return 8;
          case yl:
          case Rp:
            return 32;
          case Yf:
            return 268435456;
          default:
            return 32;
        }
      default:
        return 32;
    }
  }
  var Qo = !1,
    oa = null,
    fa = null,
    da = null,
    su = new Map(),
    cu = new Map(),
    ha = [],
    BS =
      "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
        " ",
      );
  function zy(t, e) {
    switch (t) {
      case "focusin":
      case "focusout":
        oa = null;
        break;
      case "dragenter":
      case "dragleave":
        fa = null;
        break;
      case "mouseover":
      case "mouseout":
        da = null;
        break;
      case "pointerover":
      case "pointerout":
        su.delete(e.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        cu.delete(e.pointerId);
    }
  }
  function ou(t, e, a, i, s, c) {
    return t === null || t.nativeEvent !== c
      ? ((t = {
          blockedOn: e,
          domEventName: a,
          eventSystemFlags: i,
          nativeEvent: c,
          targetContainers: [s],
        }),
        e !== null && ((e = pl(e)), e !== null && wy(e)),
        t)
      : ((t.eventSystemFlags |= i),
        (e = t.targetContainers),
        s !== null && e.indexOf(s) === -1 && e.push(s),
        t);
  }
  function HS(t, e, a, i, s) {
    switch (e) {
      case "focusin":
        return ((oa = ou(oa, t, e, a, i, s)), !0);
      case "dragenter":
        return ((fa = ou(fa, t, e, a, i, s)), !0);
      case "mouseover":
        return ((da = ou(da, t, e, a, i, s)), !0);
      case "pointerover":
        var c = s.pointerId;
        return (su.set(c, ou(su.get(c) || null, t, e, a, i, s)), !0);
      case "gotpointercapture":
        return ((c = s.pointerId), cu.set(c, ou(cu.get(c) || null, t, e, a, i, s)), !0);
    }
    return !1;
  }
  function Dy(t) {
    var e = gl(t.target);
    if (e !== null) {
      var a = f(e);
      if (a !== null) {
        if (((e = a.tag), e === 13)) {
          if (((e = d(a)), e !== null)) {
            ((t.blockedOn = e),
              Kf(t.priority, function () {
                Oy(a);
              }));
            return;
          }
        } else if (e === 31) {
          if (((e = m(a)), e !== null)) {
            ((t.blockedOn = e),
              Kf(t.priority, function () {
                Oy(a);
              }));
            return;
          }
        } else if (e === 3 && a.stateNode.current.memoizedState.isDehydrated) {
          t.blockedOn = a.tag === 3 ? a.stateNode.containerInfo : null;
          return;
        }
      }
    }
    t.blockedOn = null;
  }
  function Ir(t) {
    if (t.blockedOn !== null) return !1;
    for (var e = t.targetContainers; 0 < e.length; ) {
      var a = qo(t.nativeEvent);
      if (a === null) {
        a = t.nativeEvent;
        var i = new a.constructor(a.type, a);
        ((qs = i), a.target.dispatchEvent(i), (qs = null));
      } else return ((e = pl(a)), e !== null && wy(e), (t.blockedOn = a), !1);
      e.shift();
    }
    return !0;
  }
  function Uy(t, e, a) {
    Ir(t) && a.delete(e);
  }
  function qS() {
    ((Qo = !1),
      oa !== null && Ir(oa) && (oa = null),
      fa !== null && Ir(fa) && (fa = null),
      da !== null && Ir(da) && (da = null),
      su.forEach(Uy),
      cu.forEach(Uy));
  }
  function $r(t, e) {
    t.blockedOn === e &&
      ((t.blockedOn = null),
      Qo || ((Qo = !0), n.unstable_scheduleCallback(n.unstable_NormalPriority, qS)));
  }
  var Wr = null;
  function Ly(t) {
    Wr !== t &&
      ((Wr = t),
      n.unstable_scheduleCallback(n.unstable_NormalPriority, function () {
        Wr === t && (Wr = null);
        for (var e = 0; e < t.length; e += 3) {
          var a = t[e],
            i = t[e + 1],
            s = t[e + 2];
          if (typeof i != "function") {
            if (Yo(i || a) === null) continue;
            break;
          }
          var c = pl(a);
          c !== null &&
            (t.splice(e, 3),
            (e -= 3),
            Hc(c, { pending: !0, data: s, method: a.method, action: i }, i, s));
        }
      }));
  }
  function Wl(t) {
    function e(A) {
      return $r(A, t);
    }
    (oa !== null && $r(oa, t),
      fa !== null && $r(fa, t),
      da !== null && $r(da, t),
      su.forEach(e),
      cu.forEach(e));
    for (var a = 0; a < ha.length; a++) {
      var i = ha[a];
      i.blockedOn === t && (i.blockedOn = null);
    }
    for (; 0 < ha.length && ((a = ha[0]), a.blockedOn === null); )
      (Dy(a), a.blockedOn === null && ha.shift());
    if (((a = (t.ownerDocument || t).$$reactFormReplay), a != null))
      for (i = 0; i < a.length; i += 3) {
        var s = a[i],
          c = a[i + 1],
          h = s[Ee] || null;
        if (typeof c == "function") h || Ly(a);
        else if (h) {
          var S = null;
          if (c && c.hasAttribute("formAction")) {
            if (((s = c), (h = c[Ee] || null))) S = h.formAction;
            else if (Yo(s) !== null) continue;
          } else S = h.action;
          (typeof S == "function" ? (a[i + 1] = S) : (a.splice(i, 3), (i -= 3)), Ly(a));
        }
      }
  }
  function Ny() {
    function t(c) {
      c.canIntercept &&
        c.info === "react-transition" &&
        c.intercept({
          handler: function () {
            return new Promise(function (h) {
              return (s = h);
            });
          },
          focusReset: "manual",
          scroll: "manual",
        });
    }
    function e() {
      (s !== null && (s(), (s = null)), i || setTimeout(a, 20));
    }
    function a() {
      if (!i && !navigation.transition) {
        var c = navigation.currentEntry;
        c &&
          c.url != null &&
          navigation.navigate(c.url, {
            state: c.getState(),
            info: "react-transition",
            history: "replace",
          });
      }
    }
    if (typeof navigation == "object") {
      var i = !1,
        s = null;
      return (
        navigation.addEventListener("navigate", t),
        navigation.addEventListener("navigatesuccess", e),
        navigation.addEventListener("navigateerror", e),
        setTimeout(a, 100),
        function () {
          ((i = !0),
            navigation.removeEventListener("navigate", t),
            navigation.removeEventListener("navigatesuccess", e),
            navigation.removeEventListener("navigateerror", e),
            s !== null && (s(), (s = null)));
        }
      );
    }
  }
  function Go(t) {
    this._internalRoot = t;
  }
  ((ts.prototype.render = Go.prototype.render =
    function (t) {
      var e = this._internalRoot;
      if (e === null) throw Error(r(409));
      var a = e.current,
        i = qe();
      xy(a, i, t, e, null, null);
    }),
    (ts.prototype.unmount = Go.prototype.unmount =
      function () {
        var t = this._internalRoot;
        if (t !== null) {
          this._internalRoot = null;
          var e = t.containerInfo;
          (xy(t.current, 2, null, t, null, null), Lr(), (e[vl] = null));
        }
      }));
  function ts(t) {
    this._internalRoot = t;
  }
  ts.prototype.unstable_scheduleHydration = function (t) {
    if (t) {
      var e = Zf();
      t = { blockedOn: null, target: t, priority: e };
      for (var a = 0; a < ha.length && e !== 0 && e < ha[a].priority; a++);
      (ha.splice(a, 0, t), a === 0 && Dy(t));
    }
  };
  var jy = l.version;
  if (jy !== "19.2.5") throw Error(r(527, jy, "19.2.5"));
  P.findDOMNode = function (t) {
    var e = t._reactInternals;
    if (e === void 0)
      throw typeof t.render == "function"
        ? Error(r(188))
        : ((t = Object.keys(t).join(",")), Error(r(268, t)));
    return ((t = v(e)), (t = t !== null ? p(t) : null), (t = t === null ? null : t.stateNode), t);
  };
  var YS = {
    bundleType: 0,
    version: "19.2.5",
    rendererPackageName: "react-dom",
    currentDispatcherRef: j,
    reconcilerVersion: "19.2.5",
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var es = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!es.isDisabled && es.supportsFiber)
      try {
        ((Si = es.inject(YS)), (ze = es));
      } catch {}
  }
  return (
    (du.createRoot = function (t, e) {
      if (!o(t)) throw Error(r(299));
      var a = !1,
        i = "",
        s = Vh,
        c = Xh,
        h = Zh;
      return (
        e != null &&
          (e.unstable_strictMode === !0 && (a = !0),
          e.identifierPrefix !== void 0 && (i = e.identifierPrefix),
          e.onUncaughtError !== void 0 && (s = e.onUncaughtError),
          e.onCaughtError !== void 0 && (c = e.onCaughtError),
          e.onRecoverableError !== void 0 && (h = e.onRecoverableError)),
        (e = Ty(t, 1, !1, null, null, a, i, null, s, c, h, Ny)),
        (t[vl] = e.current),
        Ro(t),
        new Go(e)
      );
    }),
    (du.hydrateRoot = function (t, e, a) {
      if (!o(t)) throw Error(r(299));
      var i = !1,
        s = "",
        c = Vh,
        h = Xh,
        S = Zh,
        A = null;
      return (
        a != null &&
          (a.unstable_strictMode === !0 && (i = !0),
          a.identifierPrefix !== void 0 && (s = a.identifierPrefix),
          a.onUncaughtError !== void 0 && (c = a.onUncaughtError),
          a.onCaughtError !== void 0 && (h = a.onCaughtError),
          a.onRecoverableError !== void 0 && (S = a.onRecoverableError),
          a.formState !== void 0 && (A = a.formState)),
        (e = Ty(t, 1, !0, e, a ?? null, i, s, A, c, h, S, Ny)),
        (e.context = Ay(null)),
        (a = e.current),
        (i = qe()),
        (i = zs(i)),
        (s = $n(i)),
        (s.callback = null),
        Wn(a, s, i),
        (a = i),
        (e.current.lanes = a),
        _i(e, a),
        on(e),
        (t[vl] = e.current),
        Ro(t),
        new ts(e)
      );
    }),
    (du.version = "19.2.5"),
    du
  );
}
var Py;
function kS() {
  if (Py) return Ko.exports;
  Py = 1;
  function n() {
    if (
      !(
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" ||
        typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"
      )
    )
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
      } catch (l) {
        console.error(l);
      }
  }
  return (n(), (Ko.exports = FS()), Ko.exports);
}
var IS = kS(),
  $S = "__TSS_CONTEXT",
  df = Symbol.for("TSS_SERVER_FUNCTION"),
  Jy = Symbol.for("TSS_SERVER_FUNCTION_FACTORY"),
  WS = "application/x-tss-framed",
  Bn = { JSON: 0, CHUNK: 1, END: 2, ERROR: 3 },
  tb = /;\s*v=(\d+)/;
function eb(n) {
  const l = n.match(tb);
  return l ? parseInt(l[1], 10) : void 0;
}
function nb(n) {
  const l = eb(n);
  if (l !== void 0 && l !== 1)
    throw new Error(
      `Incompatible framed protocol version: server=${l}, client=1. Please ensure client and server are using compatible versions.`,
    );
}
var xf = () => window.__TSS_START_OPTIONS__,
  ng = !1;
function Ru(n) {
  return n[n.length - 1];
}
function ab(n) {
  return typeof n == "function";
}
function Ta(n, l) {
  return ab(n) ? n(l) : n;
}
var lb = Object.prototype.hasOwnProperty,
  Fy = Object.prototype.propertyIsEnumerable,
  ib = () => Object.create(null),
  Ia = (n, l) => Wa(n, l, ib);
function Wa(n, l, u = () => ({}), r = 0) {
  if (n === l) return n;
  if (r > 500) return l;
  const o = l,
    f = $y(n) && $y(o);
  if (!f && !(mi(n) && mi(o))) return o;
  const d = f ? n : ky(n);
  if (!d) return o;
  const m = f ? o : ky(o);
  if (!m) return o;
  const y = d.length,
    v = m.length,
    p = f ? new Array(v) : u();
  let g = 0;
  for (let b = 0; b < v; b++) {
    const E = f ? b : m[b],
      R = n[E],
      M = o[E];
    if (R === M) {
      ((p[E] = R), (f ? b < y : lb.call(n, E)) && g++);
      continue;
    }
    if (R === null || M === null || typeof R != "object" || typeof M != "object") {
      p[E] = M;
      continue;
    }
    const x = Wa(R, M, u, r + 1);
    ((p[E] = x), x === R && g++);
  }
  return y === v && g === y ? n : p;
}
function ky(n) {
  const l = Object.getOwnPropertyNames(n);
  for (const o of l) if (!Fy.call(n, o)) return !1;
  const u = Object.getOwnPropertySymbols(n);
  if (u.length === 0) return l;
  const r = l;
  for (const o of u) {
    if (!Fy.call(n, o)) return !1;
    r.push(o);
  }
  return r;
}
function mi(n) {
  if (!Iy(n)) return !1;
  const l = n.constructor;
  if (typeof l > "u") return !0;
  const u = l.prototype;
  return !(!Iy(u) || !u.hasOwnProperty("isPrototypeOf"));
}
function Iy(n) {
  return Object.prototype.toString.call(n) === "[object Object]";
}
function $y(n) {
  return Array.isArray(n) && n.length === Object.keys(n).length;
}
function Oe(n, l, u) {
  if (n === l) return !0;
  if (typeof n != typeof l) return !1;
  if (Array.isArray(n) && Array.isArray(l)) {
    if (n.length !== l.length) return !1;
    for (let r = 0, o = n.length; r < o; r++) if (!Oe(n[r], l[r], u)) return !1;
    return !0;
  }
  if (mi(n) && mi(l)) {
    const r = (u == null ? void 0 : u.ignoreUndefined) ?? !0;
    if (u != null && u.partial) {
      for (const d in l) if ((!r || l[d] !== void 0) && !Oe(n[d], l[d], u)) return !1;
      return !0;
    }
    let o = 0;
    if (!r) o = Object.keys(n).length;
    else for (const d in n) n[d] !== void 0 && o++;
    let f = 0;
    for (const d in l) if ((!r || l[d] !== void 0) && (f++, f > o || !Oe(n[d], l[d], u))) return !1;
    return o === f;
  }
  return !1;
}
function fl(n) {
  let l, u;
  const r = new Promise((o, f) => {
    ((l = o), (u = f));
  });
  return (
    (r.status = "pending"),
    (r.resolve = (o) => {
      ((r.status = "resolved"), (r.value = o), l(o), n == null || n(o));
    }),
    (r.reject = (o) => {
      ((r.status = "rejected"), u(o));
    }),
    r
  );
}
function ub(n) {
  return typeof (n == null ? void 0 : n.message) != "string"
    ? !1
    : n.message.startsWith("Failed to fetch dynamically imported module") ||
        n.message.startsWith("error loading dynamically imported module") ||
        n.message.startsWith("Importing a module script failed");
}
function Tu(n) {
  return !!(n && typeof n == "object" && typeof n.then == "function");
}
function rb(n) {
  return n.replace(/[\x00-\x1f\x7f]/g, "");
}
function Wy(n) {
  let l;
  try {
    l = decodeURI(n);
  } catch {
    l = n.replaceAll(/%[0-9A-F]{2}/gi, (u) => {
      try {
        return decodeURI(u);
      } catch {
        return u;
      }
    });
  }
  return rb(l);
}
var sb = ["http:", "https:", "mailto:", "tel:"];
function ds(n, l) {
  if (!n) return !1;
  try {
    const u = new URL(n);
    return !l.has(u.protocol);
  } catch {
    return !1;
  }
}
var cb = {
    "&": "\\u0026",
    ">": "\\u003e",
    "<": "\\u003c",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  },
  ob = /[&><\u2028\u2029]/g;
function fb(n) {
  return n.replace(ob, (l) => cb[l]);
}
function hu(n) {
  if (!n) return { path: n, handledProtocolRelativeURL: !1 };
  if (!/[%\\\x00-\x1f\x7f]/.test(n) && !n.startsWith("//"))
    return { path: n, handledProtocolRelativeURL: !1 };
  const l = /%25|%5C/gi;
  let u = 0,
    r = "",
    o;
  for (; (o = l.exec(n)) !== null; ) ((r += Wy(n.slice(u, o.index)) + o[0]), (u = l.lastIndex));
  r = r + Wy(u ? n.slice(u) : n);
  let f = !1;
  return (
    r.startsWith("//") && ((f = !0), (r = "/" + r.replace(/^\/+/, ""))),
    { path: r, handledProtocolRelativeURL: f }
  );
}
function db(n) {
  return /\s|[^\u0000-\u007F]/.test(n) ? n.replace(/\s|[^\u0000-\u007F]/gu, encodeURIComponent) : n;
}
function hb(n, l) {
  if (n === l) return !0;
  if (n.length !== l.length) return !1;
  for (let u = 0; u < n.length; u++) if (n[u] !== l[u]) return !1;
  return !0;
}
function Ce() {
  throw new Error("Invariant failed");
}
function Au(n) {
  const l = new Map();
  let u, r;
  const o = (f) => {
    f.next &&
      (f.prev
        ? ((f.prev.next = f.next),
          (f.next.prev = f.prev),
          (f.next = void 0),
          r && ((r.next = f), (f.prev = r)))
        : ((f.next.prev = void 0),
          (u = f.next),
          (f.next = void 0),
          r && ((f.prev = r), (r.next = f))),
      (r = f));
  };
  return {
    get(f) {
      const d = l.get(f);
      if (d) return (o(d), d.value);
    },
    set(f, d) {
      if (l.size >= n && u) {
        const y = u;
        (l.delete(y.key),
          y.next && ((u = y.next), (y.next.prev = void 0)),
          y === r && (r = void 0));
      }
      const m = l.get(f);
      if (m) ((m.value = d), o(m));
      else {
        const y = { key: f, value: d, prev: r };
        (r && (r.next = y), (r = y), u || (u = y), l.set(f, y));
      }
    },
    clear() {
      (l.clear(), (u = void 0), (r = void 0));
    },
  };
}
var tl = 4,
  ag = 5;
function mb(n) {
  const l = n.indexOf("{");
  if (l === -1) return null;
  const u = n.indexOf("}", l);
  return u === -1 || l + 1 >= n.length ? null : [l, u];
}
function Mf(n, l, u = new Uint16Array(6)) {
  const r = n.indexOf("/", l),
    o = r === -1 ? n.length : r,
    f = n.substring(l, o);
  if (!f || !f.includes("$"))
    return ((u[0] = 0), (u[1] = l), (u[2] = l), (u[3] = o), (u[4] = o), (u[5] = o), u);
  if (f === "$") {
    const m = n.length;
    return ((u[0] = 2), (u[1] = l), (u[2] = l), (u[3] = m), (u[4] = m), (u[5] = m), u);
  }
  if (f.charCodeAt(0) === 36)
    return ((u[0] = 1), (u[1] = l), (u[2] = l + 1), (u[3] = o), (u[4] = o), (u[5] = o), u);
  const d = mb(f);
  if (d) {
    const [m, y] = d,
      v = f.charCodeAt(m + 1);
    if (v === 45) {
      if (m + 2 < f.length && f.charCodeAt(m + 2) === 36) {
        const p = m + 3,
          g = y;
        if (p < g)
          return (
            (u[0] = 3),
            (u[1] = l + m),
            (u[2] = l + p),
            (u[3] = l + g),
            (u[4] = l + y + 1),
            (u[5] = o),
            u
          );
      }
    } else if (v === 36) {
      const p = m + 1,
        g = m + 2;
      return g === y
        ? ((u[0] = 2),
          (u[1] = l + m),
          (u[2] = l + p),
          (u[3] = l + g),
          (u[4] = l + y + 1),
          (u[5] = n.length),
          u)
        : ((u[0] = 1),
          (u[1] = l + m),
          (u[2] = l + g),
          (u[3] = l + y),
          (u[4] = l + y + 1),
          (u[5] = o),
          u);
    }
  }
  return ((u[0] = 0), (u[1] = l), (u[2] = l), (u[3] = o), (u[4] = o), (u[5] = o), u);
}
function bs(n, l, u, r, o, f, d) {
  var y, v, p, g, b, E, R, M, x, U, G, C, z;
  d == null || d(u);
  let m = r;
  {
    const Y = u.fullPath ?? u.from,
      I = Y.length,
      q = ((y = u.options) == null ? void 0 : y.caseSensitive) ?? n,
      k = !!(
        (p = (v = u.options) == null ? void 0 : v.params) != null &&
        p.parse &&
        (b = (g = u.options) == null ? void 0 : g.skipRouteOnParseError) != null &&
        b.params
      );
    for (; m < I; ) {
      const F = Mf(Y, m, l);
      let W;
      const et = m,
        rt = F[5];
      switch (((m = rt + 1), f++, F[0])) {
        case 0: {
          const dt = Y.substring(F[2], F[3]);
          if (q) {
            const it = (E = o.static) == null ? void 0 : E.get(dt);
            if (it) W = it;
            else {
              o.static ?? (o.static = new Map());
              const j = el(u.fullPath ?? u.from);
              ((j.parent = o), (j.depth = f), (W = j), o.static.set(dt, j));
            }
          } else {
            const it = dt.toLowerCase(),
              j = (R = o.staticInsensitive) == null ? void 0 : R.get(it);
            if (j) W = j;
            else {
              o.staticInsensitive ?? (o.staticInsensitive = new Map());
              const P = el(u.fullPath ?? u.from);
              ((P.parent = o), (P.depth = f), (W = P), o.staticInsensitive.set(it, P));
            }
          }
          break;
        }
        case 1: {
          const dt = Y.substring(et, F[1]),
            it = Y.substring(F[4], rt),
            j = q && !!(dt || it),
            P = dt ? (j ? dt : dt.toLowerCase()) : void 0,
            nt = it ? (j ? it : it.toLowerCase()) : void 0,
            vt =
              !k &&
              ((M = o.dynamic) == null
                ? void 0
                : M.find(
                    (ht) =>
                      !ht.skipOnParamError &&
                      ht.caseSensitive === j &&
                      ht.prefix === P &&
                      ht.suffix === nt,
                  ));
          if (vt) W = vt;
          else {
            const ht = Io(1, u.fullPath ?? u.from, j, P, nt);
            ((W = ht),
              (ht.depth = f),
              (ht.parent = o),
              o.dynamic ?? (o.dynamic = []),
              o.dynamic.push(ht));
          }
          break;
        }
        case 3: {
          const dt = Y.substring(et, F[1]),
            it = Y.substring(F[4], rt),
            j = q && !!(dt || it),
            P = dt ? (j ? dt : dt.toLowerCase()) : void 0,
            nt = it ? (j ? it : it.toLowerCase()) : void 0,
            vt =
              !k &&
              ((x = o.optional) == null
                ? void 0
                : x.find(
                    (ht) =>
                      !ht.skipOnParamError &&
                      ht.caseSensitive === j &&
                      ht.prefix === P &&
                      ht.suffix === nt,
                  ));
          if (vt) W = vt;
          else {
            const ht = Io(3, u.fullPath ?? u.from, j, P, nt);
            ((W = ht),
              (ht.parent = o),
              (ht.depth = f),
              o.optional ?? (o.optional = []),
              o.optional.push(ht));
          }
          break;
        }
        case 2: {
          const dt = Y.substring(et, F[1]),
            it = Y.substring(F[4], rt),
            j = q && !!(dt || it),
            P = dt ? (j ? dt : dt.toLowerCase()) : void 0,
            nt = it ? (j ? it : it.toLowerCase()) : void 0,
            vt = Io(2, u.fullPath ?? u.from, j, P, nt);
          ((W = vt),
            (vt.parent = o),
            (vt.depth = f),
            o.wildcard ?? (o.wildcard = []),
            o.wildcard.push(vt));
        }
      }
      o = W;
    }
    if (k && u.children && !u.isRoot && u.id && u.id.charCodeAt(u.id.lastIndexOf("/") + 1) === 95) {
      const F = el(u.fullPath ?? u.from);
      ((F.kind = ag),
        (F.parent = o),
        f++,
        (F.depth = f),
        o.pathless ?? (o.pathless = []),
        o.pathless.push(F),
        (o = F));
    }
    const J = (u.path || !u.children) && !u.isRoot;
    if (J && Y.endsWith("/")) {
      const F = el(u.fullPath ?? u.from);
      ((F.kind = tl), (F.parent = o), f++, (F.depth = f), (o.index = F), (o = F));
    }
    ((o.parse =
      ((G = (U = u.options) == null ? void 0 : U.params) == null ? void 0 : G.parse) ?? null),
      (o.skipOnParamError = k),
      (o.parsingPriority =
        ((z = (C = u.options) == null ? void 0 : C.skipRouteOnParseError) == null
          ? void 0
          : z.priority) ?? 0),
      J && !o.route && ((o.route = u), (o.fullPath = u.fullPath ?? u.from)));
  }
  if (u.children) for (const Y of u.children) bs(n, l, Y, m, o, f, d);
}
function ko(n, l) {
  if (n.skipOnParamError && !l.skipOnParamError) return -1;
  if (!n.skipOnParamError && l.skipOnParamError) return 1;
  if (n.skipOnParamError && l.skipOnParamError && (n.parsingPriority || l.parsingPriority))
    return l.parsingPriority - n.parsingPriority;
  if (n.prefix && l.prefix && n.prefix !== l.prefix) {
    if (n.prefix.startsWith(l.prefix)) return -1;
    if (l.prefix.startsWith(n.prefix)) return 1;
  }
  if (n.suffix && l.suffix && n.suffix !== l.suffix) {
    if (n.suffix.endsWith(l.suffix)) return -1;
    if (l.suffix.endsWith(n.suffix)) return 1;
  }
  return n.prefix && !l.prefix
    ? -1
    : !n.prefix && l.prefix
      ? 1
      : n.suffix && !l.suffix
        ? -1
        : !n.suffix && l.suffix
          ? 1
          : n.caseSensitive && !l.caseSensitive
            ? -1
            : !n.caseSensitive && l.caseSensitive
              ? 1
              : 0;
}
function va(n) {
  var l, u, r;
  if (n.pathless) for (const o of n.pathless) va(o);
  if (n.static) for (const o of n.static.values()) va(o);
  if (n.staticInsensitive) for (const o of n.staticInsensitive.values()) va(o);
  if ((l = n.dynamic) != null && l.length) {
    n.dynamic.sort(ko);
    for (const o of n.dynamic) va(o);
  }
  if ((u = n.optional) != null && u.length) {
    n.optional.sort(ko);
    for (const o of n.optional) va(o);
  }
  if ((r = n.wildcard) != null && r.length) {
    n.wildcard.sort(ko);
    for (const o of n.wildcard) va(o);
  }
}
function el(n) {
  return {
    kind: 0,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath: n,
    parent: null,
    parse: null,
    skipOnParamError: !1,
    parsingPriority: 0,
  };
}
function Io(n, l, u, r, o) {
  return {
    kind: n,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath: l,
    parent: null,
    parse: null,
    skipOnParamError: !1,
    parsingPriority: 0,
    caseSensitive: u,
    prefix: r,
    suffix: o,
  };
}
function yb(n, l) {
  const u = el("/"),
    r = new Uint16Array(6);
  for (const o of n) bs(!1, r, o, 1, u, 0);
  (va(u), (l.masksTree = u), (l.flatCache = Au(1e3)));
}
function vb(n, l) {
  n || (n = "/");
  const u = l.flatCache.get(n);
  if (u) return u;
  const r = wf(n, l.masksTree);
  return (l.flatCache.set(n, r), r);
}
function gb(n, l, u, r, o) {
  (n || (n = "/"), r || (r = "/"));
  const f = l ? `case\0${n}` : n;
  let d = o.singleCache.get(f);
  return (
    d || ((d = el("/")), bs(l, new Uint16Array(6), { from: n }, 1, d, 0), o.singleCache.set(f, d)),
    wf(r, d, u)
  );
}
function pb(n, l, u = !1) {
  const r = u ? n : `nofuzz\0${n}`,
    o = l.matchCache.get(r);
  if (o !== void 0) return o;
  n || (n = "/");
  let f;
  try {
    f = wf(n, l.segmentTree, u);
  } catch (d) {
    if (d instanceof URIError) f = null;
    else throw d;
  }
  return (f && (f.branch = _b(f.route)), l.matchCache.set(r, f), f);
}
function Sb(n) {
  return n === "/" ? n : n.replace(/\/{1,}$/, "");
}
function bb(n, l = !1, u) {
  const r = el(n.fullPath),
    o = new Uint16Array(6),
    f = {},
    d = {};
  let m = 0;
  return (
    bs(l, o, n, 1, r, 0, (y) => {
      if ((u == null || u(y, m), y.id in f && Ce(), (f[y.id] = y), m !== 0 && y.path)) {
        const v = Sb(y.fullPath);
        (!d[v] || y.fullPath.endsWith("/")) && (d[v] = y);
      }
      m++;
    }),
    va(r),
    {
      processedTree: {
        segmentTree: r,
        singleCache: Au(1e3),
        matchCache: Au(1e3),
        flatCache: null,
        masksTree: null,
      },
      routesById: f,
      routesByPath: d,
    }
  );
}
function wf(n, l, u = !1) {
  const r = n.split("/"),
    o = Rb(n, r, l, u);
  if (!o) return null;
  const [f] = lg(n, r, o);
  return { route: o.node.route, rawParams: f, parsedParams: o.parsedParams };
}
function lg(n, l, u) {
  var p, g, b, E, R, M, x, U, G, C;
  const r = Eb(u.node);
  let o = null;
  const f = Object.create(null);
  let d = ((p = u.extract) == null ? void 0 : p.part) ?? 0,
    m = ((g = u.extract) == null ? void 0 : g.node) ?? 0,
    y = ((b = u.extract) == null ? void 0 : b.path) ?? 0,
    v = ((E = u.extract) == null ? void 0 : E.segment) ?? 0;
  for (; m < r.length; d++, m++, y++, v++) {
    const z = r[m];
    if (z.kind === tl) break;
    if (z.kind === ag) {
      (v--, d--, y--);
      continue;
    }
    const Y = l[d],
      I = y;
    if ((Y && (y += Y.length), z.kind === 1)) {
      o ?? (o = u.node.fullPath.split("/"));
      const q = o[v],
        k = ((R = z.prefix) == null ? void 0 : R.length) ?? 0;
      if (q.charCodeAt(k) === 123) {
        const J = ((M = z.suffix) == null ? void 0 : M.length) ?? 0,
          F = q.substring(k + 2, q.length - J - 1),
          W = Y.substring(k, Y.length - J);
        f[F] = decodeURIComponent(W);
      } else {
        const J = q.substring(1);
        f[J] = decodeURIComponent(Y);
      }
    } else if (z.kind === 3) {
      if (u.skipped & (1 << m)) {
        (d--, (y = I - 1));
        continue;
      }
      o ?? (o = u.node.fullPath.split("/"));
      const q = o[v],
        k = ((x = z.prefix) == null ? void 0 : x.length) ?? 0,
        J = ((U = z.suffix) == null ? void 0 : U.length) ?? 0,
        F = q.substring(k + 3, q.length - J - 1),
        W = z.suffix || z.prefix ? Y.substring(k, Y.length - J) : Y;
      W && (f[F] = decodeURIComponent(W));
    } else if (z.kind === 2) {
      const q = z,
        k = n.substring(
          I + (((G = q.prefix) == null ? void 0 : G.length) ?? 0),
          n.length - (((C = q.suffix) == null ? void 0 : C.length) ?? 0),
        ),
        J = decodeURIComponent(k);
      ((f["*"] = J), (f._splat = J));
      break;
    }
  }
  return (
    u.rawParams && Object.assign(f, u.rawParams), [f, { part: d, node: m, path: y, segment: v }]
  );
}
function _b(n) {
  const l = [n];
  for (; n.parentRoute; ) ((n = n.parentRoute), l.push(n));
  return (l.reverse(), l);
}
function Eb(n) {
  const l = Array(n.depth + 1);
  do ((l[n.depth] = n), (n = n.parent));
  while (n);
  return l;
}
function Rb(n, l, u, r) {
  if (n === "/" && u.index) return { node: u.index, skipped: 0 };
  const o = !Ru(l),
    f = o && n !== "/",
    d = l.length - (o ? 1 : 0),
    m = [{ node: u, index: 1, skipped: 0, depth: 1, statics: 1, dynamics: 0, optionals: 0 }];
  let y = null,
    v = null,
    p = null;
  for (; m.length; ) {
    const g = m.pop(),
      { node: b, index: E, skipped: R, depth: M, statics: x, dynamics: U, optionals: G } = g;
    let { extract: C, rawParams: z, parsedParams: Y } = g;
    if (b.skipOnParamError) {
      if (!$o(n, l, g)) continue;
      ((z = g.rawParams), (C = g.extract), (Y = g.parsedParams));
    }
    r && b.route && b.kind !== tl && mu(v, g) && (v = g);
    const I = E === d;
    if (
      I &&
      (b.route && !f && mu(p, g) && (p = g), !b.optional && !b.wildcard && !b.index && !b.pathless)
    )
      continue;
    const q = I ? void 0 : l[E];
    let k;
    if (I && b.index) {
      const J = {
        node: b.index,
        index: E,
        skipped: R,
        depth: M + 1,
        statics: x,
        dynamics: U,
        optionals: G,
        extract: C,
        rawParams: z,
        parsedParams: Y,
      };
      let F = !0;
      if ((b.index.skipOnParamError && ($o(n, l, J) || (F = !1)), F)) {
        if (x === d && !U && !G && !R) return J;
        mu(p, J) && (p = J);
      }
    }
    if (b.wildcard && mu(y, g))
      for (const J of b.wildcard) {
        const { prefix: F, suffix: W } = J;
        if (F && (I || !(J.caseSensitive ? q : (k ?? (k = q.toLowerCase()))).startsWith(F)))
          continue;
        if (W) {
          if (I) continue;
          const rt = l.slice(E).join("/").slice(-W.length);
          if ((J.caseSensitive ? rt : rt.toLowerCase()) !== W) continue;
        }
        const et = {
          node: J,
          index: d,
          skipped: R,
          depth: M,
          statics: x,
          dynamics: U,
          optionals: G,
          extract: C,
          rawParams: z,
          parsedParams: Y,
        };
        if (!(J.skipOnParamError && !$o(n, l, et))) {
          y = et;
          break;
        }
      }
    if (b.optional) {
      const J = R | (1 << M),
        F = M + 1;
      for (let W = b.optional.length - 1; W >= 0; W--) {
        const et = b.optional[W];
        m.push({
          node: et,
          index: E,
          skipped: J,
          depth: F,
          statics: x,
          dynamics: U,
          optionals: G,
          extract: C,
          rawParams: z,
          parsedParams: Y,
        });
      }
      if (!I)
        for (let W = b.optional.length - 1; W >= 0; W--) {
          const et = b.optional[W],
            { prefix: rt, suffix: dt } = et;
          if (rt || dt) {
            const it = et.caseSensitive ? q : (k ?? (k = q.toLowerCase()));
            if ((rt && !it.startsWith(rt)) || (dt && !it.endsWith(dt))) continue;
          }
          m.push({
            node: et,
            index: E + 1,
            skipped: R,
            depth: F,
            statics: x,
            dynamics: U,
            optionals: G + 1,
            extract: C,
            rawParams: z,
            parsedParams: Y,
          });
        }
    }
    if (!I && b.dynamic && q)
      for (let J = b.dynamic.length - 1; J >= 0; J--) {
        const F = b.dynamic[J],
          { prefix: W, suffix: et } = F;
        if (W || et) {
          const rt = F.caseSensitive ? q : (k ?? (k = q.toLowerCase()));
          if ((W && !rt.startsWith(W)) || (et && !rt.endsWith(et))) continue;
        }
        m.push({
          node: F,
          index: E + 1,
          skipped: R,
          depth: M + 1,
          statics: x,
          dynamics: U + 1,
          optionals: G,
          extract: C,
          rawParams: z,
          parsedParams: Y,
        });
      }
    if (!I && b.staticInsensitive) {
      const J = b.staticInsensitive.get(k ?? (k = q.toLowerCase()));
      J &&
        m.push({
          node: J,
          index: E + 1,
          skipped: R,
          depth: M + 1,
          statics: x + 1,
          dynamics: U,
          optionals: G,
          extract: C,
          rawParams: z,
          parsedParams: Y,
        });
    }
    if (!I && b.static) {
      const J = b.static.get(q);
      J &&
        m.push({
          node: J,
          index: E + 1,
          skipped: R,
          depth: M + 1,
          statics: x + 1,
          dynamics: U,
          optionals: G,
          extract: C,
          rawParams: z,
          parsedParams: Y,
        });
    }
    if (b.pathless) {
      const J = M + 1;
      for (let F = b.pathless.length - 1; F >= 0; F--) {
        const W = b.pathless[F];
        m.push({
          node: W,
          index: E,
          skipped: R,
          depth: J,
          statics: x,
          dynamics: U,
          optionals: G,
          extract: C,
          rawParams: z,
          parsedParams: Y,
        });
      }
    }
  }
  if (p && y) return mu(y, p) ? p : y;
  if (p) return p;
  if (y) return y;
  if (r && v) {
    let g = v.index;
    for (let E = 0; E < v.index; E++) g += l[E].length;
    const b = g === n.length ? "/" : n.slice(g);
    return (
      v.rawParams ?? (v.rawParams = Object.create(null)),
      (v.rawParams["**"] = decodeURIComponent(b)),
      v
    );
  }
  return null;
}
function $o(n, l, u) {
  try {
    const [r, o] = lg(n, l, u);
    ((u.rawParams = r), (u.extract = o));
    const f = u.node.parse(r);
    return ((u.parsedParams = Object.assign(Object.create(null), u.parsedParams, f)), !0);
  } catch {
    return null;
  }
}
function mu(n, l) {
  return n
    ? l.statics > n.statics ||
        (l.statics === n.statics &&
          (l.dynamics > n.dynamics ||
            (l.dynamics === n.dynamics &&
              (l.optionals > n.optionals ||
                (l.optionals === n.optionals &&
                  ((l.node.kind === tl) > (n.node.kind === tl) ||
                    ((l.node.kind === tl) == (n.node.kind === tl) && l.depth > n.depth)))))))
    : !0;
}
function rs(n) {
  return Of(n.filter((l) => l !== void 0).join("/"));
}
function Of(n) {
  return n.replace(/\/{2,}/g, "/");
}
function ig(n) {
  return n === "/" ? n : n.replace(/^\/{1,}/, "");
}
function xa(n) {
  const l = n.length;
  return l > 1 && n[l - 1] === "/" ? n.replace(/\/{1,}$/, "") : n;
}
function ug(n) {
  return xa(ig(n));
}
function hs(n, l) {
  return n != null && n.endsWith("/") && n !== "/" && n !== `${l}/` ? n.slice(0, -1) : n;
}
function Tb(n, l, u) {
  return hs(n, u) === hs(l, u);
}
function Ab({ base: n, to: l, trailingSlash: u = "never", cache: r }) {
  const o = l.startsWith("/"),
    f = !o && l === ".";
  let d;
  if (r) {
    d = o ? l : f ? n : n + "\0" + l;
    const g = r.get(d);
    if (g) return g;
  }
  let m;
  if (f) m = n.split("/");
  else if (o) m = l.split("/");
  else {
    for (m = n.split("/"); m.length > 1 && Ru(m) === ""; ) m.pop();
    const g = l.split("/");
    for (let b = 0, E = g.length; b < E; b++) {
      const R = g[b];
      R === ""
        ? b
          ? b === E - 1 && m.push(R)
          : (m = [R])
        : R === ".."
          ? m.pop()
          : R === "." || m.push(R);
    }
  }
  m.length > 1 && (Ru(m) === "" ? u === "never" && m.pop() : u === "always" && m.push(""));
  let y,
    v = "";
  for (let g = 0; g < m.length; g++) {
    g > 0 && (v += "/");
    const b = m[g];
    if (!b) continue;
    y = Mf(b, 0, y);
    const E = y[0];
    if (E === 0) {
      v += b;
      continue;
    }
    const R = y[5],
      M = b.substring(0, y[1]),
      x = b.substring(y[4], R),
      U = b.substring(y[2], y[3]);
    E === 1
      ? (v += M || x ? `${M}{$${U}}${x}` : `$${U}`)
      : E === 2
        ? (v += M || x ? `${M}{$}${x}` : "$")
        : (v += `${M}{-$${U}}${x}`);
  }
  v = Of(v);
  const p = v || "/";
  return (d && r && r.set(d, p), p);
}
function xb(n) {
  const l = new Map(n.map((o) => [encodeURIComponent(o), o])),
    u = Array.from(l.keys())
      .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    r = new RegExp(u, "g");
  return (o) => o.replace(r, (f) => l.get(f) ?? f);
}
function Wo(n, l, u) {
  const r = l[n];
  return typeof r != "string"
    ? r
    : n === "_splat"
      ? /^[a-zA-Z0-9\-._~!/]*$/.test(r)
        ? r
        : r
            .split("/")
            .map((o) => ev(o, u))
            .join("/")
      : ev(r, u);
}
function tv({ path: n, params: l, decoder: u, ...r }) {
  let o = !1;
  const f = Object.create(null);
  if (!n || n === "/") return { interpolatedPath: "/", usedParams: f, isMissingParams: o };
  if (!n.includes("$")) return { interpolatedPath: n, usedParams: f, isMissingParams: o };
  const d = n.length;
  let m = 0,
    y,
    v = "";
  for (; m < d; ) {
    const p = m;
    y = Mf(n, p, y);
    const g = y[5];
    if (((m = g + 1), p === g)) continue;
    const b = y[0];
    if (b === 0) {
      v += "/" + n.substring(p, g);
      continue;
    }
    if (b === 2) {
      const E = l._splat;
      ((f._splat = E), (f["*"] = E));
      const R = n.substring(p, y[1]),
        M = n.substring(y[4], g);
      if (!E) {
        ((o = !0), (R || M) && (v += "/" + R + M));
        continue;
      }
      const x = Wo("_splat", l, u);
      v += "/" + R + x + M;
      continue;
    }
    if (b === 1) {
      const E = n.substring(y[2], y[3]);
      (!o && !(E in l) && (o = !0), (f[E] = l[E]));
      const R = n.substring(p, y[1]),
        M = n.substring(y[4], g),
        x = Wo(E, l, u) ?? "undefined";
      v += "/" + R + x + M;
      continue;
    }
    if (b === 3) {
      const E = n.substring(y[2], y[3]),
        R = l[E];
      if (R == null) continue;
      f[E] = R;
      const M = n.substring(p, y[1]),
        x = n.substring(y[4], g),
        U = Wo(E, l, u) ?? "";
      v += "/" + M + U + x;
      continue;
    }
  }
  return (
    n.endsWith("/") && (v += "/"), { usedParams: f, interpolatedPath: v || "/", isMissingParams: o }
  );
}
function ev(n, l) {
  const u = encodeURIComponent(n);
  return (l == null ? void 0 : l(u)) ?? u;
}
function re(n) {
  return (n == null ? void 0 : n.isNotFound) === !0;
}
function Mb() {
  try {
    return typeof window < "u" && typeof window.sessionStorage == "object"
      ? window.sessionStorage
      : void 0;
  } catch {
    return;
  }
}
var wb = "tsr-scroll-restoration-v1_3";
function Ob() {
  const n = Mb();
  if (!n) return null;
  let l = {};
  try {
    const r = JSON.parse(n.getItem("tsr-scroll-restoration-v1_3") || "{}");
    mi(r) && (l = r);
  } catch {}
  return {
    get state() {
      return l;
    },
    set: (r) => {
      l = Ta(r, l) || l;
    },
    persist: () => {
      try {
        n.setItem(wb, JSON.stringify(l));
      } catch {}
    },
  };
}
var nv = Ob(),
  Cb = (n) => n.state.__TSR_key || n.href;
function zb(n) {
  const l = [];
  let u;
  for (; (u = n.parentNode); )
    (l.push(`${n.tagName}:nth-child(${Array.prototype.indexOf.call(u.children, n) + 1})`), (n = u));
  return `${l.reverse().join(" > ")}`.toLowerCase();
}
var as = !1,
  yu = "window",
  av = "data-scroll-restoration-id";
function Db(n, l) {
  if (!nv) return;
  const u = nv;
  if (
    ((n.options.scrollRestoration ?? !1) && (n.isScrollRestoring = !0),
    n.isScrollRestorationSetup || !u)
  )
    return;
  ((n.isScrollRestorationSetup = !0), (as = !1));
  const r = n.options.getScrollRestorationKey || Cb,
    o = new Map();
  window.history.scrollRestoration = "manual";
  const f = (m) => {
      if (!(as || !n.isScrollRestoring))
        if (m.target === document || m.target === window)
          o.set(yu, { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 });
        else {
          const y = m.target;
          o.set(y, { scrollX: y.scrollLeft || 0, scrollY: y.scrollTop || 0 });
        }
    },
    d = (m) => {
      var v;
      if (!n.isScrollRestoring || !m || o.size === 0 || !u) return;
      const y = (v = u.state)[m] || (v[m] = {});
      for (const [p, g] of o) {
        let b;
        if (p === yu) b = yu;
        else if (p.isConnected) {
          const E = p.getAttribute(av);
          b = E ? `[${av}="${E}"]` : zb(p);
        }
        b && (y[b] = g);
      }
    };
  (document.addEventListener("scroll", f, !0),
    n.subscribe("onBeforeLoad", (m) => {
      (d(m.fromLocation ? r(m.fromLocation) : void 0), o.clear());
    }),
    window.addEventListener("pagehide", () => {
      (d(r(n.stores.resolvedLocation.get() ?? n.stores.location.get())), u.persist());
    }),
    n.subscribe("onRendered", (m) => {
      var g;
      const y = r(m.toLocation),
        v = n.options.scrollRestorationBehavior,
        p = n.options.scrollToTopSelectors;
      if ((o.clear(), !n.resetNextScroll)) {
        n.resetNextScroll = !0;
        return;
      }
      if (
        !(
          typeof n.options.scrollRestoration == "function" &&
          !n.options.scrollRestoration({ location: n.latestLocation })
        )
      ) {
        as = !0;
        try {
          const b = n.isScrollRestoring ? u.state[y] : void 0;
          let E = !1;
          if (b)
            for (const R in b) {
              const M = b[R];
              if (!mi(M)) continue;
              const { scrollX: x, scrollY: U } = M;
              if (!(!Number.isFinite(x) || !Number.isFinite(U))) {
                if (R === yu) (window.scrollTo({ top: U, left: x, behavior: v }), (E = !0));
                else if (R) {
                  let G;
                  try {
                    G = document.querySelector(R);
                  } catch {
                    continue;
                  }
                  G && ((G.scrollLeft = x), (G.scrollTop = U), (E = !0));
                }
              }
            }
          if (!E) {
            const R = n.history.location.hash.slice(1);
            if (R) {
              const M =
                ((g = window.history.state) == null ? void 0 : g.__hashScrollIntoViewOptions) ?? !0;
              if (M) {
                const x = document.getElementById(R);
                x && x.scrollIntoView(M);
              }
            } else {
              const M = { top: 0, left: 0, behavior: v };
              if ((window.scrollTo(M), p))
                for (const x of p) {
                  if (x === yu) continue;
                  const U = typeof x == "function" ? x() : document.querySelector(x);
                  U && U.scrollTo(M);
                }
            }
          }
        } finally {
          as = !1;
        }
        n.isScrollRestoring && u.set((b) => (b[y] || (b[y] = {}), b));
      }
    }));
}
function rg(n, l = String) {
  const u = new URLSearchParams();
  for (const r in n) {
    const o = n[r];
    o !== void 0 && u.set(r, l(o));
  }
  return u.toString();
}
function tf(n) {
  return n ? (n === "false" ? !1 : n === "true" ? !0 : +n * 0 === 0 && +n + "" === n ? +n : n) : "";
}
function Ub(n) {
  const l = new URLSearchParams(n),
    u = Object.create(null);
  for (const [r, o] of l.entries()) {
    const f = u[r];
    f == null ? (u[r] = tf(o)) : Array.isArray(f) ? f.push(tf(o)) : (u[r] = [f, tf(o)]);
  }
  return u;
}
var Lb = jb(JSON.parse),
  Nb = Bb(JSON.stringify, JSON.parse);
function jb(n) {
  return (l) => {
    l[0] === "?" && (l = l.substring(1));
    const u = Ub(l);
    for (const r in u) {
      const o = u[r];
      if (typeof o == "string")
        try {
          u[r] = n(o);
        } catch {}
    }
    return u;
  };
}
function Bb(n, l) {
  const u = typeof l == "function";
  function r(o) {
    if (typeof o == "object" && o !== null)
      try {
        return n(o);
      } catch {}
    else if (u && typeof o == "string")
      try {
        return (l(o), n(o));
      } catch {}
    return o;
  }
  return (o) => {
    const f = rg(o, r);
    return f ? `?${f}` : "";
  };
}
var cl = "__root__";
function sg(n) {
  if (
    ((n.statusCode = n.statusCode || n.code || 307),
    !n._builtLocation && !n.reloadDocument && typeof n.href == "string")
  )
    try {
      (new URL(n.href), (n.reloadDocument = !0));
    } catch {}
  const l = new Headers(n.headers);
  n.href && l.get("Location") === null && l.set("Location", n.href);
  const u = new Response(null, { status: n.statusCode, headers: l });
  if (((u.options = n), n.throw)) throw u;
  return u;
}
function _e(n) {
  return n instanceof Response && !!n.options;
}
function cg(n) {
  if (n !== null && typeof n == "object" && n.isSerializedRedirect) return sg(n);
}
function Hb(n) {
  return {
    input: ({ url: l }) => {
      for (const u of n) l = hf(u, l);
      return l;
    },
    output: ({ url: l }) => {
      for (let u = n.length - 1; u >= 0; u--) l = og(n[u], l);
      return l;
    },
  };
}
function qb(n) {
  const l = ug(n.basepath),
    u = `/${l}`,
    r = `${u}/`,
    o = n.caseSensitive ? u : u.toLowerCase(),
    f = n.caseSensitive ? r : r.toLowerCase();
  return {
    input: ({ url: d }) => {
      const m = n.caseSensitive ? d.pathname : d.pathname.toLowerCase();
      return (
        m === o ? (d.pathname = "/") : m.startsWith(f) && (d.pathname = d.pathname.slice(u.length)),
        d
      );
    },
    output: ({ url: d }) => ((d.pathname = rs(["/", l, d.pathname])), d),
  };
}
function hf(n, l) {
  var r;
  const u = (r = n == null ? void 0 : n.input) == null ? void 0 : r.call(n, { url: l });
  if (u) {
    if (typeof u == "string") return new URL(u);
    if (u instanceof URL) return u;
  }
  return l;
}
function og(n, l) {
  var r;
  const u = (r = n == null ? void 0 : n.output) == null ? void 0 : r.call(n, { url: l });
  if (u) {
    if (typeof u == "string") return new URL(u);
    if (u instanceof URL) return u;
  }
  return l;
}
function Yb(n, l) {
  const { createMutableStore: u, createReadonlyStore: r, batch: o, init: f } = l,
    d = new Map(),
    m = new Map(),
    y = new Map(),
    v = u(n.status),
    p = u(n.loadedAt),
    g = u(n.isLoading),
    b = u(n.isTransitioning),
    E = u(n.location),
    R = u(n.resolvedLocation),
    M = u(n.statusCode),
    x = u(n.redirect),
    U = u([]),
    G = u([]),
    C = u([]),
    z = r(() => ef(d, U.get())),
    Y = r(() => ef(m, G.get())),
    I = r(() => ef(y, C.get())),
    q = r(() => U.get()[0]),
    k = r(() =>
      U.get().some((P) => {
        var nt;
        return ((nt = d.get(P)) == null ? void 0 : nt.get().status) === "pending";
      }),
    ),
    J = r(() => {
      var P;
      return {
        locationHref: E.get().href,
        resolvedLocationHref: (P = R.get()) == null ? void 0 : P.href,
        status: v.get(),
      };
    }),
    F = r(() => ({
      status: v.get(),
      loadedAt: p.get(),
      isLoading: g.get(),
      isTransitioning: b.get(),
      matches: z.get(),
      location: E.get(),
      resolvedLocation: R.get(),
      statusCode: M.get(),
      redirect: x.get(),
    })),
    W = Au(64);
  function et(P) {
    let nt = W.get(P);
    return (
      nt ||
        ((nt = r(() => {
          const vt = U.get();
          for (const ht of vt) {
            const O = d.get(ht);
            if (O && O.routeId === P) return O.get();
          }
        })),
        W.set(P, nt)),
      nt
    );
  }
  const rt = {
    status: v,
    loadedAt: p,
    isLoading: g,
    isTransitioning: b,
    location: E,
    resolvedLocation: R,
    statusCode: M,
    redirect: x,
    matchesId: U,
    pendingIds: G,
    cachedIds: C,
    matches: z,
    pendingMatches: Y,
    cachedMatches: I,
    firstId: q,
    hasPending: k,
    matchRouteDeps: J,
    matchStores: d,
    pendingMatchStores: m,
    cachedMatchStores: y,
    __store: F,
    getRouteMatchStore: et,
    setMatches: dt,
    setPending: it,
    setCached: j,
  };
  (dt(n.matches), f == null || f(rt));
  function dt(P) {
    nf(P, d, U, u, o);
  }
  function it(P) {
    nf(P, m, G, u, o);
  }
  function j(P) {
    nf(P, y, C, u, o);
  }
  return rt;
}
function ef(n, l) {
  const u = [];
  for (const r of l) {
    const o = n.get(r);
    o && u.push(o.get());
  }
  return u;
}
function nf(n, l, u, r, o) {
  const f = n.map((m) => m.id),
    d = new Set(f);
  o(() => {
    for (const m of l.keys()) d.has(m) || l.delete(m);
    for (const m of n) {
      const y = l.get(m.id);
      if (!y) {
        const v = r(m);
        ((v.routeId = m.routeId), l.set(m.id, v));
        continue;
      }
      ((y.routeId = m.routeId), y.get() !== m && y.set(m));
    }
    hb(u.get(), f) || u.set(f);
  });
}
var mf = (n) => {
    var l;
    if (!n.rendered) return ((n.rendered = !0), (l = n.onReady) == null ? void 0 : l.call(n));
  },
  Qb = (n) =>
    n.stores.matchesId.get().some((l) => {
      var u;
      return (u = n.stores.matchStores.get(l)) == null ? void 0 : u.get()._forcePending;
    }),
  _s = (n, l) => !!(n.preload && !n.router.stores.matchStores.has(l)),
  ol = (n, l, u = !0) => {
    const r = { ...(n.router.options.context ?? {}) },
      o = u ? l : l - 1;
    for (let f = 0; f <= o; f++) {
      const d = n.matches[f];
      if (!d) continue;
      const m = n.router.getMatch(d.id);
      m && Object.assign(r, m.__routeContext, m.__beforeLoadContext);
    }
    return r;
  },
  lv = (n, l) => {
    if (!n.matches.length) return;
    const u = l.routeId,
      r = n.matches.findIndex((d) => d.routeId === n.router.routeTree.id),
      o = r >= 0 ? r : 0;
    let f = u
      ? n.matches.findIndex((d) => d.routeId === u)
      : (n.firstBadMatchIndex ?? n.matches.length - 1);
    f < 0 && (f = o);
    for (let d = f; d >= 0; d--) {
      const m = n.matches[d];
      if (n.router.looseRoutesById[m.routeId].options.notFoundComponent) return d;
    }
    return u ? f : o;
  },
  Aa = (n, l, u) => {
    var r, o, f;
    if (!(!_e(u) && !re(u)))
      throw (
        (_e(u) && u.redirectHandled && !u.options.reloadDocument) ||
          (l &&
            ((r = l._nonReactive.beforeLoadPromise) == null || r.resolve(),
            (o = l._nonReactive.loaderPromise) == null || o.resolve(),
            (l._nonReactive.beforeLoadPromise = void 0),
            (l._nonReactive.loaderPromise = void 0),
            (l._nonReactive.error = u),
            n.updateMatch(l.id, (d) => ({
              ...d,
              status: _e(u)
                ? "redirected"
                : re(u)
                  ? "notFound"
                  : d.status === "pending"
                    ? "success"
                    : d.status,
              context: ol(n, l.index),
              isFetching: !1,
              error: u,
            })),
            re(u) && !u.routeId && (u.routeId = l.routeId),
            (f = l._nonReactive.loadPromise) == null || f.resolve()),
          _e(u) &&
            ((n.rendered = !0),
            (u.options._fromLocation = n.location),
            (u.redirectHandled = !0),
            (u = n.router.resolveRedirect(u)))),
        u
      );
  },
  fg = (n, l) => {
    const u = n.router.getMatch(l);
    return !!(!u || u._nonReactive.dehydrated);
  },
  iv = (n, l, u) => {
    const r = ol(n, u);
    n.updateMatch(l, (o) => ({ ...o, context: r }));
  },
  vu = (n, l, u, r) => {
    var m, y;
    const { id: o, routeId: f } = n.matches[l],
      d = n.router.looseRoutesById[f];
    if (u instanceof Promise) throw u;
    ((u.routerCode = r),
      n.firstBadMatchIndex ?? (n.firstBadMatchIndex = l),
      Aa(n, n.router.getMatch(o), u));
    try {
      (y = (m = d.options).onError) == null || y.call(m, u);
    } catch (v) {
      ((u = v), Aa(n, n.router.getMatch(o), u));
    }
    (n.updateMatch(o, (v) => {
      var p, g;
      return (
        (p = v._nonReactive.beforeLoadPromise) == null || p.resolve(),
        (v._nonReactive.beforeLoadPromise = void 0),
        (g = v._nonReactive.loadPromise) == null || g.resolve(),
        {
          ...v,
          error: u,
          status: "error",
          isFetching: !1,
          updatedAt: Date.now(),
          abortController: new AbortController(),
        }
      );
    }),
      !n.preload && !_e(u) && !re(u) && (n.serialError ?? (n.serialError = u)));
  },
  dg = (n, l, u, r) => {
    var f;
    if (r._nonReactive.pendingTimeout !== void 0) return;
    const o = u.options.pendingMs ?? n.router.options.defaultPendingMs;
    if (
      n.onReady &&
      !_s(n, l) &&
      (u.options.loader || u.options.beforeLoad || mg(u)) &&
      typeof o == "number" &&
      o !== 1 / 0 &&
      (u.options.pendingComponent ??
        ((f = n.router.options) == null ? void 0 : f.defaultPendingComponent))
    ) {
      const d = setTimeout(() => {
        mf(n);
      }, o);
      r._nonReactive.pendingTimeout = d;
    }
  },
  Gb = (n, l, u) => {
    const r = n.router.getMatch(l);
    if (!r._nonReactive.beforeLoadPromise && !r._nonReactive.loaderPromise) return;
    dg(n, l, u, r);
    const o = () => {
      const f = n.router.getMatch(l);
      f.preload && (f.status === "redirected" || f.status === "notFound") && Aa(n, f, f.error);
    };
    return r._nonReactive.beforeLoadPromise ? r._nonReactive.beforeLoadPromise.then(o) : o();
  },
  Vb = (n, l, u, r) => {
    const o = n.router.getMatch(l);
    let f = o._nonReactive.loadPromise;
    o._nonReactive.loadPromise = fl(() => {
      (f == null || f.resolve(), (f = void 0));
    });
    const { paramsError: d, searchError: m } = o;
    (d && vu(n, u, d, "PARSE_PARAMS"), m && vu(n, u, m, "VALIDATE_SEARCH"), dg(n, l, r, o));
    const y = new AbortController();
    let v = !1;
    const p = () => {
        v ||
          ((v = !0),
          n.updateMatch(l, (z) => ({
            ...z,
            isFetching: "beforeLoad",
            fetchCount: z.fetchCount + 1,
            abortController: y,
          })));
      },
      g = () => {
        var z;
        ((z = o._nonReactive.beforeLoadPromise) == null || z.resolve(),
          (o._nonReactive.beforeLoadPromise = void 0),
          n.updateMatch(l, (Y) => ({ ...Y, isFetching: !1 })));
      };
    if (!r.options.beforeLoad) {
      n.router.batch(() => {
        (p(), g());
      });
      return;
    }
    o._nonReactive.beforeLoadPromise = fl();
    const b = { ...ol(n, u, !1), ...o.__routeContext },
      { search: E, params: R, cause: M } = o,
      x = _s(n, l),
      U = {
        search: E,
        abortController: y,
        params: R,
        preload: x,
        context: b,
        location: n.location,
        navigate: (z) => n.router.navigate({ ...z, _fromLocation: n.location }),
        buildLocation: n.router.buildLocation,
        cause: x ? "preload" : M,
        matches: n.matches,
        routeId: r.id,
        ...n.router.options.additionalContext,
      },
      G = (z) => {
        if (z === void 0) {
          n.router.batch(() => {
            (p(), g());
          });
          return;
        }
        ((_e(z) || re(z)) && (p(), vu(n, u, z, "BEFORE_LOAD")),
          n.router.batch(() => {
            (p(), n.updateMatch(l, (Y) => ({ ...Y, __beforeLoadContext: z })), g());
          }));
      };
    let C;
    try {
      if (((C = r.options.beforeLoad(U)), Tu(C)))
        return (
          p(),
          C.catch((z) => {
            vu(n, u, z, "BEFORE_LOAD");
          }).then(G)
        );
    } catch (z) {
      (p(), vu(n, u, z, "BEFORE_LOAD"));
    }
    G(C);
  },
  Xb = (n, l) => {
    const { id: u, routeId: r } = n.matches[l],
      o = n.router.looseRoutesById[r],
      f = () => m(),
      d = () => Vb(n, u, l, o),
      m = () => {
        if (fg(n, u)) return;
        const y = Gb(n, u, o);
        return Tu(y) ? y.then(d) : d();
      };
    return f();
  },
  Zb = (n, l, u) => {
    var f, d, m, y, v, p;
    const r = n.router.getMatch(l);
    if (!r || (!u.options.head && !u.options.scripts && !u.options.headers)) return;
    const o = {
      ssr: n.router.options.ssr,
      matches: n.matches,
      match: r,
      params: r.params,
      loaderData: r.loaderData,
    };
    return Promise.all([
      (d = (f = u.options).head) == null ? void 0 : d.call(f, o),
      (y = (m = u.options).scripts) == null ? void 0 : y.call(m, o),
      (p = (v = u.options).headers) == null ? void 0 : p.call(v, o),
    ]).then(([g, b, E]) => ({
      meta: g == null ? void 0 : g.meta,
      links: g == null ? void 0 : g.links,
      headScripts: g == null ? void 0 : g.scripts,
      headers: E,
      scripts: b,
      styles: g == null ? void 0 : g.styles,
    }));
  },
  hg = (n, l, u, r, o) => {
    const f = l[r - 1],
      { params: d, loaderDeps: m, abortController: y, cause: v } = n.router.getMatch(u),
      p = ol(n, r),
      g = _s(n, u);
    return {
      params: d,
      deps: m,
      preload: !!g,
      parentMatchPromise: f,
      abortController: y,
      context: p,
      location: n.location,
      navigate: (b) => n.router.navigate({ ...b, _fromLocation: n.location }),
      cause: g ? "preload" : v,
      route: o,
      ...n.router.options.additionalContext,
    };
  },
  uv = async (n, l, u, r, o) => {
    var f, d, m, y, v;
    try {
      const p = n.router.getMatch(u);
      try {
        (!(ng ?? n.router.isServer) || p.ssr === !0) && xu(o);
        const g = o.options.loader,
          b = typeof g == "function" ? g : g == null ? void 0 : g.handler,
          E = b == null ? void 0 : b(hg(n, l, u, r, o)),
          R = !!b && Tu(E);
        if (
          ((R ||
            o._lazyPromise ||
            o._componentsPromise ||
            o.options.head ||
            o.options.scripts ||
            o.options.headers ||
            p._nonReactive.minPendingPromise) &&
            n.updateMatch(u, (x) => ({ ...x, isFetching: "loader" })),
          b)
        ) {
          const x = R ? await E : E;
          (Aa(n, n.router.getMatch(u), x),
            x !== void 0 && n.updateMatch(u, (U) => ({ ...U, loaderData: x })));
        }
        o._lazyPromise && (await o._lazyPromise);
        const M = p._nonReactive.minPendingPromise;
        (M && (await M),
          o._componentsPromise && (await o._componentsPromise),
          n.updateMatch(u, (x) => ({
            ...x,
            error: void 0,
            context: ol(n, r),
            status: "success",
            isFetching: !1,
            updatedAt: Date.now(),
          })));
      } catch (g) {
        let b = g;
        if ((b == null ? void 0 : b.name) === "AbortError") {
          if (p.abortController.signal.aborted) {
            ((f = p._nonReactive.loaderPromise) == null || f.resolve(),
              (p._nonReactive.loaderPromise = void 0));
            return;
          }
          n.updateMatch(u, (R) => ({
            ...R,
            status: R.status === "pending" ? "success" : R.status,
            isFetching: !1,
            context: ol(n, r),
          }));
          return;
        }
        const E = p._nonReactive.minPendingPromise;
        (E && (await E),
          re(g) &&
            (await ((m = (d = o.options.notFoundComponent) == null ? void 0 : d.preload) == null
              ? void 0
              : m.call(d))),
          Aa(n, n.router.getMatch(u), g));
        try {
          (v = (y = o.options).onError) == null || v.call(y, g);
        } catch (R) {
          ((b = R), Aa(n, n.router.getMatch(u), R));
        }
        (!_e(b) && !re(b) && (await xu(o, ["errorComponent"])),
          n.updateMatch(u, (R) => ({
            ...R,
            error: b,
            context: ol(n, r),
            status: "error",
            isFetching: !1,
          })));
      }
    } catch (p) {
      const g = n.router.getMatch(u);
      (g && (g._nonReactive.loaderPromise = void 0), Aa(n, g, p));
    }
  },
  Kb = async (n, l, u) => {
    var E, R, M, x;
    async function r(U, G, C, z, Y) {
      const I = Date.now() - G.updatedAt,
        q = U
          ? (Y.options.preloadStaleTime ?? n.router.options.defaultPreloadStaleTime ?? 3e4)
          : (Y.options.staleTime ?? n.router.options.defaultStaleTime ?? 0),
        k = Y.options.shouldReload,
        J = typeof k == "function" ? k(hg(n, l, o, u, Y)) : k,
        { status: F, invalid: W } = z,
        et =
          I >= q && (!!n.forceStaleReload || z.cause === "enter" || (C !== void 0 && C !== z.id));
      ((d = F === "success" && (W || (J ?? et))),
        (U && Y.options.preload === !1) ||
          (d && !n.sync && p
            ? ((m = !0),
              (async () => {
                var rt, dt;
                try {
                  await uv(n, l, o, u, Y);
                  const it = n.router.getMatch(o);
                  ((rt = it._nonReactive.loaderPromise) == null || rt.resolve(),
                    (dt = it._nonReactive.loadPromise) == null || dt.resolve(),
                    (it._nonReactive.loaderPromise = void 0),
                    (it._nonReactive.loadPromise = void 0));
                } catch (it) {
                  _e(it) && (await n.router.navigate(it.options));
                }
              })())
            : F !== "success" || d
              ? await uv(n, l, o, u, Y)
              : iv(n, o, u)));
    }
    const { id: o, routeId: f } = n.matches[u];
    let d = !1,
      m = !1;
    const y = n.router.looseRoutesById[f],
      v = y.options.loader,
      p =
        ((typeof v == "function" || v == null ? void 0 : v.staleReloadMode) ??
          n.router.options.defaultStaleReloadMode) !== "blocking";
    if (fg(n, o)) {
      if (!n.router.getMatch(o)) return n.matches[u];
      iv(n, o, u);
    } else {
      const U = n.router.getMatch(o),
        G = n.router.stores.matchesId.get()[u],
        C =
          ((E = (G && n.router.stores.matchStores.get(G)) || null) == null ? void 0 : E.routeId) ===
          f
            ? G
            : (R = n.router.stores.matches.get().find((Y) => Y.routeId === f)) == null
              ? void 0
              : R.id,
        z = _s(n, o);
      if (U._nonReactive.loaderPromise) {
        if (U.status === "success" && !n.sync && !U.preload && p) return U;
        await U._nonReactive.loaderPromise;
        const Y = n.router.getMatch(o),
          I = Y._nonReactive.error || Y.error;
        (I && Aa(n, Y, I), Y.status === "pending" && (await r(z, U, C, Y, y)));
      } else {
        const Y = z && !n.router.stores.matchStores.has(o),
          I = n.router.getMatch(o);
        ((I._nonReactive.loaderPromise = fl()),
          Y !== I.preload && n.updateMatch(o, (q) => ({ ...q, preload: Y })),
          await r(z, U, C, I, y));
      }
    }
    const g = n.router.getMatch(o);
    (m ||
      ((M = g._nonReactive.loaderPromise) == null || M.resolve(),
      (x = g._nonReactive.loadPromise) == null || x.resolve(),
      (g._nonReactive.loadPromise = void 0)),
      clearTimeout(g._nonReactive.pendingTimeout),
      (g._nonReactive.pendingTimeout = void 0),
      m || (g._nonReactive.loaderPromise = void 0),
      (g._nonReactive.dehydrated = void 0));
    const b = m ? g.isFetching : !1;
    return b !== g.isFetching || g.invalid !== !1
      ? (n.updateMatch(o, (U) => ({ ...U, isFetching: b, invalid: !1 })), n.router.getMatch(o))
      : g;
  };
async function rv(n) {
  var b, E;
  const l = n,
    u = [];
  Qb(l.router) && mf(l);
  let r;
  for (let R = 0; R < l.matches.length; R++) {
    try {
      const M = Xb(l, R);
      Tu(M) && (await M);
    } catch (M) {
      if (_e(M)) throw M;
      if (re(M)) r = M;
      else if (!l.preload) throw M;
      break;
    }
    if (l.serialError || l.firstBadMatchIndex != null) break;
  }
  const o = l.firstBadMatchIndex ?? l.matches.length,
    f = r && !l.preload ? lv(l, r) : void 0,
    d = r && l.preload ? 0 : f !== void 0 ? Math.min(f + 1, o) : o;
  let m, y;
  for (let R = 0; R < d; R++) u.push(Kb(l, u, R));
  try {
    await Promise.all(u);
  } catch {
    const R = await Promise.allSettled(u);
    for (const M of R) {
      if (M.status !== "rejected") continue;
      const x = M.reason;
      if (_e(x)) throw x;
      re(x) ? (m ?? (m = x)) : (y ?? (y = x));
    }
    if (y !== void 0) throw y;
  }
  const v = m ?? (r && !l.preload ? r : void 0);
  let p = l.firstBadMatchIndex !== void 0 ? l.firstBadMatchIndex : l.matches.length - 1;
  if (!v && r && l.preload) return l.matches;
  if (v) {
    const R = lv(l, v);
    R === void 0 && Ce();
    const M = l.matches[R],
      x = l.router.looseRoutesById[M.routeId],
      U = (b = l.router.options) == null ? void 0 : b.defaultNotFoundComponent;
    (!x.options.notFoundComponent && U && (x.options.notFoundComponent = U),
      (v.routeId = M.routeId));
    const G = M.routeId === l.router.routeTree.id;
    (l.updateMatch(M.id, (C) => ({
      ...C,
      ...(G
        ? { status: "success", globalNotFound: !0, error: void 0 }
        : { status: "notFound", error: v }),
      isFetching: !1,
    })),
      (p = R),
      await xu(x, ["notFoundComponent"]));
  } else if (!l.preload) {
    const R = l.matches[0];
    R.globalNotFound ||
      ((E = l.router.getMatch(R.id)) != null &&
        E.globalNotFound &&
        l.updateMatch(R.id, (M) => ({ ...M, globalNotFound: !1, error: void 0 })));
  }
  if (l.serialError && l.firstBadMatchIndex !== void 0) {
    const R = l.router.looseRoutesById[l.matches[l.firstBadMatchIndex].routeId];
    await xu(R, ["errorComponent"]);
  }
  for (let R = 0; R <= p; R++) {
    const { id: M, routeId: x } = l.matches[R],
      U = l.router.looseRoutesById[x];
    try {
      const G = Zb(l, M, U);
      if (G) {
        const C = await G;
        l.updateMatch(M, (z) => ({ ...z, ...C }));
      }
    } catch (G) {
      console.error(`Error executing head for route ${x}:`, G);
    }
  }
  const g = mf(l);
  if ((Tu(g) && (await g), v)) throw v;
  if (l.serialError && !l.preload && !l.onReady) throw l.serialError;
  return l.matches;
}
function sv(n, l) {
  const u = l
    .map((r) => {
      var o, f;
      return (f = (o = n.options[r]) == null ? void 0 : o.preload) == null ? void 0 : f.call(o);
    })
    .filter(Boolean);
  if (u.length !== 0) return Promise.all(u);
}
function xu(n, l = ss) {
  !n._lazyLoaded &&
    n._lazyPromise === void 0 &&
    (n.lazyFn
      ? (n._lazyPromise = n.lazyFn().then((r) => {
          const { id: o, ...f } = r.options;
          (Object.assign(n.options, f), (n._lazyLoaded = !0), (n._lazyPromise = void 0));
        }))
      : (n._lazyLoaded = !0));
  const u = () =>
    n._componentsLoaded
      ? void 0
      : l === ss
        ? (() => {
            if (n._componentsPromise === void 0) {
              const r = sv(n, ss);
              r
                ? (n._componentsPromise = r.then(() => {
                    ((n._componentsLoaded = !0), (n._componentsPromise = void 0));
                  }))
                : (n._componentsLoaded = !0);
            }
            return n._componentsPromise;
          })()
        : sv(n, l);
  return n._lazyPromise ? n._lazyPromise.then(u) : u();
}
function mg(n) {
  var l;
  for (const u of ss) if ((l = n.options[u]) != null && l.preload) return !0;
  return !1;
}
var ss = ["component", "errorComponent", "pendingComponent", "notFoundComponent"],
  Ma = "__TSR_index",
  cv = "popstate",
  ov = "beforeunload";
function Pb(n) {
  let l = n.getLocation();
  const u = new Set(),
    r = (d) => {
      ((l = n.getLocation()), u.forEach((m) => m({ location: l, action: d })));
    },
    o = (d) => {
      (n.notifyOnIndexChange ?? !0) ? r(d) : (l = n.getLocation());
    },
    f = async ({ task: d, navigateOpts: m, ...y }) => {
      var g, b;
      if ((m == null ? void 0 : m.ignoreBlocker) ?? !1) {
        d();
        return;
      }
      const v = ((g = n.getBlockers) == null ? void 0 : g.call(n)) ?? [],
        p = y.type === "PUSH" || y.type === "REPLACE";
      if (typeof document < "u" && v.length && p)
        for (const E of v) {
          const R = ms(y.path, y.state);
          if (await E.blockerFn({ currentLocation: l, nextLocation: R, action: y.type })) {
            (b = n.onBlocked) == null || b.call(n);
            return;
          }
        }
      d();
    };
  return {
    get location() {
      return l;
    },
    get length() {
      return n.getLength();
    },
    subscribers: u,
    subscribe: (d) => (
      u.add(d),
      () => {
        u.delete(d);
      }
    ),
    push: (d, m, y) => {
      const v = l.state[Ma];
      ((m = fv(v + 1, m)),
        f({
          task: () => {
            (n.pushState(d, m), r({ type: "PUSH" }));
          },
          navigateOpts: y,
          type: "PUSH",
          path: d,
          state: m,
        }));
    },
    replace: (d, m, y) => {
      const v = l.state[Ma];
      ((m = fv(v, m)),
        f({
          task: () => {
            (n.replaceState(d, m), r({ type: "REPLACE" }));
          },
          navigateOpts: y,
          type: "REPLACE",
          path: d,
          state: m,
        }));
    },
    go: (d, m) => {
      f({
        task: () => {
          (n.go(d), o({ type: "GO", index: d }));
        },
        navigateOpts: m,
        type: "GO",
      });
    },
    back: (d) => {
      f({
        task: () => {
          (n.back((d == null ? void 0 : d.ignoreBlocker) ?? !1), o({ type: "BACK" }));
        },
        navigateOpts: d,
        type: "BACK",
      });
    },
    forward: (d) => {
      f({
        task: () => {
          (n.forward((d == null ? void 0 : d.ignoreBlocker) ?? !1), o({ type: "FORWARD" }));
        },
        navigateOpts: d,
        type: "FORWARD",
      });
    },
    canGoBack: () => l.state[Ma] !== 0,
    createHref: (d) => n.createHref(d),
    block: (d) => {
      var y;
      if (!n.setBlockers) return () => {};
      const m = ((y = n.getBlockers) == null ? void 0 : y.call(n)) ?? [];
      return (
        n.setBlockers([...m, d]),
        () => {
          var p, g;
          const v = ((p = n.getBlockers) == null ? void 0 : p.call(n)) ?? [];
          (g = n.setBlockers) == null ||
            g.call(
              n,
              v.filter((b) => b !== d),
            );
        }
      );
    },
    flush: () => {
      var d;
      return (d = n.flush) == null ? void 0 : d.call(n);
    },
    destroy: () => {
      var d;
      return (d = n.destroy) == null ? void 0 : d.call(n);
    },
    notify: r,
  };
}
function fv(n, l) {
  l || (l = {});
  const u = Cf();
  return { ...l, key: u, __TSR_key: u, [Ma]: n };
}
function Jb(n) {
  var k, J;
  const l = typeof document < "u" ? window : void 0,
    u = l.history.pushState,
    r = l.history.replaceState;
  let o = [];
  const f = () => o,
    d = (F) => (o = F),
    m = (F) => F,
    y = () => ms(`${l.location.pathname}${l.location.search}${l.location.hash}`, l.history.state);
  if (
    !((k = l.history.state) != null && k.__TSR_key) &&
    !((J = l.history.state) != null && J.key)
  ) {
    const F = Cf();
    l.history.replaceState({ [Ma]: 0, key: F, __TSR_key: F }, "");
  }
  let v = y(),
    p,
    g = !1,
    b = !1,
    E = !1,
    R = !1;
  const M = () => v;
  let x, U;
  const G = () => {
      x &&
        ((q._ignoreSubscribers = !0),
        (x.isPush ? l.history.pushState : l.history.replaceState)(x.state, "", x.href),
        (q._ignoreSubscribers = !1),
        (x = void 0),
        (U = void 0),
        (p = void 0));
    },
    C = (F, W, et) => {
      const rt = m(W);
      (U || (p = v),
        (v = ms(W, et)),
        (x = { href: rt, state: et, isPush: (x == null ? void 0 : x.isPush) || F === "push" }),
        U || (U = Promise.resolve().then(() => G())));
    },
    z = (F) => {
      ((v = y()), q.notify({ type: F }));
    },
    Y = async () => {
      if (b) {
        b = !1;
        return;
      }
      const F = y(),
        W = F.state[Ma] - v.state[Ma],
        et = W === 1,
        rt = W === -1,
        dt = (!et && !rt) || g;
      g = !1;
      const it = dt ? "GO" : rt ? "BACK" : "FORWARD",
        j = dt ? { type: "GO", index: W } : { type: rt ? "BACK" : "FORWARD" };
      if (E) E = !1;
      else {
        const P = f();
        if (typeof document < "u" && P.length) {
          for (const nt of P)
            if (await nt.blockerFn({ currentLocation: v, nextLocation: F, action: it })) {
              ((b = !0), l.history.go(1), q.notify(j));
              return;
            }
        }
      }
      ((v = y()), q.notify(j));
    },
    I = (F) => {
      if (R) {
        R = !1;
        return;
      }
      let W = !1;
      const et = f();
      if (typeof document < "u" && et.length)
        for (const rt of et) {
          const dt = rt.enableBeforeUnload ?? !0;
          if (dt === !0) {
            W = !0;
            break;
          }
          if (typeof dt == "function" && dt() === !0) {
            W = !0;
            break;
          }
        }
      if (W) return (F.preventDefault(), (F.returnValue = ""));
    },
    q = Pb({
      getLocation: M,
      getLength: () => l.history.length,
      pushState: (F, W) => C("push", F, W),
      replaceState: (F, W) => C("replace", F, W),
      back: (F) => (F && (E = !0), (R = !0), l.history.back()),
      forward: (F) => {
        (F && (E = !0), (R = !0), l.history.forward());
      },
      go: (F) => {
        ((g = !0), l.history.go(F));
      },
      createHref: (F) => m(F),
      flush: G,
      destroy: () => {
        ((l.history.pushState = u),
          (l.history.replaceState = r),
          l.removeEventListener(ov, I, { capture: !0 }),
          l.removeEventListener(cv, Y));
      },
      onBlocked: () => {
        p && v !== p && (v = p);
      },
      getBlockers: f,
      setBlockers: d,
      notifyOnIndexChange: !1,
    });
  return (
    l.addEventListener(ov, I, { capture: !0 }),
    l.addEventListener(cv, Y),
    (l.history.pushState = function (...F) {
      const W = u.apply(l.history, F);
      return (q._ignoreSubscribers || z("PUSH"), W);
    }),
    (l.history.replaceState = function (...F) {
      const W = r.apply(l.history, F);
      return (q._ignoreSubscribers || z("REPLACE"), W);
    }),
    q
  );
}
function Fb(n) {
  let l = n.replace(/[\x00-\x1f\x7f]/g, "");
  return (l.startsWith("//") && (l = "/" + l.replace(/^\/+/, "")), l);
}
function ms(n, l) {
  const u = Fb(n),
    r = u.indexOf("#"),
    o = u.indexOf("?"),
    f = Cf();
  return {
    href: u,
    pathname: u.substring(0, r > 0 ? (o > 0 ? Math.min(r, o) : r) : o > 0 ? o : u.length),
    hash: r > -1 ? u.substring(r) : "",
    search: o > -1 ? u.slice(o, r === -1 ? void 0 : r) : "",
    state: l || { [Ma]: 0, key: f, __TSR_key: f },
  };
}
function Cf() {
  return (Math.random() + 1).toString(36).substring(7);
}
function kb(n) {
  return n instanceof Error ? { name: n.name, message: n.message } : { data: n };
}
function ai(n, l) {
  const u = l,
    r = n;
  return {
    fromLocation: u,
    toLocation: r,
    pathChanged: (u == null ? void 0 : u.pathname) !== r.pathname,
    hrefChanged: (u == null ? void 0 : u.href) !== r.href,
    hashChanged: (u == null ? void 0 : u.hash) !== r.hash,
  };
}
var Ib = class {
    constructor(n, l) {
      ((this.tempLocationKey = `${Math.round(Math.random() * 1e7)}`),
        (this.resetNextScroll = !0),
        (this.shouldViewTransition = void 0),
        (this.isViewTransitionTypesSupported = void 0),
        (this.subscribers = new Set()),
        (this.isScrollRestoring = !1),
        (this.isScrollRestorationSetup = !1),
        (this.startTransition = (u) => u()),
        (this.update = (u) => {
          var p;
          const r = this.options,
            o = this.basepath ?? (r == null ? void 0 : r.basepath) ?? "/",
            f = this.basepath === void 0,
            d = r == null ? void 0 : r.rewrite;
          if (
            ((this.options = { ...r, ...u }),
            (this.isServer = this.options.isServer ?? typeof document > "u"),
            (this.protocolAllowlist = new Set(this.options.protocolAllowlist)),
            this.options.pathParamsAllowedCharacters &&
              (this.pathParamsDecoder = xb(this.options.pathParamsAllowedCharacters)),
            (!this.history || (this.options.history && this.options.history !== this.history)) &&
              (this.options.history
                ? (this.history = this.options.history)
                : (this.history = Jb())),
            (this.origin = this.options.origin),
            this.origin ||
              (window != null && window.origin && window.origin !== "null"
                ? (this.origin = window.origin)
                : (this.origin = "http://localhost")),
            this.history && this.updateLatestLocation(),
            this.options.routeTree !== this.routeTree)
          ) {
            this.routeTree = this.options.routeTree;
            let g;
            ((this.resolvePathCache = Au(1e3)), (g = this.buildRouteTree()), this.setRoutes(g));
          }
          if (!this.stores && this.latestLocation) {
            const g = this.getStoreConfig(this);
            ((this.batch = g.batch), (this.stores = Yb(Wb(this.latestLocation), g)), Db(this));
          }
          let m = !1;
          const y = this.options.basepath ?? "/",
            v = this.options.rewrite;
          if (f || o !== y || d !== v) {
            this.basepath = y;
            const g = [],
              b = ug(y);
            (b && b !== "/" && g.push(qb({ basepath: y })),
              v && g.push(v),
              (this.rewrite = g.length === 0 ? void 0 : g.length === 1 ? g[0] : Hb(g)),
              this.history && this.updateLatestLocation(),
              (m = !0));
          }
          (m && this.stores && this.stores.location.set(this.latestLocation),
            typeof window < "u" &&
              "CSS" in window &&
              typeof ((p = window.CSS) == null ? void 0 : p.supports) == "function" &&
              (this.isViewTransitionTypesSupported = window.CSS.supports(
                "selector(:active-view-transition-type(a)",
              )));
        }),
        (this.updateLatestLocation = () => {
          this.latestLocation = this.parseLocation(this.history.location, this.latestLocation);
        }),
        (this.buildRouteTree = () => {
          const u = bb(this.routeTree, this.options.caseSensitive, (r, o) => {
            r.init({ originalIndex: o });
          });
          return (this.options.routeMasks && yb(this.options.routeMasks, u.processedTree), u);
        }),
        (this.subscribe = (u, r) => {
          const o = { eventType: u, fn: r };
          return (
            this.subscribers.add(o),
            () => {
              this.subscribers.delete(o);
            }
          );
        }),
        (this.emit = (u) => {
          this.subscribers.forEach((r) => {
            r.eventType === u.type && r.fn(u);
          });
        }),
        (this.parseLocation = (u, r) => {
          const o = ({ pathname: y, search: v, hash: p, href: g, state: b }) => {
              if (!this.rewrite && !/[ \x00-\x1f\x7f\u0080-\uffff]/.test(y)) {
                const U = this.options.parseSearch(v),
                  G = this.options.stringifySearch(U);
                return {
                  href: y + G + p,
                  publicHref: y + G + p,
                  pathname: hu(y).path,
                  external: !1,
                  searchStr: G,
                  search: Ia(r == null ? void 0 : r.search, U),
                  hash: hu(p.slice(1)).path,
                  state: Wa(r == null ? void 0 : r.state, b),
                };
              }
              const E = new URL(g, this.origin),
                R = hf(this.rewrite, E),
                M = this.options.parseSearch(R.search),
                x = this.options.stringifySearch(M);
              return (
                (R.search = x),
                {
                  href: R.href.replace(R.origin, ""),
                  publicHref: g,
                  pathname: hu(R.pathname).path,
                  external: !!this.rewrite && R.origin !== this.origin,
                  searchStr: x,
                  search: Ia(r == null ? void 0 : r.search, M),
                  hash: hu(R.hash.slice(1)).path,
                  state: Wa(r == null ? void 0 : r.state, b),
                }
              );
            },
            f = o(u),
            { __tempLocation: d, __tempKey: m } = f.state;
          if (d && (!m || m === this.tempLocationKey)) {
            const y = o(d);
            return (
              (y.state.key = f.state.key),
              (y.state.__TSR_key = f.state.__TSR_key),
              delete y.state.__tempLocation,
              { ...y, maskedLocation: f }
            );
          }
          return f;
        }),
        (this.resolvePathWithBase = (u, r) =>
          Ab({
            base: u,
            to: Of(r),
            trailingSlash: this.options.trailingSlash,
            cache: this.resolvePathCache,
          })),
        (this.matchRoutes = (u, r, o) =>
          typeof u == "string"
            ? this.matchRoutesInternal({ pathname: u, search: r }, o)
            : this.matchRoutesInternal(u, r)),
        (this.getMatchedRoutes = (u) =>
          t1({ pathname: u, routesById: this.routesById, processedTree: this.processedTree })),
        (this.cancelMatch = (u) => {
          const r = this.getMatch(u);
          r &&
            (r.abortController.abort(),
            clearTimeout(r._nonReactive.pendingTimeout),
            (r._nonReactive.pendingTimeout = void 0));
        }),
        (this.cancelMatches = () => {
          (this.stores.pendingIds.get().forEach((u) => {
            this.cancelMatch(u);
          }),
            this.stores.matchesId.get().forEach((u) => {
              var o;
              if (this.stores.pendingMatchStores.has(u)) return;
              const r = (o = this.stores.matchStores.get(u)) == null ? void 0 : o.get();
              r && (r.status === "pending" || r.isFetching === "loader") && this.cancelMatch(u);
            }));
        }),
        (this.buildLocation = (u) => {
          const r = (f = {}) => {
              var F, W;
              const d = f._fromLocation || this.pendingBuiltLocation || this.latestLocation,
                m = this.matchRoutesLightweight(d);
              f.from;
              const y = f.unsafeRelative === "path" ? d.pathname : (f.from ?? m.fullPath),
                v = this.resolvePathWithBase(y, "."),
                p = m.search,
                g = Object.assign(Object.create(null), m.params),
                b = f.to
                  ? this.resolvePathWithBase(v, `${f.to}`)
                  : this.resolvePathWithBase(v, "."),
                E =
                  f.params === !1 || f.params === null
                    ? Object.create(null)
                    : (f.params ?? !0) === !0
                      ? g
                      : Object.assign(g, Ta(f.params, g)),
                R = this.getMatchedRoutes(b);
              let M = R.matchedRoutes;
              if (
                ((!R.foundRoute || (R.foundRoute.path !== "/" && R.routeParams["**"])) &&
                  this.options.notFoundRoute &&
                  (M = [...M, this.options.notFoundRoute]),
                Object.keys(E).length > 0)
              )
                for (const et of M) {
                  const rt =
                    ((F = et.options.params) == null ? void 0 : F.stringify) ??
                    et.options.stringifyParams;
                  if (rt)
                    try {
                      Object.assign(E, rt(E));
                    } catch {}
                }
              const x = u.leaveParams
                ? b
                : hu(
                    tv({
                      path: b,
                      params: E,
                      decoder: this.pathParamsDecoder,
                      server: this.isServer,
                    }).interpolatedPath,
                  ).path;
              let U = p;
              if (u._includeValidateSearch && (W = this.options.search) != null && W.strict) {
                const et = {};
                (M.forEach((rt) => {
                  if (rt.options.validateSearch)
                    try {
                      Object.assign(et, cs(rt.options.validateSearch, { ...et, ...U }));
                    } catch {}
                }),
                  (U = et));
              }
              ((U = e1({
                search: U,
                dest: f,
                destRoutes: M,
                _includeValidateSearch: u._includeValidateSearch,
              })),
                (U = Ia(p, U)));
              const G = this.options.stringifySearch(U),
                C = f.hash === !0 ? d.hash : f.hash ? Ta(f.hash, d.hash) : void 0,
                z = C ? `#${C}` : "";
              let Y = f.state === !0 ? d.state : f.state ? Ta(f.state, d.state) : {};
              Y = Wa(d.state, Y);
              const I = `${x}${G}${z}`;
              let q,
                k,
                J = !1;
              if (this.rewrite) {
                const et = new URL(I, this.origin),
                  rt = og(this.rewrite, et);
                ((q = et.href.replace(et.origin, "")),
                  rt.origin !== this.origin
                    ? ((k = rt.href), (J = !0))
                    : (k = rt.pathname + rt.search + rt.hash));
              } else ((q = db(I)), (k = q));
              return {
                publicHref: k,
                href: q,
                pathname: x,
                search: U,
                searchStr: G,
                state: Y,
                hash: C ?? "",
                external: J,
                unmaskOnReload: f.unmaskOnReload,
              };
            },
            o = (f = {}, d) => {
              const m = r(f);
              let y = d ? r(d) : void 0;
              if (!y) {
                const v = Object.create(null);
                if (this.options.routeMasks) {
                  const p = vb(m.pathname, this.processedTree);
                  if (p) {
                    Object.assign(v, p.rawParams);
                    const { from: g, params: b, ...E } = p.route,
                      R =
                        b === !1 || b === null
                          ? Object.create(null)
                          : (b ?? !0) === !0
                            ? v
                            : Object.assign(v, Ta(b, v));
                    ((d = { from: u.from, ...E, params: R }), (y = r(d)));
                  }
                }
              }
              return (y && (m.maskedLocation = y), m);
            };
          return u.mask ? o(u, { from: u.from, ...u.mask }) : o(u);
        }),
        (this.commitLocation = async ({ viewTransition: u, ignoreBlocker: r, ...o }) => {
          const f = () => {
              const y = ["key", "__TSR_key", "__TSR_index", "__hashScrollIntoViewOptions"];
              y.forEach((p) => {
                o.state[p] = this.latestLocation.state[p];
              });
              const v = Oe(o.state, this.latestLocation.state);
              return (
                y.forEach((p) => {
                  delete o.state[p];
                }),
                v
              );
            },
            d = xa(this.latestLocation.href) === xa(o.href);
          let m = this.commitLocationPromise;
          if (
            ((this.commitLocationPromise = fl(() => {
              (m == null || m.resolve(), (m = void 0));
            })),
            d && f())
          )
            this.load();
          else {
            let { maskedLocation: y, hashScrollIntoView: v, ...p } = o;
            (y &&
              ((p = {
                ...y,
                state: {
                  ...y.state,
                  __tempKey: void 0,
                  __tempLocation: {
                    ...p,
                    search: p.searchStr,
                    state: {
                      ...p.state,
                      __tempKey: void 0,
                      __tempLocation: void 0,
                      __TSR_key: void 0,
                      key: void 0,
                    },
                  },
                },
              }),
              (p.unmaskOnReload ?? this.options.unmaskOnReload ?? !1) &&
                (p.state.__tempKey = this.tempLocationKey)),
              (p.state.__hashScrollIntoViewOptions =
                v ?? this.options.defaultHashScrollIntoView ?? !0),
              (this.shouldViewTransition = u),
              this.history[o.replace ? "replace" : "push"](p.publicHref, p.state, {
                ignoreBlocker: r,
              }));
          }
          return (
            (this.resetNextScroll = o.resetScroll ?? !0),
            this.history.subscribers.size || this.load(),
            this.commitLocationPromise
          );
        }),
        (this.buildAndCommitLocation = ({
          replace: u,
          resetScroll: r,
          hashScrollIntoView: o,
          viewTransition: f,
          ignoreBlocker: d,
          href: m,
          ...y
        } = {}) => {
          if (m) {
            const g = this.history.location.state.__TSR_index,
              b = ms(m, { __TSR_index: u ? g : g + 1 }),
              E = new URL(b.pathname, this.origin);
            ((y.to = hf(this.rewrite, E).pathname),
              (y.search = this.options.parseSearch(b.search)),
              (y.hash = b.hash.slice(1)));
          }
          const v = this.buildLocation({ ...y, _includeValidateSearch: !0 });
          this.pendingBuiltLocation = v;
          const p = this.commitLocation({
            ...v,
            viewTransition: f,
            replace: u,
            resetScroll: r,
            hashScrollIntoView: o,
            ignoreBlocker: d,
          });
          return (
            Promise.resolve().then(() => {
              this.pendingBuiltLocation === v && (this.pendingBuiltLocation = void 0);
            }),
            p
          );
        }),
        (this.navigate = async ({ to: u, reloadDocument: r, href: o, publicHref: f, ...d }) => {
          var y, v;
          let m = !1;
          if (o)
            try {
              (new URL(`${o}`), (m = !0));
            } catch {}
          if ((m && !r && (r = !0), r)) {
            if (u !== void 0 || !o) {
              const g = this.buildLocation({ to: u, ...d });
              ((o = o ?? g.publicHref), (f = f ?? g.publicHref));
            }
            const p = !m && f ? f : o;
            if (ds(p, this.protocolAllowlist)) return Promise.resolve();
            if (!d.ignoreBlocker) {
              const g = ((v = (y = this.history).getBlockers) == null ? void 0 : v.call(y)) ?? [];
              for (const b of g)
                if (
                  b != null &&
                  b.blockerFn &&
                  (await b.blockerFn({
                    currentLocation: this.latestLocation,
                    nextLocation: this.latestLocation,
                    action: "PUSH",
                  }))
                )
                  return Promise.resolve();
            }
            return (
              d.replace ? window.location.replace(p) : (window.location.href = p), Promise.resolve()
            );
          }
          return this.buildAndCommitLocation({ ...d, href: o, to: u, _isNavigate: !0 });
        }),
        (this.beforeLoad = () => {
          (this.cancelMatches(), this.updateLatestLocation());
          const u = this.matchRoutes(this.latestLocation),
            r = this.stores.cachedMatches.get().filter((o) => !u.some((f) => f.id === o.id));
          this.batch(() => {
            (this.stores.status.set("pending"),
              this.stores.statusCode.set(200),
              this.stores.isLoading.set(!0),
              this.stores.location.set(this.latestLocation),
              this.stores.setPending(u),
              this.stores.setCached(r));
          });
        }),
        (this.load = async (u) => {
          let r, o, f;
          const d = this.stores.resolvedLocation.get() ?? this.stores.location.get();
          for (
            f = new Promise((y) => {
              this.startTransition(async () => {
                var v;
                try {
                  this.beforeLoad();
                  const p = this.latestLocation,
                    g = ai(p, this.stores.resolvedLocation.get());
                  (this.stores.redirect.get() || this.emit({ type: "onBeforeNavigate", ...g }),
                    this.emit({ type: "onBeforeLoad", ...g }),
                    await rv({
                      router: this,
                      sync: u == null ? void 0 : u.sync,
                      forceStaleReload: d.href === p.href,
                      matches: this.stores.pendingMatches.get(),
                      location: p,
                      updateMatch: this.updateMatch,
                      onReady: async () => {
                        this.startTransition(() => {
                          this.startViewTransition(async () => {
                            var x, U;
                            let b = null,
                              E = null,
                              R = null,
                              M = null;
                            this.batch(() => {
                              const G = this.stores.pendingMatches.get(),
                                C = G.length,
                                z = this.stores.matches.get();
                              b = C
                                ? z.filter((q) => !this.stores.pendingMatchStores.has(q.id))
                                : null;
                              const Y = new Set();
                              for (const q of this.stores.pendingMatchStores.values())
                                q.routeId && Y.add(q.routeId);
                              const I = new Set();
                              for (const q of this.stores.matchStores.values())
                                q.routeId && I.add(q.routeId);
                              ((E = C ? z.filter((q) => !Y.has(q.routeId)) : null),
                                (R = C ? G.filter((q) => !I.has(q.routeId)) : null),
                                (M = C ? G.filter((q) => I.has(q.routeId)) : z),
                                this.stores.isLoading.set(!1),
                                this.stores.loadedAt.set(Date.now()),
                                C &&
                                  (this.stores.setMatches(G),
                                  this.stores.setPending([]),
                                  this.stores.setCached([
                                    ...this.stores.cachedMatches.get(),
                                    ...b.filter(
                                      (q) =>
                                        q.status !== "error" &&
                                        q.status !== "notFound" &&
                                        q.status !== "redirected",
                                    ),
                                  ]),
                                  this.clearExpiredCache()));
                            });
                            for (const [G, C] of [
                              [E, "onLeave"],
                              [R, "onEnter"],
                              [M, "onStay"],
                            ])
                              if (G)
                                for (const z of G)
                                  (U = (x = this.looseRoutesById[z.routeId].options)[C]) == null ||
                                    U.call(x, z);
                          });
                        });
                      },
                    }));
                } catch (p) {
                  _e(p)
                    ? ((r = p), this.navigate({ ...r.options, replace: !0, ignoreBlocker: !0 }))
                    : re(p) && (o = p);
                  const g = r
                    ? r.status
                    : o
                      ? 404
                      : this.stores.matches.get().some((b) => b.status === "error")
                        ? 500
                        : 200;
                  this.batch(() => {
                    (this.stores.statusCode.set(g), this.stores.redirect.set(r));
                  });
                }
                (this.latestLoadPromise === f &&
                  ((v = this.commitLocationPromise) == null || v.resolve(),
                  (this.latestLoadPromise = void 0),
                  (this.commitLocationPromise = void 0)),
                  y());
              });
            }),
              this.latestLoadPromise = f,
              await f;
            this.latestLoadPromise && f !== this.latestLoadPromise;
          )
            await this.latestLoadPromise;
          let m;
          (this.hasNotFoundMatch()
            ? (m = 404)
            : this.stores.matches.get().some((y) => y.status === "error") && (m = 500),
            m !== void 0 && this.stores.statusCode.set(m));
        }),
        (this.startViewTransition = (u) => {
          const r = this.shouldViewTransition ?? this.options.defaultViewTransition;
          if (
            ((this.shouldViewTransition = void 0),
            r &&
              typeof document < "u" &&
              "startViewTransition" in document &&
              typeof document.startViewTransition == "function")
          ) {
            let o;
            if (typeof r == "object" && this.isViewTransitionTypesSupported) {
              const f = this.latestLocation,
                d = this.stores.resolvedLocation.get(),
                m = typeof r.types == "function" ? r.types(ai(f, d)) : r.types;
              if (m === !1) {
                u();
                return;
              }
              o = { update: u, types: m };
            } else o = u;
            document.startViewTransition(o);
          } else u();
        }),
        (this.updateMatch = (u, r) => {
          this.startTransition(() => {
            const o = this.stores.pendingMatchStores.get(u);
            if (o) {
              o.set(r);
              return;
            }
            const f = this.stores.matchStores.get(u);
            if (f) {
              f.set(r);
              return;
            }
            const d = this.stores.cachedMatchStores.get(u);
            if (d) {
              const m = r(d.get());
              m.status === "redirected"
                ? this.stores.cachedMatchStores.delete(u) &&
                  this.stores.cachedIds.set((y) => y.filter((v) => v !== u))
                : d.set(m);
            }
          });
        }),
        (this.getMatch = (u) => {
          var r, o, f;
          return (
            ((r = this.stores.cachedMatchStores.get(u)) == null ? void 0 : r.get()) ??
            ((o = this.stores.pendingMatchStores.get(u)) == null ? void 0 : o.get()) ??
            ((f = this.stores.matchStores.get(u)) == null ? void 0 : f.get())
          );
        }),
        (this.invalidate = (u) => {
          const r = (o) => {
            var f;
            return (((f = u == null ? void 0 : u.filter) == null ? void 0 : f.call(u, o)) ?? !0)
              ? {
                  ...o,
                  invalid: !0,
                  ...((u != null && u.forcePending) ||
                  o.status === "error" ||
                  o.status === "notFound"
                    ? { status: "pending", error: void 0 }
                    : void 0),
                }
              : o;
          };
          return (
            this.batch(() => {
              (this.stores.setMatches(this.stores.matches.get().map(r)),
                this.stores.setCached(this.stores.cachedMatches.get().map(r)),
                this.stores.setPending(this.stores.pendingMatches.get().map(r)));
            }),
            (this.shouldViewTransition = !1),
            this.load({ sync: u == null ? void 0 : u.sync })
          );
        }),
        (this.getParsedLocationHref = (u) => u.publicHref || "/"),
        (this.resolveRedirect = (u) => {
          const r = u.headers.get("Location");
          if (!u.options.href || u.options._builtLocation) {
            const o = u.options._builtLocation ?? this.buildLocation(u.options),
              f = this.getParsedLocationHref(o);
            ((u.options.href = f), u.headers.set("Location", f));
          } else if (r)
            try {
              const o = new URL(r);
              if (this.origin && o.origin === this.origin) {
                const f = o.pathname + o.search + o.hash;
                ((u.options.href = f), u.headers.set("Location", f));
              }
            } catch {}
          if (
            u.options.href &&
            !u.options._builtLocation &&
            ds(u.options.href, this.protocolAllowlist)
          )
            throw new Error("Redirect blocked: unsafe protocol");
          return (u.headers.get("Location") || u.headers.set("Location", u.options.href), u);
        }),
        (this.clearCache = (u) => {
          const r = u == null ? void 0 : u.filter;
          r !== void 0
            ? this.stores.setCached(this.stores.cachedMatches.get().filter((o) => !r(o)))
            : this.stores.setCached([]);
        }),
        (this.clearExpiredCache = () => {
          const u = Date.now(),
            r = (o) => {
              const f = this.looseRoutesById[o.routeId];
              if (!f.options.loader) return !0;
              const d =
                (o.preload
                  ? (f.options.preloadGcTime ?? this.options.defaultPreloadGcTime)
                  : (f.options.gcTime ?? this.options.defaultGcTime)) ?? 300 * 1e3;
              return o.status === "error" ? !0 : u - o.updatedAt >= d;
            };
          this.clearCache({ filter: r });
        }),
        (this.loadRouteChunk = xu),
        (this.preloadRoute = async (u) => {
          const r = u._builtLocation ?? this.buildLocation(u);
          let o = this.matchRoutes(r, { throwOnError: !0, preload: !0, dest: u });
          const f = new Set([...this.stores.matchesId.get(), ...this.stores.pendingIds.get()]),
            d = new Set([...f, ...this.stores.cachedIds.get()]),
            m = o.filter((y) => !d.has(y.id));
          if (m.length) {
            const y = this.stores.cachedMatches.get();
            this.stores.setCached([...y, ...m]);
          }
          try {
            return (
              (o = await rv({
                router: this,
                matches: o,
                location: r,
                preload: !0,
                updateMatch: (y, v) => {
                  f.has(y) ? (o = o.map((p) => (p.id === y ? v(p) : p))) : this.updateMatch(y, v);
                },
              })),
              o
            );
          } catch (y) {
            if (_e(y))
              return y.options.reloadDocument
                ? void 0
                : await this.preloadRoute({ ...y.options, _fromLocation: r });
            re(y) || console.error(y);
            return;
          }
        }),
        (this.matchRoute = (u, r) => {
          const o = {
              ...u,
              to: u.to ? this.resolvePathWithBase(u.from || "", u.to) : void 0,
              params: u.params || {},
              leaveParams: !0,
            },
            f = this.buildLocation(o);
          if (r != null && r.pending && this.stores.status.get() !== "pending") return !1;
          const d = (
              (r == null ? void 0 : r.pending) === void 0 ? !this.stores.isLoading.get() : r.pending
            )
              ? this.latestLocation
              : this.stores.resolvedLocation.get() || this.stores.location.get(),
            m = gb(
              f.pathname,
              (r == null ? void 0 : r.caseSensitive) ?? !1,
              (r == null ? void 0 : r.fuzzy) ?? !1,
              d.pathname,
              this.processedTree,
            );
          return !m || (u.params && !Oe(m.rawParams, u.params, { partial: !0 }))
            ? !1
            : ((r == null ? void 0 : r.includeSearch) ?? !0)
              ? Oe(d.search, f.search, { partial: !0 })
                ? m.rawParams
                : !1
              : m.rawParams;
        }),
        (this.hasNotFoundMatch = () =>
          this.stores.matches.get().some((u) => u.status === "notFound" || u.globalNotFound)),
        (this.getStoreConfig = l),
        this.update({
          defaultPreloadDelay: 50,
          defaultPendingMs: 1e3,
          defaultPendingMinMs: 500,
          context: void 0,
          ...n,
          caseSensitive: n.caseSensitive ?? !1,
          notFoundMode: n.notFoundMode ?? "fuzzy",
          stringifySearch: n.stringifySearch ?? Nb,
          parseSearch: n.parseSearch ?? Lb,
          protocolAllowlist: n.protocolAllowlist ?? sb,
        }),
        typeof document < "u" && (self.__TSR_ROUTER__ = this));
    }
    isShell() {
      return !!this.options.isShell;
    }
    isPrerendering() {
      return !!this.options.isPrerendering;
    }
    get state() {
      return this.stores.__store.get();
    }
    setRoutes({ routesById: n, routesByPath: l, processedTree: u }) {
      ((this.routesById = n), (this.routesByPath = l), (this.processedTree = u));
      const r = this.options.notFoundRoute;
      r && (r.init({ originalIndex: 99999999999 }), (this.routesById[r.id] = r));
    }
    get looseRoutesById() {
      return this.routesById;
    }
    getParentContext(n) {
      return n != null && n.id
        ? (n.context ?? this.options.context ?? void 0)
        : (this.options.context ?? void 0);
    }
    matchRoutesInternal(n, l) {
      var g, b;
      const u = this.getMatchedRoutes(n.pathname),
        { foundRoute: r, routeParams: o, parsedParams: f } = u;
      let { matchedRoutes: d } = u,
        m = !1;
      (r ? r.path !== "/" && o["**"] : xa(n.pathname)) &&
        (this.options.notFoundRoute ? (d = [...d, this.options.notFoundRoute]) : (m = !0));
      const y = m ? a1(this.options.notFoundMode, d) : void 0,
        v = new Array(d.length),
        p = new Map();
      for (const E of this.stores.matchStores.values()) E.routeId && p.set(E.routeId, E.get());
      for (let E = 0; E < d.length; E++) {
        const R = d[E],
          M = v[E - 1];
        let x, U, G;
        {
          const it = (M == null ? void 0 : M.search) ?? n.search,
            j = (M == null ? void 0 : M._strictSearch) ?? void 0;
          try {
            const P = cs(R.options.validateSearch, { ...it }) ?? void 0;
            ((x = { ...it, ...P }), (U = { ...j, ...P }), (G = void 0));
          } catch (P) {
            let nt = P;
            if (
              (P instanceof ys || (nt = new ys(P.message, { cause: P })),
              l != null && l.throwOnError)
            )
              throw nt;
            ((x = it), (U = {}), (G = nt));
          }
        }
        const C =
            ((b = (g = R.options).loaderDeps) == null ? void 0 : b.call(g, { search: x })) ?? "",
          z = C ? JSON.stringify(C) : "",
          { interpolatedPath: Y, usedParams: I } = tv({
            path: R.fullPath,
            params: o,
            decoder: this.pathParamsDecoder,
            server: this.isServer,
          }),
          q = R.id + Y + z,
          k = this.getMatch(q),
          J = p.get(R.id),
          F = (k == null ? void 0 : k._strictParams) ?? I;
        let W;
        if (!k)
          try {
            dv(R, I, f, F);
          } catch (it) {
            if (
              (re(it) || _e(it) ? (W = it) : (W = new $b(it.message, { cause: it })),
              l != null && l.throwOnError)
            )
              throw W;
          }
        Object.assign(o, F);
        const et = J ? "stay" : "enter";
        let rt;
        if (k)
          rt = {
            ...k,
            cause: et,
            params: (J == null ? void 0 : J.params) ?? o,
            _strictParams: F,
            search: Ia(J ? J.search : k.search, x),
            _strictSearch: U,
          };
        else {
          const it =
            R.options.loader || R.options.beforeLoad || R.lazyFn || mg(R) ? "pending" : "success";
          rt = {
            id: q,
            ssr: R.options.ssr,
            index: E,
            routeId: R.id,
            params: (J == null ? void 0 : J.params) ?? o,
            _strictParams: F,
            pathname: Y,
            updatedAt: Date.now(),
            search: J ? Ia(J.search, x) : x,
            _strictSearch: U,
            searchError: void 0,
            status: it,
            isFetching: !1,
            error: void 0,
            paramsError: W,
            __routeContext: void 0,
            _nonReactive: { loadPromise: fl() },
            __beforeLoadContext: void 0,
            context: {},
            abortController: new AbortController(),
            fetchCount: 0,
            cause: et,
            loaderDeps: J ? Wa(J.loaderDeps, C) : C,
            invalid: !1,
            preload: !1,
            links: void 0,
            scripts: void 0,
            headScripts: void 0,
            meta: void 0,
            staticData: R.options.staticData || {},
            fullPath: R.fullPath,
          };
        }
        ((l != null && l.preload) || (rt.globalNotFound = y === R.id), (rt.searchError = G));
        const dt = this.getParentContext(M);
        ((rt.context = { ...dt, ...rt.__routeContext, ...rt.__beforeLoadContext }), (v[E] = rt));
      }
      for (let E = 0; E < v.length; E++) {
        const R = v[E],
          M = this.looseRoutesById[R.routeId],
          x = this.getMatch(R.id),
          U = p.get(R.routeId);
        if (((R.params = U ? Ia(U.params, o) : o), !x)) {
          const G = v[E - 1],
            C = this.getParentContext(G);
          if (M.options.context) {
            const z = {
              deps: R.loaderDeps,
              params: R.params,
              context: C ?? {},
              location: n,
              navigate: (Y) => this.navigate({ ...Y, _fromLocation: n }),
              buildLocation: this.buildLocation,
              cause: R.cause,
              abortController: R.abortController,
              preload: !!R.preload,
              matches: v,
              routeId: M.id,
            };
            R.__routeContext = M.options.context(z) ?? void 0;
          }
          R.context = { ...C, ...R.__routeContext, ...R.__beforeLoadContext };
        }
      }
      return v;
    }
    matchRoutesLightweight(n) {
      var p;
      const {
          matchedRoutes: l,
          routeParams: u,
          parsedParams: r,
        } = this.getMatchedRoutes(n.pathname),
        o = Ru(l),
        f = { ...n.search };
      for (const g of l)
        try {
          Object.assign(f, cs(g.options.validateSearch, f));
        } catch {}
      const d = Ru(this.stores.matchesId.get()),
        m = d && ((p = this.stores.matchStores.get(d)) == null ? void 0 : p.get()),
        y = m && m.routeId === o.id && m.pathname === n.pathname;
      let v;
      if (y) v = m.params;
      else {
        const g = Object.assign(Object.create(null), u);
        for (const b of l)
          try {
            dv(b, u, r ?? {}, g);
          } catch {}
        v = g;
      }
      return { matchedRoutes: l, fullPath: o.fullPath, search: f, params: v };
    }
  },
  ys = class extends Error {},
  $b = class extends Error {};
function Wb(n) {
  return {
    loadedAt: 0,
    isLoading: !1,
    isTransitioning: !1,
    status: "idle",
    resolvedLocation: void 0,
    location: n,
    matches: [],
    statusCode: 200,
  };
}
function cs(n, l) {
  if (n == null) return {};
  if ("~standard" in n) {
    const u = n["~standard"].validate(l);
    if (u instanceof Promise) throw new ys("Async validation not supported");
    if (u.issues) throw new ys(JSON.stringify(u.issues, void 0, 2), { cause: u });
    return u.value;
  }
  return "parse" in n ? n.parse(l) : typeof n == "function" ? n(l) : {};
}
function t1({ pathname: n, routesById: l, processedTree: u }) {
  const r = Object.create(null),
    o = xa(n);
  let f, d;
  const m = pb(o, u, !0);
  return (
    m &&
      ((f = m.route),
      Object.assign(r, m.rawParams),
      (d = Object.assign(Object.create(null), m.parsedParams))),
    {
      matchedRoutes: (m == null ? void 0 : m.branch) || [l.__root__],
      routeParams: r,
      foundRoute: f,
      parsedParams: d,
    }
  );
}
function e1({ search: n, dest: l, destRoutes: u, _includeValidateSearch: r }) {
  return n1(u)(n, l, r ?? !1);
}
function n1(n) {
  var o;
  const l = { dest: null, _includeValidateSearch: !1, middlewares: [] };
  for (const f of n) {
    if ("search" in f.options)
      (o = f.options.search) != null &&
        o.middlewares &&
        l.middlewares.push(...f.options.search.middlewares);
    else if (f.options.preSearchFilters || f.options.postSearchFilters) {
      const d = ({ search: m, next: y }) => {
        let v = m;
        "preSearchFilters" in f.options &&
          f.options.preSearchFilters &&
          (v = f.options.preSearchFilters.reduce((g, b) => b(g), m));
        const p = y(v);
        return "postSearchFilters" in f.options && f.options.postSearchFilters
          ? f.options.postSearchFilters.reduce((g, b) => b(g), p)
          : p;
      };
      l.middlewares.push(d);
    }
    if (f.options.validateSearch) {
      const d = ({ search: m, next: y }) => {
        const v = y(m);
        if (!l._includeValidateSearch) return v;
        try {
          return { ...v, ...(cs(f.options.validateSearch, v) ?? void 0) };
        } catch {
          return v;
        }
      };
      l.middlewares.push(d);
    }
  }
  const u = ({ search: f }) => {
    const d = l.dest;
    return d.search ? (d.search === !0 ? f : Ta(d.search, f)) : {};
  };
  l.middlewares.push(u);
  const r = (f, d, m) => {
    if (f >= m.length) return d;
    const y = m[f];
    return y({ search: d, next: (p) => r(f + 1, p, m) });
  };
  return function (d, m, y) {
    return ((l.dest = m), (l._includeValidateSearch = y), r(0, d, l.middlewares));
  };
}
function a1(n, l) {
  if (n !== "root")
    for (let u = l.length - 1; u >= 0; u--) {
      const r = l[u];
      if (r.children) return r.id;
    }
  return cl;
}
function dv(n, l, u, r) {
  var f;
  const o = ((f = n.options.params) == null ? void 0 : f.parse) ?? n.options.parseParams;
  if (o)
    if (n.options.skipRouteOnParseError) for (const d in l) d in u && (r[d] = u[d]);
    else {
      const d = o(r);
      Object.assign(r, d);
    }
}
var yn = Symbol.for("TSR_DEFERRED_PROMISE");
function l1(n, l) {
  const u = n;
  return (
    u[yn] ||
      ((u[yn] = { status: "pending" }),
      u
        .then((r) => {
          ((u[yn].status = "success"), (u[yn].data = r));
        })
        .catch((r) => {
          ((u[yn].status = "error"), (u[yn].error = { data: kb(r), __isServerError: !0 }));
        })),
    u
  );
}
var i1 = "Error preloading route! ☝️";
function hv(n, l) {
  if (n) return typeof n == "string" ? n : n[l];
}
function u1(n) {
  return typeof n == "string" ? { href: n, crossOrigin: void 0 } : n;
}
var yg = class {
    get to() {
      return this._to;
    }
    get id() {
      return this._id;
    }
    get path() {
      return this._path;
    }
    get fullPath() {
      return this._fullPath;
    }
    constructor(n) {
      if (
        ((this.init = (l) => {
          var y, v;
          this.originalIndex = l.originalIndex;
          const u = this.options,
            r = !(u != null && u.path) && !(u != null && u.id);
          ((this.parentRoute =
            (v = (y = this.options).getParentRoute) == null ? void 0 : v.call(y)),
            r ? (this._path = cl) : this.parentRoute || Ce());
          let o = r ? cl : u == null ? void 0 : u.path;
          o && o !== "/" && (o = ig(o));
          const f = (u == null ? void 0 : u.id) || o;
          let d = r ? cl : rs([this.parentRoute.id === "__root__" ? "" : this.parentRoute.id, f]);
          (o === "__root__" && (o = "/"), d !== "__root__" && (d = rs(["/", d])));
          const m = d === "__root__" ? "/" : rs([this.parentRoute.fullPath, o]);
          ((this._path = o), (this._id = d), (this._fullPath = m), (this._to = xa(m)));
        }),
        (this.addChildren = (l) => this._addFileChildren(l)),
        (this._addFileChildren = (l) => (
          Array.isArray(l) && (this.children = l),
          typeof l == "object" && l !== null && (this.children = Object.values(l)),
          this
        )),
        (this._addFileTypes = () => this),
        (this.updateLoader = (l) => (Object.assign(this.options, l), this)),
        (this.update = (l) => (Object.assign(this.options, l), this)),
        (this.lazy = (l) => ((this.lazyFn = l), this)),
        (this.redirect = (l) => sg({ from: this.fullPath, ...l })),
        (this.options = n || {}),
        (this.isRoot = !(n != null && n.getParentRoute)),
        n != null && n.id && n != null && n.path)
      )
        throw new Error("Route cannot have both an 'id' and a 'path' option.");
    }
  },
  r1 = class extends yg {
    constructor(n) {
      super(n);
    }
  };
function s1(n) {
  if (typeof document < "u" && document.querySelector) {
    const l = n.stores.location.get(),
      u = l.state.__hashScrollIntoViewOptions ?? !0;
    if (u && l.hash !== "") {
      const r = document.getElementById(l.hash);
      r && r.scrollIntoView(u);
    }
  }
}
var c1 = ((n) => (
    (n[(n.AggregateError = 1)] = "AggregateError"),
    (n[(n.ArrowFunction = 2)] = "ArrowFunction"),
    (n[(n.ErrorPrototypeStack = 4)] = "ErrorPrototypeStack"),
    (n[(n.ObjectAssign = 8)] = "ObjectAssign"),
    (n[(n.BigIntTypedArray = 16)] = "BigIntTypedArray"),
    (n[(n.RegExp = 32)] = "RegExp"),
    n
  ))(c1 || {}),
  Yn = Symbol.asyncIterator,
  vg = Symbol.hasInstance,
  li = Symbol.isConcatSpreadable,
  Qn = Symbol.iterator,
  gg = Symbol.match,
  pg = Symbol.matchAll,
  Sg = Symbol.replace,
  bg = Symbol.search,
  _g = Symbol.species,
  Eg = Symbol.split,
  Rg = Symbol.toPrimitive,
  ii = Symbol.toStringTag,
  Tg = Symbol.unscopables,
  Ag = {
    [Yn]: 0,
    [vg]: 1,
    [li]: 2,
    [Qn]: 3,
    [gg]: 4,
    [pg]: 5,
    [Sg]: 6,
    [bg]: 7,
    [_g]: 8,
    [Eg]: 9,
    [Rg]: 10,
    [ii]: 11,
    [Tg]: 12,
  },
  o1 = {
    0: Yn,
    1: vg,
    2: li,
    3: Qn,
    4: gg,
    5: pg,
    6: Sg,
    7: bg,
    8: _g,
    9: Eg,
    10: Rg,
    11: ii,
    12: Tg,
  },
  _ = void 0,
  f1 = {
    2: !0,
    3: !1,
    1: _,
    0: null,
    4: -0,
    5: Number.POSITIVE_INFINITY,
    6: Number.NEGATIVE_INFINITY,
    7: Number.NaN,
  },
  d1 = {
    0: "Error",
    1: "EvalError",
    2: "RangeError",
    3: "ReferenceError",
    4: "SyntaxError",
    5: "TypeError",
    6: "URIError",
  },
  h1 = {
    0: Error,
    1: EvalError,
    2: RangeError,
    3: ReferenceError,
    4: SyntaxError,
    5: TypeError,
    6: URIError,
  };
function Ot(n, l, u, r, o, f, d, m, y, v, p, g) {
  return { t: n, i: l, s: u, c: r, m: o, p: f, e: d, a: m, f: y, b: v, o: p, l: g };
}
function wa(n) {
  return Ot(2, _, n, _, _, _, _, _, _, _, _, _);
}
var xg = wa(2),
  Mg = wa(3),
  m1 = wa(1),
  y1 = wa(0),
  v1 = wa(4),
  g1 = wa(5),
  p1 = wa(6),
  S1 = wa(7);
function b1(n) {
  switch (n) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case `
`:
      return "\\n";
    case "\r":
      return "\\r";
    case "\b":
      return "\\b";
    case "	":
      return "\\t";
    case "\f":
      return "\\f";
    case "<":
      return "\\x3C";
    case "\u2028":
      return "\\u2028";
    case "\u2029":
      return "\\u2029";
    default:
      return _;
  }
}
function Oa(n) {
  let l = "",
    u = 0,
    r;
  for (let o = 0, f = n.length; o < f; o++)
    ((r = b1(n[o])), r && ((l += n.slice(u, o) + r), (u = o + 1)));
  return (u === 0 ? (l = n) : (l += n.slice(u)), l);
}
function _1(n) {
  switch (n) {
    case "\\\\":
      return "\\";
    case '\\"':
      return '"';
    case "\\n":
      return `
`;
    case "\\r":
      return "\r";
    case "\\b":
      return "\b";
    case "\\t":
      return "	";
    case "\\f":
      return "\f";
    case "\\x3C":
      return "<";
    case "\\u2028":
      return "\u2028";
    case "\\u2029":
      return "\u2029";
    default:
      return n;
  }
}
function Ca(n) {
  return n.replace(/(\\\\|\\"|\\n|\\r|\\b|\\t|\\f|\\u2028|\\u2029|\\x3C)/g, _1);
}
var ls = "__SEROVAL_REFS__",
  wg = new Map(),
  ni = new Map();
function Og(n) {
  return wg.has(n);
}
function E1(n) {
  return ni.has(n);
}
function R1(n) {
  if (Og(n)) return wg.get(n);
  throw new t_(n);
}
function T1(n) {
  if (E1(n)) return ni.get(n);
  throw new e_(n);
}
typeof globalThis < "u"
  ? Object.defineProperty(globalThis, ls, {
      value: ni,
      configurable: !0,
      writable: !1,
      enumerable: !1,
    })
  : typeof window < "u"
    ? Object.defineProperty(window, ls, {
        value: ni,
        configurable: !0,
        writable: !1,
        enumerable: !1,
      })
    : typeof self < "u"
      ? Object.defineProperty(self, ls, {
          value: ni,
          configurable: !0,
          writable: !1,
          enumerable: !1,
        })
      : typeof global < "u" &&
        Object.defineProperty(global, ls, {
          value: ni,
          configurable: !0,
          writable: !1,
          enumerable: !1,
        });
function zf(n) {
  return n instanceof EvalError
    ? 1
    : n instanceof RangeError
      ? 2
      : n instanceof ReferenceError
        ? 3
        : n instanceof SyntaxError
          ? 4
          : n instanceof TypeError
            ? 5
            : n instanceof URIError
              ? 6
              : 0;
}
function A1(n) {
  let l = d1[zf(n)];
  return n.name !== l
    ? { name: n.name }
    : n.constructor.name !== l
      ? { name: n.constructor.name }
      : {};
}
function Cg(n, l) {
  let u = A1(n),
    r = Object.getOwnPropertyNames(n);
  for (let o = 0, f = r.length, d; o < f; o++)
    ((d = r[o]),
      d !== "name" &&
        d !== "message" &&
        (d === "stack" ? l & 4 && ((u = u || {}), (u[d] = n[d])) : ((u = u || {}), (u[d] = n[d]))));
  return u;
}
function zg(n) {
  return Object.isFrozen(n) ? 3 : Object.isSealed(n) ? 2 : Object.isExtensible(n) ? 0 : 1;
}
function x1(n) {
  switch (n) {
    case Number.POSITIVE_INFINITY:
      return g1;
    case Number.NEGATIVE_INFINITY:
      return p1;
  }
  return n !== n ? S1 : Object.is(n, -0) ? v1 : Ot(0, _, n, _, _, _, _, _, _, _, _, _);
}
function Dg(n) {
  return Ot(1, _, Oa(n), _, _, _, _, _, _, _, _, _);
}
function M1(n) {
  return Ot(3, _, "" + n, _, _, _, _, _, _, _, _, _);
}
function w1(n) {
  return Ot(4, n, _, _, _, _, _, _, _, _, _, _);
}
function O1(n, l) {
  let u = l.valueOf();
  return Ot(5, n, u !== u ? "" : l.toISOString(), _, _, _, _, _, _, _, _, _);
}
function C1(n, l) {
  return Ot(6, n, _, Oa(l.source), l.flags, _, _, _, _, _, _, _);
}
function z1(n, l) {
  return Ot(17, n, Ag[l], _, _, _, _, _, _, _, _, _);
}
function D1(n, l) {
  return Ot(18, n, Oa(R1(l)), _, _, _, _, _, _, _, _, _);
}
function U1(n, l, u) {
  return Ot(25, n, u, Oa(l), _, _, _, _, _, _, _, _);
}
function L1(n, l, u) {
  return Ot(9, n, _, _, _, _, _, u, _, _, zg(l), _);
}
function N1(n, l) {
  return Ot(21, n, _, _, _, _, _, _, l, _, _, _);
}
function j1(n, l, u) {
  return Ot(15, n, _, l.constructor.name, _, _, _, _, u, l.byteOffset, _, l.length);
}
function B1(n, l, u) {
  return Ot(16, n, _, l.constructor.name, _, _, _, _, u, l.byteOffset, _, l.byteLength);
}
function H1(n, l, u) {
  return Ot(20, n, _, _, _, _, _, _, u, l.byteOffset, _, l.byteLength);
}
function q1(n, l, u) {
  return Ot(13, n, zf(l), _, Oa(l.message), u, _, _, _, _, _, _);
}
function Y1(n, l, u) {
  return Ot(14, n, zf(l), _, Oa(l.message), u, _, _, _, _, _, _);
}
function Q1(n, l) {
  return Ot(7, n, _, _, _, _, _, l, _, _, _, _);
}
function G1(n, l) {
  return Ot(28, _, _, _, _, _, _, [n, l], _, _, _, _);
}
function V1(n, l) {
  return Ot(30, _, _, _, _, _, _, [n, l], _, _, _, _);
}
function X1(n, l, u) {
  return Ot(31, n, _, _, _, _, _, u, l, _, _, _);
}
function Z1(n, l) {
  return Ot(32, n, _, _, _, _, _, _, l, _, _, _);
}
function K1(n, l) {
  return Ot(33, n, _, _, _, _, _, _, l, _, _, _);
}
function P1(n, l) {
  return Ot(34, n, _, _, _, _, _, _, l, _, _, _);
}
function J1(n, l, u, r) {
  return Ot(35, n, u, _, _, _, _, l, _, _, _, r);
}
var F1 = { parsing: 1, serialization: 2, deserialization: 3 };
function k1(n) {
  return `Seroval Error (step: ${F1[n]})`;
}
var I1 = (n, l) => k1(n),
  Ug = class extends Error {
    constructor(n, l) {
      (super(I1(n)), (this.cause = l));
    }
  },
  mv = class extends Ug {
    constructor(n) {
      super("parsing", n);
    }
  },
  $1 = class extends Ug {
    constructor(n) {
      super("deserialization", n);
    }
  };
function Gn(n) {
  return `Seroval Error (specific: ${n})`;
}
var Es = class extends Error {
    constructor(l) {
      (super(Gn(1)), (this.value = l));
    }
  },
  Lg = class extends Error {
    constructor(l) {
      super(Gn(2));
    }
  },
  W1 = class extends Error {
    constructor(n) {
      super(Gn(3));
    }
  },
  Lu = class extends Error {
    constructor(n) {
      super(Gn(4));
    }
  },
  t_ = class extends Error {
    constructor(n) {
      (super(Gn(5)), (this.value = n));
    }
  },
  e_ = class extends Error {
    constructor(n) {
      super(Gn(6));
    }
  },
  n_ = class extends Error {
    constructor(n) {
      super(Gn(7));
    }
  },
  za = class extends Error {
    constructor(n) {
      super(Gn(8));
    }
  },
  a_ = class extends Error {
    constructor(l) {
      super(Gn(9));
    }
  },
  l_ = class {
    constructor(n, l) {
      ((this.value = n), (this.replacement = l));
    }
  },
  Rs = () => {
    let n = { p: 0, s: 0, f: 0 };
    return (
      (n.p = new Promise((l, u) => {
        ((n.s = l), (n.f = u));
      })),
      n
    );
  },
  i_ = (n, l) => {
    (n.s(l), (n.p.s = 1), (n.p.v = l));
  },
  u_ = (n, l) => {
    (n.f(l), (n.p.s = 2), (n.p.v = l));
  };
Rs.toString();
i_.toString();
u_.toString();
var r_ = () => {
    let n = [],
      l = [],
      u = !0,
      r = !1,
      o = 0,
      f = (y, v, p) => {
        for (p = 0; p < o; p++) l[p] && l[p][v](y);
      },
      d = (y, v, p, g) => {
        for (v = 0, p = n.length; v < p; v++)
          ((g = n[v]), !u && v === p - 1 ? y[r ? "return" : "throw"](g) : y.next(g));
      },
      m = (y, v) => (
        u && ((v = o++), (l[v] = y)),
        d(y),
        () => {
          u && ((l[v] = l[o]), (l[o--] = void 0));
        }
      );
    return {
      __SEROVAL_STREAM__: !0,
      on: (y) => m(y),
      next: (y) => {
        u && (n.push(y), f(y, "next"));
      },
      throw: (y) => {
        u && (n.push(y), f(y, "throw"), (u = !1), (r = !1), (l.length = 0));
      },
      return: (y) => {
        u && (n.push(y), f(y, "return"), (u = !1), (r = !0), (l.length = 0));
      },
    };
  },
  s_ = (n) => (l) => () => {
    let u = 0,
      r = {
        [n]: () => r,
        next: () => {
          if (u > l.d) return { done: !0, value: void 0 };
          let o = u++,
            f = l.v[o];
          if (o === l.t) throw f;
          return { done: o === l.d, value: f };
        },
      };
    return r;
  },
  c_ = (n, l) => (u) => () => {
    let r = 0,
      o = -1,
      f = !1,
      d = [],
      m = [],
      y = (p = 0, g = m.length) => {
        for (; p < g; p++) m[p].s({ done: !0, value: void 0 });
      };
    u.on({
      next: (p) => {
        let g = m.shift();
        (g && g.s({ done: !1, value: p }), d.push(p));
      },
      throw: (p) => {
        let g = m.shift();
        (g && g.f(p), y(), (o = d.length), (f = !0), d.push(p));
      },
      return: (p) => {
        let g = m.shift();
        (g && g.s({ done: !0, value: p }), y(), (o = d.length), d.push(p));
      },
    });
    let v = {
      [n]: () => v,
      next: () => {
        if (o === -1) {
          let b = r++;
          if (b >= d.length) {
            let E = l();
            return (m.push(E), E.p);
          }
          return { done: !1, value: d[b] };
        }
        if (r > o) return { done: !0, value: void 0 };
        let p = r++,
          g = d[p];
        if (p !== o) return { done: !1, value: g };
        if (f) throw g;
        return { done: !0, value: g };
      },
    };
    return v;
  },
  Ng = (n) => {
    let l = atob(n),
      u = l.length,
      r = new Uint8Array(u);
    for (let o = 0; o < u; o++) r[o] = l.charCodeAt(o);
    return r.buffer;
  };
Ng.toString();
function o_(n) {
  return "__SEROVAL_SEQUENCE__" in n;
}
function jg(n, l, u) {
  return { __SEROVAL_SEQUENCE__: !0, v: n, t: l, d: u };
}
function f_(n) {
  let l = [],
    u = -1,
    r = -1,
    o = n[Qn]();
  for (;;)
    try {
      let f = o.next();
      if ((l.push(f.value), f.done)) {
        r = l.length - 1;
        break;
      }
    } catch (f) {
      ((u = l.length), l.push(f));
    }
  return jg(l, u, r);
}
var d_ = s_(Qn);
function h_(n) {
  return d_(n);
}
var m_ = {},
  y_ = {},
  v_ = { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {} };
function Ts(n) {
  return "__SEROVAL_STREAM__" in n;
}
function dl() {
  return r_();
}
function g_(n) {
  let l = dl(),
    u = n[Yn]();
  async function r() {
    try {
      let o = await u.next();
      o.done ? l.return(o.value) : (l.next(o.value), await r());
    } catch (o) {
      l.throw(o);
    }
  }
  return (r().catch(() => {}), l);
}
var p_ = c_(Yn, Rs);
function S_(n) {
  return p_(n);
}
async function b_(n) {
  try {
    return [1, await n];
  } catch (l) {
    return [0, l];
  }
}
function __(n, l) {
  return {
    plugins: l.plugins,
    mode: n,
    marked: new Set(),
    features: 63 ^ (l.disabledFeatures || 0),
    refs: l.refs || new Map(),
    depthLimit: l.depthLimit || 1e3,
  };
}
function os(n, l) {
  n.marked.add(l);
}
function E_(n, l) {
  let u = n.refs.size;
  return (n.refs.set(l, u), u);
}
function As(n, l) {
  let u = n.refs.get(l);
  return u != null ? (os(n, u), { type: 1, value: w1(u) }) : { type: 0, value: E_(n, l) };
}
function Df(n, l) {
  let u = As(n, l);
  return u.type === 1 ? u : Og(l) ? { type: 2, value: D1(u.value, l) } : u;
}
function nl(n, l) {
  let u = Df(n, l);
  if (u.type !== 0) return u.value;
  if (l in Ag) return z1(u.value, l);
  throw new Es(l);
}
function xs(n, l) {
  let u = As(n, v_[l]);
  return u.type === 1 ? u.value : Ot(26, u.value, l, _, _, _, _, _, _, _, _, _);
}
function R_(n) {
  let l = As(n, m_);
  return l.type === 1 ? l.value : Ot(27, l.value, _, _, _, _, _, _, nl(n, Qn), _, _, _);
}
function T_(n) {
  let l = As(n, y_);
  return l.type === 1 ? l.value : Ot(29, l.value, _, _, _, _, _, [xs(n, 1), nl(n, Yn)], _, _, _, _);
}
function A_(n, l, u, r) {
  return Ot(u ? 11 : 10, n, _, _, _, r, _, _, _, _, zg(l), _);
}
function x_(n, l, u, r) {
  return Ot(8, l, _, _, _, _, { k: u, v: r }, _, xs(n, 0), _, _, _);
}
function M_(n, l, u) {
  let r = new Uint8Array(u),
    o = "";
  for (let f = 0, d = r.length; f < d; f++) o += String.fromCharCode(r[f]);
  return Ot(19, l, Oa(btoa(o)), _, _, _, _, _, xs(n, 5), _, _, _);
}
function w_(n, l) {
  return { base: __(n, l), child: void 0 };
}
var O_ = class {
  constructor(n, l) {
    ((this._p = n), (this.depth = l));
  }
  parse(n) {
    return ne(this._p, this.depth, n);
  }
};
async function C_(n, l, u) {
  let r = [];
  for (let o = 0, f = u.length; o < f; o++) o in u ? (r[o] = await ne(n, l, u[o])) : (r[o] = 0);
  return r;
}
async function z_(n, l, u, r) {
  return L1(u, r, await C_(n, l, r));
}
async function Uf(n, l, u) {
  let r = Object.entries(u),
    o = [],
    f = [];
  for (let d = 0, m = r.length; d < m; d++) (o.push(Oa(r[d][0])), f.push(await ne(n, l, r[d][1])));
  return (
    Qn in u && (o.push(nl(n.base, Qn)), f.push(G1(R_(n.base), await ne(n, l, f_(u))))),
    Yn in u && (o.push(nl(n.base, Yn)), f.push(V1(T_(n.base), await ne(n, l, g_(u))))),
    ii in u && (o.push(nl(n.base, ii)), f.push(Dg(u[ii]))),
    li in u && (o.push(nl(n.base, li)), f.push(u[li] ? xg : Mg)),
    { k: o, v: f }
  );
}
async function af(n, l, u, r, o) {
  return A_(u, r, o, await Uf(n, l, r));
}
async function D_(n, l, u, r) {
  return N1(u, await ne(n, l, r.valueOf()));
}
async function U_(n, l, u, r) {
  return j1(u, r, await ne(n, l, r.buffer));
}
async function L_(n, l, u, r) {
  return B1(u, r, await ne(n, l, r.buffer));
}
async function N_(n, l, u, r) {
  return H1(u, r, await ne(n, l, r.buffer));
}
async function yv(n, l, u, r) {
  let o = Cg(r, n.base.features);
  return q1(u, r, o ? await Uf(n, l, o) : _);
}
async function j_(n, l, u, r) {
  let o = Cg(r, n.base.features);
  return Y1(u, r, o ? await Uf(n, l, o) : _);
}
async function B_(n, l, u, r) {
  let o = [],
    f = [];
  for (let [d, m] of r.entries()) (o.push(await ne(n, l, d)), f.push(await ne(n, l, m)));
  return x_(n.base, u, o, f);
}
async function H_(n, l, u, r) {
  let o = [];
  for (let f of r.keys()) o.push(await ne(n, l, f));
  return Q1(u, o);
}
async function Bg(n, l, u, r) {
  let o = n.base.plugins;
  if (o)
    for (let f = 0, d = o.length; f < d; f++) {
      let m = o[f];
      if (m.parse.async && m.test(r))
        return U1(u, m.tag, await m.parse.async(r, new O_(n, l), { id: u }));
    }
  return _;
}
async function q_(n, l, u, r) {
  let [o, f] = await b_(r);
  return Ot(12, u, o, _, _, _, _, _, await ne(n, l, f), _, _, _);
}
function Y_(n, l, u, r, o) {
  let f = [],
    d = u.on({
      next: (m) => {
        (os(this.base, l),
          ne(this, n, m).then(
            (y) => {
              f.push(Z1(l, y));
            },
            (y) => {
              (o(y), d());
            },
          ));
      },
      throw: (m) => {
        (os(this.base, l),
          ne(this, n, m).then(
            (y) => {
              (f.push(K1(l, y)), r(f), d());
            },
            (y) => {
              (o(y), d());
            },
          ));
      },
      return: (m) => {
        (os(this.base, l),
          ne(this, n, m).then(
            (y) => {
              (f.push(P1(l, y)), r(f), d());
            },
            (y) => {
              (o(y), d());
            },
          ));
      },
    });
}
async function Q_(n, l, u, r) {
  return X1(u, xs(n.base, 4), await new Promise(Y_.bind(n, l, u, r)));
}
async function G_(n, l, u, r) {
  let o = [];
  for (let f = 0, d = r.v.length; f < d; f++) o[f] = await ne(n, l, r.v[f]);
  return J1(u, o, r.t, r.d);
}
async function V_(n, l, u, r) {
  if (Array.isArray(r)) return z_(n, l, u, r);
  if (Ts(r)) return Q_(n, l, u, r);
  if (o_(r)) return G_(n, l, u, r);
  let o = r.constructor;
  if (o === l_) return ne(n, l, r.replacement);
  let f = await Bg(n, l, u, r);
  if (f) return f;
  switch (o) {
    case Object:
      return af(n, l, u, r, !1);
    case _:
      return af(n, l, u, r, !0);
    case Date:
      return O1(u, r);
    case Error:
    case EvalError:
    case RangeError:
    case ReferenceError:
    case SyntaxError:
    case TypeError:
    case URIError:
      return yv(n, l, u, r);
    case Number:
    case Boolean:
    case String:
    case BigInt:
      return D_(n, l, u, r);
    case ArrayBuffer:
      return M_(n.base, u, r);
    case Int8Array:
    case Int16Array:
    case Int32Array:
    case Uint8Array:
    case Uint16Array:
    case Uint32Array:
    case Uint8ClampedArray:
    case Float32Array:
    case Float64Array:
      return U_(n, l, u, r);
    case DataView:
      return N_(n, l, u, r);
    case Map:
      return B_(n, l, u, r);
    case Set:
      return H_(n, l, u, r);
  }
  if (o === Promise || r instanceof Promise) return q_(n, l, u, r);
  let d = n.base.features;
  if (d & 32 && o === RegExp) return C1(u, r);
  if (d & 16)
    switch (o) {
      case BigInt64Array:
      case BigUint64Array:
        return L_(n, l, u, r);
    }
  if (d & 1 && typeof AggregateError < "u" && (o === AggregateError || r instanceof AggregateError))
    return j_(n, l, u, r);
  if (r instanceof Error) return yv(n, l, u, r);
  if (Qn in r || Yn in r) return af(n, l, u, r, !!o);
  throw new Es(r);
}
async function X_(n, l, u) {
  let r = Df(n.base, u);
  if (r.type !== 0) return r.value;
  let o = await Bg(n, l, r.value, u);
  if (o) return o;
  throw new Es(u);
}
async function ne(n, l, u) {
  switch (typeof u) {
    case "boolean":
      return u ? xg : Mg;
    case "undefined":
      return m1;
    case "string":
      return Dg(u);
    case "number":
      return x1(u);
    case "bigint":
      return M1(u);
    case "object": {
      if (u) {
        let r = Df(n.base, u);
        return r.type === 0 ? await V_(n, l + 1, r.value, u) : r.value;
      }
      return y1;
    }
    case "symbol":
      return nl(n.base, u);
    case "function":
      return X_(n, l, u);
    default:
      throw new Es(u);
  }
}
async function Z_(n, l) {
  try {
    return await ne(n, 0, l);
  } catch (u) {
    throw u instanceof mv ? u : new mv(u);
  }
}
var K_ = ((n) => ((n[(n.Vanilla = 1)] = "Vanilla"), (n[(n.Cross = 2)] = "Cross"), n))(K_ || {});
function Hg(n, l) {
  for (let u = 0, r = l.length; u < r; u++) {
    let o = l[u];
    n.has(o) || (n.add(o), o.extends && Hg(n, o.extends));
  }
}
function qg(n) {
  if (n) {
    let l = new Set();
    return (Hg(l, n), [...l]);
  }
}
function P_(n) {
  switch (n) {
    case "Int8Array":
      return Int8Array;
    case "Int16Array":
      return Int16Array;
    case "Int32Array":
      return Int32Array;
    case "Uint8Array":
      return Uint8Array;
    case "Uint16Array":
      return Uint16Array;
    case "Uint32Array":
      return Uint32Array;
    case "Uint8ClampedArray":
      return Uint8ClampedArray;
    case "Float32Array":
      return Float32Array;
    case "Float64Array":
      return Float64Array;
    case "BigInt64Array":
      return BigInt64Array;
    case "BigUint64Array":
      return BigUint64Array;
    default:
      throw new n_(n);
  }
}
var J_ = 1e6,
  F_ = 1e4,
  k_ = 2e4;
function Yg(n, l) {
  switch (l) {
    case 3:
      return Object.freeze(n);
    case 1:
      return Object.preventExtensions(n);
    case 2:
      return Object.seal(n);
    default:
      return n;
  }
}
var I_ = 1e3;
function $_(n, l) {
  var u;
  return {
    mode: n,
    plugins: l.plugins,
    refs: l.refs || new Map(),
    features: (u = l.features) != null ? u : 63 ^ (l.disabledFeatures || 0),
    depthLimit: l.depthLimit || I_,
  };
}
function W_(n) {
  return { mode: 2, base: $_(2, n), child: _ };
}
var tE = class {
  constructor(n, l) {
    ((this._p = n), (this.depth = l));
  }
  deserialize(n) {
    return qt(this._p, this.depth, n);
  }
};
function Qg(n, l) {
  if (l < 0 || !Number.isFinite(l) || !Number.isInteger(l)) throw new za({ t: 4, i: l });
  if (n.refs.has(l)) throw new Error("Conflicted ref id: " + l);
}
function eE(n, l, u) {
  return (Qg(n.base, l), n.state.marked.has(l) && n.base.refs.set(l, u), u);
}
function nE(n, l, u) {
  return (Qg(n.base, l), n.base.refs.set(l, u), u);
}
function ae(n, l, u) {
  return n.mode === 1 ? eE(n, l, u) : nE(n, l, u);
}
function yf(n, l, u) {
  if (Object.hasOwn(l, u)) return l[u];
  throw new za(n);
}
function aE(n, l) {
  return ae(n, l.i, T1(Ca(l.s)));
}
function lE(n, l, u) {
  let r = u.a,
    o = r.length,
    f = ae(n, u.i, new Array(o));
  for (let d = 0, m; d < o; d++) ((m = r[d]), m && (f[d] = qt(n, l, m)));
  return (Yg(f, u.o), f);
}
function iE(n) {
  switch (n) {
    case "constructor":
    case "__proto__":
    case "prototype":
    case "__defineGetter__":
    case "__defineSetter__":
    case "__lookupGetter__":
    case "__lookupSetter__":
      return !1;
    default:
      return !0;
  }
}
function uE(n) {
  switch (n) {
    case Yn:
    case li:
    case ii:
    case Qn:
      return !0;
    default:
      return !1;
  }
}
function vv(n, l, u) {
  iE(l)
    ? (n[l] = u)
    : Object.defineProperty(n, l, { value: u, configurable: !0, enumerable: !0, writable: !0 });
}
function rE(n, l, u, r, o) {
  if (typeof r == "string") vv(u, Ca(r), qt(n, l, o));
  else {
    let f = qt(n, l, r);
    switch (typeof f) {
      case "string":
        vv(u, f, qt(n, l, o));
        break;
      case "symbol":
        uE(f) && (u[f] = qt(n, l, o));
        break;
      default:
        throw new za(r);
    }
  }
}
function Gg(n, l, u, r) {
  let o = u.k;
  if (o.length > 0) for (let f = 0, d = u.v, m = o.length; f < m; f++) rE(n, l, r, o[f], d[f]);
  return r;
}
function sE(n, l, u) {
  let r = ae(n, u.i, u.t === 10 ? {} : Object.create(null));
  return (Gg(n, l, u.p, r), Yg(r, u.o), r);
}
function cE(n, l) {
  return ae(n, l.i, new Date(l.s));
}
function oE(n, l) {
  if (n.base.features & 32) {
    let u = Ca(l.c);
    if (u.length > k_) throw new za(l);
    return ae(n, l.i, new RegExp(u, l.m));
  }
  throw new Lg(l);
}
function fE(n, l, u) {
  let r = ae(n, u.i, new Set());
  for (let o = 0, f = u.a, d = f.length; o < d; o++) r.add(qt(n, l, f[o]));
  return r;
}
function dE(n, l, u) {
  let r = ae(n, u.i, new Map());
  for (let o = 0, f = u.e.k, d = u.e.v, m = f.length; o < m; o++)
    r.set(qt(n, l, f[o]), qt(n, l, d[o]));
  return r;
}
function hE(n, l) {
  if (l.s.length > J_) throw new za(l);
  return ae(n, l.i, Ng(Ca(l.s)));
}
function mE(n, l, u) {
  var r;
  let o = P_(u.c),
    f = qt(n, l, u.f),
    d = (r = u.b) != null ? r : 0;
  if (d < 0 || d > f.byteLength) throw new za(u);
  return ae(n, u.i, new o(f, d, u.l));
}
function yE(n, l, u) {
  var r;
  let o = qt(n, l, u.f),
    f = (r = u.b) != null ? r : 0;
  if (f < 0 || f > o.byteLength) throw new za(u);
  return ae(n, u.i, new DataView(o, f, u.l));
}
function Vg(n, l, u, r) {
  if (u.p) {
    let o = Gg(n, l, u.p, {});
    Object.defineProperties(r, Object.getOwnPropertyDescriptors(o));
  }
  return r;
}
function vE(n, l, u) {
  let r = ae(n, u.i, new AggregateError([], Ca(u.m)));
  return Vg(n, l, u, r);
}
function gE(n, l, u) {
  let r = yf(u, h1, u.s),
    o = ae(n, u.i, new r(Ca(u.m)));
  return Vg(n, l, u, o);
}
function pE(n, l, u) {
  let r = Rs(),
    o = ae(n, u.i, r.p),
    f = qt(n, l, u.f);
  return (u.s ? r.s(f) : r.f(f), o);
}
function SE(n, l, u) {
  return ae(n, u.i, Object(qt(n, l, u.f)));
}
function bE(n, l, u) {
  let r = n.base.plugins;
  if (r) {
    let o = Ca(u.c);
    for (let f = 0, d = r.length; f < d; f++) {
      let m = r[f];
      if (m.tag === o) return ae(n, u.i, m.deserialize(u.s, new tE(n, l), { id: u.i }));
    }
  }
  throw new W1(u.c);
}
function _E(n, l) {
  return ae(n, l.i, ae(n, l.s, Rs()).p);
}
function EE(n, l, u) {
  let r = n.base.refs.get(u.i);
  if (r) return (r.s(qt(n, l, u.a[1])), _);
  throw new Lu("Promise");
}
function RE(n, l, u) {
  let r = n.base.refs.get(u.i);
  if (r) return (r.f(qt(n, l, u.a[1])), _);
  throw new Lu("Promise");
}
function TE(n, l, u) {
  qt(n, l, u.a[0]);
  let r = qt(n, l, u.a[1]);
  return h_(r);
}
function AE(n, l, u) {
  qt(n, l, u.a[0]);
  let r = qt(n, l, u.a[1]);
  return S_(r);
}
function xE(n, l, u) {
  let r = ae(n, u.i, dl()),
    o = u.a,
    f = o.length;
  if (f) for (let d = 0; d < f; d++) qt(n, l, o[d]);
  return r;
}
function ME(n, l, u) {
  let r = n.base.refs.get(u.i);
  if (r && Ts(r)) return (r.next(qt(n, l, u.f)), _);
  throw new Lu("Stream");
}
function wE(n, l, u) {
  let r = n.base.refs.get(u.i);
  if (r && Ts(r)) return (r.throw(qt(n, l, u.f)), _);
  throw new Lu("Stream");
}
function OE(n, l, u) {
  let r = n.base.refs.get(u.i);
  if (r && Ts(r)) return (r.return(qt(n, l, u.f)), _);
  throw new Lu("Stream");
}
function CE(n, l, u) {
  return (qt(n, l, u.f), _);
}
function zE(n, l, u) {
  return (qt(n, l, u.a[1]), _);
}
function DE(n, l, u) {
  let r = ae(n, u.i, jg([], u.s, u.l));
  for (let o = 0, f = u.a.length; o < f; o++) r.v[o] = qt(n, l, u.a[o]);
  return r;
}
function qt(n, l, u) {
  if (l > n.base.depthLimit) throw new a_(n.base.depthLimit);
  switch (((l += 1), u.t)) {
    case 2:
      return yf(u, f1, u.s);
    case 0:
      return Number(u.s);
    case 1:
      return Ca(String(u.s));
    case 3:
      if (String(u.s).length > F_) throw new za(u);
      return BigInt(u.s);
    case 4:
      return n.base.refs.get(u.i);
    case 18:
      return aE(n, u);
    case 9:
      return lE(n, l, u);
    case 10:
    case 11:
      return sE(n, l, u);
    case 5:
      return cE(n, u);
    case 6:
      return oE(n, u);
    case 7:
      return fE(n, l, u);
    case 8:
      return dE(n, l, u);
    case 19:
      return hE(n, u);
    case 16:
    case 15:
      return mE(n, l, u);
    case 20:
      return yE(n, l, u);
    case 14:
      return vE(n, l, u);
    case 13:
      return gE(n, l, u);
    case 12:
      return pE(n, l, u);
    case 17:
      return yf(u, o1, u.s);
    case 21:
      return SE(n, l, u);
    case 25:
      return bE(n, l, u);
    case 22:
      return _E(n, u);
    case 23:
      return EE(n, l, u);
    case 24:
      return RE(n, l, u);
    case 28:
      return TE(n, l, u);
    case 30:
      return AE(n, l, u);
    case 31:
      return xE(n, l, u);
    case 32:
      return ME(n, l, u);
    case 33:
      return wE(n, l, u);
    case 34:
      return OE(n, l, u);
    case 27:
      return CE(n, l, u);
    case 29:
      return zE(n, l, u);
    case 35:
      return DE(n, l, u);
    default:
      throw new Lg(u);
  }
}
function UE(n, l) {
  try {
    return qt(n, 0, l);
  } catch (u) {
    throw new $1(u);
  }
}
var LE = () => T;
LE.toString();
function gv(n, l) {
  let u = qg(l.plugins),
    r = W_({
      plugins: u,
      refs: l.refs,
      features: l.features,
      disabledFeatures: l.disabledFeatures,
      depthLimit: l.depthLimit,
    });
  return UE(r, n);
}
async function NE(n, l = {}) {
  let u = qg(l.plugins),
    r = w_(1, { plugins: u, disabledFeatures: l.disabledFeatures });
  return { t: await Z_(r, n), f: r.base.features, m: Array.from(r.base.marked) };
}
function jE(n) {
  return {
    tag: "$TSR/t/" + n.key,
    test: n.test,
    parse: {
      sync(l, u, r) {
        return { v: u.parse(n.toSerializable(l)) };
      },
      async async(l, u, r) {
        return { v: await u.parse(n.toSerializable(l)) };
      },
      stream(l, u, r) {
        return { v: u.parse(n.toSerializable(l)) };
      },
    },
    serialize: void 0,
    deserialize(l, u, r) {
      return n.fromSerializable(u.deserialize(l.v));
    },
  };
}
var BE = class {
    constructor(n, l) {
      ((this.stream = n), (this.hint = (l == null ? void 0 : l.hint) ?? "binary"));
    }
  },
  vs = globalThis.Buffer,
  Xg = !!vs && typeof vs.from == "function";
function Zg(n) {
  if (n.length === 0) return "";
  if (Xg) return vs.from(n).toString("base64");
  const l = 32768,
    u = [];
  for (let r = 0; r < n.length; r += l) {
    const o = n.subarray(r, r + l);
    u.push(String.fromCharCode.apply(null, o));
  }
  return btoa(u.join(""));
}
function Kg(n) {
  if (n.length === 0) return new Uint8Array(0);
  if (Xg) {
    const r = vs.from(n, "base64");
    return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
  }
  const l = atob(n),
    u = new Uint8Array(l.length);
  for (let r = 0; r < l.length; r++) u[r] = l.charCodeAt(r);
  return u;
}
var gu = Object.create(null),
  pu = Object.create(null),
  HE = (n) =>
    new ReadableStream({
      start(l) {
        n.on({
          next(u) {
            try {
              l.enqueue(Kg(u));
            } catch {}
          },
          throw(u) {
            l.error(u);
          },
          return() {
            try {
              l.close();
            } catch {}
          },
        });
      },
    }),
  qE = new TextEncoder(),
  YE = (n) =>
    new ReadableStream({
      start(l) {
        n.on({
          next(u) {
            try {
              typeof u == "string" ? l.enqueue(qE.encode(u)) : l.enqueue(Kg(u.$b64));
            } catch {}
          },
          throw(u) {
            l.error(u);
          },
          return() {
            try {
              l.close();
            } catch {}
          },
        });
      },
    }),
  QE =
    "(s=>new ReadableStream({start(c){s.on({next(b){try{const d=atob(b),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}catch(_){}},throw(e){c.error(e)},return(){try{c.close()}catch(_){}}})}}))",
  GE =
    "(s=>{const e=new TextEncoder();return new ReadableStream({start(c){s.on({next(v){try{if(typeof v==='string'){c.enqueue(e.encode(v))}else{const d=atob(v.$b64),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}}catch(_){}},throw(x){c.error(x)},return(){try{c.close()}catch(_){}}})}})})";
function pv(n) {
  const l = dl(),
    u = n.getReader();
  return (
    (async () => {
      try {
        for (;;) {
          const { done: r, value: o } = await u.read();
          if (r) {
            l.return(void 0);
            break;
          }
          l.next(Zg(o));
        }
      } catch (r) {
        l.throw(r);
      } finally {
        u.releaseLock();
      }
    })(),
    l
  );
}
function Sv(n) {
  const l = dl(),
    u = n.getReader(),
    r = new TextDecoder("utf-8", { fatal: !0 });
  return (
    (async () => {
      try {
        for (;;) {
          const { done: o, value: f } = await u.read();
          if (o) {
            try {
              const d = r.decode();
              d.length > 0 && l.next(d);
            } catch {}
            l.return(void 0);
            break;
          }
          try {
            const d = r.decode(f, { stream: !0 });
            d.length > 0 && l.next(d);
          } catch {
            l.next({ $b64: Zg(f) });
          }
        }
      } catch (o) {
        l.throw(o);
      } finally {
        u.releaseLock();
      }
    })(),
    l
  );
}
var VE = {
  tag: "tss/RawStream",
  extends: [
    {
      tag: "tss/RawStreamFactory",
      test(n) {
        return n === gu;
      },
      parse: {
        sync(n, l, u) {
          return {};
        },
        async async(n, l, u) {
          return {};
        },
        stream(n, l, u) {
          return {};
        },
      },
      serialize(n, l, u) {
        return QE;
      },
      deserialize(n, l, u) {
        return gu;
      },
    },
    {
      tag: "tss/RawStreamFactoryText",
      test(n) {
        return n === pu;
      },
      parse: {
        sync(n, l, u) {
          return {};
        },
        async async(n, l, u) {
          return {};
        },
        stream(n, l, u) {
          return {};
        },
      },
      serialize(n, l, u) {
        return GE;
      },
      deserialize(n, l, u) {
        return pu;
      },
    },
  ],
  test(n) {
    return n instanceof BE;
  },
  parse: {
    sync(n, l, u) {
      const r = n.hint === "text" ? pu : gu;
      return { hint: l.parse(n.hint), factory: l.parse(r), stream: l.parse(dl()) };
    },
    async async(n, l, u) {
      const r = n.hint === "text" ? pu : gu,
        o = n.hint === "text" ? Sv(n.stream) : pv(n.stream);
      return { hint: await l.parse(n.hint), factory: await l.parse(r), stream: await l.parse(o) };
    },
    stream(n, l, u) {
      const r = n.hint === "text" ? pu : gu,
        o = n.hint === "text" ? Sv(n.stream) : pv(n.stream);
      return { hint: l.parse(n.hint), factory: l.parse(r), stream: l.parse(o) };
    },
  },
  serialize(n, l, u) {
    return "(" + l.serialize(n.factory) + ")(" + l.serialize(n.stream) + ")";
  },
  deserialize(n, l, u) {
    const r = l.deserialize(n.stream);
    return l.deserialize(n.hint) === "text" ? YE(r) : HE(r);
  },
};
function XE(n) {
  return {
    tag: "tss/RawStream",
    test: () => !1,
    parse: {},
    serialize() {
      throw new Error(
        "RawStreamDeserializePlugin.serialize should not be called. Client only deserializes.",
      );
    },
    deserialize(l, u, r) {
      return n(
        typeof (u == null ? void 0 : u.deserialize) == "function"
          ? u.deserialize(l.streamId)
          : l.streamId,
      );
    },
  };
}
var ZE = {
    tag: "$TSR/Error",
    test(n) {
      return n instanceof Error;
    },
    parse: {
      sync(n, l) {
        return { message: l.parse(n.message) };
      },
      async async(n, l) {
        return { message: await l.parse(n.message) };
      },
      stream(n, l) {
        return { message: l.parse(n.message) };
      },
    },
    serialize(n, l) {
      return "new Error(" + l.serialize(n.message) + ")";
    },
    deserialize(n, l) {
      return new Error(l.deserialize(n.message));
    },
  },
  ga = {},
  Pg = (n) =>
    new ReadableStream({
      start: (l) => {
        n.on({
          next: (u) => {
            try {
              l.enqueue(u);
            } catch {}
          },
          throw: (u) => {
            l.error(u);
          },
          return: () => {
            try {
              l.close();
            } catch {}
          },
        });
      },
    }),
  KE = {
    tag: "seroval-plugins/web/ReadableStreamFactory",
    test(n) {
      return n === ga;
    },
    parse: {
      sync() {
        return ga;
      },
      async async() {
        return await Promise.resolve(ga);
      },
      stream() {
        return ga;
      },
    },
    serialize() {
      return Pg.toString();
    },
    deserialize() {
      return ga;
    },
  };
function bv(n) {
  let l = dl(),
    u = n.getReader();
  async function r() {
    try {
      let o = await u.read();
      o.done ? l.return(o.value) : (l.next(o.value), await r());
    } catch (o) {
      l.throw(o);
    }
  }
  return (r().catch(() => {}), l);
}
var PE = {
    tag: "seroval/plugins/web/ReadableStream",
    extends: [KE],
    test(n) {
      return typeof ReadableStream > "u" ? !1 : n instanceof ReadableStream;
    },
    parse: {
      sync(n, l) {
        return { factory: l.parse(ga), stream: l.parse(dl()) };
      },
      async async(n, l) {
        return { factory: await l.parse(ga), stream: await l.parse(bv(n)) };
      },
      stream(n, l) {
        return { factory: l.parse(ga), stream: l.parse(bv(n)) };
      },
    },
    serialize(n, l) {
      return "(" + l.serialize(n.factory) + ")(" + l.serialize(n.stream) + ")";
    },
    deserialize(n, l) {
      let u = l.deserialize(n.stream);
      return Pg(u);
    },
  },
  JE = PE,
  FE = [ZE, VE, JE];
function kE() {
  var n, l;
  return [
    ...(((l = (n = xf()) == null ? void 0 : n.serializationAdapters) == null
      ? void 0
      : l.map(jE)) ?? []),
    ...FE,
  ];
}
var _v = new TextDecoder(),
  IE = new Uint8Array(0),
  Ev = 16 * 1024 * 1024,
  Rv = 32 * 1024 * 1024,
  Tv = 1024,
  Av = 1e5;
function $E(n) {
  const l = new Map(),
    u = new Map(),
    r = new Set();
  let o = !1,
    f = null,
    d = 0,
    m;
  const y = new ReadableStream({
    start(g) {
      m = g;
    },
    cancel() {
      o = !0;
      try {
        f == null || f.cancel();
      } catch {}
      (l.forEach((g) => {
        try {
          g.error(new Error("Framed response cancelled"));
        } catch {}
      }),
        l.clear(),
        u.clear(),
        r.clear());
    },
  });
  function v(g) {
    const b = u.get(g);
    if (b) return b;
    if (r.has(g))
      return new ReadableStream({
        start(R) {
          R.close();
        },
      });
    if (u.size >= Tv) throw new Error(`Too many raw streams in framed response (max ${Tv})`);
    const E = new ReadableStream({
      start(R) {
        l.set(g, R);
      },
      cancel() {
        (r.add(g), l.delete(g), u.delete(g));
      },
    });
    return (u.set(g, E), E);
  }
  function p(g) {
    return (v(g), l.get(g));
  }
  return (
    (async () => {
      const g = n.getReader();
      f = g;
      const b = [];
      let E = 0;
      function R() {
        if (E < 9) return null;
        const x = b[0];
        if (x.length >= 9)
          return {
            type: x[0],
            streamId: ((x[1] << 24) | (x[2] << 16) | (x[3] << 8) | x[4]) >>> 0,
            length: ((x[5] << 24) | (x[6] << 16) | (x[7] << 8) | x[8]) >>> 0,
          };
        const U = new Uint8Array(9);
        let G = 0,
          C = 9;
        for (let z = 0; z < b.length && C > 0; z++) {
          const Y = b[z],
            I = Math.min(Y.length, C);
          (U.set(Y.subarray(0, I), G), (G += I), (C -= I));
        }
        return {
          type: U[0],
          streamId: ((U[1] << 24) | (U[2] << 16) | (U[3] << 8) | U[4]) >>> 0,
          length: ((U[5] << 24) | (U[6] << 16) | (U[7] << 8) | U[8]) >>> 0,
        };
      }
      function M(x) {
        if (x === 0) return IE;
        const U = new Uint8Array(x);
        let G = 0,
          C = x;
        for (; C > 0 && b.length > 0; ) {
          const z = b[0];
          if (!z) break;
          const Y = Math.min(z.length, C);
          (U.set(z.subarray(0, Y), G),
            (G += Y),
            (C -= Y),
            Y === z.length ? b.shift() : (b[0] = z.subarray(Y)));
        }
        return ((E -= x), U);
      }
      try {
        for (;;) {
          const { done: x, value: U } = await g.read();
          if (o || x) break;
          if (U) {
            if (E + U.length > Rv) throw new Error(`Framed response buffer exceeded ${Rv} bytes`);
            for (b.push(U), E += U.length; ; ) {
              const G = R();
              if (!G) break;
              const { type: C, streamId: z, length: Y } = G;
              if (C !== Bn.JSON && C !== Bn.CHUNK && C !== Bn.END && C !== Bn.ERROR)
                throw new Error(`Unknown frame type: ${C}`);
              if (C === Bn.JSON) {
                if (z !== 0) throw new Error("Invalid JSON frame streamId (expected 0)");
              } else if (z === 0) throw new Error("Invalid raw frame streamId (expected non-zero)");
              if (Y > Ev) throw new Error(`Frame payload too large: ${Y} bytes (max ${Ev})`);
              const I = 9 + Y;
              if (E < I) break;
              if (++d > Av) throw new Error(`Too many frames in framed response (max ${Av})`);
              M(9);
              const q = M(Y);
              switch (C) {
                case Bn.JSON:
                  try {
                    m.enqueue(_v.decode(q));
                  } catch {}
                  break;
                case Bn.CHUNK: {
                  const k = p(z);
                  k && k.enqueue(q);
                  break;
                }
                case Bn.END: {
                  const k = p(z);
                  if ((r.add(z), k)) {
                    try {
                      k.close();
                    } catch {}
                    l.delete(z);
                  }
                  break;
                }
                case Bn.ERROR: {
                  const k = p(z);
                  if ((r.add(z), k)) {
                    const J = _v.decode(q);
                    (k.error(new Error(J)), l.delete(z));
                  }
                  break;
                }
              }
            }
          }
        }
        if (E !== 0) throw new Error("Incomplete frame at end of framed response");
        try {
          m.close();
        } catch {}
        (l.forEach((x) => {
          try {
            x.close();
          } catch {}
        }),
          l.clear());
      } catch (x) {
        try {
          m.error(x);
        } catch {}
        (l.forEach((U) => {
          try {
            U.error(x);
          } catch {}
        }),
          l.clear());
      } finally {
        try {
          g.releaseLock();
        } catch {}
        f = null;
      }
    })(),
    { getOrCreateStream: v, jsonChunks: y }
  );
}
var Mu = null;
async function vf(n) {
  n.length > 0 && (await Promise.allSettled(n));
}
var WE = Object.prototype.hasOwnProperty;
function Jg(n) {
  for (const l in n) if (WE.call(n, l)) return !0;
  return !1;
}
async function tR(n, l, u) {
  Mu || (Mu = kE());
  const r = l[0],
    o = r.fetch ?? u,
    f = r.data instanceof FormData ? "formData" : "payload",
    d = r.headers ? new Headers(r.headers) : new Headers();
  if (
    (d.set("x-tsr-serverFn", "true"),
    f === "payload" && d.set("accept", `${WS}, application/x-ndjson, application/json`),
    r.method === "GET")
  ) {
    if (f === "formData") throw new Error("FormData is not supported with GET requests");
    const y = await Fg(r);
    if (y !== void 0) {
      const v = rg({ payload: y });
      n.includes("?") ? (n += `&${v}`) : (n += `?${v}`);
    }
  }
  let m;
  if (r.method === "POST") {
    const y = await eR(r);
    (y != null && y.contentType && d.set("content-type", y.contentType),
      (m = y == null ? void 0 : y.body));
  }
  return await nR(async () => o(n, { method: r.method, headers: d, signal: r.signal, body: m }));
}
async function Fg(n) {
  let l = !1;
  const u = {};
  if (
    (n.data !== void 0 && ((l = !0), (u.data = n.data)),
    n.context && Jg(n.context) && ((l = !0), (u.context = n.context)),
    l)
  )
    return kg(u);
}
async function kg(n) {
  return JSON.stringify(await Promise.resolve(NE(n, { plugins: Mu })));
}
async function eR(n) {
  if (n.data instanceof FormData) {
    let u;
    return (
      n.context && Jg(n.context) && (u = await kg(n.context)),
      u !== void 0 && n.data.set($S, u),
      { body: n.data }
    );
  }
  const l = await Fg(n);
  if (l) return { body: l, contentType: "application/json" };
}
async function nR(n) {
  let l;
  try {
    l = await n();
  } catch (r) {
    if (r instanceof Response) l = r;
    else throw (console.log(r), r);
  }
  if (l.headers.get("x-tss-raw") === "true") return l;
  const u = l.headers.get("content-type");
  if ((u || Ce(), l.headers.get("x-tss-serialized"))) {
    let r;
    if (u.includes("application/x-tss-framed")) {
      if ((nb(u), !l.body)) throw new Error("No response body for framed response");
      const { getOrCreateStream: o, jsonChunks: f } = $E(l.body),
        d = [XE(o), ...(Mu || [])],
        m = new Map();
      r = await aR({
        jsonStream: f,
        onMessage: (y) => gv(y, { refs: m, plugins: d }),
        onError(y, v) {
          console.error(y, v);
        },
      });
    } else if (u.includes("application/json")) {
      const o = await l.json(),
        f = [];
      try {
        r = gv(o, { plugins: Mu });
      } finally {
      }
      await vf(f);
    }
    if ((r || Ce(), r instanceof Error)) throw r;
    return r;
  }
  if (u.includes("application/json")) {
    const r = await l.json(),
      o = cg(r);
    if (o) throw o;
    if (re(r)) throw r;
    return r;
  }
  if (!l.ok) throw new Error(await l.text());
  return l;
}
async function aR({ jsonStream: n, onMessage: l, onError: u }) {
  const r = n.getReader(),
    { value: o, done: f } = await r.read();
  if (f || !o) throw new Error("Stream ended before first object");
  const d = JSON.parse(o);
  let m = !1;
  const y = (async () => {
    try {
      for (;;) {
        const { value: g, done: b } = await r.read();
        if (b) break;
        if (g)
          try {
            const E = [];
            try {
              l(JSON.parse(g));
            } finally {
            }
            await vf(E);
          } catch (E) {
            u == null || u(`Invalid JSON: ${g}`, E);
          }
      }
    } catch (g) {
      m || u == null || u("Stream processing error:", g);
    }
  })();
  let v;
  const p = [];
  try {
    v = l(d);
  } catch (g) {
    throw ((m = !0), r.cancel().catch(() => {}), g);
  }
  return (
    await vf(p),
    Promise.resolve(v).catch(() => {
      ((m = !0), r.cancel().catch(() => {}));
    }),
    y.finally(() => {
      try {
        r.releaseLock();
      } catch {}
    }),
    v
  );
}
function Lf(n) {
  const l = "/_serverFn/" + n;
  return Object.assign(
    (...o) => {
      var d, m;
      const f = (m = (d = xf()) == null ? void 0 : d.serverFns) == null ? void 0 : m.fetch;
      return tR(l, o, f ?? fetch);
    },
    { url: l, serverFnMeta: { id: n }, [df]: !0 },
  );
}
var lR = {
  key: "$TSS/serverfn",
  test: (n) => (typeof n != "function" || !(df in n) ? !1 : !!n[df]),
  toSerializable: ({ serverFnMeta: n }) => ({ functionId: n.id }),
  fromSerializable: ({ functionId: n }) => Lf(n),
};
function Ig(n) {
  if (Array.isArray(n)) return n.flatMap((p) => Ig(p));
  if (typeof n != "string") return [];
  const l = [];
  let u = 0,
    r,
    o,
    f,
    d,
    m;
  const y = () => {
      for (; u < n.length && /\s/.test(n.charAt(u)); ) u += 1;
      return u < n.length;
    },
    v = () => ((o = n.charAt(u)), o !== "=" && o !== ";" && o !== ",");
  for (; u < n.length; ) {
    for (r = u, m = !1; y(); )
      if (((o = n.charAt(u)), o === ",")) {
        for (f = u, u += 1, y(), d = u; u < n.length && v(); ) u += 1;
        u < n.length && n.charAt(u) === "="
          ? ((m = !0), (u = d), l.push(n.slice(r, f)), (r = u))
          : (u = f + 1);
      } else u += 1;
    (!m || u >= n.length) && l.push(n.slice(r));
  }
  return l;
}
function iR(n) {
  return n instanceof Headers
    ? n
    : Array.isArray(n)
      ? new Headers(n)
      : typeof n == "object"
        ? new Headers(n)
        : null;
}
function uR(...n) {
  return n.reduce((l, u) => {
    const r = iR(u);
    if (!r) return l;
    for (const [o, f] of r.entries())
      o === "set-cookie" ? Ig(f).forEach((d) => l.append("set-cookie", d)) : l.set(o, f);
    return l;
  }, new Headers());
}
function xv(n) {
  return n.replaceAll("\0", "/").replaceAll("�", "/");
}
function rR(n, l) {
  ((n.id = l.i),
    (n.__beforeLoadContext = l.b),
    (n.loaderData = l.l),
    (n.status = l.s),
    (n.ssr = l.ssr),
    (n.updatedAt = l.u),
    (n.error = l.e),
    l.g !== void 0 && (n.globalNotFound = l.g));
}
async function sR(n) {
  var x, U, G;
  window.$_TSR || Ce();
  const l = n.options.serializationAdapters;
  if (l != null && l.length) {
    const C = new Map();
    (l.forEach((z) => {
      C.set(z.key, z.fromSerializable);
    }),
      (window.$_TSR.t = C),
      window.$_TSR.buffer.forEach((z) => z()));
  }
  ((window.$_TSR.initialized = !0), window.$_TSR.router || Ce());
  const u = window.$_TSR.router;
  (u.matches.forEach((C) => {
    C.i = xv(C.i);
  }),
    u.lastMatchId && (u.lastMatchId = xv(u.lastMatchId)));
  const { manifest: r, dehydratedData: o, lastMatchId: f } = u;
  n.ssr = { manifest: r };
  const d = (x = document.querySelector('meta[property="csp-nonce"]')) == null ? void 0 : x.content;
  n.options.ssr = { nonce: d };
  const m = n.matchRoutes(n.stores.location.get()),
    y = Promise.all(m.map((C) => n.loadRouteChunk(n.looseRoutesById[C.routeId])));
  function v(C) {
    const z = n.looseRoutesById[C.routeId].options.pendingMinMs ?? n.options.defaultPendingMinMs;
    if (z) {
      const Y = fl();
      ((C._nonReactive.minPendingPromise = Y),
        (C._forcePending = !0),
        setTimeout(() => {
          (Y.resolve(),
            n.updateMatch(
              C.id,
              (I) => ((I._nonReactive.minPendingPromise = void 0), { ...I, _forcePending: void 0 }),
            ));
        }, z));
    }
  }
  function p(C) {
    const z = n.looseRoutesById[C.routeId];
    z && (z.options.ssr = C.ssr);
  }
  let g;
  (m.forEach((C) => {
    const z = u.matches.find((Y) => Y.i === C.id);
    if (!z) {
      ((C._nonReactive.dehydrated = !1), (C.ssr = !1), p(C));
      return;
    }
    (rR(C, z),
      p(C),
      (C._nonReactive.dehydrated = C.ssr !== !1),
      (C.ssr === "data-only" || C.ssr === !1) && g === void 0 && ((g = C.index), v(C)));
  }),
    n.stores.setMatches(m),
    await ((G = (U = n.options).hydrate) == null ? void 0 : G.call(U, o)));
  const b = n.stores.matches.get(),
    E = n.stores.location.get();
  await Promise.all(
    b.map(async (C) => {
      var z, Y, I, q, k;
      try {
        const J = n.looseRoutesById[C.routeId],
          F = ((z = b[C.index - 1]) == null ? void 0 : z.context) ?? n.options.context;
        if (J.options.context) {
          const dt = {
            deps: C.loaderDeps,
            params: C.params,
            context: F ?? {},
            location: E,
            navigate: (it) => n.navigate({ ...it, _fromLocation: E }),
            buildLocation: n.buildLocation,
            cause: C.cause,
            abortController: C.abortController,
            preload: !1,
            matches: m,
            routeId: J.id,
          };
          C.__routeContext = J.options.context(dt) ?? void 0;
        }
        C.context = { ...F, ...C.__routeContext, ...C.__beforeLoadContext };
        const W = {
            ssr: n.options.ssr,
            matches: b,
            match: C,
            params: C.params,
            loaderData: C.loaderData,
          },
          et = await ((I = (Y = J.options).head) == null ? void 0 : I.call(Y, W)),
          rt = await ((k = (q = J.options).scripts) == null ? void 0 : k.call(q, W));
        ((C.meta = et == null ? void 0 : et.meta),
          (C.links = et == null ? void 0 : et.links),
          (C.headScripts = et == null ? void 0 : et.scripts),
          (C.styles = et == null ? void 0 : et.styles),
          (C.scripts = rt));
      } catch (J) {
        if (re(J))
          ((C.error = { isNotFound: !0 }),
            console.error(`NotFound error during hydration for routeId: ${C.routeId}`, J));
        else
          throw (
            (C.error = J), console.error(`Error during hydration for route ${C.routeId}:`, J), J
          );
      }
    }),
  );
  const R = m[m.length - 1].id !== f;
  if (!m.some((C) => C.ssr === !1) && !R)
    return (
      m.forEach((C) => {
        C._nonReactive.dehydrated = void 0;
      }),
      n.stores.resolvedLocation.set(n.stores.location.get()),
      y
    );
  const M = Promise.resolve()
    .then(() => n.load())
    .catch((C) => {
      console.error("Error during router hydration:", C);
    });
  if (R) {
    const C = m[1];
    (C || Ce(),
      v(C),
      (C._displayPending = !0),
      (C._nonReactive.displayPendingPromise = M),
      M.then(() => {
        n.batch(() => {
          (n.stores.status.get() === "pending" &&
            (n.stores.status.set("idle"), n.stores.resolvedLocation.set(n.stores.location.get())),
            n.updateMatch(C.id, (z) => ({
              ...z,
              _displayPending: void 0,
              displayPendingPromise: void 0,
            })));
        });
      }));
  }
  return y;
}
var gs = st.use,
  bu = typeof window < "u" ? st.useLayoutEffect : st.useEffect;
function lf(n) {
  const l = st.useRef({ value: n, prev: null }),
    u = l.current.value;
  return (n !== u && (l.current = { value: n, prev: u }), l.current.prev);
}
function cR(n, l, u = {}, r = {}) {
  st.useEffect(() => {
    if (!n.current || r.disabled || typeof IntersectionObserver != "function") return;
    const o = new IntersectionObserver(([f]) => {
      l(f);
    }, u);
    return (
      o.observe(n.current),
      () => {
        o.disconnect();
      }
    );
  }, [l, u, r.disabled, n]);
}
function oR(n) {
  const l = st.useRef(null);
  return (st.useImperativeHandle(n, () => l.current, []), l);
}
function fR({ promise: n }) {
  if (gs) return gs(n);
  const l = l1(n);
  if (l[yn].status === "pending") throw l;
  if (l[yn].status === "error") throw l[yn].error;
  return l[yn].data;
}
function dR(n) {
  const l = $.jsx(hR, { ...n });
  return n.fallback ? $.jsx(st.Suspense, { fallback: n.fallback, children: l }) : l;
}
function hR(n) {
  const l = fR(n);
  return n.children(l);
}
function Nf(n) {
  const l = n.errorComponent ?? jf;
  return $.jsx(mR, {
    getResetKey: n.getResetKey,
    onCatch: n.onCatch,
    children: ({ error: u, reset: r }) =>
      u ? st.createElement(l, { error: u, reset: r }) : n.children,
  });
}
var mR = class extends st.Component {
  constructor(...n) {
    (super(...n), (this.state = { error: null }));
  }
  static getDerivedStateFromProps(n, l) {
    const u = n.getResetKey();
    return l.error && l.resetKey !== u ? { resetKey: u, error: null } : { resetKey: u };
  }
  static getDerivedStateFromError(n) {
    return { error: n };
  }
  reset() {
    this.setState({ error: null });
  }
  componentDidCatch(n, l) {
    this.props.onCatch && this.props.onCatch(n, l);
  }
  render() {
    return this.props.children({
      error: this.state.error,
      reset: () => {
        this.reset();
      },
    });
  }
};
function jf({ error: n }) {
  const [l, u] = st.useState(!1);
  return $.jsxs("div", {
    style: { padding: ".5rem", maxWidth: "100%" },
    children: [
      $.jsxs("div", {
        style: { display: "flex", alignItems: "center", gap: ".5rem" },
        children: [
          $.jsx("strong", { style: { fontSize: "1rem" }, children: "Something went wrong!" }),
          $.jsx("button", {
            style: {
              appearance: "none",
              fontSize: ".6em",
              border: "1px solid currentColor",
              padding: ".1rem .2rem",
              fontWeight: "bold",
              borderRadius: ".25rem",
            },
            onClick: () => u((r) => !r),
            children: l ? "Hide Error" : "Show Error",
          }),
        ],
      }),
      $.jsx("div", { style: { height: ".25rem" } }),
      l
        ? $.jsx("div", {
            children: $.jsx("pre", {
              style: {
                fontSize: ".7em",
                border: "1px solid red",
                borderRadius: ".25rem",
                padding: ".3rem",
                color: "red",
                overflow: "auto",
              },
              children: n.message ? $.jsx("code", { children: n.message }) : null,
            }),
          })
        : null,
    ],
  });
}
function yR({ children: n, fallback: l = null }) {
  return Bf() ? $.jsx(Eu.Fragment, { children: n }) : $.jsx(Eu.Fragment, { children: l });
}
function Bf() {
  return Eu.useSyncExternalStore(
    vR,
    () => !0,
    () => !1,
  );
}
function vR() {
  return () => {};
}
var $g = st.createContext(null);
function pe(n) {
  return st.useContext($g);
}
var Ms = st.createContext(void 0),
  gR = st.createContext(void 0),
  Xt = ((n) => (
    (n[(n.None = 0)] = "None"),
    (n[(n.Mutable = 1)] = "Mutable"),
    (n[(n.Watching = 2)] = "Watching"),
    (n[(n.RecursedCheck = 4)] = "RecursedCheck"),
    (n[(n.Recursed = 8)] = "Recursed"),
    (n[(n.Dirty = 16)] = "Dirty"),
    (n[(n.Pending = 32)] = "Pending"),
    n
  ))(Xt || {});
function pR({ update: n, notify: l, unwatched: u }) {
  return { link: r, unlink: o, propagate: f, checkDirty: d, shallowPropagate: m };
  function r(v, p, g) {
    const b = p.depsTail;
    if (b !== void 0 && b.dep === v) return;
    const E = b !== void 0 ? b.nextDep : p.deps;
    if (E !== void 0 && E.dep === v) {
      ((E.version = g), (p.depsTail = E));
      return;
    }
    const R = v.subsTail;
    if (R !== void 0 && R.version === g && R.sub === p) return;
    const M =
      (p.depsTail =
      v.subsTail =
        { version: g, dep: v, sub: p, prevDep: b, nextDep: E, prevSub: R, nextSub: void 0 });
    (E !== void 0 && (E.prevDep = M),
      b !== void 0 ? (b.nextDep = M) : (p.deps = M),
      R !== void 0 ? (R.nextSub = M) : (v.subs = M));
  }
  function o(v, p = v.sub) {
    const g = v.dep,
      b = v.prevDep,
      E = v.nextDep,
      R = v.nextSub,
      M = v.prevSub;
    return (
      E !== void 0 ? (E.prevDep = b) : (p.depsTail = b),
      b !== void 0 ? (b.nextDep = E) : (p.deps = E),
      R !== void 0 ? (R.prevSub = M) : (g.subsTail = M),
      M !== void 0 ? (M.nextSub = R) : (g.subs = R) === void 0 && u(g),
      E
    );
  }
  function f(v) {
    let p = v.nextSub,
      g;
    t: do {
      const b = v.sub;
      let E = b.flags;
      if (
        (E & 60
          ? E & 12
            ? E & 4
              ? !(E & 48) && y(v, b)
                ? ((b.flags = E | 40), (E &= 1))
                : (E = 0)
              : (b.flags = (E & -9) | 32)
            : (E = 0)
          : (b.flags = E | 32),
        E & 2 && l(b),
        E & 1)
      ) {
        const R = b.subs;
        if (R !== void 0) {
          const M = (v = R).nextSub;
          M !== void 0 && ((g = { value: p, prev: g }), (p = M));
          continue;
        }
      }
      if ((v = p) !== void 0) {
        p = v.nextSub;
        continue;
      }
      for (; g !== void 0; )
        if (((v = g.value), (g = g.prev), v !== void 0)) {
          p = v.nextSub;
          continue t;
        }
      break;
    } while (!0);
  }
  function d(v, p) {
    let g,
      b = 0,
      E = !1;
    t: do {
      const R = v.dep,
        M = R.flags;
      if (p.flags & 16) E = !0;
      else if ((M & 17) === 17) {
        if (n(R)) {
          const x = R.subs;
          (x.nextSub !== void 0 && m(x), (E = !0));
        }
      } else if ((M & 33) === 33) {
        ((v.nextSub !== void 0 || v.prevSub !== void 0) && (g = { value: v, prev: g }),
          (v = R.deps),
          (p = R),
          ++b);
        continue;
      }
      if (!E) {
        const x = v.nextDep;
        if (x !== void 0) {
          v = x;
          continue;
        }
      }
      for (; b--; ) {
        const x = p.subs,
          U = x.nextSub !== void 0;
        if ((U ? ((v = g.value), (g = g.prev)) : (v = x), E)) {
          if (n(p)) {
            (U && m(x), (p = v.sub));
            continue;
          }
          E = !1;
        } else p.flags &= -33;
        p = v.sub;
        const G = v.nextDep;
        if (G !== void 0) {
          v = G;
          continue t;
        }
      }
      return E;
    } while (!0);
  }
  function m(v) {
    do {
      const p = v.sub,
        g = p.flags;
      (g & 48) === 32 && ((p.flags = g | 16), (g & 6) === 2 && l(p));
    } while ((v = v.nextSub) !== void 0);
  }
  function y(v, p) {
    let g = p.depsTail;
    for (; g !== void 0; ) {
      if (g === v) return !0;
      g = g.prevDep;
    }
    return !1;
  }
}
function SR(n, l, u) {
  var f, d, m;
  const r = typeof n == "object",
    o = r ? n : void 0;
  return {
    next: (f = r ? n.next : n) == null ? void 0 : f.bind(o),
    error: (d = r ? n.error : l) == null ? void 0 : d.bind(o),
    complete: (m = r ? n.complete : u) == null ? void 0 : m.bind(o),
  };
}
const gf = [];
let fs = 0;
const {
  link: Mv,
  unlink: bR,
  propagate: _R,
  checkDirty: Wg,
  shallowPropagate: wv,
} = pR({
  update(n) {
    return n._update();
  },
  notify(n) {
    ((gf[pf++] = n), (n.flags &= ~Xt.Watching));
  },
  unwatched(n) {
    n.depsTail !== void 0 && ((n.depsTail = void 0), (n.flags = Xt.Mutable | Xt.Dirty), ps(n));
  },
});
let is = 0,
  pf = 0,
  fn,
  Sf = 0;
function tp(n) {
  try {
    (++Sf, n());
  } finally {
    --Sf || ep();
  }
}
function ps(n) {
  const l = n.depsTail;
  let u = l !== void 0 ? l.nextDep : n.deps;
  for (; u !== void 0; ) u = bR(u, n);
}
function ep() {
  if (!(Sf > 0)) {
    for (; is < pf; ) {
      const n = gf[is];
      ((gf[is++] = void 0), n.notify());
    }
    ((is = 0), (pf = 0));
  }
}
function Ov(n, l) {
  const u = typeof n == "function",
    r = n,
    o = {
      _snapshot: u ? void 0 : n,
      subs: void 0,
      subsTail: void 0,
      deps: void 0,
      depsTail: void 0,
      flags: u ? Xt.None : Xt.Mutable,
      get() {
        return (fn !== void 0 && Mv(o, fn, fs), o._snapshot);
      },
      subscribe(f) {
        const d = SR(f),
          m = { current: !1 },
          y = ER(() => {
            var v;
            (o.get(),
              m.current ? (v = d.next) == null || v.call(d, o._snapshot) : (m.current = !0));
          });
        return {
          unsubscribe: () => {
            y.stop();
          },
        };
      },
      _update(f) {
        const d = fn,
          m = (l == null ? void 0 : l.compare) ?? Object.is;
        if (u) ((fn = o), ++fs, (o.depsTail = void 0));
        else if (f === void 0) return !1;
        u && (o.flags = Xt.Mutable | Xt.RecursedCheck);
        try {
          const y = o._snapshot,
            v = typeof f == "function" ? f(y) : f === void 0 && u ? r(y) : f;
          return y === void 0 || !m(y, v) ? ((o._snapshot = v), !0) : !1;
        } finally {
          ((fn = d), u && (o.flags &= ~Xt.RecursedCheck), ps(o));
        }
      },
    };
  return (
    u
      ? ((o.flags = Xt.Mutable | Xt.Dirty),
        (o.get = function () {
          const f = o.flags;
          if (f & Xt.Dirty || (f & Xt.Pending && Wg(o.deps, o))) {
            if (o._update()) {
              const d = o.subs;
              d !== void 0 && wv(d);
            }
          } else f & Xt.Pending && (o.flags = f & ~Xt.Pending);
          return (fn !== void 0 && Mv(o, fn, fs), o._snapshot);
        }))
      : (o.set = function (f) {
          if (o._update(f)) {
            const d = o.subs;
            d !== void 0 && (_R(d), wv(d), ep());
          }
        }),
    o
  );
}
function ER(n) {
  const l = () => {
      const r = fn;
      ((fn = u), ++fs, (u.depsTail = void 0), (u.flags = Xt.Watching | Xt.RecursedCheck));
      try {
        return n();
      } finally {
        ((fn = r), (u.flags &= ~Xt.RecursedCheck), ps(u));
      }
    },
    u = {
      deps: void 0,
      depsTail: void 0,
      subs: void 0,
      subsTail: void 0,
      flags: Xt.Watching | Xt.RecursedCheck,
      notify() {
        const r = this.flags;
        r & Xt.Dirty || (r & Xt.Pending && Wg(this.deps, this)) ? l() : (this.flags = Xt.Watching);
      },
      stop() {
        ((this.flags = Xt.None), (this.depsTail = void 0), ps(this));
      },
    };
  return (l(), u);
}
var uf = { exports: {} },
  rf = {},
  sf = { exports: {} },
  cf = {};
/**
 * @license React
 * use-sync-external-store-shim.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Cv;
function RR() {
  if (Cv) return cf;
  Cv = 1;
  var n = Uu();
  function l(g, b) {
    return (g === b && (g !== 0 || 1 / g === 1 / b)) || (g !== g && b !== b);
  }
  var u = typeof Object.is == "function" ? Object.is : l,
    r = n.useState,
    o = n.useEffect,
    f = n.useLayoutEffect,
    d = n.useDebugValue;
  function m(g, b) {
    var E = b(),
      R = r({ inst: { value: E, getSnapshot: b } }),
      M = R[0].inst,
      x = R[1];
    return (
      f(
        function () {
          ((M.value = E), (M.getSnapshot = b), y(M) && x({ inst: M }));
        },
        [g, E, b],
      ),
      o(
        function () {
          return (
            y(M) && x({ inst: M }),
            g(function () {
              y(M) && x({ inst: M });
            })
          );
        },
        [g],
      ),
      d(E),
      E
    );
  }
  function y(g) {
    var b = g.getSnapshot;
    g = g.value;
    try {
      var E = b();
      return !u(g, E);
    } catch {
      return !0;
    }
  }
  function v(g, b) {
    return b();
  }
  var p =
    typeof window > "u" ||
    typeof window.document > "u" ||
    typeof window.document.createElement > "u"
      ? v
      : m;
  return (
    (cf.useSyncExternalStore = n.useSyncExternalStore !== void 0 ? n.useSyncExternalStore : p), cf
  );
}
var zv;
function TR() {
  return (zv || ((zv = 1), (sf.exports = RR())), sf.exports);
}
/**
 * @license React
 * use-sync-external-store-shim/with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ var Dv;
function AR() {
  if (Dv) return rf;
  Dv = 1;
  var n = Uu(),
    l = TR();
  function u(v, p) {
    return (v === p && (v !== 0 || 1 / v === 1 / p)) || (v !== v && p !== p);
  }
  var r = typeof Object.is == "function" ? Object.is : u,
    o = l.useSyncExternalStore,
    f = n.useRef,
    d = n.useEffect,
    m = n.useMemo,
    y = n.useDebugValue;
  return (
    (rf.useSyncExternalStoreWithSelector = function (v, p, g, b, E) {
      var R = f(null);
      if (R.current === null) {
        var M = { hasValue: !1, value: null };
        R.current = M;
      } else M = R.current;
      R = m(
        function () {
          function U(I) {
            if (!G) {
              if (((G = !0), (C = I), (I = b(I)), E !== void 0 && M.hasValue)) {
                var q = M.value;
                if (E(q, I)) return (z = q);
              }
              return (z = I);
            }
            if (((q = z), r(C, I))) return q;
            var k = b(I);
            return E !== void 0 && E(q, k) ? ((C = I), q) : ((C = I), (z = k));
          }
          var G = !1,
            C,
            z,
            Y = g === void 0 ? null : g;
          return [
            function () {
              return U(p());
            },
            Y === null
              ? void 0
              : function () {
                  return U(Y());
                },
          ];
        },
        [p, g, b, E],
      );
      var x = o(v, R[0], R[1]);
      return (
        d(
          function () {
            ((M.hasValue = !0), (M.value = x));
          },
          [x],
        ),
        y(x),
        x
      );
    }),
    rf
  );
}
var Uv;
function xR() {
  return (Uv || ((Uv = 1), (uf.exports = AR())), uf.exports);
}
var MR = xR();
function wR(n, l) {
  return n === l;
}
function te(n, l, u = wR) {
  const r = st.useCallback(
      (d) => {
        if (!n) return () => {};
        const { unsubscribe: m } = n.subscribe(d);
        return m;
      },
      [n],
    ),
    o = st.useCallback(() => (n == null ? void 0 : n.get()), [n]);
  return MR.useSyncExternalStoreWithSelector(r, o, o, l, u);
}
var OR = { get: () => {}, subscribe: () => ({ unsubscribe: () => {} }) };
function hl(n) {
  const l = pe(),
    u = st.useContext(n.from ? gR : Ms),
    r = n.from ?? u,
    o = r ? (n.from ? l.stores.getRouteMatchStore(r) : l.stores.matchStores.get(r)) : void 0,
    f = st.useRef(void 0);
  return te(o ?? OR, (d) => {
    if (((n.shouldThrow ?? !0) && !d && Ce(), d === void 0)) return;
    const m = n.select ? n.select(d) : d;
    if (n.structuralSharing ?? l.options.defaultStructuralSharing) {
      const y = Wa(f.current, m);
      return ((f.current = y), y);
    }
    return m;
  });
}
function np(n) {
  return hl({
    from: n.from,
    strict: n.strict,
    structuralSharing: n.structuralSharing,
    select: (l) => (n.select ? n.select(l.loaderData) : l.loaderData),
  });
}
function ap(n) {
  const { select: l, ...u } = n;
  return hl({ ...u, select: (r) => (l ? l(r.loaderDeps) : r.loaderDeps) });
}
function lp(n) {
  return hl({
    from: n.from,
    shouldThrow: n.shouldThrow,
    structuralSharing: n.structuralSharing,
    strict: n.strict,
    select: (l) => {
      const u = n.strict === !1 ? l.params : l._strictParams;
      return n.select ? n.select(u) : u;
    },
  });
}
function ip(n) {
  return hl({
    from: n.from,
    strict: n.strict,
    shouldThrow: n.shouldThrow,
    structuralSharing: n.structuralSharing,
    select: (l) => (n.select ? n.select(l.search) : l.search),
  });
}
function up(n) {
  const l = pe();
  return st.useCallback(
    (u) => l.navigate({ ...u, from: u.from ?? (n == null ? void 0 : n.from) }),
    [n == null ? void 0 : n.from, l],
  );
}
function rp(n) {
  return hl({ ...n, select: (l) => (n.select ? n.select(l.context) : l.context) });
}
var CR = eg();
function zR(n, l) {
  const u = pe(),
    r = oR(l),
    {
      activeProps: o,
      inactiveProps: f,
      activeOptions: d,
      to: m,
      preload: y,
      preloadDelay: v,
      preloadIntentProximity: p,
      hashScrollIntoView: g,
      replace: b,
      startTransition: E,
      resetScroll: R,
      viewTransition: M,
      children: x,
      target: U,
      disabled: G,
      style: C,
      className: z,
      onClick: Y,
      onBlur: I,
      onFocus: q,
      onMouseEnter: k,
      onMouseLeave: J,
      onTouchStart: F,
      ignoreBlocker: W,
      params: et,
      search: rt,
      hash: dt,
      state: it,
      mask: j,
      reloadDocument: P,
      unsafeRelative: nt,
      from: vt,
      _fromLocation: ht,
      ...O
    } = n,
    Z = Bf(),
    tt = st.useMemo(
      () => n,
      [
        u,
        n.from,
        n._fromLocation,
        n.hash,
        n.to,
        n.search,
        n.params,
        n.state,
        n.mask,
        n.unsafeRelative,
      ],
    ),
    at = te(
      u.stores.location,
      (Ut) => Ut,
      (Ut, se) => Ut.href === se.href,
    ),
    ct = st.useMemo(() => {
      const Ut = { _fromLocation: at, ...tt };
      return u.buildLocation(Ut);
    }, [u, at, tt]),
    St = ct.maskedLocation ? ct.maskedLocation.publicHref : ct.publicHref,
    xt = ct.maskedLocation ? ct.maskedLocation.external : ct.external,
    Yt = st.useMemo(() => BR(St, xt, u.history, G), [G, xt, St, u.history]),
    Bt = st.useMemo(() => {
      if (Yt != null && Yt.external) return ds(Yt.href, u.protocolAllowlist) ? void 0 : Yt.href;
      if (!HR(m) && !(typeof m != "string" || m.indexOf(":") === -1))
        try {
          return (new URL(m), ds(m, u.protocolAllowlist) ? void 0 : m);
        } catch {}
    }, [m, Yt, u.protocolAllowlist]),
    vn = st.useMemo(() => {
      if (Bt) return !1;
      if (d != null && d.exact) {
        if (!Tb(at.pathname, ct.pathname, u.basepath)) return !1;
      } else {
        const Ut = hs(at.pathname, u.basepath),
          se = hs(ct.pathname, u.basepath);
        if (!(Ut.startsWith(se) && (Ut.length === se.length || Ut[se.length] === "/"))) return !1;
      }
      return ((d == null ? void 0 : d.includeSearch) ?? !0) &&
        !Oe(at.search, ct.search, {
          partial: !(d != null && d.exact),
          ignoreUndefined: !(d != null && d.explicitUndefined),
        })
        ? !1
        : d != null && d.includeHash
          ? Z && at.hash === ct.hash
          : !0;
    }, [
      d == null ? void 0 : d.exact,
      d == null ? void 0 : d.explicitUndefined,
      d == null ? void 0 : d.includeHash,
      d == null ? void 0 : d.includeSearch,
      at,
      Bt,
      Z,
      ct.hash,
      ct.pathname,
      ct.search,
      u.basepath,
    ]),
    gn = vn ? (Ta(o, {}) ?? DR) : of,
    Vn = vn ? of : (Ta(f, {}) ?? of),
    vi = [z, gn.className, Vn.className].filter(Boolean).join(" "),
    ln = (C || gn.style || Vn.style) && { ...C, ...gn.style, ...Vn.style },
    [gi, ml] = st.useState(!1),
    Hu = st.useRef(!1),
    pn = n.reloadDocument || Bt ? !1 : (y ?? u.options.defaultPreload),
    Da = v ?? u.options.defaultPreloadDelay ?? 0,
    $e = st.useCallback(() => {
      u.preloadRoute({ ...tt, _builtLocation: ct }).catch((Ut) => {
        (console.warn(Ut), console.warn(i1));
      });
    }, [u, tt, ct]);
  (cR(
    r,
    st.useCallback(
      (Ut) => {
        Ut != null && Ut.isIntersecting && $e();
      },
      [$e],
    ),
    jR,
    { disabled: !!G || pn !== "viewport" },
  ),
    st.useEffect(() => {
      Hu.current || (!G && pn === "render" && ($e(), (Hu.current = !0)));
    }, [G, $e, pn]));
  const pi = (Ut) => {
    const se = Ut.currentTarget.getAttribute("target"),
      un = U !== void 0 ? U : se;
    if (!G && !qR(Ut) && !Ut.defaultPrevented && (!un || un === "_self") && Ut.button === 0) {
      (Ut.preventDefault(),
        CR.flushSync(() => {
          ml(!0);
        }));
      const yl = u.subscribe("onResolved", () => {
        (yl(), ml(!1));
      });
      u.navigate({
        ...tt,
        replace: b,
        resetScroll: R,
        hashScrollIntoView: g,
        startTransition: E,
        viewTransition: M,
        ignoreBlocker: W,
      });
    }
  };
  if (Bt)
    return {
      ...O,
      ref: r,
      href: Bt,
      ...(x && { children: x }),
      ...(U && { target: U }),
      ...(G && { disabled: G }),
      ...(C && { style: C }),
      ...(z && { className: z }),
      ...(Y && { onClick: Y }),
      ...(I && { onBlur: I }),
      ...(q && { onFocus: q }),
      ...(k && { onMouseEnter: k }),
      ...(J && { onMouseLeave: J }),
      ...(F && { onTouchStart: F }),
    };
  const qu = (Ut) => {
      if (G || pn !== "intent") return;
      if (!Da) {
        $e();
        return;
      }
      const se = Ut.currentTarget;
      if (Su.has(se)) return;
      const un = setTimeout(() => {
        (Su.delete(se), $e());
      }, Da);
      Su.set(se, un);
    },
    Os = (Ut) => {
      G || pn !== "intent" || $e();
    },
    ye = (Ut) => {
      if (G || !pn || !Da) return;
      const se = Ut.currentTarget,
        un = Su.get(se);
      un && (clearTimeout(un), Su.delete(se));
    };
  return {
    ...O,
    ...gn,
    ...Vn,
    href: Yt == null ? void 0 : Yt.href,
    ref: r,
    onClick: ti([Y, pi]),
    onBlur: ti([I, ye]),
    onFocus: ti([q, qu]),
    onMouseEnter: ti([k, qu]),
    onMouseLeave: ti([J, ye]),
    onTouchStart: ti([F, Os]),
    disabled: !!G,
    target: U,
    ...(ln && { style: ln }),
    ...(vi && { className: vi }),
    ...(G && UR),
    ...(vn && LR),
    ...(Z && gi && NR),
  };
}
var of = {},
  DR = { className: "active" },
  UR = { role: "link", "aria-disabled": !0 },
  LR = { "data-status": "active", "aria-current": "page" },
  NR = { "data-transitioning": "transitioning" },
  Su = new WeakMap(),
  jR = { rootMargin: "100px" },
  ti = (n) => (l) => {
    for (const u of n)
      if (u) {
        if (l.defaultPrevented) return;
        u(l);
      }
  };
function BR(n, l, u, r) {
  if (!r) return l ? { href: n, external: !0 } : { href: u.createHref(n) || "/", external: !1 };
}
function HR(n) {
  if (typeof n != "string") return !1;
  const l = n.charCodeAt(0);
  return l === 47 ? n.charCodeAt(1) !== 47 : l === 46;
}
var $a = st.forwardRef((n, l) => {
  const { _asChild: u, ...r } = n,
    { type: o, ...f } = zR(r, l),
    d =
      typeof r.children == "function"
        ? r.children({ isActive: f["data-status"] === "active" })
        : r.children;
  if (!u) {
    const { disabled: m, ...y } = f;
    return st.createElement("a", y, d);
  }
  return st.createElement(u, f, d);
});
function qR(n) {
  return !!(n.metaKey || n.altKey || n.ctrlKey || n.shiftKey);
}
var YR = class extends yg {
  constructor(l) {
    (super(l),
      (this.useMatch = (u) =>
        hl({
          select: u == null ? void 0 : u.select,
          from: this.id,
          structuralSharing: u == null ? void 0 : u.structuralSharing,
        })),
      (this.useRouteContext = (u) => rp({ ...u, from: this.id })),
      (this.useSearch = (u) =>
        ip({
          select: u == null ? void 0 : u.select,
          structuralSharing: u == null ? void 0 : u.structuralSharing,
          from: this.id,
        })),
      (this.useParams = (u) =>
        lp({
          select: u == null ? void 0 : u.select,
          structuralSharing: u == null ? void 0 : u.structuralSharing,
          from: this.id,
        })),
      (this.useLoaderDeps = (u) => ap({ ...u, from: this.id })),
      (this.useLoaderData = (u) => np({ ...u, from: this.id })),
      (this.useNavigate = () => up({ from: this.fullPath })),
      (this.Link = Eu.forwardRef((u, r) => $.jsx($a, { ref: r, from: this.fullPath, ...u }))));
  }
};
function QR(n) {
  return new YR(n);
}
var GR = class extends r1 {
  constructor(n) {
    (super(n),
      (this.useMatch = (l) =>
        hl({
          select: l == null ? void 0 : l.select,
          from: this.id,
          structuralSharing: l == null ? void 0 : l.structuralSharing,
        })),
      (this.useRouteContext = (l) => rp({ ...l, from: this.id })),
      (this.useSearch = (l) =>
        ip({
          select: l == null ? void 0 : l.select,
          structuralSharing: l == null ? void 0 : l.structuralSharing,
          from: this.id,
        })),
      (this.useParams = (l) =>
        lp({
          select: l == null ? void 0 : l.select,
          structuralSharing: l == null ? void 0 : l.structuralSharing,
          from: this.id,
        })),
      (this.useLoaderDeps = (l) => ap({ ...l, from: this.id })),
      (this.useLoaderData = (l) => np({ ...l, from: this.id })),
      (this.useNavigate = () => up({ from: this.fullPath })),
      (this.Link = Eu.forwardRef((l, u) => $.jsx($a, { ref: u, from: this.fullPath, ...l }))));
  }
};
function VR(n) {
  return new GR(n);
}
function Nu(n) {
  return new XR(n, { silent: !0 }).createRoute;
}
var XR = class {
  constructor(n, l) {
    ((this.path = n),
      (this.createRoute = (u) => {
        const r = QR(u);
        return ((r.isRoot = !1), r);
      }),
      (this.silent = l == null ? void 0 : l.silent));
  }
};
function ju(n, l) {
  let u, r, o, f;
  const d = () => (
      u ||
        (u = n()
          .then((y) => {
            ((u = void 0), (r = y[l]));
          })
          .catch((y) => {
            if (
              ((o = y),
              ub(o) && o instanceof Error && typeof window < "u" && typeof sessionStorage < "u")
            ) {
              const v = `tanstack_router_reload:${o.message}`;
              sessionStorage.getItem(v) || (sessionStorage.setItem(v, "1"), (f = !0));
            }
          })),
      u
    ),
    m = function (v) {
      if (f) throw (window.location.reload(), new Promise(() => {}));
      if (o) throw o;
      if (!r)
        if (gs) gs(d());
        else throw d();
      return st.createElement(r, v);
    };
  return ((m.preload = d), m);
}
function ZR(n) {
  const l = pe(),
    u = `not-found-${te(l.stores.location, (r) => r.pathname)}-${te(l.stores.status, (r) => r)}`;
  return $.jsx(Nf, {
    getResetKey: () => u,
    onCatch: (r, o) => {
      var f;
      if (re(r)) (f = n.onCatch) == null || f.call(n, r, o);
      else throw r;
    },
    errorComponent: ({ error: r }) => {
      var o;
      if (re(r)) return (o = n.fallback) == null ? void 0 : o.call(n, r);
      throw r;
    },
    children: n.children,
  });
}
function KR() {
  return $.jsx("p", { children: "Not Found" });
}
function ei(n) {
  return $.jsx($.Fragment, { children: n.children });
}
function sp(n, l, u) {
  return l.options.notFoundComponent
    ? $.jsx(l.options.notFoundComponent, { ...u })
    : n.options.defaultNotFoundComponent
      ? $.jsx(n.options.defaultNotFoundComponent, { ...u })
      : $.jsx(KR, {});
}
function PR(n) {
  return null;
}
function JR() {
  return (PR(pe()), null);
}
var cp = st.memo(function ({ matchId: l }) {
  const u = pe(),
    r = u.stores.matchStores.get(l);
  r || Ce();
  const o = te(u.stores.loadedAt, (d) => d),
    f = te(r, (d) => d);
  return $.jsx(FR, {
    router: u,
    matchId: l,
    resetKey: o,
    matchState: st.useMemo(() => {
      var y;
      const d = f.routeId,
        m = (y = u.routesById[d].parentRoute) == null ? void 0 : y.id;
      return { routeId: d, ssr: f.ssr, _displayPending: f._displayPending, parentRouteId: m };
    }, [f._displayPending, f.routeId, f.ssr, u.routesById]),
  });
});
function FR({ router: n, matchId: l, resetKey: u, matchState: r }) {
  var R, M;
  const o = n.routesById[r.routeId],
    f = o.options.pendingComponent ?? n.options.defaultPendingComponent,
    d = f ? $.jsx(f, {}) : null,
    m = o.options.errorComponent ?? n.options.defaultErrorComponent,
    y = o.options.onCatch ?? n.options.defaultOnCatch,
    v = o.isRoot
      ? (o.options.notFoundComponent ??
        ((R = n.options.notFoundRoute) == null ? void 0 : R.options.component))
      : o.options.notFoundComponent,
    p = r.ssr === !1 || r.ssr === "data-only",
    g =
      (!o.isRoot || o.options.wrapInSuspense || p) &&
      (o.options.wrapInSuspense ??
        f ??
        (((M = o.options.errorComponent) == null ? void 0 : M.preload) || p))
        ? st.Suspense
        : ei,
    b = m ? Nf : ei,
    E = v ? ZR : ei;
  return $.jsxs(o.isRoot ? (o.options.shellComponent ?? ei) : ei, {
    children: [
      $.jsx(Ms.Provider, {
        value: l,
        children: $.jsx(g, {
          fallback: d,
          children: $.jsx(b, {
            getResetKey: () => u,
            errorComponent: m || jf,
            onCatch: (x, U) => {
              if (re(x)) throw (x.routeId ?? (x.routeId = r.routeId), x);
              y == null || y(x, U);
            },
            children: $.jsx(E, {
              fallback: (x) => {
                if (
                  (x.routeId ?? (x.routeId = r.routeId),
                  !v || (x.routeId && x.routeId !== r.routeId) || (!x.routeId && !o.isRoot))
                )
                  throw x;
                return st.createElement(v, x);
              },
              children:
                p || r._displayPending
                  ? $.jsx(yR, { fallback: d, children: $.jsx(Lv, { matchId: l }) })
                  : $.jsx(Lv, { matchId: l }),
            }),
          }),
        }),
      }),
      r.parentRouteId === cl
        ? $.jsxs($.Fragment, {
            children: [
              $.jsx(kR, { resetKey: u }),
              n.options.scrollRestoration && ng ? $.jsx(JR, {}) : null,
            ],
          })
        : null,
    ],
  });
}
function kR({ resetKey: n }) {
  const l = pe(),
    u = st.useRef(void 0);
  return (
    bu(() => {
      const r = l.latestLocation.href;
      (u.current === void 0 || u.current !== r) &&
        (l.emit({
          type: "onRendered",
          ...ai(l.stores.location.get(), l.stores.resolvedLocation.get()),
        }),
        (u.current = r));
    }, [l.latestLocation.state.__TSR_key, n, l]),
    null
  );
}
var Lv = st.memo(function ({ matchId: l }) {
    const u = pe(),
      r = (p, g) => {
        var b;
        return ((b = u.getMatch(p.id)) == null ? void 0 : b._nonReactive[g]) ?? p._nonReactive[g];
      },
      o = u.stores.matchStores.get(l);
    o || Ce();
    const f = te(o, (p) => p),
      d = f.routeId,
      m = u.routesById[d],
      y = st.useMemo(() => {
        var g;
        const p =
          (g = u.routesById[d].options.remountDeps ?? u.options.defaultRemountDeps) == null
            ? void 0
            : g({
                routeId: d,
                loaderDeps: f.loaderDeps,
                params: f._strictParams,
                search: f._strictSearch,
              });
        return p ? JSON.stringify(p) : void 0;
      }, [
        d,
        f.loaderDeps,
        f._strictParams,
        f._strictSearch,
        u.options.defaultRemountDeps,
        u.routesById,
      ]),
      v = st.useMemo(() => {
        const p = m.options.component ?? u.options.defaultComponent;
        return p ? $.jsx(p, {}, y) : $.jsx(op, {});
      }, [y, m.options.component, u.options.defaultComponent]);
    if (f._displayPending) throw r(f, "displayPendingPromise");
    if (f._forcePending) throw r(f, "minPendingPromise");
    if (f.status === "pending") {
      const p = m.options.pendingMinMs ?? u.options.defaultPendingMinMs;
      if (p) {
        const g = u.getMatch(f.id);
        if (g && !g._nonReactive.minPendingPromise) {
          const b = fl();
          ((g._nonReactive.minPendingPromise = b),
            setTimeout(() => {
              (b.resolve(), (g._nonReactive.minPendingPromise = void 0));
            }, p));
        }
      }
      throw r(f, "loadPromise");
    }
    if (f.status === "notFound") return (re(f.error) || Ce(), sp(u, m, f.error));
    if (f.status === "redirected") throw (_e(f.error) || Ce(), r(f, "loadPromise"));
    if (f.status === "error") throw f.error;
    return v;
  }),
  op = st.memo(function () {
    const l = pe(),
      u = st.useContext(Ms);
    let r,
      o = !1,
      f;
    {
      const v = u ? l.stores.matchStores.get(u) : void 0;
      (([r, o] = te(v, (p) => [
        p == null ? void 0 : p.routeId,
        (p == null ? void 0 : p.globalNotFound) ?? !1,
      ])),
        (f = te(l.stores.matchesId, (p) => p[p.findIndex((g) => g === u) + 1])));
    }
    const d = r ? l.routesById[r] : void 0,
      m = l.options.defaultPendingComponent ? $.jsx(l.options.defaultPendingComponent, {}) : null;
    if (o) return (d || Ce(), sp(l, d, void 0));
    if (!f) return null;
    const y = $.jsx(cp, { matchId: f });
    return r === cl ? $.jsx(st.Suspense, { fallback: m, children: y }) : y;
  });
function IR() {
  const n = pe(),
    l = st.useRef({ router: n, mounted: !1 }),
    [u, r] = st.useState(!1),
    o = te(n.stores.isLoading, (g) => g),
    f = te(n.stores.hasPending, (g) => g),
    d = lf(o),
    m = o || u || f,
    y = lf(m),
    v = o || f,
    p = lf(v);
  return (
    (n.startTransition = (g) => {
      (r(!0),
        st.startTransition(() => {
          (g(), r(!1));
        }));
    }),
    st.useEffect(() => {
      const g = n.history.subscribe(n.load),
        b = n.buildLocation({
          to: n.latestLocation.pathname,
          search: !0,
          params: !0,
          hash: !0,
          state: !0,
          _includeValidateSearch: !0,
        });
      return (
        xa(n.latestLocation.publicHref) !== xa(b.publicHref) &&
          n.commitLocation({ ...b, replace: !0 }),
        () => {
          g();
        }
      );
    }, [n, n.history]),
    bu(() => {
      if ((typeof window < "u" && n.ssr) || (l.current.router === n && l.current.mounted)) return;
      ((l.current = { router: n, mounted: !0 }),
        (async () => {
          try {
            await n.load();
          } catch (b) {
            console.error(b);
          }
        })());
    }, [n]),
    bu(() => {
      d &&
        !o &&
        n.emit({ type: "onLoad", ...ai(n.stores.location.get(), n.stores.resolvedLocation.get()) });
    }, [d, n, o]),
    bu(() => {
      p &&
        !v &&
        n.emit({
          type: "onBeforeRouteMount",
          ...ai(n.stores.location.get(), n.stores.resolvedLocation.get()),
        });
    }, [v, p, n]),
    bu(() => {
      if (y && !m) {
        const g = ai(n.stores.location.get(), n.stores.resolvedLocation.get());
        (n.emit({ type: "onResolved", ...g }),
          tp(() => {
            (n.stores.status.set("idle"), n.stores.resolvedLocation.set(n.stores.location.get()));
          }),
          g.hrefChanged && s1(n));
      }
    }, [m, y, n]),
    null
  );
}
function $R() {
  const n = pe(),
    l = n.routesById[cl].options.pendingComponent ?? n.options.defaultPendingComponent,
    u = l ? $.jsx(l, {}) : null,
    r = $.jsxs(typeof document < "u" && n.ssr ? ei : st.Suspense, {
      fallback: u,
      children: [$.jsx(IR, {}), $.jsx(WR, {})],
    });
  return n.options.InnerWrap ? $.jsx(n.options.InnerWrap, { children: r }) : r;
}
function WR() {
  const n = pe(),
    l = te(n.stores.firstId, (o) => o),
    u = te(n.stores.loadedAt, (o) => o),
    r = l ? $.jsx(cp, { matchId: l }) : null;
  return $.jsx(Ms.Provider, {
    value: l,
    children: n.options.disableGlobalCatchBoundary
      ? r
      : $.jsx(Nf, { getResetKey: () => u, errorComponent: jf, onCatch: void 0, children: r }),
  });
}
var tT = (n) => ({ createMutableStore: Ov, createReadonlyStore: Ov, batch: tp }),
  eT = (n) => new nT(n),
  nT = class extends Ib {
    constructor(n) {
      super(n, tT);
    }
  };
function aT({ router: n, children: l, ...u }) {
  Object.keys(u).length > 0 &&
    n.update({ ...n.options, ...u, context: { ...n.options.context, ...u.context } });
  const r = $.jsx($g.Provider, { value: n, children: l });
  return n.options.Wrap ? $.jsx(n.options.Wrap, { children: r }) : r;
}
function lT({ router: n, ...l }) {
  return $.jsx(aT, { router: n, ...l, children: $.jsx($R, {}) });
}
function fp({ tag: n, attrs: l, children: u, nonce: r }) {
  switch (n) {
    case "title":
      return $.jsx("title", { ...l, suppressHydrationWarning: !0, children: u });
    case "meta":
      return $.jsx("meta", { ...l, suppressHydrationWarning: !0 });
    case "link":
      return $.jsx("link", {
        ...l,
        precedence:
          (l == null ? void 0 : l.precedence) ??
          ((l == null ? void 0 : l.rel) === "stylesheet" ? "default" : void 0),
        nonce: r,
        suppressHydrationWarning: !0,
      });
    case "style":
      return $.jsx("style", { ...l, dangerouslySetInnerHTML: { __html: u }, nonce: r });
    case "script":
      return $.jsx(iT, { attrs: l, children: u });
    default:
      return null;
  }
}
function iT({ attrs: n, children: l }) {
  pe();
  const u = Bf(),
    r =
      typeof (n == null ? void 0 : n.type) == "string" &&
      n.type !== "" &&
      n.type !== "text/javascript" &&
      n.type !== "module";
  if (
    (st.useEffect(() => {
      if (!r) {
        if (n != null && n.src) {
          const o = (() => {
            try {
              const d = document.baseURI || window.location.href;
              return new URL(n.src, d).href;
            } catch {
              return n.src;
            }
          })();
          if (Array.from(document.querySelectorAll("script[src]")).find((d) => d.src === o)) return;
          const f = document.createElement("script");
          for (const [d, m] of Object.entries(n))
            d !== "suppressHydrationWarning" &&
              m !== void 0 &&
              m !== !1 &&
              f.setAttribute(d, typeof m == "boolean" ? "" : String(m));
          return (
            document.head.appendChild(f),
            () => {
              f.parentNode && f.parentNode.removeChild(f);
            }
          );
        }
        if (typeof l == "string") {
          const o = typeof (n == null ? void 0 : n.type) == "string" ? n.type : "text/javascript",
            f = typeof (n == null ? void 0 : n.nonce) == "string" ? n.nonce : void 0;
          if (
            Array.from(document.querySelectorAll("script:not([src])")).find((m) => {
              if (!(m instanceof HTMLScriptElement)) return !1;
              const y = m.getAttribute("type") ?? "text/javascript",
                v = m.getAttribute("nonce") ?? void 0;
              return m.textContent === l && y === o && v === f;
            })
          )
            return;
          const d = document.createElement("script");
          if (((d.textContent = l), n))
            for (const [m, y] of Object.entries(n))
              m !== "suppressHydrationWarning" &&
                y !== void 0 &&
                y !== !1 &&
                d.setAttribute(m, typeof y == "boolean" ? "" : String(y));
          return (
            document.head.appendChild(d),
            () => {
              d.parentNode && d.parentNode.removeChild(d);
            }
          );
        }
      }
    }, [n, l, r]),
    r && typeof l == "string")
  )
    return $.jsx("script", {
      ...n,
      suppressHydrationWarning: !0,
      dangerouslySetInnerHTML: { __html: l },
    });
  if (!u) {
    if (n != null && n.src) return $.jsx("script", { ...n, suppressHydrationWarning: !0 });
    if (typeof l == "string")
      return $.jsx("script", {
        ...n,
        dangerouslySetInnerHTML: { __html: l },
        suppressHydrationWarning: !0,
      });
  }
  return null;
}
var uT = (n) => {
  var v;
  const l = pe(),
    u = (v = l.options.ssr) == null ? void 0 : v.nonce,
    r = te(l.stores.matches, (p) => p.map((g) => g.meta).filter(Boolean), Oe),
    o = st.useMemo(() => {
      const p = [],
        g = {};
      let b;
      for (let E = r.length - 1; E >= 0; E--) {
        const R = r[E];
        for (let M = R.length - 1; M >= 0; M--) {
          const x = R[M];
          if (x)
            if (x.title) b || (b = { tag: "title", children: x.title });
            else if ("script:ld+json" in x)
              try {
                const U = JSON.stringify(x["script:ld+json"]);
                p.push({ tag: "script", attrs: { type: "application/ld+json" }, children: fb(U) });
              } catch {}
            else {
              const U = x.name ?? x.property;
              if (U) {
                if (g[U]) continue;
                g[U] = !0;
              }
              p.push({ tag: "meta", attrs: { ...x, nonce: u } });
            }
        }
      }
      return (
        b && p.push(b),
        u && p.push({ tag: "meta", attrs: { property: "csp-nonce", content: u } }),
        p.reverse(),
        p
      );
    }, [r, u]),
    f = te(
      l.stores.matches,
      (p) => {
        var R;
        const g = p
            .map((M) => M.links)
            .filter(Boolean)
            .flat(1)
            .map((M) => ({ tag: "link", attrs: { ...M, nonce: u } })),
          b = (R = l.ssr) == null ? void 0 : R.manifest,
          E = p
            .map((M) => {
              var x;
              return (
                ((x = b == null ? void 0 : b.routes[M.routeId]) == null ? void 0 : x.assets) ?? []
              );
            })
            .filter(Boolean)
            .flat(1)
            .filter((M) => M.tag === "link")
            .map((M) => {
              var x;
              return {
                tag: "link",
                attrs: {
                  ...M.attrs,
                  crossOrigin:
                    hv(n, "stylesheet") ?? ((x = M.attrs) == null ? void 0 : x.crossOrigin),
                  suppressHydrationWarning: !0,
                  nonce: u,
                },
              };
            });
        return [...g, ...E];
      },
      Oe,
    ),
    d = te(
      l.stores.matches,
      (p) => {
        const g = [];
        return (
          p
            .map((b) => l.looseRoutesById[b.routeId])
            .forEach((b) => {
              var E, R, M, x;
              return (x =
                (M =
                  (R = (E = l.ssr) == null ? void 0 : E.manifest) == null
                    ? void 0
                    : R.routes[b.id]) == null
                  ? void 0
                  : M.preloads) == null
                ? void 0
                : x.filter(Boolean).forEach((U) => {
                    const G = u1(U);
                    g.push({
                      tag: "link",
                      attrs: {
                        rel: "modulepreload",
                        href: G.href,
                        crossOrigin: hv(n, "modulepreload") ?? G.crossOrigin,
                        nonce: u,
                      },
                    });
                  });
            }),
          g
        );
      },
      Oe,
    ),
    m = te(
      l.stores.matches,
      (p) =>
        p
          .map((g) => g.styles)
          .flat(1)
          .filter(Boolean)
          .map(({ children: g, ...b }) => ({
            tag: "style",
            attrs: { ...b, nonce: u },
            children: g,
          })),
      Oe,
    ),
    y = te(
      l.stores.matches,
      (p) =>
        p
          .map((g) => g.headScripts)
          .flat(1)
          .filter(Boolean)
          .map(({ children: g, ...b }) => ({
            tag: "script",
            attrs: { ...b, nonce: u },
            children: g,
          })),
      Oe,
    );
  return rT([...o, ...d, ...f, ...m, ...y], (p) => JSON.stringify(p));
};
function rT(n, l) {
  const u = new Set();
  return n.filter((r) => {
    const o = l(r);
    return u.has(o) ? !1 : (u.add(o), !0);
  });
}
function sT(n) {
  var r;
  const l = uT(n.assetCrossOrigin),
    u = (r = pe().options.ssr) == null ? void 0 : r.nonce;
  return $.jsx($.Fragment, {
    children: l.map((o) =>
      st.createElement(fp, { ...o, key: `tsr-meta-${JSON.stringify(o)}`, nonce: u }),
    ),
  });
}
var cT = () => {
  var f;
  const n = pe(),
    l = (f = n.options.ssr) == null ? void 0 : f.nonce,
    u = (d) => {
      var v;
      const m = [],
        y = (v = n.ssr) == null ? void 0 : v.manifest;
      return y
        ? (d
            .map((p) => n.looseRoutesById[p.routeId])
            .forEach((p) => {
              var g, b;
              return (b = (g = y.routes[p.id]) == null ? void 0 : g.assets) == null
                ? void 0
                : b
                    .filter((E) => E.tag === "script")
                    .forEach((E) => {
                      m.push({
                        tag: "script",
                        attrs: { ...E.attrs, nonce: l },
                        children: E.children,
                      });
                    });
            }),
          m)
        : [];
    },
    r = (d) =>
      d
        .map((m) => m.scripts)
        .flat(1)
        .filter(Boolean)
        .map(({ children: m, ...y }) => ({
          tag: "script",
          attrs: { ...y, suppressHydrationWarning: !0, nonce: l },
          children: m,
        })),
    o = te(n.stores.matches, u, Oe);
  return oT(n, te(n.stores.matches, r, Oe), o);
};
function oT(n, l, u) {
  let r;
  n.serverSsr && (r = n.serverSsr.takeBufferedScripts());
  const o = [...l, ...u];
  return (
    r && o.unshift(r),
    $.jsx($.Fragment, {
      children: o.map((f, d) => st.createElement(fp, { ...f, key: `tsr-scripts-${f.tag}-${d}` })),
    })
  );
}
var ws = class {
    constructor() {
      ((this.listeners = new Set()), (this.subscribe = this.subscribe.bind(this)));
    }
    subscribe(n) {
      return (
        this.listeners.add(n),
        this.onSubscribe(),
        () => {
          (this.listeners.delete(n), this.onUnsubscribe());
        }
      );
    }
    hasListeners() {
      return this.listeners.size > 0;
    }
    onSubscribe() {}
    onUnsubscribe() {}
  },
  al,
  pa,
  ui,
  Kv,
  fT =
    ((Kv = class extends ws {
      constructor() {
        super();
        At(this, al);
        At(this, pa);
        At(this, ui);
        mt(this, ui, (l) => {
          if (typeof window < "u" && window.addEventListener) {
            const u = () => l();
            return (
              window.addEventListener("visibilitychange", u, !1),
              () => {
                window.removeEventListener("visibilitychange", u);
              }
            );
          }
        });
      }
      onSubscribe() {
        V(this, pa) || this.setEventListener(V(this, ui));
      }
      onUnsubscribe() {
        var l;
        this.hasListeners() || ((l = V(this, pa)) == null || l.call(this), mt(this, pa, void 0));
      }
      setEventListener(l) {
        var u;
        (mt(this, ui, l),
          (u = V(this, pa)) == null || u.call(this),
          mt(
            this,
            pa,
            l((r) => {
              typeof r == "boolean" ? this.setFocused(r) : this.onFocus();
            }),
          ));
      }
      setFocused(l) {
        V(this, al) !== l && (mt(this, al, l), this.onFocus());
      }
      onFocus() {
        const l = this.isFocused();
        this.listeners.forEach((u) => {
          u(l);
        });
      }
      isFocused() {
        var l;
        return typeof V(this, al) == "boolean"
          ? V(this, al)
          : ((l = globalThis.document) == null ? void 0 : l.visibilityState) !== "hidden";
      }
    }),
    (al = new WeakMap()),
    (pa = new WeakMap()),
    (ui = new WeakMap()),
    Kv),
  dp = new fT(),
  dT = {
    setTimeout: (n, l) => setTimeout(n, l),
    clearTimeout: (n) => clearTimeout(n),
    setInterval: (n, l) => setInterval(n, l),
    clearInterval: (n) => clearInterval(n),
  },
  Sa,
  Af,
  Pv,
  hT =
    ((Pv = class {
      constructor() {
        At(this, Sa, dT);
        At(this, Af, !1);
      }
      setTimeoutProvider(n) {
        mt(this, Sa, n);
      }
      setTimeout(n, l) {
        return V(this, Sa).setTimeout(n, l);
      }
      clearTimeout(n) {
        V(this, Sa).clearTimeout(n);
      }
      setInterval(n, l) {
        return V(this, Sa).setInterval(n, l);
      }
      clearInterval(n) {
        V(this, Sa).clearInterval(n);
      }
    }),
    (Sa = new WeakMap()),
    (Af = new WeakMap()),
    Pv),
  bf = new hT();
function mT(n) {
  setTimeout(n, 0);
}
var yT = typeof window > "u" || "Deno" in globalThis;
function nn() {}
function vT(n, l) {
  return typeof n == "function" ? n(l) : n;
}
function gT(n) {
  return typeof n == "number" && n >= 0 && n !== 1 / 0;
}
function pT(n, l) {
  return Math.max(n + (l || 0) - Date.now(), 0);
}
function _f(n, l) {
  return typeof n == "function" ? n(l) : n;
}
function ST(n, l) {
  return typeof n == "function" ? n(l) : n;
}
function Nv(n, l) {
  const { type: u = "all", exact: r, fetchStatus: o, predicate: f, queryKey: d, stale: m } = n;
  if (d) {
    if (r) {
      if (l.queryHash !== Hf(d, l.options)) return !1;
    } else if (!Ou(l.queryKey, d)) return !1;
  }
  if (u !== "all") {
    const y = l.isActive();
    if ((u === "active" && !y) || (u === "inactive" && y)) return !1;
  }
  return !(
    (typeof m == "boolean" && l.isStale() !== m) ||
    (o && o !== l.state.fetchStatus) ||
    (f && !f(l))
  );
}
function jv(n, l) {
  const { exact: u, status: r, predicate: o, mutationKey: f } = n;
  if (f) {
    if (!l.options.mutationKey) return !1;
    if (u) {
      if (wu(l.options.mutationKey) !== wu(f)) return !1;
    } else if (!Ou(l.options.mutationKey, f)) return !1;
  }
  return !((r && l.state.status !== r) || (o && !o(l)));
}
function Hf(n, l) {
  return ((l == null ? void 0 : l.queryKeyHashFn) || wu)(n);
}
function wu(n) {
  return JSON.stringify(n, (l, u) =>
    Ef(u)
      ? Object.keys(u)
          .sort()
          .reduce((r, o) => ((r[o] = u[o]), r), {})
      : u,
  );
}
function Ou(n, l) {
  return n === l
    ? !0
    : typeof n != typeof l
      ? !1
      : n && l && typeof n == "object" && typeof l == "object"
        ? Object.keys(l).every((u) => Ou(n[u], l[u]))
        : !1;
}
var bT = Object.prototype.hasOwnProperty;
function hp(n, l, u = 0) {
  if (n === l) return n;
  if (u > 500) return l;
  const r = Bv(n) && Bv(l);
  if (!r && !(Ef(n) && Ef(l))) return l;
  const f = (r ? n : Object.keys(n)).length,
    d = r ? l : Object.keys(l),
    m = d.length,
    y = r ? new Array(m) : {};
  let v = 0;
  for (let p = 0; p < m; p++) {
    const g = r ? p : d[p],
      b = n[g],
      E = l[g];
    if (b === E) {
      ((y[g] = b), (r ? p < f : bT.call(n, g)) && v++);
      continue;
    }
    if (b === null || E === null || typeof b != "object" || typeof E != "object") {
      y[g] = E;
      continue;
    }
    const R = hp(b, E, u + 1);
    ((y[g] = R), R === b && v++);
  }
  return f === m && v === f ? n : y;
}
function E2(n, l) {
  if (!l || Object.keys(n).length !== Object.keys(l).length) return !1;
  for (const u in n) if (n[u] !== l[u]) return !1;
  return !0;
}
function Bv(n) {
  return Array.isArray(n) && n.length === Object.keys(n).length;
}
function Ef(n) {
  if (!Hv(n)) return !1;
  const l = n.constructor;
  if (l === void 0) return !0;
  const u = l.prototype;
  return !(
    !Hv(u) ||
    !u.hasOwnProperty("isPrototypeOf") ||
    Object.getPrototypeOf(n) !== Object.prototype
  );
}
function Hv(n) {
  return Object.prototype.toString.call(n) === "[object Object]";
}
function _T(n) {
  return new Promise((l) => {
    bf.setTimeout(l, n);
  });
}
function ET(n, l, u) {
  return typeof u.structuralSharing == "function"
    ? u.structuralSharing(n, l)
    : u.structuralSharing !== !1
      ? hp(n, l)
      : l;
}
function RT(n, l, u = 0) {
  const r = [...n, l];
  return u && r.length > u ? r.slice(1) : r;
}
function TT(n, l, u = 0) {
  const r = [l, ...n];
  return u && r.length > u ? r.slice(0, -1) : r;
}
var qf = Symbol();
function mp(n, l) {
  return !n.queryFn && l != null && l.initialPromise
    ? () => l.initialPromise
    : !n.queryFn || n.queryFn === qf
      ? () => Promise.reject(new Error(`Missing queryFn: '${n.queryHash}'`))
      : n.queryFn;
}
function R2(n, l) {
  return typeof n == "function" ? n(...l) : !!n;
}
function AT(n, l, u) {
  let r = !1,
    o;
  return (
    Object.defineProperty(n, "signal", {
      enumerable: !0,
      get: () => (
        o ?? (o = l()),
        r || ((r = !0), o.aborted ? u() : o.addEventListener("abort", u, { once: !0 })),
        o
      ),
    }),
    n
  );
}
var yp = (() => {
  let n = () => yT;
  return {
    isServer() {
      return n();
    },
    setIsServer(l) {
      n = l;
    },
  };
})();
function xT() {
  let n, l;
  const u = new Promise((o, f) => {
    ((n = o), (l = f));
  });
  ((u.status = "pending"), u.catch(() => {}));
  function r(o) {
    (Object.assign(u, o), delete u.resolve, delete u.reject);
  }
  return (
    (u.resolve = (o) => {
      (r({ status: "fulfilled", value: o }), n(o));
    }),
    (u.reject = (o) => {
      (r({ status: "rejected", reason: o }), l(o));
    }),
    u
  );
}
var MT = mT;
function wT() {
  let n = [],
    l = 0,
    u = (m) => {
      m();
    },
    r = (m) => {
      m();
    },
    o = MT;
  const f = (m) => {
      l
        ? n.push(m)
        : o(() => {
            u(m);
          });
    },
    d = () => {
      const m = n;
      ((n = []),
        m.length &&
          o(() => {
            r(() => {
              m.forEach((y) => {
                u(y);
              });
            });
          }));
    };
  return {
    batch: (m) => {
      let y;
      l++;
      try {
        y = m();
      } finally {
        (l--, l || d());
      }
      return y;
    },
    batchCalls:
      (m) =>
      (...y) => {
        f(() => {
          m(...y);
        });
      },
    schedule: f,
    setNotifyFunction: (m) => {
      u = m;
    },
    setBatchNotifyFunction: (m) => {
      r = m;
    },
    setScheduler: (m) => {
      o = m;
    },
  };
}
var be = wT(),
  ri,
  ba,
  si,
  Jv,
  OT =
    ((Jv = class extends ws {
      constructor() {
        super();
        At(this, ri, !0);
        At(this, ba);
        At(this, si);
        mt(this, si, (l) => {
          if (typeof window < "u" && window.addEventListener) {
            const u = () => l(!0),
              r = () => l(!1);
            return (
              window.addEventListener("online", u, !1),
              window.addEventListener("offline", r, !1),
              () => {
                (window.removeEventListener("online", u), window.removeEventListener("offline", r));
              }
            );
          }
        });
      }
      onSubscribe() {
        V(this, ba) || this.setEventListener(V(this, si));
      }
      onUnsubscribe() {
        var l;
        this.hasListeners() || ((l = V(this, ba)) == null || l.call(this), mt(this, ba, void 0));
      }
      setEventListener(l) {
        var u;
        (mt(this, si, l),
          (u = V(this, ba)) == null || u.call(this),
          mt(this, ba, l(this.setOnline.bind(this))));
      }
      setOnline(l) {
        V(this, ri) !== l &&
          (mt(this, ri, l),
          this.listeners.forEach((r) => {
            r(l);
          }));
      }
      isOnline() {
        return V(this, ri);
      }
    }),
    (ri = new WeakMap()),
    (ba = new WeakMap()),
    (si = new WeakMap()),
    Jv),
  Ss = new OT();
function CT(n) {
  return Math.min(1e3 * 2 ** n, 3e4);
}
function vp(n) {
  return (n ?? "online") === "online" ? Ss.isOnline() : !0;
}
var Rf = class extends Error {
  constructor(n) {
    (super("CancelledError"),
      (this.revert = n == null ? void 0 : n.revert),
      (this.silent = n == null ? void 0 : n.silent));
  }
};
function gp(n) {
  let l = !1,
    u = 0,
    r;
  const o = xT(),
    f = () => o.status !== "pending",
    d = (M) => {
      var x;
      if (!f()) {
        const U = new Rf(M);
        (b(U), (x = n.onCancel) == null || x.call(n, U));
      }
    },
    m = () => {
      l = !0;
    },
    y = () => {
      l = !1;
    },
    v = () => dp.isFocused() && (n.networkMode === "always" || Ss.isOnline()) && n.canRun(),
    p = () => vp(n.networkMode) && n.canRun(),
    g = (M) => {
      f() || (r == null || r(), o.resolve(M));
    },
    b = (M) => {
      f() || (r == null || r(), o.reject(M));
    },
    E = () =>
      new Promise((M) => {
        var x;
        ((r = (U) => {
          (f() || v()) && M(U);
        }),
          (x = n.onPause) == null || x.call(n));
      }).then(() => {
        var M;
        ((r = void 0), f() || (M = n.onContinue) == null || M.call(n));
      }),
    R = () => {
      if (f()) return;
      let M;
      const x = u === 0 ? n.initialPromise : void 0;
      try {
        M = x ?? n.fn();
      } catch (U) {
        M = Promise.reject(U);
      }
      Promise.resolve(M)
        .then(g)
        .catch((U) => {
          var I;
          if (f()) return;
          const G = n.retry ?? (yp.isServer() ? 0 : 3),
            C = n.retryDelay ?? CT,
            z = typeof C == "function" ? C(u, U) : C,
            Y = G === !0 || (typeof G == "number" && u < G) || (typeof G == "function" && G(u, U));
          if (l || !Y) {
            b(U);
            return;
          }
          (u++,
            (I = n.onFail) == null || I.call(n, u, U),
            _T(z)
              .then(() => (v() ? void 0 : E()))
              .then(() => {
                l ? b(U) : R();
              }));
        });
    };
  return {
    promise: o,
    status: () => o.status,
    cancel: d,
    continue: () => (r == null || r(), o),
    cancelRetry: m,
    continueRetry: y,
    canStart: p,
    start: () => (p() ? R() : E().then(R), o),
  };
}
var ll,
  Fv,
  pp =
    ((Fv = class {
      constructor() {
        At(this, ll);
      }
      destroy() {
        this.clearGcTimeout();
      }
      scheduleGc() {
        (this.clearGcTimeout(),
          gT(this.gcTime) &&
            mt(
              this,
              ll,
              bf.setTimeout(() => {
                this.optionalRemove();
              }, this.gcTime),
            ));
      }
      updateGcTime(n) {
        this.gcTime = Math.max(this.gcTime || 0, n ?? (yp.isServer() ? 1 / 0 : 300 * 1e3));
      }
      clearGcTimeout() {
        V(this, ll) !== void 0 && (bf.clearTimeout(V(this, ll)), mt(this, ll, void 0));
      }
    }),
    (ll = new WeakMap()),
    Fv),
  il,
  ci,
  Ie,
  ul,
  ue,
  Cu,
  rl,
  Ye,
  Sp,
  Hn,
  kv,
  zT =
    ((kv = class extends pp {
      constructor(l) {
        super();
        At(this, Ye);
        At(this, il);
        At(this, ci);
        At(this, Ie);
        At(this, ul);
        At(this, ue);
        At(this, Cu);
        At(this, rl);
        (mt(this, rl, !1),
          mt(this, Cu, l.defaultOptions),
          this.setOptions(l.options),
          (this.observers = []),
          mt(this, ul, l.client),
          mt(this, Ie, V(this, ul).getQueryCache()),
          (this.queryKey = l.queryKey),
          (this.queryHash = l.queryHash),
          mt(this, il, Yv(this.options)),
          (this.state = l.state ?? V(this, il)),
          this.scheduleGc());
      }
      get meta() {
        return this.options.meta;
      }
      get promise() {
        var l;
        return (l = V(this, ue)) == null ? void 0 : l.promise;
      }
      setOptions(l) {
        if (
          ((this.options = { ...V(this, Cu), ...l }),
          this.updateGcTime(this.options.gcTime),
          this.state && this.state.data === void 0)
        ) {
          const u = Yv(this.options);
          u.data !== void 0 && (this.setState(qv(u.data, u.dataUpdatedAt)), mt(this, il, u));
        }
      }
      optionalRemove() {
        !this.observers.length && this.state.fetchStatus === "idle" && V(this, Ie).remove(this);
      }
      setData(l, u) {
        const r = ET(this.state.data, l, this.options);
        return (
          me(this, Ye, Hn).call(this, {
            data: r,
            type: "success",
            dataUpdatedAt: u == null ? void 0 : u.updatedAt,
            manual: u == null ? void 0 : u.manual,
          }),
          r
        );
      }
      setState(l, u) {
        me(this, Ye, Hn).call(this, { type: "setState", state: l, setStateOptions: u });
      }
      cancel(l) {
        var r, o;
        const u = (r = V(this, ue)) == null ? void 0 : r.promise;
        return (
          (o = V(this, ue)) == null || o.cancel(l), u ? u.then(nn).catch(nn) : Promise.resolve()
        );
      }
      destroy() {
        (super.destroy(), this.cancel({ silent: !0 }));
      }
      get resetState() {
        return V(this, il);
      }
      reset() {
        (this.destroy(), this.setState(this.resetState));
      }
      isActive() {
        return this.observers.some((l) => ST(l.options.enabled, this) !== !1);
      }
      isDisabled() {
        return this.getObserversCount() > 0
          ? !this.isActive()
          : this.options.queryFn === qf || !this.isFetched();
      }
      isFetched() {
        return this.state.dataUpdateCount + this.state.errorUpdateCount > 0;
      }
      isStatic() {
        return this.getObserversCount() > 0
          ? this.observers.some((l) => _f(l.options.staleTime, this) === "static")
          : !1;
      }
      isStale() {
        return this.getObserversCount() > 0
          ? this.observers.some((l) => l.getCurrentResult().isStale)
          : this.state.data === void 0 || this.state.isInvalidated;
      }
      isStaleByTime(l = 0) {
        return this.state.data === void 0
          ? !0
          : l === "static"
            ? !1
            : this.state.isInvalidated
              ? !0
              : !pT(this.state.dataUpdatedAt, l);
      }
      onFocus() {
        var u;
        const l = this.observers.find((r) => r.shouldFetchOnWindowFocus());
        (l == null || l.refetch({ cancelRefetch: !1 }), (u = V(this, ue)) == null || u.continue());
      }
      onOnline() {
        var u;
        const l = this.observers.find((r) => r.shouldFetchOnReconnect());
        (l == null || l.refetch({ cancelRefetch: !1 }), (u = V(this, ue)) == null || u.continue());
      }
      addObserver(l) {
        this.observers.includes(l) ||
          (this.observers.push(l),
          this.clearGcTimeout(),
          V(this, Ie).notify({ type: "observerAdded", query: this, observer: l }));
      }
      removeObserver(l) {
        this.observers.includes(l) &&
          ((this.observers = this.observers.filter((u) => u !== l)),
          this.observers.length ||
            (V(this, ue) &&
              (V(this, rl) || me(this, Ye, Sp).call(this)
                ? V(this, ue).cancel({ revert: !0 })
                : V(this, ue).cancelRetry()),
            this.scheduleGc()),
          V(this, Ie).notify({ type: "observerRemoved", query: this, observer: l }));
      }
      getObserversCount() {
        return this.observers.length;
      }
      invalidate() {
        this.state.isInvalidated || me(this, Ye, Hn).call(this, { type: "invalidate" });
      }
      async fetch(l, u) {
        var y, v, p, g, b, E, R, M, x, U, G, C;
        if (
          this.state.fetchStatus !== "idle" &&
          ((y = V(this, ue)) == null ? void 0 : y.status()) !== "rejected"
        ) {
          if (this.state.data !== void 0 && u != null && u.cancelRefetch)
            this.cancel({ silent: !0 });
          else if (V(this, ue)) return (V(this, ue).continueRetry(), V(this, ue).promise);
        }
        if ((l && this.setOptions(l), !this.options.queryFn)) {
          const z = this.observers.find((Y) => Y.options.queryFn);
          z && this.setOptions(z.options);
        }
        const r = new AbortController(),
          o = (z) => {
            Object.defineProperty(z, "signal", {
              enumerable: !0,
              get: () => (mt(this, rl, !0), r.signal),
            });
          },
          f = () => {
            const z = mp(this.options, u),
              I = (() => {
                const q = { client: V(this, ul), queryKey: this.queryKey, meta: this.meta };
                return (o(q), q);
              })();
            return (
              mt(this, rl, !1), this.options.persister ? this.options.persister(z, I, this) : z(I)
            );
          },
          m = (() => {
            const z = {
              fetchOptions: u,
              options: this.options,
              queryKey: this.queryKey,
              client: V(this, ul),
              state: this.state,
              fetchFn: f,
            };
            return (o(z), z);
          })();
        ((v = this.options.behavior) == null || v.onFetch(m, this),
          mt(this, ci, this.state),
          (this.state.fetchStatus === "idle" ||
            this.state.fetchMeta !== ((p = m.fetchOptions) == null ? void 0 : p.meta)) &&
            me(this, Ye, Hn).call(this, {
              type: "fetch",
              meta: (g = m.fetchOptions) == null ? void 0 : g.meta,
            }),
          mt(
            this,
            ue,
            gp({
              initialPromise: u == null ? void 0 : u.initialPromise,
              fn: m.fetchFn,
              onCancel: (z) => {
                (z instanceof Rf &&
                  z.revert &&
                  this.setState({ ...V(this, ci), fetchStatus: "idle" }),
                  r.abort());
              },
              onFail: (z, Y) => {
                me(this, Ye, Hn).call(this, { type: "failed", failureCount: z, error: Y });
              },
              onPause: () => {
                me(this, Ye, Hn).call(this, { type: "pause" });
              },
              onContinue: () => {
                me(this, Ye, Hn).call(this, { type: "continue" });
              },
              retry: m.options.retry,
              retryDelay: m.options.retryDelay,
              networkMode: m.options.networkMode,
              canRun: () => !0,
            }),
          ));
        try {
          const z = await V(this, ue).start();
          if (z === void 0) throw new Error(`${this.queryHash} data is undefined`);
          return (
            this.setData(z),
            (E = (b = V(this, Ie).config).onSuccess) == null || E.call(b, z, this),
            (M = (R = V(this, Ie).config).onSettled) == null ||
              M.call(R, z, this.state.error, this),
            z
          );
        } catch (z) {
          if (z instanceof Rf) {
            if (z.silent) return V(this, ue).promise;
            if (z.revert) {
              if (this.state.data === void 0) throw z;
              return this.state.data;
            }
          }
          throw (
            me(this, Ye, Hn).call(this, { type: "error", error: z }),
            (U = (x = V(this, Ie).config).onError) == null || U.call(x, z, this),
            (C = (G = V(this, Ie).config).onSettled) == null || C.call(G, this.state.data, z, this),
            z
          );
        } finally {
          this.scheduleGc();
        }
      }
    }),
    (il = new WeakMap()),
    (ci = new WeakMap()),
    (Ie = new WeakMap()),
    (ul = new WeakMap()),
    (ue = new WeakMap()),
    (Cu = new WeakMap()),
    (rl = new WeakMap()),
    (Ye = new WeakSet()),
    (Sp = function () {
      return this.state.fetchStatus === "paused" && this.state.status === "pending";
    }),
    (Hn = function (l) {
      const u = (r) => {
        switch (l.type) {
          case "failed":
            return { ...r, fetchFailureCount: l.failureCount, fetchFailureReason: l.error };
          case "pause":
            return { ...r, fetchStatus: "paused" };
          case "continue":
            return { ...r, fetchStatus: "fetching" };
          case "fetch":
            return { ...r, ...DT(r.data, this.options), fetchMeta: l.meta ?? null };
          case "success":
            const o = {
              ...r,
              ...qv(l.data, l.dataUpdatedAt),
              dataUpdateCount: r.dataUpdateCount + 1,
              ...(!l.manual && {
                fetchStatus: "idle",
                fetchFailureCount: 0,
                fetchFailureReason: null,
              }),
            };
            return (mt(this, ci, l.manual ? o : void 0), o);
          case "error":
            const f = l.error;
            return {
              ...r,
              error: f,
              errorUpdateCount: r.errorUpdateCount + 1,
              errorUpdatedAt: Date.now(),
              fetchFailureCount: r.fetchFailureCount + 1,
              fetchFailureReason: f,
              fetchStatus: "idle",
              status: "error",
              isInvalidated: !0,
            };
          case "invalidate":
            return { ...r, isInvalidated: !0 };
          case "setState":
            return { ...r, ...l.state };
        }
      };
      ((this.state = u(this.state)),
        be.batch(() => {
          (this.observers.forEach((r) => {
            r.onQueryUpdate();
          }),
            V(this, Ie).notify({ query: this, type: "updated", action: l }));
        }));
    }),
    kv);
function DT(n, l) {
  return {
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: vp(l.networkMode) ? "fetching" : "paused",
    ...(n === void 0 && { error: null, status: "pending" }),
  };
}
function qv(n, l) {
  return {
    data: n,
    dataUpdatedAt: l ?? Date.now(),
    error: null,
    isInvalidated: !1,
    status: "success",
  };
}
function Yv(n) {
  const l = typeof n.initialData == "function" ? n.initialData() : n.initialData,
    u = l !== void 0,
    r = u
      ? typeof n.initialDataUpdatedAt == "function"
        ? n.initialDataUpdatedAt()
        : n.initialDataUpdatedAt
      : 0;
  return {
    data: l,
    dataUpdateCount: 0,
    dataUpdatedAt: u ? (r ?? Date.now()) : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: !1,
    status: u ? "success" : "pending",
    fetchStatus: "idle",
  };
}
function Qv(n) {
  return {
    onFetch: (l, u) => {
      var p, g, b, E, R;
      const r = l.options,
        o =
          (b =
            (g = (p = l.fetchOptions) == null ? void 0 : p.meta) == null ? void 0 : g.fetchMore) ==
          null
            ? void 0
            : b.direction,
        f = ((E = l.state.data) == null ? void 0 : E.pages) || [],
        d = ((R = l.state.data) == null ? void 0 : R.pageParams) || [];
      let m = { pages: [], pageParams: [] },
        y = 0;
      const v = async () => {
        let M = !1;
        const x = (C) => {
            AT(
              C,
              () => l.signal,
              () => (M = !0),
            );
          },
          U = mp(l.options, l.fetchOptions),
          G = async (C, z, Y) => {
            if (M) return Promise.reject();
            if (z == null && C.pages.length) return Promise.resolve(C);
            const q = (() => {
                const W = {
                  client: l.client,
                  queryKey: l.queryKey,
                  pageParam: z,
                  direction: Y ? "backward" : "forward",
                  meta: l.options.meta,
                };
                return (x(W), W);
              })(),
              k = await U(q),
              { maxPages: J } = l.options,
              F = Y ? TT : RT;
            return { pages: F(C.pages, k, J), pageParams: F(C.pageParams, z, J) };
          };
        if (o && f.length) {
          const C = o === "backward",
            z = C ? UT : Gv,
            Y = { pages: f, pageParams: d },
            I = z(r, Y);
          m = await G(Y, I, C);
        } else {
          const C = n ?? f.length;
          do {
            const z = y === 0 ? (d[0] ?? r.initialPageParam) : Gv(r, m);
            if (y > 0 && z == null) break;
            ((m = await G(m, z)), y++);
          } while (y < C);
        }
        return m;
      };
      l.options.persister
        ? (l.fetchFn = () => {
            var M, x;
            return (x = (M = l.options).persister) == null
              ? void 0
              : x.call(
                  M,
                  v,
                  {
                    client: l.client,
                    queryKey: l.queryKey,
                    meta: l.options.meta,
                    signal: l.signal,
                  },
                  u,
                );
          })
        : (l.fetchFn = v);
    },
  };
}
function Gv(n, { pages: l, pageParams: u }) {
  const r = l.length - 1;
  return l.length > 0 ? n.getNextPageParam(l[r], l, u[r], u) : void 0;
}
function UT(n, { pages: l, pageParams: u }) {
  var r;
  return l.length > 0
    ? (r = n.getPreviousPageParam) == null
      ? void 0
      : r.call(n, l[0], l, u[0], u)
    : void 0;
}
var zu,
  dn,
  ge,
  sl,
  hn,
  ya,
  Iv,
  LT =
    ((Iv = class extends pp {
      constructor(l) {
        super();
        At(this, hn);
        At(this, zu);
        At(this, dn);
        At(this, ge);
        At(this, sl);
        (mt(this, zu, l.client),
          (this.mutationId = l.mutationId),
          mt(this, ge, l.mutationCache),
          mt(this, dn, []),
          (this.state = l.state || NT()),
          this.setOptions(l.options),
          this.scheduleGc());
      }
      setOptions(l) {
        ((this.options = l), this.updateGcTime(this.options.gcTime));
      }
      get meta() {
        return this.options.meta;
      }
      addObserver(l) {
        V(this, dn).includes(l) ||
          (V(this, dn).push(l),
          this.clearGcTimeout(),
          V(this, ge).notify({ type: "observerAdded", mutation: this, observer: l }));
      }
      removeObserver(l) {
        (mt(
          this,
          dn,
          V(this, dn).filter((u) => u !== l),
        ),
          this.scheduleGc(),
          V(this, ge).notify({ type: "observerRemoved", mutation: this, observer: l }));
      }
      optionalRemove() {
        V(this, dn).length ||
          (this.state.status === "pending" ? this.scheduleGc() : V(this, ge).remove(this));
      }
      continue() {
        var l;
        return (
          ((l = V(this, sl)) == null ? void 0 : l.continue()) ?? this.execute(this.state.variables)
        );
      }
      async execute(l) {
        var d, m, y, v, p, g, b, E, R, M, x, U, G, C, z, Y, I, q;
        const u = () => {
            me(this, hn, ya).call(this, { type: "continue" });
          },
          r = {
            client: V(this, zu),
            meta: this.options.meta,
            mutationKey: this.options.mutationKey,
          };
        mt(
          this,
          sl,
          gp({
            fn: () =>
              this.options.mutationFn
                ? this.options.mutationFn(l, r)
                : Promise.reject(new Error("No mutationFn found")),
            onFail: (k, J) => {
              me(this, hn, ya).call(this, { type: "failed", failureCount: k, error: J });
            },
            onPause: () => {
              me(this, hn, ya).call(this, { type: "pause" });
            },
            onContinue: u,
            retry: this.options.retry ?? 0,
            retryDelay: this.options.retryDelay,
            networkMode: this.options.networkMode,
            canRun: () => V(this, ge).canRun(this),
          }),
        );
        const o = this.state.status === "pending",
          f = !V(this, sl).canStart();
        try {
          if (o) u();
          else {
            (me(this, hn, ya).call(this, { type: "pending", variables: l, isPaused: f }),
              V(this, ge).config.onMutate && (await V(this, ge).config.onMutate(l, this, r)));
            const J = await ((m = (d = this.options).onMutate) == null ? void 0 : m.call(d, l, r));
            J !== this.state.context &&
              me(this, hn, ya).call(this, {
                type: "pending",
                context: J,
                variables: l,
                isPaused: f,
              });
          }
          const k = await V(this, sl).start();
          return (
            await ((v = (y = V(this, ge).config).onSuccess) == null
              ? void 0
              : v.call(y, k, l, this.state.context, this, r)),
            await ((g = (p = this.options).onSuccess) == null
              ? void 0
              : g.call(p, k, l, this.state.context, r)),
            await ((E = (b = V(this, ge).config).onSettled) == null
              ? void 0
              : E.call(b, k, null, this.state.variables, this.state.context, this, r)),
            await ((M = (R = this.options).onSettled) == null
              ? void 0
              : M.call(R, k, null, l, this.state.context, r)),
            me(this, hn, ya).call(this, { type: "success", data: k }),
            k
          );
        } catch (k) {
          try {
            await ((U = (x = V(this, ge).config).onError) == null
              ? void 0
              : U.call(x, k, l, this.state.context, this, r));
          } catch (J) {
            Promise.reject(J);
          }
          try {
            await ((C = (G = this.options).onError) == null
              ? void 0
              : C.call(G, k, l, this.state.context, r));
          } catch (J) {
            Promise.reject(J);
          }
          try {
            await ((Y = (z = V(this, ge).config).onSettled) == null
              ? void 0
              : Y.call(z, void 0, k, this.state.variables, this.state.context, this, r));
          } catch (J) {
            Promise.reject(J);
          }
          try {
            await ((q = (I = this.options).onSettled) == null
              ? void 0
              : q.call(I, void 0, k, l, this.state.context, r));
          } catch (J) {
            Promise.reject(J);
          }
          throw (me(this, hn, ya).call(this, { type: "error", error: k }), k);
        } finally {
          V(this, ge).runNext(this);
        }
      }
    }),
    (zu = new WeakMap()),
    (dn = new WeakMap()),
    (ge = new WeakMap()),
    (sl = new WeakMap()),
    (hn = new WeakSet()),
    (ya = function (l) {
      const u = (r) => {
        switch (l.type) {
          case "failed":
            return { ...r, failureCount: l.failureCount, failureReason: l.error };
          case "pause":
            return { ...r, isPaused: !0 };
          case "continue":
            return { ...r, isPaused: !1 };
          case "pending":
            return {
              ...r,
              context: l.context,
              data: void 0,
              failureCount: 0,
              failureReason: null,
              error: null,
              isPaused: l.isPaused,
              status: "pending",
              variables: l.variables,
              submittedAt: Date.now(),
            };
          case "success":
            return {
              ...r,
              data: l.data,
              failureCount: 0,
              failureReason: null,
              error: null,
              status: "success",
              isPaused: !1,
            };
          case "error":
            return {
              ...r,
              data: void 0,
              error: l.error,
              failureCount: r.failureCount + 1,
              failureReason: l.error,
              isPaused: !1,
              status: "error",
            };
        }
      };
      ((this.state = u(this.state)),
        be.batch(() => {
          (V(this, dn).forEach((r) => {
            r.onMutationUpdate(l);
          }),
            V(this, ge).notify({ mutation: this, type: "updated", action: l }));
        }));
    }),
    Iv);
function NT() {
  return {
    context: void 0,
    data: void 0,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: !1,
    status: "idle",
    variables: void 0,
    submittedAt: 0,
  };
}
var qn,
  an,
  Du,
  $v,
  jT =
    (($v = class extends ws {
      constructor(l = {}) {
        super();
        At(this, qn);
        At(this, an);
        At(this, Du);
        ((this.config = l), mt(this, qn, new Set()), mt(this, an, new Map()), mt(this, Du, 0));
      }
      build(l, u, r) {
        const o = new LT({
          client: l,
          mutationCache: this,
          mutationId: ++ns(this, Du)._,
          options: l.defaultMutationOptions(u),
          state: r,
        });
        return (this.add(o), o);
      }
      add(l) {
        V(this, qn).add(l);
        const u = us(l);
        if (typeof u == "string") {
          const r = V(this, an).get(u);
          r ? r.push(l) : V(this, an).set(u, [l]);
        }
        this.notify({ type: "added", mutation: l });
      }
      remove(l) {
        if (V(this, qn).delete(l)) {
          const u = us(l);
          if (typeof u == "string") {
            const r = V(this, an).get(u);
            if (r)
              if (r.length > 1) {
                const o = r.indexOf(l);
                o !== -1 && r.splice(o, 1);
              } else r[0] === l && V(this, an).delete(u);
          }
        }
        this.notify({ type: "removed", mutation: l });
      }
      canRun(l) {
        const u = us(l);
        if (typeof u == "string") {
          const r = V(this, an).get(u),
            o = r == null ? void 0 : r.find((f) => f.state.status === "pending");
          return !o || o === l;
        } else return !0;
      }
      runNext(l) {
        var r;
        const u = us(l);
        if (typeof u == "string") {
          const o =
            (r = V(this, an).get(u)) == null ? void 0 : r.find((f) => f !== l && f.state.isPaused);
          return (o == null ? void 0 : o.continue()) ?? Promise.resolve();
        } else return Promise.resolve();
      }
      clear() {
        be.batch(() => {
          (V(this, qn).forEach((l) => {
            this.notify({ type: "removed", mutation: l });
          }),
            V(this, qn).clear(),
            V(this, an).clear());
        });
      }
      getAll() {
        return Array.from(V(this, qn));
      }
      find(l) {
        const u = { exact: !0, ...l };
        return this.getAll().find((r) => jv(u, r));
      }
      findAll(l = {}) {
        return this.getAll().filter((u) => jv(l, u));
      }
      notify(l) {
        be.batch(() => {
          this.listeners.forEach((u) => {
            u(l);
          });
        });
      }
      resumePausedMutations() {
        const l = this.getAll().filter((u) => u.state.isPaused);
        return be.batch(() => Promise.all(l.map((u) => u.continue().catch(nn))));
      }
    }),
    (qn = new WeakMap()),
    (an = new WeakMap()),
    (Du = new WeakMap()),
    $v);
function us(n) {
  var l;
  return (l = n.options.scope) == null ? void 0 : l.id;
}
var mn,
  Wv,
  BT =
    ((Wv = class extends ws {
      constructor(l = {}) {
        super();
        At(this, mn);
        ((this.config = l), mt(this, mn, new Map()));
      }
      build(l, u, r) {
        const o = u.queryKey,
          f = u.queryHash ?? Hf(o, u);
        let d = this.get(f);
        return (
          d ||
            ((d = new zT({
              client: l,
              queryKey: o,
              queryHash: f,
              options: l.defaultQueryOptions(u),
              state: r,
              defaultOptions: l.getQueryDefaults(o),
            })),
            this.add(d)),
          d
        );
      }
      add(l) {
        V(this, mn).has(l.queryHash) ||
          (V(this, mn).set(l.queryHash, l), this.notify({ type: "added", query: l }));
      }
      remove(l) {
        const u = V(this, mn).get(l.queryHash);
        u &&
          (l.destroy(),
          u === l && V(this, mn).delete(l.queryHash),
          this.notify({ type: "removed", query: l }));
      }
      clear() {
        be.batch(() => {
          this.getAll().forEach((l) => {
            this.remove(l);
          });
        });
      }
      get(l) {
        return V(this, mn).get(l);
      }
      getAll() {
        return [...V(this, mn).values()];
      }
      find(l) {
        const u = { exact: !0, ...l };
        return this.getAll().find((r) => Nv(u, r));
      }
      findAll(l = {}) {
        const u = this.getAll();
        return Object.keys(l).length > 0 ? u.filter((r) => Nv(l, r)) : u;
      }
      notify(l) {
        be.batch(() => {
          this.listeners.forEach((u) => {
            u(l);
          });
        });
      }
      onFocus() {
        be.batch(() => {
          this.getAll().forEach((l) => {
            l.onFocus();
          });
        });
      }
      onOnline() {
        be.batch(() => {
          this.getAll().forEach((l) => {
            l.onOnline();
          });
        });
      }
    }),
    (mn = new WeakMap()),
    Wv),
  Pt,
  _a,
  Ea,
  oi,
  fi,
  Ra,
  di,
  hi,
  tg,
  HT =
    ((tg = class {
      constructor(n = {}) {
        At(this, Pt);
        At(this, _a);
        At(this, Ea);
        At(this, oi);
        At(this, fi);
        At(this, Ra);
        At(this, di);
        At(this, hi);
        (mt(this, Pt, n.queryCache || new BT()),
          mt(this, _a, n.mutationCache || new jT()),
          mt(this, Ea, n.defaultOptions || {}),
          mt(this, oi, new Map()),
          mt(this, fi, new Map()),
          mt(this, Ra, 0));
      }
      mount() {
        (ns(this, Ra)._++,
          V(this, Ra) === 1 &&
            (mt(
              this,
              di,
              dp.subscribe(async (n) => {
                n && (await this.resumePausedMutations(), V(this, Pt).onFocus());
              }),
            ),
            mt(
              this,
              hi,
              Ss.subscribe(async (n) => {
                n && (await this.resumePausedMutations(), V(this, Pt).onOnline());
              }),
            )));
      }
      unmount() {
        var n, l;
        (ns(this, Ra)._--,
          V(this, Ra) === 0 &&
            ((n = V(this, di)) == null || n.call(this),
            mt(this, di, void 0),
            (l = V(this, hi)) == null || l.call(this),
            mt(this, hi, void 0)));
      }
      isFetching(n) {
        return V(this, Pt).findAll({ ...n, fetchStatus: "fetching" }).length;
      }
      isMutating(n) {
        return V(this, _a).findAll({ ...n, status: "pending" }).length;
      }
      getQueryData(n) {
        var u;
        const l = this.defaultQueryOptions({ queryKey: n });
        return (u = V(this, Pt).get(l.queryHash)) == null ? void 0 : u.state.data;
      }
      ensureQueryData(n) {
        const l = this.defaultQueryOptions(n),
          u = V(this, Pt).build(this, l),
          r = u.state.data;
        return r === void 0
          ? this.fetchQuery(n)
          : (n.revalidateIfStale && u.isStaleByTime(_f(l.staleTime, u)) && this.prefetchQuery(l),
            Promise.resolve(r));
      }
      getQueriesData(n) {
        return V(this, Pt)
          .findAll(n)
          .map(({ queryKey: l, state: u }) => {
            const r = u.data;
            return [l, r];
          });
      }
      setQueryData(n, l, u) {
        const r = this.defaultQueryOptions({ queryKey: n }),
          o = V(this, Pt).get(r.queryHash),
          f = o == null ? void 0 : o.state.data,
          d = vT(l, f);
        if (d !== void 0)
          return V(this, Pt)
            .build(this, r)
            .setData(d, { ...u, manual: !0 });
      }
      setQueriesData(n, l, u) {
        return be.batch(() =>
          V(this, Pt)
            .findAll(n)
            .map(({ queryKey: r }) => [r, this.setQueryData(r, l, u)]),
        );
      }
      getQueryState(n) {
        var u;
        const l = this.defaultQueryOptions({ queryKey: n });
        return (u = V(this, Pt).get(l.queryHash)) == null ? void 0 : u.state;
      }
      removeQueries(n) {
        const l = V(this, Pt);
        be.batch(() => {
          l.findAll(n).forEach((u) => {
            l.remove(u);
          });
        });
      }
      resetQueries(n, l) {
        const u = V(this, Pt);
        return be.batch(
          () => (
            u.findAll(n).forEach((r) => {
              r.reset();
            }),
            this.refetchQueries({ type: "active", ...n }, l)
          ),
        );
      }
      cancelQueries(n, l = {}) {
        const u = { revert: !0, ...l },
          r = be.batch(() =>
            V(this, Pt)
              .findAll(n)
              .map((o) => o.cancel(u)),
          );
        return Promise.all(r).then(nn).catch(nn);
      }
      invalidateQueries(n, l = {}) {
        return be.batch(
          () => (
            V(this, Pt)
              .findAll(n)
              .forEach((u) => {
                u.invalidate();
              }),
            (n == null ? void 0 : n.refetchType) === "none"
              ? Promise.resolve()
              : this.refetchQueries(
                  {
                    ...n,
                    type:
                      (n == null ? void 0 : n.refetchType) ??
                      (n == null ? void 0 : n.type) ??
                      "active",
                  },
                  l,
                )
          ),
        );
      }
      refetchQueries(n, l = {}) {
        const u = { ...l, cancelRefetch: l.cancelRefetch ?? !0 },
          r = be.batch(() =>
            V(this, Pt)
              .findAll(n)
              .filter((o) => !o.isDisabled() && !o.isStatic())
              .map((o) => {
                let f = o.fetch(void 0, u);
                return (
                  u.throwOnError || (f = f.catch(nn)),
                  o.state.fetchStatus === "paused" ? Promise.resolve() : f
                );
              }),
          );
        return Promise.all(r).then(nn);
      }
      fetchQuery(n) {
        const l = this.defaultQueryOptions(n);
        l.retry === void 0 && (l.retry = !1);
        const u = V(this, Pt).build(this, l);
        return u.isStaleByTime(_f(l.staleTime, u)) ? u.fetch(l) : Promise.resolve(u.state.data);
      }
      prefetchQuery(n) {
        return this.fetchQuery(n).then(nn).catch(nn);
      }
      fetchInfiniteQuery(n) {
        return ((n.behavior = Qv(n.pages)), this.fetchQuery(n));
      }
      prefetchInfiniteQuery(n) {
        return this.fetchInfiniteQuery(n).then(nn).catch(nn);
      }
      ensureInfiniteQueryData(n) {
        return ((n.behavior = Qv(n.pages)), this.ensureQueryData(n));
      }
      resumePausedMutations() {
        return Ss.isOnline() ? V(this, _a).resumePausedMutations() : Promise.resolve();
      }
      getQueryCache() {
        return V(this, Pt);
      }
      getMutationCache() {
        return V(this, _a);
      }
      getDefaultOptions() {
        return V(this, Ea);
      }
      setDefaultOptions(n) {
        mt(this, Ea, n);
      }
      setQueryDefaults(n, l) {
        V(this, oi).set(wu(n), { queryKey: n, defaultOptions: l });
      }
      getQueryDefaults(n) {
        const l = [...V(this, oi).values()],
          u = {};
        return (
          l.forEach((r) => {
            Ou(n, r.queryKey) && Object.assign(u, r.defaultOptions);
          }),
          u
        );
      }
      setMutationDefaults(n, l) {
        V(this, fi).set(wu(n), { mutationKey: n, defaultOptions: l });
      }
      getMutationDefaults(n) {
        const l = [...V(this, fi).values()],
          u = {};
        return (
          l.forEach((r) => {
            Ou(n, r.mutationKey) && Object.assign(u, r.defaultOptions);
          }),
          u
        );
      }
      defaultQueryOptions(n) {
        if (n._defaulted) return n;
        const l = {
          ...V(this, Ea).queries,
          ...this.getQueryDefaults(n.queryKey),
          ...n,
          _defaulted: !0,
        };
        return (
          l.queryHash || (l.queryHash = Hf(l.queryKey, l)),
          l.refetchOnReconnect === void 0 && (l.refetchOnReconnect = l.networkMode !== "always"),
          l.throwOnError === void 0 && (l.throwOnError = !!l.suspense),
          !l.networkMode && l.persister && (l.networkMode = "offlineFirst"),
          l.queryFn === qf && (l.enabled = !1),
          l
        );
      }
      defaultMutationOptions(n) {
        return n != null && n._defaulted
          ? n
          : {
              ...V(this, Ea).mutations,
              ...((n == null ? void 0 : n.mutationKey) && this.getMutationDefaults(n.mutationKey)),
              ...n,
              _defaulted: !0,
            };
      }
      clear() {
        (V(this, Pt).clear(), V(this, _a).clear());
      }
    }),
    (Pt = new WeakMap()),
    (_a = new WeakMap()),
    (Ea = new WeakMap()),
    (oi = new WeakMap()),
    (fi = new WeakMap()),
    (Ra = new WeakMap()),
    (di = new WeakMap()),
    (hi = new WeakMap()),
    tg),
  bp = st.createContext(void 0),
  T2 = (n) => {
    const l = st.useContext(bp);
    if (!l) throw new Error("No QueryClient set, use QueryClientProvider to set one");
    return l;
  },
  qT = ({ client: n, children: l }) => (
    st.useEffect(
      () => (
        n.mount(),
        () => {
          n.unmount();
        }
      ),
      [n],
    ),
    $.jsx(bp.Provider, { value: n, children: l })
  );
const YT = new HT(),
  yi = VR({
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "TanStack Start in a Durable Facet" },
      ],
    }),
    component: QT,
  });
function QT() {
  return $.jsx(qT, { client: YT, children: $.jsx(GT, { children: $.jsx(op, {}) }) });
}
function GT({ children: n }) {
  return $.jsxs("html", {
    lang: "en",
    children: [
      $.jsxs("head", {
        children: [
          $.jsx(sT, {}),
          $.jsx("style", {
            dangerouslySetInnerHTML: {
              __html: `
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; }
          nav { padding: 1rem; border-bottom: 1px solid #222; display: flex; gap: 1rem; align-items: center; }
          nav a { color: #60a5fa; text-decoration: none; }
          nav a:hover { text-decoration: underline; }
          nav a[data-status="active"] { color: #f59e0b; font-weight: bold; }
          main { padding: 2rem; max-width: 600px; margin: 0 auto; }
          h1 { font-size: 1.5rem; margin-bottom: 1rem; }
          p { line-height: 1.6; color: #aaa; margin-bottom: 1rem; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; background: #166534; color: #4ade80; }
          button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
          button:hover { border-color: #555; }
          .counter { font-size: 3rem; font-weight: bold; color: #f59e0b; font-family: monospace; text-align: center; margin: 1rem 0; }
          input[type="text"] { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.9rem; outline: none; }
          input[type="text"]:focus { border-color: #60a5fa; }
          .thing-item { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; }
          .thing-item:hover { border-color: #444; }
          .btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
          .btn-danger:hover { background: #991b1b; border-color: #b91c1c; }
          .btn-primary { background: #1e3a5f; border-color: #2563eb; color: #93c5fd; }
          .btn-primary:hover { background: #1e40af; border-color: #3b82f6; }
          .error-box { background: #450a0a; border: 1px solid #7f1d1d; border-radius: 8px; padding: 0.75rem 1rem; color: #fca5a5; font-size: 0.85rem; }
          .empty-state { text-align: center; padding: 2rem; color: #555; font-style: italic; }
        `,
            },
          }),
        ],
      }),
      $.jsxs("body", {
        children: [
          $.jsxs("nav", {
            children: [
              $.jsx("span", {
                style: { fontWeight: "bold", color: "#fff" },
                children: "Facet App",
              }),
              $.jsx($a, { to: "/", children: "Home" }),
              $.jsx($a, { to: "/about", children: "About" }),
              $.jsx($a, { to: "/counter", children: "Counter" }),
              $.jsx($a, { to: "/server-fns", children: "Server Fns" }),
              $.jsx($a, { to: "/things", children: "Things" }),
              $.jsx("span", { className: "badge", children: "DO Facet" }),
            ],
          }),
          n,
          $.jsx(cT, {}),
        ],
      }),
    ],
  });
}
const VT = "modulepreload",
  XT = function (n) {
    return "/" + n;
  },
  Vv = {},
  Bu = function (l, u, r) {
    let o = Promise.resolve();
    if (u && u.length > 0) {
      let d = function (v) {
        return Promise.all(
          v.map((p) =>
            Promise.resolve(p).then(
              (g) => ({ status: "fulfilled", value: g }),
              (g) => ({ status: "rejected", reason: g }),
            ),
          ),
        );
      };
      document.getElementsByTagName("link");
      const m = document.querySelector("meta[property=csp-nonce]"),
        y = (m == null ? void 0 : m.nonce) || (m == null ? void 0 : m.getAttribute("nonce"));
      o = d(
        u.map((v) => {
          if (((v = XT(v)), v in Vv)) return;
          Vv[v] = !0;
          const p = v.endsWith(".css"),
            g = p ? '[rel="stylesheet"]' : "";
          if (document.querySelector(`link[href="${v}"]${g}`)) return;
          const b = document.createElement("link");
          if (
            ((b.rel = p ? "stylesheet" : VT),
            p || (b.as = "script"),
            (b.crossOrigin = ""),
            (b.href = v),
            y && b.setAttribute("nonce", y),
            document.head.appendChild(b),
            p)
          )
            return new Promise((E, R) => {
              (b.addEventListener("load", E),
                b.addEventListener("error", () => R(new Error(`Unable to preload CSS for ${v}`))));
            });
        }),
      );
    }
    function f(d) {
      const m = new Event("vite:preloadError", { cancelable: !0 });
      if (((m.payload = d), window.dispatchEvent(m), !m.defaultPrevented)) throw d;
    }
    return o.then((d) => {
      for (const m of d || []) m.status === "rejected" && f(m.reason);
      return l().catch(f);
    });
  },
  ZT = () => Bu(() => import("./things-dIUMGWuJ.js"), []),
  KT = Nu("/things")({ component: ju(ZT, "component") }),
  PT = () => Bu(() => import("./server-fns-GJPD0IyO.js"), []),
  JT = Nu("/server-fns")({ component: ju(PT, "component") });
function Xv(n) {
  return n !== "__proto__" && n !== "constructor" && n !== "prototype";
}
function Tf(n, l) {
  const u = Object.create(null);
  if (n) for (const r of Object.keys(n)) Xv(r) && (u[r] = n[r]);
  if (l && typeof l == "object") for (const r of Object.keys(l)) Xv(r) && (u[r] = l[r]);
  return u;
}
function _p(n) {
  return Object.create(null);
}
var Ep = () => {
    throw new Error("createServerOnlyFn() functions can only be called on the server!");
  },
  _u = (n, l) => {
    const u = l || n || {};
    return (
      typeof u.method > "u" && (u.method = "GET"),
      Object.assign((f) => _u(void 0, { ...u, ...f }), {
        options: u,
        middleware: (f) => {
          const d = [...(u.middleware || [])];
          f.map((y) => {
            Jy in y ? y.options.middleware && d.push(...y.options.middleware) : d.push(y);
          });
          const m = _u(void 0, { ...u, middleware: d });
          return ((m[Jy] = !0), m);
        },
        inputValidator: (f) => _u(void 0, { ...u, inputValidator: f }),
        handler: (...f) => {
          const [d, m] = f,
            y = { ...u, extractedFn: d, serverFn: m },
            v = [...(y.middleware || []), IT(y)];
          return (
            (d.method = u.method),
            Object.assign(
              async (p) => {
                const g = await Zv(v, "client", {
                    ...d,
                    ...y,
                    data: p == null ? void 0 : p.data,
                    headers: p == null ? void 0 : p.headers,
                    signal: p == null ? void 0 : p.signal,
                    fetch: p == null ? void 0 : p.fetch,
                    context: _p(),
                  }),
                  b = cg(g.error);
                if (b) throw b;
                if (g.error) throw g.error;
                return g.result;
              },
              {
                ...d,
                method: u.method,
                __executeServer: async (p) => {
                  const g = Ep(),
                    b = g.contextAfterGlobalMiddlewares;
                  return await Zv(v, "server", {
                    ...d,
                    ...p,
                    serverFnMeta: d.serverFnMeta,
                    context: Tf(p.context, b),
                    request: g.request,
                  }).then((E) => ({ result: E.result, error: E.error, context: E.sendContext }));
                },
              },
            )
          );
        },
      })
    );
  };
async function Zv(n, l, u) {
  var f;
  let r = FT([...(((f = xf()) == null ? void 0 : f.functionMiddleware) || []), ...n]);
  if (l === "server") {
    const d = Ep();
    d != null &&
      d.executedRequestMiddlewares &&
      (r = r.filter((m) => !d.executedRequestMiddlewares.has(m)));
  }
  const o = async (d) => {
    const m = r.shift();
    if (!m) return d;
    try {
      "inputValidator" in m.options &&
        m.options.inputValidator &&
        l === "server" &&
        (d.data = await kT(m.options.inputValidator, d.data));
      let y;
      if (
        (l === "client"
          ? "client" in m.options && (y = m.options.client)
          : "server" in m.options && (y = m.options.server),
        y)
      ) {
        const p = await y({
          ...d,
          next: async (g = {}) => {
            const b = await o({
              ...d,
              ...g,
              context: Tf(d.context, g.context),
              sendContext: Tf(d.sendContext, g.sendContext),
              headers: uR(d.headers, g.headers),
              _callSiteFetch: d._callSiteFetch,
              fetch: d._callSiteFetch ?? g.fetch ?? d.fetch,
              result: g.result !== void 0 ? g.result : g instanceof Response ? g : d.result,
              error: g.error ?? d.error,
            });
            if (b.error) throw b.error;
            return b;
          },
        });
        if (_e(p)) return { ...d, error: p };
        if (p instanceof Response) return { ...d, result: p };
        if (!p)
          throw new Error(
            "User middleware returned undefined. You must call next() or return a result in your middlewares.",
          );
        return p;
      }
      return o(d);
    } catch (y) {
      return { ...d, error: y };
    }
  };
  return o({
    ...u,
    headers: u.headers || {},
    sendContext: u.sendContext || {},
    context: u.context || _p(),
    _callSiteFetch: u.fetch,
  });
}
function FT(n, l = 100) {
  const u = new Set(),
    r = [],
    o = (f, d) => {
      if (d > l)
        throw new Error(
          `Middleware nesting depth exceeded maximum of ${l}. Check for circular references.`,
        );
      f.forEach((m) => {
        (m.options.middleware && o(m.options.middleware, d + 1), u.has(m) || (u.add(m), r.push(m)));
      });
    };
  return (o(n, 0), r);
}
async function kT(n, l) {
  if (n == null) return {};
  if ("~standard" in n) {
    const u = await n["~standard"].validate(l);
    if (u.issues) throw new Error(JSON.stringify(u.issues, void 0, 2));
    return u.value;
  }
  if ("parse" in n) return n.parse(l);
  if (typeof n == "function") return n(l);
  throw new Error("Invalid validator type!");
}
function IT(n) {
  return {
    "~types": void 0,
    options: {
      inputValidator: n.inputValidator,
      client: async ({ next: l, sendContext: u, fetch: r, ...o }) => {
        var d;
        const f = { ...o, context: u, fetch: r };
        return l(await ((d = n.extractedFn) == null ? void 0 : d.call(n, f)));
      },
      server: async ({ next: l, ...u }) => {
        var o;
        const r = await ((o = n.serverFn) == null ? void 0 : o.call(n, u));
        return l({ ...u, result: r });
      },
    },
  };
}
const $T = () => Bu(() => import("./counter-QpSH90mP.js"), []),
  WT = _u({ method: "GET" }).handler(
    Lf("380e4f27c86b2e828107a0454e2715b4169bf11b02de11d0dc9ad75de7d85a7e"),
  ),
  t2 = Nu("/counter")({ loader: async () => WT(), component: ju($T, "component") }),
  e2 = () => Bu(() => import("./about-CdFz6A7h.js"), []),
  n2 = Nu("/about")({ component: ju(e2, "component") }),
  a2 = () => Bu(() => import("./index-vdVMHcFY.js"), []),
  l2 = _u({ method: "GET" }).handler(
    Lf("bcc06e110064ff306a20f0e07346328125999211fd273f8af0a4f8e5fe43cba5"),
  ),
  i2 = Nu("/")({ loader: async () => l2(), component: ju(a2, "component") }),
  u2 = KT.update({ id: "/things", path: "/things", getParentRoute: () => yi }),
  r2 = JT.update({ id: "/server-fns", path: "/server-fns", getParentRoute: () => yi }),
  s2 = t2.update({ id: "/counter", path: "/counter", getParentRoute: () => yi }),
  c2 = n2.update({ id: "/about", path: "/about", getParentRoute: () => yi }),
  o2 = i2.update({ id: "/", path: "/", getParentRoute: () => yi }),
  f2 = { IndexRoute: o2, AboutRoute: c2, CounterRoute: s2, ServerFnsRoute: r2, ThingsRoute: u2 },
  d2 = yi._addFileChildren(f2);
function h2() {
  return eT({ routeTree: d2, scrollRestoration: !0 });
}
async function m2() {
  const n = await h2();
  let l;
  return (
    (l = []),
    (window.__TSS_START_OPTIONS__ = { serializationAdapters: l }),
    l.push(lR),
    n.options.serializationAdapters && l.push(...n.options.serializationAdapters),
    n.update({ basepath: "", serializationAdapters: l }),
    n.stores.matchesId.get().length || (await sR(n)),
    n
  );
}
async function y2() {
  var l;
  const n = await m2();
  return ((l = window.$_TSR) == null || l.h(), n);
}
var ff;
function v2() {
  return (ff || (ff = y2()), $.jsx(dR, { promise: ff, children: (n) => $.jsx(lT, { router: n }) }));
}
st.startTransition(() => {
  IS.hydrateRoot(document, $.jsx(st.StrictMode, { children: $.jsx(v2, {}) }));
});
export {
  t2 as R,
  ws as S,
  _f as a,
  bf as b,
  DT as c,
  ET as d,
  yp as e,
  dp as f,
  be as g,
  wu as h,
  gT as i,
  NT as j,
  st as k,
  R2 as l,
  $ as m,
  nn as n,
  _u as o,
  xT as p,
  Lf as q,
  ST as r,
  E2 as s,
  pT as t,
  T2 as u,
  i2 as v,
};
