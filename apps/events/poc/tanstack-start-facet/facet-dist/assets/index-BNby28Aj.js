const __vite__mapDeps = (
  i,
  m = __vite__mapDeps,
  d = m.f ||
    (m.f = [
      "assets/things-BkvK_53i.js",
      "assets/jsx-runtime-ByY1xr43.js",
      "assets/fetch-CaJINV1a.js",
      "assets/terminal-tpukXwcz.js",
      "assets/stream-h1H4kUpO.js",
      "assets/routes-ESX7X8jG.js",
    ]),
) => i.map((i) => d[i]);
import { i as e, n as t, r as n, t as r } from "./jsx-runtime-ByY1xr43.js";
var i = n((e) => {
    function t(e, t) {
      var n = e.length;
      e.push(t);
      a: for (; 0 < n; ) {
        var r = (n - 1) >>> 1,
          a = e[r];
        if (0 < i(a, t)) ((e[r] = t), (e[n] = a), (n = r));
        else break a;
      }
    }
    function n(e) {
      return e.length === 0 ? null : e[0];
    }
    function r(e) {
      if (e.length === 0) return null;
      var t = e[0],
        n = e.pop();
      if (n !== t) {
        e[0] = n;
        a: for (var r = 0, a = e.length, o = a >>> 1; r < o; ) {
          var s = 2 * (r + 1) - 1,
            c = e[s],
            l = s + 1,
            u = e[l];
          if (0 > i(c, n))
            l < a && 0 > i(u, c)
              ? ((e[r] = u), (e[l] = n), (r = l))
              : ((e[r] = c), (e[s] = n), (r = s));
          else if (l < a && 0 > i(u, n)) ((e[r] = u), (e[l] = n), (r = l));
          else break a;
        }
      }
      return t;
    }
    function i(e, t) {
      var n = e.sortIndex - t.sortIndex;
      return n === 0 ? e.id - t.id : n;
    }
    if (
      ((e.unstable_now = void 0),
      typeof performance == `object` && typeof performance.now == `function`)
    ) {
      var a = performance;
      e.unstable_now = function () {
        return a.now();
      };
    } else {
      var o = Date,
        s = o.now();
      e.unstable_now = function () {
        return o.now() - s;
      };
    }
    var c = [],
      l = [],
      u = 1,
      d = null,
      f = 3,
      p = !1,
      m = !1,
      h = !1,
      g = !1,
      _ = typeof setTimeout == `function` ? setTimeout : null,
      v = typeof clearTimeout == `function` ? clearTimeout : null,
      y = typeof setImmediate < `u` ? setImmediate : null;
    function b(e) {
      for (var i = n(l); i !== null; ) {
        if (i.callback === null) r(l);
        else if (i.startTime <= e) (r(l), (i.sortIndex = i.expirationTime), t(c, i));
        else break;
        i = n(l);
      }
    }
    function x(e) {
      if (((h = !1), b(e), !m))
        if (n(c) !== null) ((m = !0), S || ((S = !0), ie()));
        else {
          var t = n(l);
          t !== null && se(x, t.startTime - e);
        }
    }
    var S = !1,
      C = -1,
      ee = 5,
      te = -1;
    function ne() {
      return g ? !0 : !(e.unstable_now() - te < ee);
    }
    function re() {
      if (((g = !1), S)) {
        var t = e.unstable_now();
        te = t;
        var i = !0;
        try {
          a: {
            ((m = !1), h && ((h = !1), v(C), (C = -1)), (p = !0));
            var a = f;
            try {
              b: {
                for (b(t), d = n(c); d !== null && !(d.expirationTime > t && ne()); ) {
                  var o = d.callback;
                  if (typeof o == `function`) {
                    ((d.callback = null), (f = d.priorityLevel));
                    var s = o(d.expirationTime <= t);
                    if (((t = e.unstable_now()), typeof s == `function`)) {
                      ((d.callback = s), b(t), (i = !0));
                      break b;
                    }
                    (d === n(c) && r(c), b(t));
                  } else r(c);
                  d = n(c);
                }
                if (d !== null) i = !0;
                else {
                  var u = n(l);
                  (u !== null && se(x, u.startTime - t), (i = !1));
                }
              }
              break a;
            } finally {
              ((d = null), (f = a), (p = !1));
            }
            i = void 0;
          }
        } finally {
          i ? ie() : (S = !1);
        }
      }
    }
    var ie;
    if (typeof y == `function`)
      ie = function () {
        y(re);
      };
    else if (typeof MessageChannel < `u`) {
      var ae = new MessageChannel(),
        oe = ae.port2;
      ((ae.port1.onmessage = re),
        (ie = function () {
          oe.postMessage(null);
        }));
    } else
      ie = function () {
        _(re, 0);
      };
    function se(t, n) {
      C = _(function () {
        t(e.unstable_now());
      }, n);
    }
    ((e.unstable_IdlePriority = 5),
      (e.unstable_ImmediatePriority = 1),
      (e.unstable_LowPriority = 4),
      (e.unstable_NormalPriority = 3),
      (e.unstable_Profiling = null),
      (e.unstable_UserBlockingPriority = 2),
      (e.unstable_cancelCallback = function (e) {
        e.callback = null;
      }),
      (e.unstable_forceFrameRate = function (e) {
        0 > e || 125 < e
          ? console.error(
              `forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported`,
            )
          : (ee = 0 < e ? Math.floor(1e3 / e) : 5);
      }),
      (e.unstable_getCurrentPriorityLevel = function () {
        return f;
      }),
      (e.unstable_next = function (e) {
        switch (f) {
          case 1:
          case 2:
          case 3:
            var t = 3;
            break;
          default:
            t = f;
        }
        var n = f;
        f = t;
        try {
          return e();
        } finally {
          f = n;
        }
      }),
      (e.unstable_requestPaint = function () {
        g = !0;
      }),
      (e.unstable_runWithPriority = function (e, t) {
        switch (e) {
          case 1:
          case 2:
          case 3:
          case 4:
          case 5:
            break;
          default:
            e = 3;
        }
        var n = f;
        f = e;
        try {
          return t();
        } finally {
          f = n;
        }
      }),
      (e.unstable_scheduleCallback = function (r, i, a) {
        var o = e.unstable_now();
        switch (
          (typeof a == `object` && a
            ? ((a = a.delay), (a = typeof a == `number` && 0 < a ? o + a : o))
            : (a = o),
          r)
        ) {
          case 1:
            var s = -1;
            break;
          case 2:
            s = 250;
            break;
          case 5:
            s = 1073741823;
            break;
          case 4:
            s = 1e4;
            break;
          default:
            s = 5e3;
        }
        return (
          (s = a + s),
          (r = {
            id: u++,
            callback: i,
            priorityLevel: r,
            startTime: a,
            expirationTime: s,
            sortIndex: -1,
          }),
          a > o
            ? ((r.sortIndex = a),
              t(l, r),
              n(c) === null && r === n(l) && (h ? (v(C), (C = -1)) : (h = !0), se(x, a - o)))
            : ((r.sortIndex = s), t(c, r), m || p || ((m = !0), S || ((S = !0), ie()))),
          r
        );
      }),
      (e.unstable_shouldYield = ne),
      (e.unstable_wrapCallback = function (e) {
        var t = f;
        return function () {
          var n = f;
          f = t;
          try {
            return e.apply(this, arguments);
          } finally {
            f = n;
          }
        };
      }));
  }),
  a = n((e, t) => {
    t.exports = i();
  }),
  o = n((e) => {
    var n = t();
    function r(e) {
      var t = `https://react.dev/errors/` + e;
      if (1 < arguments.length) {
        t += `?args[]=` + encodeURIComponent(arguments[1]);
        for (var n = 2; n < arguments.length; n++)
          t += `&args[]=` + encodeURIComponent(arguments[n]);
      }
      return (
        `Minified React error #` +
        e +
        `; visit ` +
        t +
        ` for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`
      );
    }
    function i() {}
    var a = {
        d: {
          f: i,
          r: function () {
            throw Error(r(522));
          },
          D: i,
          C: i,
          L: i,
          m: i,
          X: i,
          S: i,
          M: i,
        },
        p: 0,
        findDOMNode: null,
      },
      o = Symbol.for(`react.portal`);
    function s(e, t, n) {
      var r = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
      return {
        $$typeof: o,
        key: r == null ? null : `` + r,
        children: e,
        containerInfo: t,
        implementation: n,
      };
    }
    var c = n.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    function l(e, t) {
      if (e === `font`) return ``;
      if (typeof t == `string`) return t === `use-credentials` ? t : ``;
    }
    ((e.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = a),
      (e.createPortal = function (e, t) {
        var n = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
        if (!t || (t.nodeType !== 1 && t.nodeType !== 9 && t.nodeType !== 11)) throw Error(r(299));
        return s(e, t, null, n);
      }),
      (e.flushSync = function (e) {
        var t = c.T,
          n = a.p;
        try {
          if (((c.T = null), (a.p = 2), e)) return e();
        } finally {
          ((c.T = t), (a.p = n), a.d.f());
        }
      }),
      (e.preconnect = function (e, t) {
        typeof e == `string` &&
          (t
            ? ((t = t.crossOrigin),
              (t = typeof t == `string` ? (t === `use-credentials` ? t : ``) : void 0))
            : (t = null),
          a.d.C(e, t));
      }),
      (e.prefetchDNS = function (e) {
        typeof e == `string` && a.d.D(e);
      }),
      (e.preinit = function (e, t) {
        if (typeof e == `string` && t && typeof t.as == `string`) {
          var n = t.as,
            r = l(n, t.crossOrigin),
            i = typeof t.integrity == `string` ? t.integrity : void 0,
            o = typeof t.fetchPriority == `string` ? t.fetchPriority : void 0;
          n === `style`
            ? a.d.S(e, typeof t.precedence == `string` ? t.precedence : void 0, {
                crossOrigin: r,
                integrity: i,
                fetchPriority: o,
              })
            : n === `script` &&
              a.d.X(e, {
                crossOrigin: r,
                integrity: i,
                fetchPriority: o,
                nonce: typeof t.nonce == `string` ? t.nonce : void 0,
              });
        }
      }),
      (e.preinitModule = function (e, t) {
        if (typeof e == `string`)
          if (typeof t == `object` && t) {
            if (t.as == null || t.as === `script`) {
              var n = l(t.as, t.crossOrigin);
              a.d.M(e, {
                crossOrigin: n,
                integrity: typeof t.integrity == `string` ? t.integrity : void 0,
                nonce: typeof t.nonce == `string` ? t.nonce : void 0,
              });
            }
          } else t ?? a.d.M(e);
      }),
      (e.preload = function (e, t) {
        if (typeof e == `string` && typeof t == `object` && t && typeof t.as == `string`) {
          var n = t.as,
            r = l(n, t.crossOrigin);
          a.d.L(e, n, {
            crossOrigin: r,
            integrity: typeof t.integrity == `string` ? t.integrity : void 0,
            nonce: typeof t.nonce == `string` ? t.nonce : void 0,
            type: typeof t.type == `string` ? t.type : void 0,
            fetchPriority: typeof t.fetchPriority == `string` ? t.fetchPriority : void 0,
            referrerPolicy: typeof t.referrerPolicy == `string` ? t.referrerPolicy : void 0,
            imageSrcSet: typeof t.imageSrcSet == `string` ? t.imageSrcSet : void 0,
            imageSizes: typeof t.imageSizes == `string` ? t.imageSizes : void 0,
            media: typeof t.media == `string` ? t.media : void 0,
          });
        }
      }),
      (e.preloadModule = function (e, t) {
        if (typeof e == `string`)
          if (t) {
            var n = l(t.as, t.crossOrigin);
            a.d.m(e, {
              as: typeof t.as == `string` && t.as !== `script` ? t.as : void 0,
              crossOrigin: n,
              integrity: typeof t.integrity == `string` ? t.integrity : void 0,
            });
          } else a.d.m(e);
      }),
      (e.requestFormReset = function (e) {
        a.d.r(e);
      }),
      (e.unstable_batchedUpdates = function (e, t) {
        return e(t);
      }),
      (e.useFormState = function (e, t, n) {
        return c.H.useFormState(e, t, n);
      }),
      (e.useFormStatus = function () {
        return c.H.useHostTransitionStatus();
      }),
      (e.version = `19.2.5`));
  }),
  s = n((e, t) => {
    function n() {
      if (
        !(
          typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > `u` ||
          typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != `function`
        )
      )
        try {
          __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
        } catch (e) {
          console.error(e);
        }
    }
    (n(), (t.exports = o()));
  }),
  c = n((e) => {
    var n = a(),
      r = t(),
      i = s();
    function o(e) {
      var t = `https://react.dev/errors/` + e;
      if (1 < arguments.length) {
        t += `?args[]=` + encodeURIComponent(arguments[1]);
        for (var n = 2; n < arguments.length; n++)
          t += `&args[]=` + encodeURIComponent(arguments[n]);
      }
      return (
        `Minified React error #` +
        e +
        `; visit ` +
        t +
        ` for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`
      );
    }
    function c(e) {
      return !(!e || (e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11));
    }
    function l(e) {
      var t = e,
        n = e;
      if (e.alternate) for (; t.return; ) t = t.return;
      else {
        e = t;
        do ((t = e), t.flags & 4098 && (n = t.return), (e = t.return));
        while (e);
      }
      return t.tag === 3 ? n : null;
    }
    function u(e) {
      if (e.tag === 13) {
        var t = e.memoizedState;
        if ((t === null && ((e = e.alternate), e !== null && (t = e.memoizedState)), t !== null))
          return t.dehydrated;
      }
      return null;
    }
    function d(e) {
      if (e.tag === 31) {
        var t = e.memoizedState;
        if ((t === null && ((e = e.alternate), e !== null && (t = e.memoizedState)), t !== null))
          return t.dehydrated;
      }
      return null;
    }
    function f(e) {
      if (l(e) !== e) throw Error(o(188));
    }
    function p(e) {
      var t = e.alternate;
      if (!t) {
        if (((t = l(e)), t === null)) throw Error(o(188));
        return t === e ? e : null;
      }
      for (var n = e, r = t; ; ) {
        var i = n.return;
        if (i === null) break;
        var a = i.alternate;
        if (a === null) {
          if (((r = i.return), r !== null)) {
            n = r;
            continue;
          }
          break;
        }
        if (i.child === a.child) {
          for (a = i.child; a; ) {
            if (a === n) return (f(i), e);
            if (a === r) return (f(i), t);
            a = a.sibling;
          }
          throw Error(o(188));
        }
        if (n.return !== r.return) ((n = i), (r = a));
        else {
          for (var s = !1, c = i.child; c; ) {
            if (c === n) {
              ((s = !0), (n = i), (r = a));
              break;
            }
            if (c === r) {
              ((s = !0), (r = i), (n = a));
              break;
            }
            c = c.sibling;
          }
          if (!s) {
            for (c = a.child; c; ) {
              if (c === n) {
                ((s = !0), (n = a), (r = i));
                break;
              }
              if (c === r) {
                ((s = !0), (r = a), (n = i));
                break;
              }
              c = c.sibling;
            }
            if (!s) throw Error(o(189));
          }
        }
        if (n.alternate !== r) throw Error(o(190));
      }
      if (n.tag !== 3) throw Error(o(188));
      return n.stateNode.current === n ? e : t;
    }
    function m(e) {
      var t = e.tag;
      if (t === 5 || t === 26 || t === 27 || t === 6) return e;
      for (e = e.child; e !== null; ) {
        if (((t = m(e)), t !== null)) return t;
        e = e.sibling;
      }
      return null;
    }
    var h = Object.assign,
      g = Symbol.for(`react.element`),
      _ = Symbol.for(`react.transitional.element`),
      v = Symbol.for(`react.portal`),
      y = Symbol.for(`react.fragment`),
      b = Symbol.for(`react.strict_mode`),
      x = Symbol.for(`react.profiler`),
      S = Symbol.for(`react.consumer`),
      C = Symbol.for(`react.context`),
      ee = Symbol.for(`react.forward_ref`),
      te = Symbol.for(`react.suspense`),
      ne = Symbol.for(`react.suspense_list`),
      re = Symbol.for(`react.memo`),
      ie = Symbol.for(`react.lazy`),
      ae = Symbol.for(`react.activity`),
      oe = Symbol.for(`react.memo_cache_sentinel`),
      se = Symbol.iterator;
    function ce(e) {
      return typeof e != `object` || !e
        ? null
        : ((e = (se && e[se]) || e[`@@iterator`]), typeof e == `function` ? e : null);
    }
    var le = Symbol.for(`react.client.reference`);
    function ue(e) {
      if (e == null) return null;
      if (typeof e == `function`) return e.$$typeof === le ? null : e.displayName || e.name || null;
      if (typeof e == `string`) return e;
      switch (e) {
        case y:
          return `Fragment`;
        case x:
          return `Profiler`;
        case b:
          return `StrictMode`;
        case te:
          return `Suspense`;
        case ne:
          return `SuspenseList`;
        case ae:
          return `Activity`;
      }
      if (typeof e == `object`)
        switch (e.$$typeof) {
          case v:
            return `Portal`;
          case C:
            return e.displayName || `Context`;
          case S:
            return (e._context.displayName || `Context`) + `.Consumer`;
          case ee:
            var t = e.render;
            return (
              (e = e.displayName),
              (e ||=
                ((e = t.displayName || t.name || ``),
                e === `` ? `ForwardRef` : `ForwardRef(` + e + `)`)),
              e
            );
          case re:
            return ((t = e.displayName || null), t === null ? ue(e.type) || `Memo` : t);
          case ie:
            ((t = e._payload), (e = e._init));
            try {
              return ue(e(t));
            } catch {}
        }
      return null;
    }
    var de = Array.isArray,
      w = r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
      E = i.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
      fe = { pending: !1, data: null, method: null, action: null },
      pe = [],
      me = -1;
    function he(e) {
      return { current: e };
    }
    function D(e) {
      0 > me || ((e.current = pe[me]), (pe[me] = null), me--);
    }
    function O(e, t) {
      (me++, (pe[me] = e.current), (e.current = t));
    }
    var k = he(null),
      ge = he(null),
      _e = he(null),
      ve = he(null);
    function ye(e, t) {
      switch ((O(_e, t), O(ge, e), O(k, null), t.nodeType)) {
        case 9:
        case 11:
          e = (e = t.documentElement) && (e = e.namespaceURI) ? Hd(e) : 0;
          break;
        default:
          if (((e = t.tagName), (t = t.namespaceURI))) ((t = Hd(t)), (e = Ud(t, e)));
          else
            switch (e) {
              case `svg`:
                e = 1;
                break;
              case `math`:
                e = 2;
                break;
              default:
                e = 0;
            }
      }
      (D(k), O(k, e));
    }
    function be() {
      (D(k), D(ge), D(_e));
    }
    function xe(e) {
      e.memoizedState !== null && O(ve, e);
      var t = k.current,
        n = Ud(t, e.type);
      t !== n && (O(ge, e), O(k, n));
    }
    function Se(e) {
      (ge.current === e && (D(k), D(ge)), ve.current === e && (D(ve), ($f._currentValue = fe)));
    }
    var Ce, we;
    function Te(e) {
      if (Ce === void 0)
        try {
          throw Error();
        } catch (e) {
          var t = e.stack.trim().match(/\n( *(at )?)/);
          ((Ce = (t && t[1]) || ``),
            (we =
              -1 <
              e.stack.indexOf(`
    at`)
                ? ` (<anonymous>)`
                : -1 < e.stack.indexOf(`@`)
                  ? `@unknown:0:0`
                  : ``));
        }
      return (
        `
` +
        Ce +
        e +
        we
      );
    }
    var Ee = !1;
    function De(e, t) {
      if (!e || Ee) return ``;
      Ee = !0;
      var n = Error.prepareStackTrace;
      Error.prepareStackTrace = void 0;
      try {
        var r = {
          DetermineComponentFrameRoot: function () {
            try {
              if (t) {
                var n = function () {
                  throw Error();
                };
                if (
                  (Object.defineProperty(n.prototype, `props`, {
                    set: function () {
                      throw Error();
                    },
                  }),
                  typeof Reflect == `object` && Reflect.construct)
                ) {
                  try {
                    Reflect.construct(n, []);
                  } catch (e) {
                    var r = e;
                  }
                  Reflect.construct(e, [], n);
                } else {
                  try {
                    n.call();
                  } catch (e) {
                    r = e;
                  }
                  e.call(n.prototype);
                }
              } else {
                try {
                  throw Error();
                } catch (e) {
                  r = e;
                }
                (n = e()) && typeof n.catch == `function` && n.catch(function () {});
              }
            } catch (e) {
              if (e && r && typeof e.stack == `string`) return [e.stack, r.stack];
            }
            return [null, null];
          },
        };
        r.DetermineComponentFrameRoot.displayName = `DetermineComponentFrameRoot`;
        var i = Object.getOwnPropertyDescriptor(r.DetermineComponentFrameRoot, `name`);
        i &&
          i.configurable &&
          Object.defineProperty(r.DetermineComponentFrameRoot, `name`, {
            value: `DetermineComponentFrameRoot`,
          });
        var a = r.DetermineComponentFrameRoot(),
          o = a[0],
          s = a[1];
        if (o && s) {
          var c = o.split(`
`),
            l = s.split(`
`);
          for (i = r = 0; r < c.length && !c[r].includes(`DetermineComponentFrameRoot`); ) r++;
          for (; i < l.length && !l[i].includes(`DetermineComponentFrameRoot`); ) i++;
          if (r === c.length || i === l.length)
            for (r = c.length - 1, i = l.length - 1; 1 <= r && 0 <= i && c[r] !== l[i]; ) i--;
          for (; 1 <= r && 0 <= i; r--, i--)
            if (c[r] !== l[i]) {
              if (r !== 1 || i !== 1)
                do
                  if ((r--, i--, 0 > i || c[r] !== l[i])) {
                    var u =
                      `
` + c[r].replace(` at new `, ` at `);
                    return (
                      e.displayName &&
                        u.includes(`<anonymous>`) &&
                        (u = u.replace(`<anonymous>`, e.displayName)),
                      u
                    );
                  }
                while (1 <= r && 0 <= i);
              break;
            }
        }
      } finally {
        ((Ee = !1), (Error.prepareStackTrace = n));
      }
      return (n = e ? e.displayName || e.name : ``) ? Te(n) : ``;
    }
    function Oe(e, t) {
      switch (e.tag) {
        case 26:
        case 27:
        case 5:
          return Te(e.type);
        case 16:
          return Te(`Lazy`);
        case 13:
          return e.child !== t && t !== null ? Te(`Suspense Fallback`) : Te(`Suspense`);
        case 19:
          return Te(`SuspenseList`);
        case 0:
        case 15:
          return De(e.type, !1);
        case 11:
          return De(e.type.render, !1);
        case 1:
          return De(e.type, !0);
        case 31:
          return Te(`Activity`);
        default:
          return ``;
      }
    }
    function ke(e) {
      try {
        var t = ``,
          n = null;
        do ((t += Oe(e, n)), (n = e), (e = e.return));
        while (e);
        return t;
      } catch (e) {
        return (
          `
Error generating stack: ` +
          e.message +
          `
` +
          e.stack
        );
      }
    }
    var Ae = Object.prototype.hasOwnProperty,
      je = n.unstable_scheduleCallback,
      Me = n.unstable_cancelCallback,
      Ne = n.unstable_shouldYield,
      Pe = n.unstable_requestPaint,
      Fe = n.unstable_now,
      Ie = n.unstable_getCurrentPriorityLevel,
      Le = n.unstable_ImmediatePriority,
      Re = n.unstable_UserBlockingPriority,
      ze = n.unstable_NormalPriority,
      Be = n.unstable_LowPriority,
      Ve = n.unstable_IdlePriority,
      He = n.log,
      Ue = n.unstable_setDisableYieldValue,
      We = null,
      Ge = null;
    function Ke(e) {
      if ((typeof He == `function` && Ue(e), Ge && typeof Ge.setStrictMode == `function`))
        try {
          Ge.setStrictMode(We, e);
        } catch {}
    }
    var qe = Math.clz32 ? Math.clz32 : Xe,
      Je = Math.log,
      Ye = Math.LN2;
    function Xe(e) {
      return ((e >>>= 0), e === 0 ? 32 : (31 - ((Je(e) / Ye) | 0)) | 0);
    }
    var Ze = 256,
      Qe = 262144,
      $e = 4194304;
    function et(e) {
      var t = e & 42;
      if (t !== 0) return t;
      switch (e & -e) {
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
          return e & 261888;
        case 262144:
        case 524288:
        case 1048576:
        case 2097152:
          return e & 3932160;
        case 4194304:
        case 8388608:
        case 16777216:
        case 33554432:
          return e & 62914560;
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
          return e;
      }
    }
    function tt(e, t, n) {
      var r = e.pendingLanes;
      if (r === 0) return 0;
      var i = 0,
        a = e.suspendedLanes,
        o = e.pingedLanes;
      e = e.warmLanes;
      var s = r & 134217727;
      return (
        s === 0
          ? ((s = r & ~a),
            s === 0
              ? o === 0
                ? n || ((n = r & ~e), n !== 0 && (i = et(n)))
                : (i = et(o))
              : (i = et(s)))
          : ((r = s & ~a),
            r === 0
              ? ((o &= s), o === 0 ? n || ((n = s & ~e), n !== 0 && (i = et(n))) : (i = et(o)))
              : (i = et(r))),
        i === 0
          ? 0
          : t !== 0 &&
              t !== i &&
              (t & a) === 0 &&
              ((a = i & -i), (n = t & -t), a >= n || (a === 32 && n & 4194048))
            ? t
            : i
      );
    }
    function nt(e, t) {
      return (e.pendingLanes & ~(e.suspendedLanes & ~e.pingedLanes) & t) === 0;
    }
    function rt(e, t) {
      switch (e) {
        case 1:
        case 2:
        case 4:
        case 8:
        case 64:
          return t + 250;
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
          return t + 5e3;
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
    function it() {
      var e = $e;
      return (($e <<= 1), !($e & 62914560) && ($e = 4194304), e);
    }
    function at(e) {
      for (var t = [], n = 0; 31 > n; n++) t.push(e);
      return t;
    }
    function ot(e, t) {
      ((e.pendingLanes |= t),
        t !== 268435456 && ((e.suspendedLanes = 0), (e.pingedLanes = 0), (e.warmLanes = 0)));
    }
    function st(e, t, n, r, i, a) {
      var o = e.pendingLanes;
      ((e.pendingLanes = n),
        (e.suspendedLanes = 0),
        (e.pingedLanes = 0),
        (e.warmLanes = 0),
        (e.expiredLanes &= n),
        (e.entangledLanes &= n),
        (e.errorRecoveryDisabledLanes &= n),
        (e.shellSuspendCounter = 0));
      var s = e.entanglements,
        c = e.expirationTimes,
        l = e.hiddenUpdates;
      for (n = o & ~n; 0 < n; ) {
        var u = 31 - qe(n),
          d = 1 << u;
        ((s[u] = 0), (c[u] = -1));
        var f = l[u];
        if (f !== null)
          for (l[u] = null, u = 0; u < f.length; u++) {
            var p = f[u];
            p !== null && (p.lane &= -536870913);
          }
        n &= ~d;
      }
      (r !== 0 && ct(e, r, 0),
        a !== 0 && i === 0 && e.tag !== 0 && (e.suspendedLanes |= a & ~(o & ~t)));
    }
    function ct(e, t, n) {
      ((e.pendingLanes |= t), (e.suspendedLanes &= ~t));
      var r = 31 - qe(t);
      ((e.entangledLanes |= t),
        (e.entanglements[r] = e.entanglements[r] | 1073741824 | (n & 261930)));
    }
    function lt(e, t) {
      var n = (e.entangledLanes |= t);
      for (e = e.entanglements; n; ) {
        var r = 31 - qe(n),
          i = 1 << r;
        ((i & t) | (e[r] & t) && (e[r] |= t), (n &= ~i));
      }
    }
    function ut(e, t) {
      var n = t & -t;
      return ((n = n & 42 ? 1 : dt(n)), (n & (e.suspendedLanes | t)) === 0 ? n : 0);
    }
    function dt(e) {
      switch (e) {
        case 2:
          e = 1;
          break;
        case 8:
          e = 4;
          break;
        case 32:
          e = 16;
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
          e = 128;
          break;
        case 268435456:
          e = 134217728;
          break;
        default:
          e = 0;
      }
      return e;
    }
    function ft(e) {
      return ((e &= -e), 2 < e ? (8 < e ? (e & 134217727 ? 32 : 268435456) : 8) : 2);
    }
    function pt() {
      var e = E.p;
      return e === 0 ? ((e = window.event), e === void 0 ? 32 : hp(e.type)) : e;
    }
    function mt(e, t) {
      var n = E.p;
      try {
        return ((E.p = e), t());
      } finally {
        E.p = n;
      }
    }
    var ht = Math.random().toString(36).slice(2),
      gt = `__reactFiber$` + ht,
      _t = `__reactProps$` + ht,
      vt = `__reactContainer$` + ht,
      yt = `__reactEvents$` + ht,
      bt = `__reactListeners$` + ht,
      xt = `__reactHandles$` + ht,
      St = `__reactResources$` + ht,
      Ct = `__reactMarker$` + ht;
    function wt(e) {
      (delete e[gt], delete e[_t], delete e[yt], delete e[bt], delete e[xt]);
    }
    function Tt(e) {
      var t = e[gt];
      if (t) return t;
      for (var n = e.parentNode; n; ) {
        if ((t = n[vt] || n[gt])) {
          if (((n = t.alternate), t.child !== null || (n !== null && n.child !== null)))
            for (e = ff(e); e !== null; ) {
              if ((n = e[gt])) return n;
              e = ff(e);
            }
          return t;
        }
        ((e = n), (n = e.parentNode));
      }
      return null;
    }
    function Et(e) {
      if ((e = e[gt] || e[vt])) {
        var t = e.tag;
        if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3) return e;
      }
      return null;
    }
    function Dt(e) {
      var t = e.tag;
      if (t === 5 || t === 26 || t === 27 || t === 6) return e.stateNode;
      throw Error(o(33));
    }
    function Ot(e) {
      var t = e[St];
      return ((t ||= e[St] = { hoistableStyles: new Map(), hoistableScripts: new Map() }), t);
    }
    function kt(e) {
      e[Ct] = !0;
    }
    var At = new Set(),
      jt = {};
    function Mt(e, t) {
      (Nt(e, t), Nt(e + `Capture`, t));
    }
    function Nt(e, t) {
      for (jt[e] = t, e = 0; e < t.length; e++) At.add(t[e]);
    }
    var Pt = RegExp(
        `^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`,
      ),
      Ft = {},
      It = {};
    function Lt(e) {
      return Ae.call(It, e)
        ? !0
        : Ae.call(Ft, e)
          ? !1
          : Pt.test(e)
            ? (It[e] = !0)
            : ((Ft[e] = !0), !1);
    }
    function Rt(e, t, n) {
      if (Lt(t))
        if (n === null) e.removeAttribute(t);
        else {
          switch (typeof n) {
            case `undefined`:
            case `function`:
            case `symbol`:
              e.removeAttribute(t);
              return;
            case `boolean`:
              var r = t.toLowerCase().slice(0, 5);
              if (r !== `data-` && r !== `aria-`) {
                e.removeAttribute(t);
                return;
              }
          }
          e.setAttribute(t, `` + n);
        }
    }
    function zt(e, t, n) {
      if (n === null) e.removeAttribute(t);
      else {
        switch (typeof n) {
          case `undefined`:
          case `function`:
          case `symbol`:
          case `boolean`:
            e.removeAttribute(t);
            return;
        }
        e.setAttribute(t, `` + n);
      }
    }
    function Bt(e, t, n, r) {
      if (r === null) e.removeAttribute(n);
      else {
        switch (typeof r) {
          case `undefined`:
          case `function`:
          case `symbol`:
          case `boolean`:
            e.removeAttribute(n);
            return;
        }
        e.setAttributeNS(t, n, `` + r);
      }
    }
    function Vt(e) {
      switch (typeof e) {
        case `bigint`:
        case `boolean`:
        case `number`:
        case `string`:
        case `undefined`:
          return e;
        case `object`:
          return e;
        default:
          return ``;
      }
    }
    function Ht(e) {
      var t = e.type;
      return (e = e.nodeName) && e.toLowerCase() === `input` && (t === `checkbox` || t === `radio`);
    }
    function Ut(e, t, n) {
      var r = Object.getOwnPropertyDescriptor(e.constructor.prototype, t);
      if (
        !e.hasOwnProperty(t) &&
        r !== void 0 &&
        typeof r.get == `function` &&
        typeof r.set == `function`
      ) {
        var i = r.get,
          a = r.set;
        return (
          Object.defineProperty(e, t, {
            configurable: !0,
            get: function () {
              return i.call(this);
            },
            set: function (e) {
              ((n = `` + e), a.call(this, e));
            },
          }),
          Object.defineProperty(e, t, { enumerable: r.enumerable }),
          {
            getValue: function () {
              return n;
            },
            setValue: function (e) {
              n = `` + e;
            },
            stopTracking: function () {
              ((e._valueTracker = null), delete e[t]);
            },
          }
        );
      }
    }
    function Wt(e) {
      if (!e._valueTracker) {
        var t = Ht(e) ? `checked` : `value`;
        e._valueTracker = Ut(e, t, `` + e[t]);
      }
    }
    function Gt(e) {
      if (!e) return !1;
      var t = e._valueTracker;
      if (!t) return !0;
      var n = t.getValue(),
        r = ``;
      return (
        e && (r = Ht(e) ? (e.checked ? `true` : `false`) : e.value),
        (e = r),
        e === n ? !1 : (t.setValue(e), !0)
      );
    }
    function Kt(e) {
      if (((e ||= typeof document < `u` ? document : void 0), e === void 0)) return null;
      try {
        return e.activeElement || e.body;
      } catch {
        return e.body;
      }
    }
    var qt = /[\n"\\]/g;
    function Jt(e) {
      return e.replace(qt, function (e) {
        return `\\` + e.charCodeAt(0).toString(16) + ` `;
      });
    }
    function Yt(e, t, n, r, i, a, o, s) {
      ((e.name = ``),
        o != null && typeof o != `function` && typeof o != `symbol` && typeof o != `boolean`
          ? (e.type = o)
          : e.removeAttribute(`type`),
        t == null
          ? (o !== `submit` && o !== `reset`) || e.removeAttribute(`value`)
          : o === `number`
            ? ((t === 0 && e.value === ``) || e.value != t) && (e.value = `` + Vt(t))
            : e.value !== `` + Vt(t) && (e.value = `` + Vt(t)),
        t == null
          ? n == null
            ? r != null && e.removeAttribute(`value`)
            : Zt(e, o, Vt(n))
          : Zt(e, o, Vt(t)),
        i == null && a != null && (e.defaultChecked = !!a),
        i != null && (e.checked = i && typeof i != `function` && typeof i != `symbol`),
        s != null && typeof s != `function` && typeof s != `symbol` && typeof s != `boolean`
          ? (e.name = `` + Vt(s))
          : e.removeAttribute(`name`));
    }
    function Xt(e, t, n, r, i, a, o, s) {
      if (
        (a != null &&
          typeof a != `function` &&
          typeof a != `symbol` &&
          typeof a != `boolean` &&
          (e.type = a),
        t != null || n != null)
      ) {
        if (!((a !== `submit` && a !== `reset`) || t != null)) {
          Wt(e);
          return;
        }
        ((n = n == null ? `` : `` + Vt(n)),
          (t = t == null ? n : `` + Vt(t)),
          s || t === e.value || (e.value = t),
          (e.defaultValue = t));
      }
      ((r ??= i),
        (r = typeof r != `function` && typeof r != `symbol` && !!r),
        (e.checked = s ? e.checked : !!r),
        (e.defaultChecked = !!r),
        o != null &&
          typeof o != `function` &&
          typeof o != `symbol` &&
          typeof o != `boolean` &&
          (e.name = o),
        Wt(e));
    }
    function Zt(e, t, n) {
      (t === `number` && Kt(e.ownerDocument) === e) ||
        e.defaultValue === `` + n ||
        (e.defaultValue = `` + n);
    }
    function Qt(e, t, n, r) {
      if (((e = e.options), t)) {
        t = {};
        for (var i = 0; i < n.length; i++) t[`$` + n[i]] = !0;
        for (n = 0; n < e.length; n++)
          ((i = t.hasOwnProperty(`$` + e[n].value)),
            e[n].selected !== i && (e[n].selected = i),
            i && r && (e[n].defaultSelected = !0));
      } else {
        for (n = `` + Vt(n), t = null, i = 0; i < e.length; i++) {
          if (e[i].value === n) {
            ((e[i].selected = !0), r && (e[i].defaultSelected = !0));
            return;
          }
          t !== null || e[i].disabled || (t = e[i]);
        }
        t !== null && (t.selected = !0);
      }
    }
    function $t(e, t, n) {
      if (t != null && ((t = `` + Vt(t)), t !== e.value && (e.value = t), n == null)) {
        e.defaultValue !== t && (e.defaultValue = t);
        return;
      }
      e.defaultValue = n == null ? `` : `` + Vt(n);
    }
    function en(e, t, n, r) {
      if (t == null) {
        if (r != null) {
          if (n != null) throw Error(o(92));
          if (de(r)) {
            if (1 < r.length) throw Error(o(93));
            r = r[0];
          }
          n = r;
        }
        ((n ??= ``), (t = n));
      }
      ((n = Vt(t)),
        (e.defaultValue = n),
        (r = e.textContent),
        r === n && r !== `` && r !== null && (e.value = r),
        Wt(e));
    }
    function tn(e, t) {
      if (t) {
        var n = e.firstChild;
        if (n && n === e.lastChild && n.nodeType === 3) {
          n.nodeValue = t;
          return;
        }
      }
      e.textContent = t;
    }
    var nn = new Set(
      `animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp`.split(
        ` `,
      ),
    );
    function rn(e, t, n) {
      var r = t.indexOf(`--`) === 0;
      n == null || typeof n == `boolean` || n === ``
        ? r
          ? e.setProperty(t, ``)
          : t === `float`
            ? (e.cssFloat = ``)
            : (e[t] = ``)
        : r
          ? e.setProperty(t, n)
          : typeof n != `number` || n === 0 || nn.has(t)
            ? t === `float`
              ? (e.cssFloat = n)
              : (e[t] = (`` + n).trim())
            : (e[t] = n + `px`);
    }
    function an(e, t, n) {
      if (t != null && typeof t != `object`) throw Error(o(62));
      if (((e = e.style), n != null)) {
        for (var r in n)
          !n.hasOwnProperty(r) ||
            (t != null && t.hasOwnProperty(r)) ||
            (r.indexOf(`--`) === 0
              ? e.setProperty(r, ``)
              : r === `float`
                ? (e.cssFloat = ``)
                : (e[r] = ``));
        for (var i in t) ((r = t[i]), t.hasOwnProperty(i) && n[i] !== r && rn(e, i, r));
      } else for (var a in t) t.hasOwnProperty(a) && rn(e, a, t[a]);
    }
    function on(e) {
      if (e.indexOf(`-`) === -1) return !1;
      switch (e) {
        case `annotation-xml`:
        case `color-profile`:
        case `font-face`:
        case `font-face-src`:
        case `font-face-uri`:
        case `font-face-format`:
        case `font-face-name`:
        case `missing-glyph`:
          return !1;
        default:
          return !0;
      }
    }
    var sn = new Map([
        [`acceptCharset`, `accept-charset`],
        [`htmlFor`, `for`],
        [`httpEquiv`, `http-equiv`],
        [`crossOrigin`, `crossorigin`],
        [`accentHeight`, `accent-height`],
        [`alignmentBaseline`, `alignment-baseline`],
        [`arabicForm`, `arabic-form`],
        [`baselineShift`, `baseline-shift`],
        [`capHeight`, `cap-height`],
        [`clipPath`, `clip-path`],
        [`clipRule`, `clip-rule`],
        [`colorInterpolation`, `color-interpolation`],
        [`colorInterpolationFilters`, `color-interpolation-filters`],
        [`colorProfile`, `color-profile`],
        [`colorRendering`, `color-rendering`],
        [`dominantBaseline`, `dominant-baseline`],
        [`enableBackground`, `enable-background`],
        [`fillOpacity`, `fill-opacity`],
        [`fillRule`, `fill-rule`],
        [`floodColor`, `flood-color`],
        [`floodOpacity`, `flood-opacity`],
        [`fontFamily`, `font-family`],
        [`fontSize`, `font-size`],
        [`fontSizeAdjust`, `font-size-adjust`],
        [`fontStretch`, `font-stretch`],
        [`fontStyle`, `font-style`],
        [`fontVariant`, `font-variant`],
        [`fontWeight`, `font-weight`],
        [`glyphName`, `glyph-name`],
        [`glyphOrientationHorizontal`, `glyph-orientation-horizontal`],
        [`glyphOrientationVertical`, `glyph-orientation-vertical`],
        [`horizAdvX`, `horiz-adv-x`],
        [`horizOriginX`, `horiz-origin-x`],
        [`imageRendering`, `image-rendering`],
        [`letterSpacing`, `letter-spacing`],
        [`lightingColor`, `lighting-color`],
        [`markerEnd`, `marker-end`],
        [`markerMid`, `marker-mid`],
        [`markerStart`, `marker-start`],
        [`overlinePosition`, `overline-position`],
        [`overlineThickness`, `overline-thickness`],
        [`paintOrder`, `paint-order`],
        [`panose-1`, `panose-1`],
        [`pointerEvents`, `pointer-events`],
        [`renderingIntent`, `rendering-intent`],
        [`shapeRendering`, `shape-rendering`],
        [`stopColor`, `stop-color`],
        [`stopOpacity`, `stop-opacity`],
        [`strikethroughPosition`, `strikethrough-position`],
        [`strikethroughThickness`, `strikethrough-thickness`],
        [`strokeDasharray`, `stroke-dasharray`],
        [`strokeDashoffset`, `stroke-dashoffset`],
        [`strokeLinecap`, `stroke-linecap`],
        [`strokeLinejoin`, `stroke-linejoin`],
        [`strokeMiterlimit`, `stroke-miterlimit`],
        [`strokeOpacity`, `stroke-opacity`],
        [`strokeWidth`, `stroke-width`],
        [`textAnchor`, `text-anchor`],
        [`textDecoration`, `text-decoration`],
        [`textRendering`, `text-rendering`],
        [`transformOrigin`, `transform-origin`],
        [`underlinePosition`, `underline-position`],
        [`underlineThickness`, `underline-thickness`],
        [`unicodeBidi`, `unicode-bidi`],
        [`unicodeRange`, `unicode-range`],
        [`unitsPerEm`, `units-per-em`],
        [`vAlphabetic`, `v-alphabetic`],
        [`vHanging`, `v-hanging`],
        [`vIdeographic`, `v-ideographic`],
        [`vMathematical`, `v-mathematical`],
        [`vectorEffect`, `vector-effect`],
        [`vertAdvY`, `vert-adv-y`],
        [`vertOriginX`, `vert-origin-x`],
        [`vertOriginY`, `vert-origin-y`],
        [`wordSpacing`, `word-spacing`],
        [`writingMode`, `writing-mode`],
        [`xmlnsXlink`, `xmlns:xlink`],
        [`xHeight`, `x-height`],
      ]),
      cn =
        /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
    function ln(e) {
      return cn.test(`` + e)
        ? `javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')`
        : e;
    }
    function un() {}
    var dn = null;
    function fn(e) {
      return (
        (e = e.target || e.srcElement || window),
        e.correspondingUseElement && (e = e.correspondingUseElement),
        e.nodeType === 3 ? e.parentNode : e
      );
    }
    var pn = null,
      mn = null;
    function hn(e) {
      var t = Et(e);
      if (t && (e = t.stateNode)) {
        var n = e[_t] || null;
        a: switch (((e = t.stateNode), t.type)) {
          case `input`:
            if (
              (Yt(
                e,
                n.value,
                n.defaultValue,
                n.defaultValue,
                n.checked,
                n.defaultChecked,
                n.type,
                n.name,
              ),
              (t = n.name),
              n.type === `radio` && t != null)
            ) {
              for (n = e; n.parentNode; ) n = n.parentNode;
              for (
                n = n.querySelectorAll(`input[name="` + Jt(`` + t) + `"][type="radio"]`), t = 0;
                t < n.length;
                t++
              ) {
                var r = n[t];
                if (r !== e && r.form === e.form) {
                  var i = r[_t] || null;
                  if (!i) throw Error(o(90));
                  Yt(
                    r,
                    i.value,
                    i.defaultValue,
                    i.defaultValue,
                    i.checked,
                    i.defaultChecked,
                    i.type,
                    i.name,
                  );
                }
              }
              for (t = 0; t < n.length; t++) ((r = n[t]), r.form === e.form && Gt(r));
            }
            break a;
          case `textarea`:
            $t(e, n.value, n.defaultValue);
            break a;
          case `select`:
            ((t = n.value), t != null && Qt(e, !!n.multiple, t, !1));
        }
      }
    }
    var gn = !1;
    function _n(e, t, n) {
      if (gn) return e(t, n);
      gn = !0;
      try {
        return e(t);
      } finally {
        if (
          ((gn = !1),
          (pn !== null || mn !== null) &&
            (xu(), pn && ((t = pn), (e = mn), (mn = pn = null), hn(t), e)))
        )
          for (t = 0; t < e.length; t++) hn(e[t]);
      }
    }
    function vn(e, t) {
      var n = e.stateNode;
      if (n === null) return null;
      var r = n[_t] || null;
      if (r === null) return null;
      n = r[t];
      a: switch (t) {
        case `onClick`:
        case `onClickCapture`:
        case `onDoubleClick`:
        case `onDoubleClickCapture`:
        case `onMouseDown`:
        case `onMouseDownCapture`:
        case `onMouseMove`:
        case `onMouseMoveCapture`:
        case `onMouseUp`:
        case `onMouseUpCapture`:
        case `onMouseEnter`:
          ((r = !r.disabled) ||
            ((e = e.type),
            (r = !(e === `button` || e === `input` || e === `select` || e === `textarea`))),
            (e = !r));
          break a;
        default:
          e = !1;
      }
      if (e) return null;
      if (n && typeof n != `function`) throw Error(o(231, t, typeof n));
      return n;
    }
    var yn = !(
        typeof window > `u` ||
        window.document === void 0 ||
        window.document.createElement === void 0
      ),
      bn = !1;
    if (yn)
      try {
        var xn = {};
        (Object.defineProperty(xn, `passive`, {
          get: function () {
            bn = !0;
          },
        }),
          window.addEventListener(`test`, xn, xn),
          window.removeEventListener(`test`, xn, xn));
      } catch {
        bn = !1;
      }
    var Sn = null,
      Cn = null,
      wn = null;
    function Tn() {
      if (wn) return wn;
      var e,
        t = Cn,
        n = t.length,
        r,
        i = `value` in Sn ? Sn.value : Sn.textContent,
        a = i.length;
      for (e = 0; e < n && t[e] === i[e]; e++);
      var o = n - e;
      for (r = 1; r <= o && t[n - r] === i[a - r]; r++);
      return (wn = i.slice(e, 1 < r ? 1 - r : void 0));
    }
    function En(e) {
      var t = e.keyCode;
      return (
        `charCode` in e ? ((e = e.charCode), e === 0 && t === 13 && (e = 13)) : (e = t),
        e === 10 && (e = 13),
        32 <= e || e === 13 ? e : 0
      );
    }
    function Dn() {
      return !0;
    }
    function On() {
      return !1;
    }
    function A(e) {
      function t(t, n, r, i, a) {
        for (var o in ((this._reactName = t),
        (this._targetInst = r),
        (this.type = n),
        (this.nativeEvent = i),
        (this.target = a),
        (this.currentTarget = null),
        e))
          e.hasOwnProperty(o) && ((t = e[o]), (this[o] = t ? t(i) : i[o]));
        return (
          (this.isDefaultPrevented = (
            i.defaultPrevented == null ? !1 === i.returnValue : i.defaultPrevented
          )
            ? Dn
            : On),
          (this.isPropagationStopped = On),
          this
        );
      }
      return (
        h(t.prototype, {
          preventDefault: function () {
            this.defaultPrevented = !0;
            var e = this.nativeEvent;
            e &&
              (e.preventDefault
                ? e.preventDefault()
                : typeof e.returnValue != `unknown` && (e.returnValue = !1),
              (this.isDefaultPrevented = Dn));
          },
          stopPropagation: function () {
            var e = this.nativeEvent;
            e &&
              (e.stopPropagation
                ? e.stopPropagation()
                : typeof e.cancelBubble != `unknown` && (e.cancelBubble = !0),
              (this.isPropagationStopped = Dn));
          },
          persist: function () {},
          isPersistent: Dn,
        }),
        t
      );
    }
    var kn = {
        eventPhase: 0,
        bubbles: 0,
        cancelable: 0,
        timeStamp: function (e) {
          return e.timeStamp || Date.now();
        },
        defaultPrevented: 0,
        isTrusted: 0,
      },
      An = A(kn),
      jn = h({}, kn, { view: 0, detail: 0 }),
      Mn = A(jn),
      Nn,
      Pn,
      Fn,
      In = h({}, jn, {
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
        getModifierState: Gn,
        button: 0,
        buttons: 0,
        relatedTarget: function (e) {
          return e.relatedTarget === void 0
            ? e.fromElement === e.srcElement
              ? e.toElement
              : e.fromElement
            : e.relatedTarget;
        },
        movementX: function (e) {
          return `movementX` in e
            ? e.movementX
            : (e !== Fn &&
                (Fn && e.type === `mousemove`
                  ? ((Nn = e.screenX - Fn.screenX), (Pn = e.screenY - Fn.screenY))
                  : (Pn = Nn = 0),
                (Fn = e)),
              Nn);
        },
        movementY: function (e) {
          return `movementY` in e ? e.movementY : Pn;
        },
      }),
      Ln = A(In),
      Rn = A(h({}, In, { dataTransfer: 0 })),
      zn = A(h({}, jn, { relatedTarget: 0 })),
      j = A(h({}, kn, { animationName: 0, elapsedTime: 0, pseudoElement: 0 })),
      Bn = A(
        h({}, kn, {
          clipboardData: function (e) {
            return `clipboardData` in e ? e.clipboardData : window.clipboardData;
          },
        }),
      ),
      Vn = A(h({}, kn, { data: 0 })),
      Hn = {
        Esc: `Escape`,
        Spacebar: ` `,
        Left: `ArrowLeft`,
        Up: `ArrowUp`,
        Right: `ArrowRight`,
        Down: `ArrowDown`,
        Del: `Delete`,
        Win: `OS`,
        Menu: `ContextMenu`,
        Apps: `ContextMenu`,
        Scroll: `ScrollLock`,
        MozPrintableKey: `Unidentified`,
      },
      M = {
        8: `Backspace`,
        9: `Tab`,
        12: `Clear`,
        13: `Enter`,
        16: `Shift`,
        17: `Control`,
        18: `Alt`,
        19: `Pause`,
        20: `CapsLock`,
        27: `Escape`,
        32: ` `,
        33: `PageUp`,
        34: `PageDown`,
        35: `End`,
        36: `Home`,
        37: `ArrowLeft`,
        38: `ArrowUp`,
        39: `ArrowRight`,
        40: `ArrowDown`,
        45: `Insert`,
        46: `Delete`,
        112: `F1`,
        113: `F2`,
        114: `F3`,
        115: `F4`,
        116: `F5`,
        117: `F6`,
        118: `F7`,
        119: `F8`,
        120: `F9`,
        121: `F10`,
        122: `F11`,
        123: `F12`,
        144: `NumLock`,
        145: `ScrollLock`,
        224: `Meta`,
      },
      Un = { Alt: `altKey`, Control: `ctrlKey`, Meta: `metaKey`, Shift: `shiftKey` };
    function Wn(e) {
      var t = this.nativeEvent;
      return t.getModifierState ? t.getModifierState(e) : (e = Un[e]) ? !!t[e] : !1;
    }
    function Gn() {
      return Wn;
    }
    var Kn = A(
        h({}, jn, {
          key: function (e) {
            if (e.key) {
              var t = Hn[e.key] || e.key;
              if (t !== `Unidentified`) return t;
            }
            return e.type === `keypress`
              ? ((e = En(e)), e === 13 ? `Enter` : String.fromCharCode(e))
              : e.type === `keydown` || e.type === `keyup`
                ? M[e.keyCode] || `Unidentified`
                : ``;
          },
          code: 0,
          location: 0,
          ctrlKey: 0,
          shiftKey: 0,
          altKey: 0,
          metaKey: 0,
          repeat: 0,
          locale: 0,
          getModifierState: Gn,
          charCode: function (e) {
            return e.type === `keypress` ? En(e) : 0;
          },
          keyCode: function (e) {
            return e.type === `keydown` || e.type === `keyup` ? e.keyCode : 0;
          },
          which: function (e) {
            return e.type === `keypress`
              ? En(e)
              : e.type === `keydown` || e.type === `keyup`
                ? e.keyCode
                : 0;
          },
        }),
      ),
      qn = A(
        h({}, In, {
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
      ),
      Jn = A(
        h({}, jn, {
          touches: 0,
          targetTouches: 0,
          changedTouches: 0,
          altKey: 0,
          metaKey: 0,
          ctrlKey: 0,
          shiftKey: 0,
          getModifierState: Gn,
        }),
      ),
      Yn = A(h({}, kn, { propertyName: 0, elapsedTime: 0, pseudoElement: 0 })),
      Xn = A(
        h({}, In, {
          deltaX: function (e) {
            return `deltaX` in e ? e.deltaX : `wheelDeltaX` in e ? -e.wheelDeltaX : 0;
          },
          deltaY: function (e) {
            return `deltaY` in e
              ? e.deltaY
              : `wheelDeltaY` in e
                ? -e.wheelDeltaY
                : `wheelDelta` in e
                  ? -e.wheelDelta
                  : 0;
          },
          deltaZ: 0,
          deltaMode: 0,
        }),
      ),
      Zn = A(h({}, kn, { newState: 0, oldState: 0 })),
      Qn = [9, 13, 27, 32],
      $n = yn && `CompositionEvent` in window,
      er = null;
    yn && `documentMode` in document && (er = document.documentMode);
    var tr = yn && `TextEvent` in window && !er,
      nr = yn && (!$n || (er && 8 < er && 11 >= er)),
      rr = ` `,
      ir = !1;
    function ar(e, t) {
      switch (e) {
        case `keyup`:
          return Qn.indexOf(t.keyCode) !== -1;
        case `keydown`:
          return t.keyCode !== 229;
        case `keypress`:
        case `mousedown`:
        case `focusout`:
          return !0;
        default:
          return !1;
      }
    }
    function or(e) {
      return ((e = e.detail), typeof e == `object` && `data` in e ? e.data : null);
    }
    var sr = !1;
    function cr(e, t) {
      switch (e) {
        case `compositionend`:
          return or(t);
        case `keypress`:
          return t.which === 32 ? ((ir = !0), rr) : null;
        case `textInput`:
          return ((e = t.data), e === rr && ir ? null : e);
        default:
          return null;
      }
    }
    function lr(e, t) {
      if (sr)
        return e === `compositionend` || (!$n && ar(e, t))
          ? ((e = Tn()), (wn = Cn = Sn = null), (sr = !1), e)
          : null;
      switch (e) {
        case `paste`:
          return null;
        case `keypress`:
          if (!(t.ctrlKey || t.altKey || t.metaKey) || (t.ctrlKey && t.altKey)) {
            if (t.char && 1 < t.char.length) return t.char;
            if (t.which) return String.fromCharCode(t.which);
          }
          return null;
        case `compositionend`:
          return nr && t.locale !== `ko` ? null : t.data;
        default:
          return null;
      }
    }
    var ur = {
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
    function dr(e) {
      var t = e && e.nodeName && e.nodeName.toLowerCase();
      return t === `input` ? !!ur[e.type] : t === `textarea`;
    }
    function fr(e, t, n, r) {
      (pn ? (mn ? mn.push(r) : (mn = [r])) : (pn = r),
        (t = Dd(t, `onChange`)),
        0 < t.length &&
          ((n = new An(`onChange`, `change`, null, n, r)), e.push({ event: n, listeners: t })));
    }
    var pr = null,
      mr = null;
    function hr(e) {
      bd(e, 0);
    }
    function gr(e) {
      if (Gt(Dt(e))) return e;
    }
    function _r(e, t) {
      if (e === `change`) return t;
    }
    var vr = !1;
    if (yn) {
      var yr;
      if (yn) {
        var br = `oninput` in document;
        if (!br) {
          var xr = document.createElement(`div`);
          (xr.setAttribute(`oninput`, `return;`), (br = typeof xr.oninput == `function`));
        }
        yr = br;
      } else yr = !1;
      vr = yr && (!document.documentMode || 9 < document.documentMode);
    }
    function Sr() {
      pr && (pr.detachEvent(`onpropertychange`, Cr), (mr = pr = null));
    }
    function Cr(e) {
      if (e.propertyName === `value` && gr(mr)) {
        var t = [];
        (fr(t, mr, e, fn(e)), _n(hr, t));
      }
    }
    function wr(e, t, n) {
      e === `focusin`
        ? (Sr(), (pr = t), (mr = n), pr.attachEvent(`onpropertychange`, Cr))
        : e === `focusout` && Sr();
    }
    function Tr(e) {
      if (e === `selectionchange` || e === `keyup` || e === `keydown`) return gr(mr);
    }
    function Er(e, t) {
      if (e === `click`) return gr(t);
    }
    function Dr(e, t) {
      if (e === `input` || e === `change`) return gr(t);
    }
    function Or(e, t) {
      return (e === t && (e !== 0 || 1 / e == 1 / t)) || (e !== e && t !== t);
    }
    var kr = typeof Object.is == `function` ? Object.is : Or;
    function Ar(e, t) {
      if (kr(e, t)) return !0;
      if (typeof e != `object` || !e || typeof t != `object` || !t) return !1;
      var n = Object.keys(e),
        r = Object.keys(t);
      if (n.length !== r.length) return !1;
      for (r = 0; r < n.length; r++) {
        var i = n[r];
        if (!Ae.call(t, i) || !kr(e[i], t[i])) return !1;
      }
      return !0;
    }
    function jr(e) {
      for (; e && e.firstChild; ) e = e.firstChild;
      return e;
    }
    function Mr(e, t) {
      var n = jr(e);
      e = 0;
      for (var r; n; ) {
        if (n.nodeType === 3) {
          if (((r = e + n.textContent.length), e <= t && r >= t)) return { node: n, offset: t - e };
          e = r;
        }
        a: {
          for (; n; ) {
            if (n.nextSibling) {
              n = n.nextSibling;
              break a;
            }
            n = n.parentNode;
          }
          n = void 0;
        }
        n = jr(n);
      }
    }
    function Nr(e, t) {
      return e && t
        ? e === t
          ? !0
          : e && e.nodeType === 3
            ? !1
            : t && t.nodeType === 3
              ? Nr(e, t.parentNode)
              : `contains` in e
                ? e.contains(t)
                : e.compareDocumentPosition
                  ? !!(e.compareDocumentPosition(t) & 16)
                  : !1
        : !1;
    }
    function Pr(e) {
      e =
        e != null && e.ownerDocument != null && e.ownerDocument.defaultView != null
          ? e.ownerDocument.defaultView
          : window;
      for (var t = Kt(e.document); t instanceof e.HTMLIFrameElement; ) {
        try {
          var n = typeof t.contentWindow.location.href == `string`;
        } catch {
          n = !1;
        }
        if (n) e = t.contentWindow;
        else break;
        t = Kt(e.document);
      }
      return t;
    }
    function Fr(e) {
      var t = e && e.nodeName && e.nodeName.toLowerCase();
      return (
        t &&
        ((t === `input` &&
          (e.type === `text` ||
            e.type === `search` ||
            e.type === `tel` ||
            e.type === `url` ||
            e.type === `password`)) ||
          t === `textarea` ||
          e.contentEditable === `true`)
      );
    }
    var Ir = yn && `documentMode` in document && 11 >= document.documentMode,
      Lr = null,
      Rr = null,
      zr = null,
      Br = !1;
    function Vr(e, t, n) {
      var r = n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
      Br ||
        Lr == null ||
        Lr !== Kt(r) ||
        ((r = Lr),
        `selectionStart` in r && Fr(r)
          ? (r = { start: r.selectionStart, end: r.selectionEnd })
          : ((r = ((r.ownerDocument && r.ownerDocument.defaultView) || window).getSelection()),
            (r = {
              anchorNode: r.anchorNode,
              anchorOffset: r.anchorOffset,
              focusNode: r.focusNode,
              focusOffset: r.focusOffset,
            })),
        (zr && Ar(zr, r)) ||
          ((zr = r),
          (r = Dd(Rr, `onSelect`)),
          0 < r.length &&
            ((t = new An(`onSelect`, `select`, null, t, n)),
            e.push({ event: t, listeners: r }),
            (t.target = Lr))));
    }
    function Hr(e, t) {
      var n = {};
      return (
        (n[e.toLowerCase()] = t.toLowerCase()),
        (n[`Webkit` + e] = `webkit` + t),
        (n[`Moz` + e] = `moz` + t),
        n
      );
    }
    var Ur = {
        animationend: Hr(`Animation`, `AnimationEnd`),
        animationiteration: Hr(`Animation`, `AnimationIteration`),
        animationstart: Hr(`Animation`, `AnimationStart`),
        transitionrun: Hr(`Transition`, `TransitionRun`),
        transitionstart: Hr(`Transition`, `TransitionStart`),
        transitioncancel: Hr(`Transition`, `TransitionCancel`),
        transitionend: Hr(`Transition`, `TransitionEnd`),
      },
      Wr = {},
      Gr = {};
    yn &&
      ((Gr = document.createElement(`div`).style),
      `AnimationEvent` in window ||
        (delete Ur.animationend.animation,
        delete Ur.animationiteration.animation,
        delete Ur.animationstart.animation),
      `TransitionEvent` in window || delete Ur.transitionend.transition);
    function Kr(e) {
      if (Wr[e]) return Wr[e];
      if (!Ur[e]) return e;
      var t = Ur[e],
        n;
      for (n in t) if (t.hasOwnProperty(n) && n in Gr) return (Wr[e] = t[n]);
      return e;
    }
    var qr = Kr(`animationend`),
      Jr = Kr(`animationiteration`),
      Yr = Kr(`animationstart`),
      Xr = Kr(`transitionrun`),
      Zr = Kr(`transitionstart`),
      Qr = Kr(`transitioncancel`),
      $r = Kr(`transitionend`),
      ei = new Map(),
      ti =
        `abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel`.split(
          ` `,
        );
    ti.push(`scrollEnd`);
    function ni(e, t) {
      (ei.set(e, t), Mt(t, [e]));
    }
    var ri =
        typeof reportError == `function`
          ? reportError
          : function (e) {
              if (typeof window == `object` && typeof window.ErrorEvent == `function`) {
                var t = new window.ErrorEvent(`error`, {
                  bubbles: !0,
                  cancelable: !0,
                  message:
                    typeof e == `object` && e && typeof e.message == `string`
                      ? String(e.message)
                      : String(e),
                  error: e,
                });
                if (!window.dispatchEvent(t)) return;
              } else if (typeof process == `object` && typeof process.emit == `function`) {
                process.emit(`uncaughtException`, e);
                return;
              }
              console.error(e);
            },
      ii = [],
      ai = 0,
      oi = 0;
    function si() {
      for (var e = ai, t = (oi = ai = 0); t < e; ) {
        var n = ii[t];
        ii[t++] = null;
        var r = ii[t];
        ii[t++] = null;
        var i = ii[t];
        ii[t++] = null;
        var a = ii[t];
        if (((ii[t++] = null), r !== null && i !== null)) {
          var o = r.pending;
          (o === null ? (i.next = i) : ((i.next = o.next), (o.next = i)), (r.pending = i));
        }
        a !== 0 && di(n, i, a);
      }
    }
    function ci(e, t, n, r) {
      ((ii[ai++] = e),
        (ii[ai++] = t),
        (ii[ai++] = n),
        (ii[ai++] = r),
        (oi |= r),
        (e.lanes |= r),
        (e = e.alternate),
        e !== null && (e.lanes |= r));
    }
    function li(e, t, n, r) {
      return (ci(e, t, n, r), fi(e));
    }
    function ui(e, t) {
      return (ci(e, null, null, t), fi(e));
    }
    function di(e, t, n) {
      e.lanes |= n;
      var r = e.alternate;
      r !== null && (r.lanes |= n);
      for (var i = !1, a = e.return; a !== null; )
        ((a.childLanes |= n),
          (r = a.alternate),
          r !== null && (r.childLanes |= n),
          a.tag === 22 && ((e = a.stateNode), e === null || e._visibility & 1 || (i = !0)),
          (e = a),
          (a = a.return));
      return e.tag === 3
        ? ((a = e.stateNode),
          i &&
            t !== null &&
            ((i = 31 - qe(n)),
            (e = a.hiddenUpdates),
            (r = e[i]),
            r === null ? (e[i] = [t]) : r.push(t),
            (t.lane = n | 536870912)),
          a)
        : null;
    }
    function fi(e) {
      if (50 < fu) throw ((fu = 0), (pu = null), Error(o(185)));
      for (var t = e.return; t !== null; ) ((e = t), (t = e.return));
      return e.tag === 3 ? e.stateNode : null;
    }
    var pi = {};
    function mi(e, t, n, r) {
      ((this.tag = e),
        (this.key = n),
        (this.sibling =
          this.child =
          this.return =
          this.stateNode =
          this.type =
          this.elementType =
            null),
        (this.index = 0),
        (this.refCleanup = this.ref = null),
        (this.pendingProps = t),
        (this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null),
        (this.mode = r),
        (this.subtreeFlags = this.flags = 0),
        (this.deletions = null),
        (this.childLanes = this.lanes = 0),
        (this.alternate = null));
    }
    function hi(e, t, n, r) {
      return new mi(e, t, n, r);
    }
    function gi(e) {
      return ((e = e.prototype), !(!e || !e.isReactComponent));
    }
    function _i(e, t) {
      var n = e.alternate;
      return (
        n === null
          ? ((n = hi(e.tag, t, e.key, e.mode)),
            (n.elementType = e.elementType),
            (n.type = e.type),
            (n.stateNode = e.stateNode),
            (n.alternate = e),
            (e.alternate = n))
          : ((n.pendingProps = t),
            (n.type = e.type),
            (n.flags = 0),
            (n.subtreeFlags = 0),
            (n.deletions = null)),
        (n.flags = e.flags & 65011712),
        (n.childLanes = e.childLanes),
        (n.lanes = e.lanes),
        (n.child = e.child),
        (n.memoizedProps = e.memoizedProps),
        (n.memoizedState = e.memoizedState),
        (n.updateQueue = e.updateQueue),
        (t = e.dependencies),
        (n.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }),
        (n.sibling = e.sibling),
        (n.index = e.index),
        (n.ref = e.ref),
        (n.refCleanup = e.refCleanup),
        n
      );
    }
    function vi(e, t) {
      e.flags &= 65011714;
      var n = e.alternate;
      return (
        n === null
          ? ((e.childLanes = 0),
            (e.lanes = t),
            (e.child = null),
            (e.subtreeFlags = 0),
            (e.memoizedProps = null),
            (e.memoizedState = null),
            (e.updateQueue = null),
            (e.dependencies = null),
            (e.stateNode = null))
          : ((e.childLanes = n.childLanes),
            (e.lanes = n.lanes),
            (e.child = n.child),
            (e.subtreeFlags = 0),
            (e.deletions = null),
            (e.memoizedProps = n.memoizedProps),
            (e.memoizedState = n.memoizedState),
            (e.updateQueue = n.updateQueue),
            (e.type = n.type),
            (t = n.dependencies),
            (e.dependencies =
              t === null ? null : { lanes: t.lanes, firstContext: t.firstContext })),
        e
      );
    }
    function yi(e, t, n, r, i, a) {
      var s = 0;
      if (((r = e), typeof e == `function`)) gi(e) && (s = 1);
      else if (typeof e == `string`)
        s = Wf(e, n, k.current) ? 26 : e === `html` || e === `head` || e === `body` ? 27 : 5;
      else
        a: switch (e) {
          case ae:
            return ((e = hi(31, n, t, i)), (e.elementType = ae), (e.lanes = a), e);
          case y:
            return bi(n.children, i, a, t);
          case b:
            ((s = 8), (i |= 24));
            break;
          case x:
            return ((e = hi(12, n, t, i | 2)), (e.elementType = x), (e.lanes = a), e);
          case te:
            return ((e = hi(13, n, t, i)), (e.elementType = te), (e.lanes = a), e);
          case ne:
            return ((e = hi(19, n, t, i)), (e.elementType = ne), (e.lanes = a), e);
          default:
            if (typeof e == `object` && e)
              switch (e.$$typeof) {
                case C:
                  s = 10;
                  break a;
                case S:
                  s = 9;
                  break a;
                case ee:
                  s = 11;
                  break a;
                case re:
                  s = 14;
                  break a;
                case ie:
                  ((s = 16), (r = null));
                  break a;
              }
            ((s = 29), (n = Error(o(130, e === null ? `null` : typeof e, ``))), (r = null));
        }
      return ((t = hi(s, n, t, i)), (t.elementType = e), (t.type = r), (t.lanes = a), t);
    }
    function bi(e, t, n, r) {
      return ((e = hi(7, e, r, t)), (e.lanes = n), e);
    }
    function xi(e, t, n) {
      return ((e = hi(6, e, null, t)), (e.lanes = n), e);
    }
    function Si(e) {
      var t = hi(18, null, null, 0);
      return ((t.stateNode = e), t);
    }
    function Ci(e, t, n) {
      return (
        (t = hi(4, e.children === null ? [] : e.children, e.key, t)),
        (t.lanes = n),
        (t.stateNode = {
          containerInfo: e.containerInfo,
          pendingChildren: null,
          implementation: e.implementation,
        }),
        t
      );
    }
    var wi = new WeakMap();
    function Ti(e, t) {
      if (typeof e == `object` && e) {
        var n = wi.get(e);
        return n === void 0 ? ((t = { value: e, source: t, stack: ke(t) }), wi.set(e, t), t) : n;
      }
      return { value: e, source: t, stack: ke(t) };
    }
    var Ei = [],
      Di = 0,
      Oi = null,
      ki = 0,
      Ai = [],
      ji = 0,
      Mi = null,
      Ni = 1,
      Pi = ``;
    function Fi(e, t) {
      ((Ei[Di++] = ki), (Ei[Di++] = Oi), (Oi = e), (ki = t));
    }
    function Ii(e, t, n) {
      ((Ai[ji++] = Ni), (Ai[ji++] = Pi), (Ai[ji++] = Mi), (Mi = e));
      var r = Ni;
      e = Pi;
      var i = 32 - qe(r) - 1;
      ((r &= ~(1 << i)), (n += 1));
      var a = 32 - qe(t) + i;
      if (30 < a) {
        var o = i - (i % 5);
        ((a = (r & ((1 << o) - 1)).toString(32)),
          (r >>= o),
          (i -= o),
          (Ni = (1 << (32 - qe(t) + i)) | (n << i) | r),
          (Pi = a + e));
      } else ((Ni = (1 << a) | (n << i) | r), (Pi = e));
    }
    function Li(e) {
      e.return !== null && (Fi(e, 1), Ii(e, 1, 0));
    }
    function Ri(e) {
      for (; e === Oi; ) ((Oi = Ei[--Di]), (Ei[Di] = null), (ki = Ei[--Di]), (Ei[Di] = null));
      for (; e === Mi; )
        ((Mi = Ai[--ji]),
          (Ai[ji] = null),
          (Pi = Ai[--ji]),
          (Ai[ji] = null),
          (Ni = Ai[--ji]),
          (Ai[ji] = null));
    }
    function zi(e, t) {
      ((Ai[ji++] = Ni), (Ai[ji++] = Pi), (Ai[ji++] = Mi), (Ni = t.id), (Pi = t.overflow), (Mi = e));
    }
    var Bi = null,
      N = null,
      P = !1,
      Vi = null,
      Hi = !1,
      Ui = Error(o(519));
    function Wi(e) {
      throw (
        Xi(
          Ti(
            Error(
              o(
                418,
                1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? `text` : `HTML`,
                ``,
              ),
            ),
            e,
          ),
        ),
        Ui
      );
    }
    function Gi(e) {
      var t = e.stateNode,
        n = e.type,
        r = e.memoizedProps;
      switch (((t[gt] = e), (t[_t] = r), n)) {
        case `dialog`:
          (Q(`cancel`, t), Q(`close`, t));
          break;
        case `iframe`:
        case `object`:
        case `embed`:
          Q(`load`, t);
          break;
        case `video`:
        case `audio`:
          for (n = 0; n < vd.length; n++) Q(vd[n], t);
          break;
        case `source`:
          Q(`error`, t);
          break;
        case `img`:
        case `image`:
        case `link`:
          (Q(`error`, t), Q(`load`, t));
          break;
        case `details`:
          Q(`toggle`, t);
          break;
        case `input`:
          (Q(`invalid`, t),
            Xt(t, r.value, r.defaultValue, r.checked, r.defaultChecked, r.type, r.name, !0));
          break;
        case `select`:
          Q(`invalid`, t);
          break;
        case `textarea`:
          (Q(`invalid`, t), en(t, r.value, r.defaultValue, r.children));
      }
      ((n = r.children),
        (typeof n != `string` && typeof n != `number` && typeof n != `bigint`) ||
        t.textContent === `` + n ||
        !0 === r.suppressHydrationWarning ||
        Nd(t.textContent, n)
          ? (r.popover != null && (Q(`beforetoggle`, t), Q(`toggle`, t)),
            r.onScroll != null && Q(`scroll`, t),
            r.onScrollEnd != null && Q(`scrollend`, t),
            r.onClick != null && (t.onclick = un),
            (t = !0))
          : (t = !1),
        t || Wi(e, !0));
    }
    function Ki(e) {
      for (Bi = e.return; Bi; )
        switch (Bi.tag) {
          case 5:
          case 31:
          case 13:
            Hi = !1;
            return;
          case 27:
          case 3:
            Hi = !0;
            return;
          default:
            Bi = Bi.return;
        }
    }
    function qi(e) {
      if (e !== Bi) return !1;
      if (!P) return (Ki(e), (P = !0), !1);
      var t = e.tag,
        n;
      if (
        ((n = t !== 3 && t !== 27) &&
          ((n = t === 5) &&
            ((n = e.type), (n = !(n !== `form` && n !== `button`) || Wd(e.type, e.memoizedProps))),
          (n = !n)),
        n && N && Wi(e),
        Ki(e),
        t === 13)
      ) {
        if (((e = e.memoizedState), (e = e === null ? null : e.dehydrated), !e))
          throw Error(o(317));
        N = df(e);
      } else if (t === 31) {
        if (((e = e.memoizedState), (e = e === null ? null : e.dehydrated), !e))
          throw Error(o(317));
        N = df(e);
      } else
        t === 27
          ? ((t = N), Qd(e.type) ? ((e = uf), (uf = null), (N = e)) : (N = t))
          : (N = Bi ? lf(e.stateNode.nextSibling) : null);
      return !0;
    }
    function Ji() {
      ((N = Bi = null), (P = !1));
    }
    function Yi() {
      var e = Vi;
      return (e !== null && (Ql === null ? (Ql = e) : Ql.push.apply(Ql, e), (Vi = null)), e);
    }
    function Xi(e) {
      Vi === null ? (Vi = [e]) : Vi.push(e);
    }
    var Zi = he(null),
      Qi = null,
      $i = null;
    function ea(e, t, n) {
      (O(Zi, t._currentValue), (t._currentValue = n));
    }
    function ta(e) {
      ((e._currentValue = Zi.current), D(Zi));
    }
    function na(e, t, n) {
      for (; e !== null; ) {
        var r = e.alternate;
        if (
          ((e.childLanes & t) === t
            ? r !== null && (r.childLanes & t) !== t && (r.childLanes |= t)
            : ((e.childLanes |= t), r !== null && (r.childLanes |= t)),
          e === n)
        )
          break;
        e = e.return;
      }
    }
    function ra(e, t, n, r) {
      var i = e.child;
      for (i !== null && (i.return = e); i !== null; ) {
        var a = i.dependencies;
        if (a !== null) {
          var s = i.child;
          a = a.firstContext;
          a: for (; a !== null; ) {
            var c = a;
            a = i;
            for (var l = 0; l < t.length; l++)
              if (c.context === t[l]) {
                ((a.lanes |= n),
                  (c = a.alternate),
                  c !== null && (c.lanes |= n),
                  na(a.return, n, e),
                  r || (s = null));
                break a;
              }
            a = c.next;
          }
        } else if (i.tag === 18) {
          if (((s = i.return), s === null)) throw Error(o(341));
          ((s.lanes |= n),
            (a = s.alternate),
            a !== null && (a.lanes |= n),
            na(s, n, e),
            (s = null));
        } else s = i.child;
        if (s !== null) s.return = i;
        else
          for (s = i; s !== null; ) {
            if (s === e) {
              s = null;
              break;
            }
            if (((i = s.sibling), i !== null)) {
              ((i.return = s.return), (s = i));
              break;
            }
            s = s.return;
          }
        i = s;
      }
    }
    function ia(e, t, n, r) {
      e = null;
      for (var i = t, a = !1; i !== null; ) {
        if (!a) {
          if (i.flags & 524288) a = !0;
          else if (i.flags & 262144) break;
        }
        if (i.tag === 10) {
          var s = i.alternate;
          if (s === null) throw Error(o(387));
          if (((s = s.memoizedProps), s !== null)) {
            var c = i.type;
            kr(i.pendingProps.value, s.value) || (e === null ? (e = [c]) : e.push(c));
          }
        } else if (i === ve.current) {
          if (((s = i.alternate), s === null)) throw Error(o(387));
          s.memoizedState.memoizedState !== i.memoizedState.memoizedState &&
            (e === null ? (e = [$f]) : e.push($f));
        }
        i = i.return;
      }
      (e !== null && ra(t, e, n, r), (t.flags |= 262144));
    }
    function aa(e) {
      for (e = e.firstContext; e !== null; ) {
        if (!kr(e.context._currentValue, e.memoizedValue)) return !0;
        e = e.next;
      }
      return !1;
    }
    function oa(e) {
      ((Qi = e), ($i = null), (e = e.dependencies), e !== null && (e.firstContext = null));
    }
    function sa(e) {
      return la(Qi, e);
    }
    function ca(e, t) {
      return (Qi === null && oa(e), la(e, t));
    }
    function la(e, t) {
      var n = t._currentValue;
      if (((t = { context: t, memoizedValue: n, next: null }), $i === null)) {
        if (e === null) throw Error(o(308));
        (($i = t), (e.dependencies = { lanes: 0, firstContext: t }), (e.flags |= 524288));
      } else $i = $i.next = t;
      return n;
    }
    var ua =
        typeof AbortController < `u`
          ? AbortController
          : function () {
              var e = [],
                t = (this.signal = {
                  aborted: !1,
                  addEventListener: function (t, n) {
                    e.push(n);
                  },
                });
              this.abort = function () {
                ((t.aborted = !0),
                  e.forEach(function (e) {
                    return e();
                  }));
              };
            },
      da = n.unstable_scheduleCallback,
      fa = n.unstable_NormalPriority,
      pa = {
        $$typeof: C,
        Consumer: null,
        Provider: null,
        _currentValue: null,
        _currentValue2: null,
        _threadCount: 0,
      };
    function ma() {
      return { controller: new ua(), data: new Map(), refCount: 0 };
    }
    function F(e) {
      (e.refCount--,
        e.refCount === 0 &&
          da(fa, function () {
            e.controller.abort();
          }));
    }
    var ha = null,
      ga = 0,
      _a = 0,
      va = null;
    function ya(e, t) {
      if (ha === null) {
        var n = (ha = []);
        ((ga = 0),
          (_a = fd()),
          (va = {
            status: `pending`,
            value: void 0,
            then: function (e) {
              n.push(e);
            },
          }));
      }
      return (ga++, t.then(ba, ba), t);
    }
    function ba() {
      if (--ga === 0 && ha !== null) {
        va !== null && (va.status = `fulfilled`);
        var e = ha;
        ((ha = null), (_a = 0), (va = null));
        for (var t = 0; t < e.length; t++) (0, e[t])();
      }
    }
    function xa(e, t) {
      var n = [],
        r = {
          status: `pending`,
          value: null,
          reason: null,
          then: function (e) {
            n.push(e);
          },
        };
      return (
        e.then(
          function () {
            ((r.status = `fulfilled`), (r.value = t));
            for (var e = 0; e < n.length; e++) (0, n[e])(t);
          },
          function (e) {
            for (r.status = `rejected`, r.reason = e, e = 0; e < n.length; e++) (0, n[e])(void 0);
          },
        ),
        r
      );
    }
    var Sa = w.S;
    w.S = function (e, t) {
      ((tu = Fe()),
        typeof t == `object` && t && typeof t.then == `function` && ya(e, t),
        Sa !== null && Sa(e, t));
    };
    var Ca = he(null);
    function wa() {
      var e = Ca.current;
      return e === null ? K.pooledCache : e;
    }
    function Ta(e, t) {
      t === null ? O(Ca, Ca.current) : O(Ca, t.pool);
    }
    function Ea() {
      var e = wa();
      return e === null ? null : { parent: pa._currentValue, pool: e };
    }
    var Da = Error(o(460)),
      Oa = Error(o(474)),
      ka = Error(o(542)),
      Aa = { then: function () {} };
    function ja(e) {
      return ((e = e.status), e === `fulfilled` || e === `rejected`);
    }
    function Ma(e, t, n) {
      switch (
        ((n = e[n]), n === void 0 ? e.push(t) : n !== t && (t.then(un, un), (t = n)), t.status)
      ) {
        case `fulfilled`:
          return t.value;
        case `rejected`:
          throw ((e = t.reason), Ia(e), e);
        default:
          if (typeof t.status == `string`) t.then(un, un);
          else {
            if (((e = K), e !== null && 100 < e.shellSuspendCounter)) throw Error(o(482));
            ((e = t),
              (e.status = `pending`),
              e.then(
                function (e) {
                  if (t.status === `pending`) {
                    var n = t;
                    ((n.status = `fulfilled`), (n.value = e));
                  }
                },
                function (e) {
                  if (t.status === `pending`) {
                    var n = t;
                    ((n.status = `rejected`), (n.reason = e));
                  }
                },
              ));
          }
          switch (t.status) {
            case `fulfilled`:
              return t.value;
            case `rejected`:
              throw ((e = t.reason), Ia(e), e);
          }
          throw ((Pa = t), Da);
      }
    }
    function Na(e) {
      try {
        var t = e._init;
        return t(e._payload);
      } catch (e) {
        throw typeof e == `object` && e && typeof e.then == `function` ? ((Pa = e), Da) : e;
      }
    }
    var Pa = null;
    function Fa() {
      if (Pa === null) throw Error(o(459));
      var e = Pa;
      return ((Pa = null), e);
    }
    function Ia(e) {
      if (e === Da || e === ka) throw Error(o(483));
    }
    var La = null,
      Ra = 0;
    function za(e) {
      var t = Ra;
      return ((Ra += 1), La === null && (La = []), Ma(La, e, t));
    }
    function Ba(e, t) {
      ((t = t.props.ref), (e.ref = t === void 0 ? null : t));
    }
    function Va(e, t) {
      throw t.$$typeof === g
        ? Error(o(525))
        : ((e = Object.prototype.toString.call(t)),
          Error(
            o(
              31,
              e === `[object Object]` ? `object with keys {` + Object.keys(t).join(`, `) + `}` : e,
            ),
          ));
    }
    function Ha(e) {
      function t(t, n) {
        if (e) {
          var r = t.deletions;
          r === null ? ((t.deletions = [n]), (t.flags |= 16)) : r.push(n);
        }
      }
      function n(n, r) {
        if (!e) return null;
        for (; r !== null; ) (t(n, r), (r = r.sibling));
        return null;
      }
      function r(e) {
        for (var t = new Map(); e !== null; )
          (e.key === null ? t.set(e.index, e) : t.set(e.key, e), (e = e.sibling));
        return t;
      }
      function i(e, t) {
        return ((e = _i(e, t)), (e.index = 0), (e.sibling = null), e);
      }
      function a(t, n, r) {
        return (
          (t.index = r),
          e
            ? ((r = t.alternate),
              r === null
                ? ((t.flags |= 67108866), n)
                : ((r = r.index), r < n ? ((t.flags |= 67108866), n) : r))
            : ((t.flags |= 1048576), n)
        );
      }
      function s(t) {
        return (e && t.alternate === null && (t.flags |= 67108866), t);
      }
      function c(e, t, n, r) {
        return t === null || t.tag !== 6
          ? ((t = xi(n, e.mode, r)), (t.return = e), t)
          : ((t = i(t, n)), (t.return = e), t);
      }
      function l(e, t, n, r) {
        var a = n.type;
        return a === y
          ? d(e, t, n.props.children, r, n.key)
          : t !== null &&
              (t.elementType === a ||
                (typeof a == `object` && a && a.$$typeof === ie && Na(a) === t.type))
            ? ((t = i(t, n.props)), Ba(t, n), (t.return = e), t)
            : ((t = yi(n.type, n.key, n.props, null, e.mode, r)), Ba(t, n), (t.return = e), t);
      }
      function u(e, t, n, r) {
        return t === null ||
          t.tag !== 4 ||
          t.stateNode.containerInfo !== n.containerInfo ||
          t.stateNode.implementation !== n.implementation
          ? ((t = Ci(n, e.mode, r)), (t.return = e), t)
          : ((t = i(t, n.children || [])), (t.return = e), t);
      }
      function d(e, t, n, r, a) {
        return t === null || t.tag !== 7
          ? ((t = bi(n, e.mode, r, a)), (t.return = e), t)
          : ((t = i(t, n)), (t.return = e), t);
      }
      function f(e, t, n) {
        if ((typeof t == `string` && t !== ``) || typeof t == `number` || typeof t == `bigint`)
          return ((t = xi(`` + t, e.mode, n)), (t.return = e), t);
        if (typeof t == `object` && t) {
          switch (t.$$typeof) {
            case _:
              return (
                (n = yi(t.type, t.key, t.props, null, e.mode, n)), Ba(n, t), (n.return = e), n
              );
            case v:
              return ((t = Ci(t, e.mode, n)), (t.return = e), t);
            case ie:
              return ((t = Na(t)), f(e, t, n));
          }
          if (de(t) || ce(t)) return ((t = bi(t, e.mode, n, null)), (t.return = e), t);
          if (typeof t.then == `function`) return f(e, za(t), n);
          if (t.$$typeof === C) return f(e, ca(e, t), n);
          Va(e, t);
        }
        return null;
      }
      function p(e, t, n, r) {
        var i = t === null ? null : t.key;
        if ((typeof n == `string` && n !== ``) || typeof n == `number` || typeof n == `bigint`)
          return i === null ? c(e, t, `` + n, r) : null;
        if (typeof n == `object` && n) {
          switch (n.$$typeof) {
            case _:
              return n.key === i ? l(e, t, n, r) : null;
            case v:
              return n.key === i ? u(e, t, n, r) : null;
            case ie:
              return ((n = Na(n)), p(e, t, n, r));
          }
          if (de(n) || ce(n)) return i === null ? d(e, t, n, r, null) : null;
          if (typeof n.then == `function`) return p(e, t, za(n), r);
          if (n.$$typeof === C) return p(e, t, ca(e, n), r);
          Va(e, n);
        }
        return null;
      }
      function m(e, t, n, r, i) {
        if ((typeof r == `string` && r !== ``) || typeof r == `number` || typeof r == `bigint`)
          return ((e = e.get(n) || null), c(t, e, `` + r, i));
        if (typeof r == `object` && r) {
          switch (r.$$typeof) {
            case _:
              return ((e = e.get(r.key === null ? n : r.key) || null), l(t, e, r, i));
            case v:
              return ((e = e.get(r.key === null ? n : r.key) || null), u(t, e, r, i));
            case ie:
              return ((r = Na(r)), m(e, t, n, r, i));
          }
          if (de(r) || ce(r)) return ((e = e.get(n) || null), d(t, e, r, i, null));
          if (typeof r.then == `function`) return m(e, t, n, za(r), i);
          if (r.$$typeof === C) return m(e, t, n, ca(t, r), i);
          Va(t, r);
        }
        return null;
      }
      function h(i, o, s, c) {
        for (
          var l = null, u = null, d = o, h = (o = 0), g = null;
          d !== null && h < s.length;
          h++
        ) {
          d.index > h ? ((g = d), (d = null)) : (g = d.sibling);
          var _ = p(i, d, s[h], c);
          if (_ === null) {
            d === null && (d = g);
            break;
          }
          (e && d && _.alternate === null && t(i, d),
            (o = a(_, o, h)),
            u === null ? (l = _) : (u.sibling = _),
            (u = _),
            (d = g));
        }
        if (h === s.length) return (n(i, d), P && Fi(i, h), l);
        if (d === null) {
          for (; h < s.length; h++)
            ((d = f(i, s[h], c)),
              d !== null && ((o = a(d, o, h)), u === null ? (l = d) : (u.sibling = d), (u = d)));
          return (P && Fi(i, h), l);
        }
        for (d = r(d); h < s.length; h++)
          ((g = m(d, i, h, s[h], c)),
            g !== null &&
              (e && g.alternate !== null && d.delete(g.key === null ? h : g.key),
              (o = a(g, o, h)),
              u === null ? (l = g) : (u.sibling = g),
              (u = g)));
        return (
          e &&
            d.forEach(function (e) {
              return t(i, e);
            }),
          P && Fi(i, h),
          l
        );
      }
      function g(i, s, c, l) {
        if (c == null) throw Error(o(151));
        for (
          var u = null, d = null, h = s, g = (s = 0), _ = null, v = c.next();
          h !== null && !v.done;
          g++, v = c.next()
        ) {
          h.index > g ? ((_ = h), (h = null)) : (_ = h.sibling);
          var y = p(i, h, v.value, l);
          if (y === null) {
            h === null && (h = _);
            break;
          }
          (e && h && y.alternate === null && t(i, h),
            (s = a(y, s, g)),
            d === null ? (u = y) : (d.sibling = y),
            (d = y),
            (h = _));
        }
        if (v.done) return (n(i, h), P && Fi(i, g), u);
        if (h === null) {
          for (; !v.done; g++, v = c.next())
            ((v = f(i, v.value, l)),
              v !== null && ((s = a(v, s, g)), d === null ? (u = v) : (d.sibling = v), (d = v)));
          return (P && Fi(i, g), u);
        }
        for (h = r(h); !v.done; g++, v = c.next())
          ((v = m(h, i, g, v.value, l)),
            v !== null &&
              (e && v.alternate !== null && h.delete(v.key === null ? g : v.key),
              (s = a(v, s, g)),
              d === null ? (u = v) : (d.sibling = v),
              (d = v)));
        return (
          e &&
            h.forEach(function (e) {
              return t(i, e);
            }),
          P && Fi(i, g),
          u
        );
      }
      function b(e, r, a, c) {
        if (
          (typeof a == `object` && a && a.type === y && a.key === null && (a = a.props.children),
          typeof a == `object` && a)
        ) {
          switch (a.$$typeof) {
            case _:
              a: {
                for (var l = a.key; r !== null; ) {
                  if (r.key === l) {
                    if (((l = a.type), l === y)) {
                      if (r.tag === 7) {
                        (n(e, r.sibling), (c = i(r, a.props.children)), (c.return = e), (e = c));
                        break a;
                      }
                    } else if (
                      r.elementType === l ||
                      (typeof l == `object` && l && l.$$typeof === ie && Na(l) === r.type)
                    ) {
                      (n(e, r.sibling), (c = i(r, a.props)), Ba(c, a), (c.return = e), (e = c));
                      break a;
                    }
                    n(e, r);
                    break;
                  } else t(e, r);
                  r = r.sibling;
                }
                a.type === y
                  ? ((c = bi(a.props.children, e.mode, c, a.key)), (c.return = e), (e = c))
                  : ((c = yi(a.type, a.key, a.props, null, e.mode, c)),
                    Ba(c, a),
                    (c.return = e),
                    (e = c));
              }
              return s(e);
            case v:
              a: {
                for (l = a.key; r !== null; ) {
                  if (r.key === l)
                    if (
                      r.tag === 4 &&
                      r.stateNode.containerInfo === a.containerInfo &&
                      r.stateNode.implementation === a.implementation
                    ) {
                      (n(e, r.sibling), (c = i(r, a.children || [])), (c.return = e), (e = c));
                      break a;
                    } else {
                      n(e, r);
                      break;
                    }
                  else t(e, r);
                  r = r.sibling;
                }
                ((c = Ci(a, e.mode, c)), (c.return = e), (e = c));
              }
              return s(e);
            case ie:
              return ((a = Na(a)), b(e, r, a, c));
          }
          if (de(a)) return h(e, r, a, c);
          if (ce(a)) {
            if (((l = ce(a)), typeof l != `function`)) throw Error(o(150));
            return ((a = l.call(a)), g(e, r, a, c));
          }
          if (typeof a.then == `function`) return b(e, r, za(a), c);
          if (a.$$typeof === C) return b(e, r, ca(e, a), c);
          Va(e, a);
        }
        return (typeof a == `string` && a !== ``) || typeof a == `number` || typeof a == `bigint`
          ? ((a = `` + a),
            r !== null && r.tag === 6
              ? (n(e, r.sibling), (c = i(r, a)), (c.return = e), (e = c))
              : (n(e, r), (c = xi(a, e.mode, c)), (c.return = e), (e = c)),
            s(e))
          : n(e, r);
      }
      return function (e, t, n, r) {
        try {
          Ra = 0;
          var i = b(e, t, n, r);
          return ((La = null), i);
        } catch (t) {
          if (t === Da || t === ka) throw t;
          var a = hi(29, t, null, e.mode);
          return ((a.lanes = r), (a.return = e), a);
        }
      };
    }
    var Ua = Ha(!0),
      Wa = Ha(!1),
      Ga = !1;
    function Ka(e) {
      e.updateQueue = {
        baseState: e.memoizedState,
        firstBaseUpdate: null,
        lastBaseUpdate: null,
        shared: { pending: null, lanes: 0, hiddenCallbacks: null },
        callbacks: null,
      };
    }
    function qa(e, t) {
      ((e = e.updateQueue),
        t.updateQueue === e &&
          (t.updateQueue = {
            baseState: e.baseState,
            firstBaseUpdate: e.firstBaseUpdate,
            lastBaseUpdate: e.lastBaseUpdate,
            shared: e.shared,
            callbacks: null,
          }));
    }
    function Ja(e) {
      return { lane: e, tag: 0, payload: null, callback: null, next: null };
    }
    function I(e, t, n) {
      var r = e.updateQueue;
      if (r === null) return null;
      if (((r = r.shared), G & 2)) {
        var i = r.pending;
        return (
          i === null ? (t.next = t) : ((t.next = i.next), (i.next = t)),
          (r.pending = t),
          (t = fi(e)),
          di(e, null, n),
          t
        );
      }
      return (ci(e, r, t, n), fi(e));
    }
    function Ya(e, t, n) {
      if (((t = t.updateQueue), t !== null && ((t = t.shared), n & 4194048))) {
        var r = t.lanes;
        ((r &= e.pendingLanes), (n |= r), (t.lanes = n), lt(e, n));
      }
    }
    function Xa(e, t) {
      var n = e.updateQueue,
        r = e.alternate;
      if (r !== null && ((r = r.updateQueue), n === r)) {
        var i = null,
          a = null;
        if (((n = n.firstBaseUpdate), n !== null)) {
          do {
            var o = { lane: n.lane, tag: n.tag, payload: n.payload, callback: null, next: null };
            (a === null ? (i = a = o) : (a = a.next = o), (n = n.next));
          } while (n !== null);
          a === null ? (i = a = t) : (a = a.next = t);
        } else i = a = t;
        ((n = {
          baseState: r.baseState,
          firstBaseUpdate: i,
          lastBaseUpdate: a,
          shared: r.shared,
          callbacks: r.callbacks,
        }),
          (e.updateQueue = n));
        return;
      }
      ((e = n.lastBaseUpdate),
        e === null ? (n.firstBaseUpdate = t) : (e.next = t),
        (n.lastBaseUpdate = t));
    }
    var Za = !1;
    function Qa() {
      if (Za) {
        var e = va;
        if (e !== null) throw e;
      }
    }
    function $a(e, t, n, r) {
      Za = !1;
      var i = e.updateQueue;
      Ga = !1;
      var a = i.firstBaseUpdate,
        o = i.lastBaseUpdate,
        s = i.shared.pending;
      if (s !== null) {
        i.shared.pending = null;
        var c = s,
          l = c.next;
        ((c.next = null), o === null ? (a = l) : (o.next = l), (o = c));
        var u = e.alternate;
        u !== null &&
          ((u = u.updateQueue),
          (s = u.lastBaseUpdate),
          s !== o && (s === null ? (u.firstBaseUpdate = l) : (s.next = l), (u.lastBaseUpdate = c)));
      }
      if (a !== null) {
        var d = i.baseState;
        ((o = 0), (u = l = c = null), (s = a));
        do {
          var f = s.lane & -536870913,
            p = f !== s.lane;
          if (p ? (J & f) === f : (r & f) === f) {
            (f !== 0 && f === _a && (Za = !0),
              u !== null &&
                (u = u.next =
                  { lane: 0, tag: s.tag, payload: s.payload, callback: null, next: null }));
            a: {
              var m = e,
                g = s;
              f = t;
              var _ = n;
              switch (g.tag) {
                case 1:
                  if (((m = g.payload), typeof m == `function`)) {
                    d = m.call(_, d, f);
                    break a;
                  }
                  d = m;
                  break a;
                case 3:
                  m.flags = (m.flags & -65537) | 128;
                case 0:
                  if (
                    ((m = g.payload), (f = typeof m == `function` ? m.call(_, d, f) : m), f == null)
                  )
                    break a;
                  d = h({}, d, f);
                  break a;
                case 2:
                  Ga = !0;
              }
            }
            ((f = s.callback),
              f !== null &&
                ((e.flags |= 64),
                p && (e.flags |= 8192),
                (p = i.callbacks),
                p === null ? (i.callbacks = [f]) : p.push(f)));
          } else
            ((p = { lane: f, tag: s.tag, payload: s.payload, callback: s.callback, next: null }),
              u === null ? ((l = u = p), (c = d)) : (u = u.next = p),
              (o |= f));
          if (((s = s.next), s === null)) {
            if (((s = i.shared.pending), s === null)) break;
            ((p = s),
              (s = p.next),
              (p.next = null),
              (i.lastBaseUpdate = p),
              (i.shared.pending = null));
          }
        } while (1);
        (u === null && (c = d),
          (i.baseState = c),
          (i.firstBaseUpdate = l),
          (i.lastBaseUpdate = u),
          a === null && (i.shared.lanes = 0),
          (Kl |= o),
          (e.lanes = o),
          (e.memoizedState = d));
      }
    }
    function eo(e, t) {
      if (typeof e != `function`) throw Error(o(191, e));
      e.call(t);
    }
    function to(e, t) {
      var n = e.callbacks;
      if (n !== null) for (e.callbacks = null, e = 0; e < n.length; e++) eo(n[e], t);
    }
    var no = he(null),
      ro = he(0);
    function io(e, t) {
      ((e = Gl), O(ro, e), O(no, t), (Gl = e | t.baseLanes));
    }
    function ao() {
      (O(ro, Gl), O(no, no.current));
    }
    function oo() {
      ((Gl = ro.current), D(no), D(ro));
    }
    var so = he(null),
      co = null;
    function lo(e) {
      var t = e.alternate;
      (O(ho, ho.current & 1),
        O(so, e),
        co === null && (t === null || no.current !== null || t.memoizedState !== null) && (co = e));
    }
    function uo(e) {
      (O(ho, ho.current), O(so, e), co === null && (co = e));
    }
    function fo(e) {
      e.tag === 22 ? (O(ho, ho.current), O(so, e), co === null && (co = e)) : po(e);
    }
    function po() {
      (O(ho, ho.current), O(so, so.current));
    }
    function mo(e) {
      (D(so), co === e && (co = null), D(ho));
    }
    var ho = he(0);
    function go(e) {
      for (var t = e; t !== null; ) {
        if (t.tag === 13) {
          var n = t.memoizedState;
          if (n !== null && ((n = n.dehydrated), n === null || of(n) || sf(n))) return t;
        } else if (
          t.tag === 19 &&
          (t.memoizedProps.revealOrder === `forwards` ||
            t.memoizedProps.revealOrder === `backwards` ||
            t.memoizedProps.revealOrder === `unstable_legacy-backwards` ||
            t.memoizedProps.revealOrder === `together`)
        ) {
          if (t.flags & 128) return t;
        } else if (t.child !== null) {
          ((t.child.return = t), (t = t.child));
          continue;
        }
        if (t === e) break;
        for (; t.sibling === null; ) {
          if (t.return === null || t.return === e) return null;
          t = t.return;
        }
        ((t.sibling.return = t.return), (t = t.sibling));
      }
      return null;
    }
    var _o = 0,
      L = null,
      R = null,
      vo = null,
      yo = !1,
      bo = !1,
      xo = !1,
      So = 0,
      Co = 0,
      wo = null,
      To = 0;
    function z() {
      throw Error(o(321));
    }
    function Eo(e, t) {
      if (t === null) return !1;
      for (var n = 0; n < t.length && n < e.length; n++) if (!kr(e[n], t[n])) return !1;
      return !0;
    }
    function Do(e, t, n, r, i, a) {
      return (
        (_o = a),
        (L = t),
        (t.memoizedState = null),
        (t.updateQueue = null),
        (t.lanes = 0),
        (w.H = e === null || e.memoizedState === null ? Vs : Hs),
        (xo = !1),
        (a = n(r, i)),
        (xo = !1),
        bo && (a = ko(t, n, r, i)),
        Oo(e),
        a
      );
    }
    function Oo(e) {
      w.H = Bs;
      var t = R !== null && R.next !== null;
      if (((_o = 0), (vo = R = L = null), (yo = !1), (Co = 0), (wo = null), t)) throw Error(o(300));
      e === null || ac || ((e = e.dependencies), e !== null && aa(e) && (ac = !0));
    }
    function ko(e, t, n, r) {
      L = e;
      var i = 0;
      do {
        if ((bo && (wo = null), (Co = 0), (bo = !1), 25 <= i)) throw Error(o(301));
        if (((i += 1), (vo = R = null), e.updateQueue != null)) {
          var a = e.updateQueue;
          ((a.lastEffect = null),
            (a.events = null),
            (a.stores = null),
            a.memoCache != null && (a.memoCache.index = 0));
        }
        ((w.H = Us), (a = t(n, r)));
      } while (bo);
      return a;
    }
    function Ao() {
      var e = w.H,
        t = e.useState()[0];
      return (
        (t = typeof t.then == `function` ? Lo(t) : t),
        (e = e.useState()[0]),
        (R === null ? null : R.memoizedState) !== e && (L.flags |= 1024),
        t
      );
    }
    function jo() {
      var e = So !== 0;
      return ((So = 0), e);
    }
    function Mo(e, t, n) {
      ((t.updateQueue = e.updateQueue), (t.flags &= -2053), (e.lanes &= ~n));
    }
    function No(e) {
      if (yo) {
        for (e = e.memoizedState; e !== null; ) {
          var t = e.queue;
          (t !== null && (t.pending = null), (e = e.next));
        }
        yo = !1;
      }
      ((_o = 0), (vo = R = L = null), (bo = !1), (Co = So = 0), (wo = null));
    }
    function Po() {
      var e = { memoizedState: null, baseState: null, baseQueue: null, queue: null, next: null };
      return (vo === null ? (L.memoizedState = vo = e) : (vo = vo.next = e), vo);
    }
    function Fo() {
      if (R === null) {
        var e = L.alternate;
        e = e === null ? null : e.memoizedState;
      } else e = R.next;
      var t = vo === null ? L.memoizedState : vo.next;
      if (t !== null) ((vo = t), (R = e));
      else {
        if (e === null) throw L.alternate === null ? Error(o(467)) : Error(o(310));
        ((R = e),
          (e = {
            memoizedState: R.memoizedState,
            baseState: R.baseState,
            baseQueue: R.baseQueue,
            queue: R.queue,
            next: null,
          }),
          vo === null ? (L.memoizedState = vo = e) : (vo = vo.next = e));
      }
      return vo;
    }
    function Io() {
      return { lastEffect: null, events: null, stores: null, memoCache: null };
    }
    function Lo(e) {
      var t = Co;
      return (
        (Co += 1),
        wo === null && (wo = []),
        (e = Ma(wo, e, t)),
        (t = L),
        (vo === null ? t.memoizedState : vo.next) === null &&
          ((t = t.alternate), (w.H = t === null || t.memoizedState === null ? Vs : Hs)),
        e
      );
    }
    function Ro(e) {
      if (typeof e == `object` && e) {
        if (typeof e.then == `function`) return Lo(e);
        if (e.$$typeof === C) return sa(e);
      }
      throw Error(o(438, String(e)));
    }
    function zo(e) {
      var t = null,
        n = L.updateQueue;
      if ((n !== null && (t = n.memoCache), t == null)) {
        var r = L.alternate;
        r !== null &&
          ((r = r.updateQueue),
          r !== null &&
            ((r = r.memoCache),
            r != null &&
              (t = {
                data: r.data.map(function (e) {
                  return e.slice();
                }),
                index: 0,
              })));
      }
      if (
        ((t ??= { data: [], index: 0 }),
        n === null && ((n = Io()), (L.updateQueue = n)),
        (n.memoCache = t),
        (n = t.data[t.index]),
        n === void 0)
      )
        for (n = t.data[t.index] = Array(e), r = 0; r < e; r++) n[r] = oe;
      return (t.index++, n);
    }
    function Bo(e, t) {
      return typeof t == `function` ? t(e) : t;
    }
    function Vo(e) {
      return Ho(Fo(), R, e);
    }
    function Ho(e, t, n) {
      var r = e.queue;
      if (r === null) throw Error(o(311));
      r.lastRenderedReducer = n;
      var i = e.baseQueue,
        a = r.pending;
      if (a !== null) {
        if (i !== null) {
          var s = i.next;
          ((i.next = a.next), (a.next = s));
        }
        ((t.baseQueue = i = a), (r.pending = null));
      }
      if (((a = e.baseState), i === null)) e.memoizedState = a;
      else {
        t = i.next;
        var c = (s = null),
          l = null,
          u = t,
          d = !1;
        do {
          var f = u.lane & -536870913;
          if (f === u.lane ? (_o & f) === f : (J & f) === f) {
            var p = u.revertLane;
            if (p === 0)
              (l !== null &&
                (l = l.next =
                  {
                    lane: 0,
                    revertLane: 0,
                    gesture: null,
                    action: u.action,
                    hasEagerState: u.hasEagerState,
                    eagerState: u.eagerState,
                    next: null,
                  }),
                f === _a && (d = !0));
            else if ((_o & p) === p) {
              ((u = u.next), p === _a && (d = !0));
              continue;
            } else
              ((f = {
                lane: 0,
                revertLane: u.revertLane,
                gesture: null,
                action: u.action,
                hasEagerState: u.hasEagerState,
                eagerState: u.eagerState,
                next: null,
              }),
                l === null ? ((c = l = f), (s = a)) : (l = l.next = f),
                (L.lanes |= p),
                (Kl |= p));
            ((f = u.action), xo && n(a, f), (a = u.hasEagerState ? u.eagerState : n(a, f)));
          } else
            ((p = {
              lane: f,
              revertLane: u.revertLane,
              gesture: u.gesture,
              action: u.action,
              hasEagerState: u.hasEagerState,
              eagerState: u.eagerState,
              next: null,
            }),
              l === null ? ((c = l = p), (s = a)) : (l = l.next = p),
              (L.lanes |= f),
              (Kl |= f));
          u = u.next;
        } while (u !== null && u !== t);
        if (
          (l === null ? (s = a) : (l.next = c),
          !kr(a, e.memoizedState) && ((ac = !0), d && ((n = va), n !== null)))
        )
          throw n;
        ((e.memoizedState = a), (e.baseState = s), (e.baseQueue = l), (r.lastRenderedState = a));
      }
      return (i === null && (r.lanes = 0), [e.memoizedState, r.dispatch]);
    }
    function Uo(e) {
      var t = Fo(),
        n = t.queue;
      if (n === null) throw Error(o(311));
      n.lastRenderedReducer = e;
      var r = n.dispatch,
        i = n.pending,
        a = t.memoizedState;
      if (i !== null) {
        n.pending = null;
        var s = (i = i.next);
        do ((a = e(a, s.action)), (s = s.next));
        while (s !== i);
        (kr(a, t.memoizedState) || (ac = !0),
          (t.memoizedState = a),
          t.baseQueue === null && (t.baseState = a),
          (n.lastRenderedState = a));
      }
      return [a, r];
    }
    function Wo(e, t, n) {
      var r = L,
        i = Fo(),
        a = P;
      if (a) {
        if (n === void 0) throw Error(o(407));
        n = n();
      } else n = t();
      var s = !kr((R || i).memoizedState, n);
      if (
        (s && ((i.memoizedState = n), (ac = !0)),
        (i = i.queue),
        fs(B.bind(null, r, i, e), [e]),
        i.getSnapshot !== t || s || (vo !== null && vo.memoizedState.tag & 1))
      ) {
        if (
          ((r.flags |= 2048),
          cs(9, { destroy: void 0 }, Ko.bind(null, r, i, n, t), null),
          K === null)
        )
          throw Error(o(349));
        a || _o & 127 || Go(r, t, n);
      }
      return n;
    }
    function Go(e, t, n) {
      ((e.flags |= 16384),
        (e = { getSnapshot: t, value: n }),
        (t = L.updateQueue),
        t === null
          ? ((t = Io()), (L.updateQueue = t), (t.stores = [e]))
          : ((n = t.stores), n === null ? (t.stores = [e]) : n.push(e)));
    }
    function Ko(e, t, n, r) {
      ((t.value = n), (t.getSnapshot = r), qo(t) && Jo(e));
    }
    function B(e, t, n) {
      return n(function () {
        qo(t) && Jo(e);
      });
    }
    function qo(e) {
      var t = e.getSnapshot;
      e = e.value;
      try {
        var n = t();
        return !kr(e, n);
      } catch {
        return !0;
      }
    }
    function Jo(e) {
      var t = ui(e, 2);
      t !== null && gu(t, e, 2);
    }
    function Yo(e) {
      var t = Po();
      if (typeof e == `function`) {
        var n = e;
        if (((e = n()), xo)) {
          Ke(!0);
          try {
            n();
          } finally {
            Ke(!1);
          }
        }
      }
      return (
        (t.memoizedState = t.baseState = e),
        (t.queue = {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: Bo,
          lastRenderedState: e,
        }),
        t
      );
    }
    function Xo(e, t, n, r) {
      return ((e.baseState = n), Ho(e, R, typeof r == `function` ? r : Bo));
    }
    function Zo(e, t, n, r, i) {
      if (Ls(e)) throw Error(o(485));
      if (((e = t.action), e !== null)) {
        var a = {
          payload: i,
          action: e,
          next: null,
          isTransition: !0,
          status: `pending`,
          value: null,
          reason: null,
          listeners: [],
          then: function (e) {
            a.listeners.push(e);
          },
        };
        (w.T === null ? (a.isTransition = !1) : n(!0),
          r(a),
          (n = t.pending),
          n === null
            ? ((a.next = t.pending = a), V(t, a))
            : ((a.next = n.next), (t.pending = n.next = a)));
      }
    }
    function V(e, t) {
      var n = t.action,
        r = t.payload,
        i = e.state;
      if (t.isTransition) {
        var a = w.T,
          o = {};
        w.T = o;
        try {
          var s = n(i, r),
            c = w.S;
          (c !== null && c(o, s), Qo(e, t, s));
        } catch (n) {
          es(e, t, n);
        } finally {
          (a !== null && o.types !== null && (a.types = o.types), (w.T = a));
        }
      } else
        try {
          ((a = n(i, r)), Qo(e, t, a));
        } catch (n) {
          es(e, t, n);
        }
    }
    function Qo(e, t, n) {
      typeof n == `object` && n && typeof n.then == `function`
        ? n.then(
            function (n) {
              $o(e, t, n);
            },
            function (n) {
              return es(e, t, n);
            },
          )
        : $o(e, t, n);
    }
    function $o(e, t, n) {
      ((t.status = `fulfilled`),
        (t.value = n),
        ts(t),
        (e.state = n),
        (t = e.pending),
        t !== null &&
          ((n = t.next), n === t ? (e.pending = null) : ((n = n.next), (t.next = n), V(e, n))));
    }
    function es(e, t, n) {
      var r = e.pending;
      if (((e.pending = null), r !== null)) {
        r = r.next;
        do ((t.status = `rejected`), (t.reason = n), ts(t), (t = t.next));
        while (t !== r);
      }
      e.action = null;
    }
    function ts(e) {
      e = e.listeners;
      for (var t = 0; t < e.length; t++) (0, e[t])();
    }
    function ns(e, t) {
      return t;
    }
    function rs(e, t) {
      if (P) {
        var n = K.formState;
        if (n !== null) {
          a: {
            var r = L;
            if (P) {
              if (N) {
                b: {
                  for (var i = N, a = Hi; i.nodeType !== 8; ) {
                    if (!a) {
                      i = null;
                      break b;
                    }
                    if (((i = lf(i.nextSibling)), i === null)) {
                      i = null;
                      break b;
                    }
                  }
                  ((a = i.data), (i = a === `F!` || a === `F` ? i : null));
                }
                if (i) {
                  ((N = lf(i.nextSibling)), (r = i.data === `F!`));
                  break a;
                }
              }
              Wi(r);
            }
            r = !1;
          }
          r && (t = n[0]);
        }
      }
      return (
        (n = Po()),
        (n.memoizedState = n.baseState = t),
        (r = {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: ns,
          lastRenderedState: t,
        }),
        (n.queue = r),
        (n = Ps.bind(null, L, r)),
        (r.dispatch = n),
        (r = Yo(!1)),
        (a = Is.bind(null, L, !1, r.queue)),
        (r = Po()),
        (i = { state: t, dispatch: null, action: e, pending: null }),
        (r.queue = i),
        (n = Zo.bind(null, L, i, a, n)),
        (i.dispatch = n),
        (r.memoizedState = e),
        [t, n, !1]
      );
    }
    function is(e) {
      return as(Fo(), R, e);
    }
    function as(e, t, n) {
      if (
        ((t = Ho(e, t, ns)[0]),
        (e = Vo(Bo)[0]),
        typeof t == `object` && t && typeof t.then == `function`)
      )
        try {
          var r = Lo(t);
        } catch (e) {
          throw e === Da ? ka : e;
        }
      else r = t;
      t = Fo();
      var i = t.queue,
        a = i.dispatch;
      return (
        n !== t.memoizedState &&
          ((L.flags |= 2048), cs(9, { destroy: void 0 }, os.bind(null, i, n), null)),
        [r, a, e]
      );
    }
    function os(e, t) {
      e.action = t;
    }
    function ss(e) {
      var t = Fo(),
        n = R;
      if (n !== null) return as(t, n, e);
      (Fo(), (t = t.memoizedState), (n = Fo()));
      var r = n.queue.dispatch;
      return ((n.memoizedState = e), [t, r, !1]);
    }
    function cs(e, t, n, r) {
      return (
        (e = { tag: e, create: n, deps: r, inst: t, next: null }),
        (t = L.updateQueue),
        t === null && ((t = Io()), (L.updateQueue = t)),
        (n = t.lastEffect),
        n === null
          ? (t.lastEffect = e.next = e)
          : ((r = n.next), (n.next = e), (e.next = r), (t.lastEffect = e)),
        e
      );
    }
    function ls() {
      return Fo().memoizedState;
    }
    function us(e, t, n, r) {
      var i = Po();
      ((L.flags |= e),
        (i.memoizedState = cs(1 | t, { destroy: void 0 }, n, r === void 0 ? null : r)));
    }
    function H(e, t, n, r) {
      var i = Fo();
      r = r === void 0 ? null : r;
      var a = i.memoizedState.inst;
      R !== null && r !== null && Eo(r, R.memoizedState.deps)
        ? (i.memoizedState = cs(t, a, n, r))
        : ((L.flags |= e), (i.memoizedState = cs(1 | t, a, n, r)));
    }
    function ds(e, t) {
      us(8390656, 8, e, t);
    }
    function fs(e, t) {
      H(2048, 8, e, t);
    }
    function ps(e) {
      L.flags |= 4;
      var t = L.updateQueue;
      if (t === null) ((t = Io()), (L.updateQueue = t), (t.events = [e]));
      else {
        var n = t.events;
        n === null ? (t.events = [e]) : n.push(e);
      }
    }
    function ms(e) {
      var t = Fo().memoizedState;
      return (
        ps({ ref: t, nextImpl: e }),
        function () {
          if (G & 2) throw Error(o(440));
          return t.impl.apply(void 0, arguments);
        }
      );
    }
    function hs(e, t) {
      return H(4, 2, e, t);
    }
    function gs(e, t) {
      return H(4, 4, e, t);
    }
    function _s(e, t) {
      if (typeof t == `function`) {
        e = e();
        var n = t(e);
        return function () {
          typeof n == `function` ? n() : t(null);
        };
      }
      if (t != null)
        return (
          (e = e()),
          (t.current = e),
          function () {
            t.current = null;
          }
        );
    }
    function vs(e, t, n) {
      ((n = n == null ? null : n.concat([e])), H(4, 4, _s.bind(null, t, e), n));
    }
    function ys() {}
    function bs(e, t) {
      var n = Fo();
      t = t === void 0 ? null : t;
      var r = n.memoizedState;
      return t !== null && Eo(t, r[1]) ? r[0] : ((n.memoizedState = [e, t]), e);
    }
    function xs(e, t) {
      var n = Fo();
      t = t === void 0 ? null : t;
      var r = n.memoizedState;
      if (t !== null && Eo(t, r[1])) return r[0];
      if (((r = e()), xo)) {
        Ke(!0);
        try {
          e();
        } finally {
          Ke(!1);
        }
      }
      return ((n.memoizedState = [r, t]), r);
    }
    function Ss(e, t, n) {
      return n === void 0 || (_o & 1073741824 && !(J & 261930))
        ? (e.memoizedState = t)
        : ((e.memoizedState = n), (e = hu()), (L.lanes |= e), (Kl |= e), n);
    }
    function Cs(e, t, n, r) {
      return kr(n, t)
        ? n
        : no.current === null
          ? !(_o & 42) || (_o & 1073741824 && !(J & 261930))
            ? ((ac = !0), (e.memoizedState = n))
            : ((e = hu()), (L.lanes |= e), (Kl |= e), t)
          : ((e = Ss(e, n, r)), kr(e, t) || (ac = !0), e);
    }
    function ws(e, t, n, r, i) {
      var a = E.p;
      E.p = a !== 0 && 8 > a ? a : 8;
      var o = w.T,
        s = {};
      ((w.T = s), Is(e, !1, t, n));
      try {
        var c = i(),
          l = w.S;
        (l !== null && l(s, c),
          typeof c == `object` && c && typeof c.then == `function`
            ? Fs(e, t, xa(c, r), mu(e))
            : Fs(e, t, r, mu(e)));
      } catch (n) {
        Fs(e, t, { then: function () {}, status: `rejected`, reason: n }, mu());
      } finally {
        ((E.p = a), o !== null && s.types !== null && (o.types = s.types), (w.T = o));
      }
    }
    function Ts() {}
    function Es(e, t, n, r) {
      if (e.tag !== 5) throw Error(o(476));
      var i = Ds(e).queue;
      ws(
        e,
        i,
        t,
        fe,
        n === null
          ? Ts
          : function () {
              return (Os(e), n(r));
            },
      );
    }
    function Ds(e) {
      var t = e.memoizedState;
      if (t !== null) return t;
      t = {
        memoizedState: fe,
        baseState: fe,
        baseQueue: null,
        queue: {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: Bo,
          lastRenderedState: fe,
        },
        next: null,
      };
      var n = {};
      return (
        (t.next = {
          memoizedState: n,
          baseState: n,
          baseQueue: null,
          queue: {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: Bo,
            lastRenderedState: n,
          },
          next: null,
        }),
        (e.memoizedState = t),
        (e = e.alternate),
        e !== null && (e.memoizedState = t),
        t
      );
    }
    function Os(e) {
      var t = Ds(e);
      (t.next === null && (t = e.alternate.memoizedState), Fs(e, t.next.queue, {}, mu()));
    }
    function ks() {
      return sa($f);
    }
    function As() {
      return Fo().memoizedState;
    }
    function js() {
      return Fo().memoizedState;
    }
    function Ms(e) {
      for (var t = e.return; t !== null; ) {
        switch (t.tag) {
          case 24:
          case 3:
            var n = mu();
            e = Ja(n);
            var r = I(t, e, n);
            (r !== null && (gu(r, t, n), Ya(r, t, n)), (t = { cache: ma() }), (e.payload = t));
            return;
        }
        t = t.return;
      }
    }
    function Ns(e, t, n) {
      var r = mu();
      ((n = {
        lane: r,
        revertLane: 0,
        gesture: null,
        action: n,
        hasEagerState: !1,
        eagerState: null,
        next: null,
      }),
        Ls(e) ? Rs(t, n) : ((n = li(e, t, n, r)), n !== null && (gu(n, e, r), zs(n, t, r))));
    }
    function Ps(e, t, n) {
      Fs(e, t, n, mu());
    }
    function Fs(e, t, n, r) {
      var i = {
        lane: r,
        revertLane: 0,
        gesture: null,
        action: n,
        hasEagerState: !1,
        eagerState: null,
        next: null,
      };
      if (Ls(e)) Rs(t, i);
      else {
        var a = e.alternate;
        if (
          e.lanes === 0 &&
          (a === null || a.lanes === 0) &&
          ((a = t.lastRenderedReducer), a !== null)
        )
          try {
            var o = t.lastRenderedState,
              s = a(o, n);
            if (((i.hasEagerState = !0), (i.eagerState = s), kr(s, o)))
              return (ci(e, t, i, 0), K === null && si(), !1);
          } catch {}
        if (((n = li(e, t, i, r)), n !== null)) return (gu(n, e, r), zs(n, t, r), !0);
      }
      return !1;
    }
    function Is(e, t, n, r) {
      if (
        ((r = {
          lane: 2,
          revertLane: fd(),
          gesture: null,
          action: r,
          hasEagerState: !1,
          eagerState: null,
          next: null,
        }),
        Ls(e))
      ) {
        if (t) throw Error(o(479));
      } else ((t = li(e, n, r, 2)), t !== null && gu(t, e, 2));
    }
    function Ls(e) {
      var t = e.alternate;
      return e === L || (t !== null && t === L);
    }
    function Rs(e, t) {
      bo = yo = !0;
      var n = e.pending;
      (n === null ? (t.next = t) : ((t.next = n.next), (n.next = t)), (e.pending = t));
    }
    function zs(e, t, n) {
      if (n & 4194048) {
        var r = t.lanes;
        ((r &= e.pendingLanes), (n |= r), (t.lanes = n), lt(e, n));
      }
    }
    var Bs = {
      readContext: sa,
      use: Ro,
      useCallback: z,
      useContext: z,
      useEffect: z,
      useImperativeHandle: z,
      useLayoutEffect: z,
      useInsertionEffect: z,
      useMemo: z,
      useReducer: z,
      useRef: z,
      useState: z,
      useDebugValue: z,
      useDeferredValue: z,
      useTransition: z,
      useSyncExternalStore: z,
      useId: z,
      useHostTransitionStatus: z,
      useFormState: z,
      useActionState: z,
      useOptimistic: z,
      useMemoCache: z,
      useCacheRefresh: z,
    };
    Bs.useEffectEvent = z;
    var Vs = {
        readContext: sa,
        use: Ro,
        useCallback: function (e, t) {
          return ((Po().memoizedState = [e, t === void 0 ? null : t]), e);
        },
        useContext: sa,
        useEffect: ds,
        useImperativeHandle: function (e, t, n) {
          ((n = n == null ? null : n.concat([e])), us(4194308, 4, _s.bind(null, t, e), n));
        },
        useLayoutEffect: function (e, t) {
          return us(4194308, 4, e, t);
        },
        useInsertionEffect: function (e, t) {
          us(4, 2, e, t);
        },
        useMemo: function (e, t) {
          var n = Po();
          t = t === void 0 ? null : t;
          var r = e();
          if (xo) {
            Ke(!0);
            try {
              e();
            } finally {
              Ke(!1);
            }
          }
          return ((n.memoizedState = [r, t]), r);
        },
        useReducer: function (e, t, n) {
          var r = Po();
          if (n !== void 0) {
            var i = n(t);
            if (xo) {
              Ke(!0);
              try {
                n(t);
              } finally {
                Ke(!1);
              }
            }
          } else i = t;
          return (
            (r.memoizedState = r.baseState = i),
            (e = {
              pending: null,
              lanes: 0,
              dispatch: null,
              lastRenderedReducer: e,
              lastRenderedState: i,
            }),
            (r.queue = e),
            (e = e.dispatch = Ns.bind(null, L, e)),
            [r.memoizedState, e]
          );
        },
        useRef: function (e) {
          var t = Po();
          return ((e = { current: e }), (t.memoizedState = e));
        },
        useState: function (e) {
          e = Yo(e);
          var t = e.queue,
            n = Ps.bind(null, L, t);
          return ((t.dispatch = n), [e.memoizedState, n]);
        },
        useDebugValue: ys,
        useDeferredValue: function (e, t) {
          return Ss(Po(), e, t);
        },
        useTransition: function () {
          var e = Yo(!1);
          return ((e = ws.bind(null, L, e.queue, !0, !1)), (Po().memoizedState = e), [!1, e]);
        },
        useSyncExternalStore: function (e, t, n) {
          var r = L,
            i = Po();
          if (P) {
            if (n === void 0) throw Error(o(407));
            n = n();
          } else {
            if (((n = t()), K === null)) throw Error(o(349));
            J & 127 || Go(r, t, n);
          }
          i.memoizedState = n;
          var a = { value: n, getSnapshot: t };
          return (
            (i.queue = a),
            ds(B.bind(null, r, a, e), [e]),
            (r.flags |= 2048),
            cs(9, { destroy: void 0 }, Ko.bind(null, r, a, n, t), null),
            n
          );
        },
        useId: function () {
          var e = Po(),
            t = K.identifierPrefix;
          if (P) {
            var n = Pi,
              r = Ni;
            ((n = (r & ~(1 << (32 - qe(r) - 1))).toString(32) + n),
              (t = `_` + t + `R_` + n),
              (n = So++),
              0 < n && (t += `H` + n.toString(32)),
              (t += `_`));
          } else ((n = To++), (t = `_` + t + `r_` + n.toString(32) + `_`));
          return (e.memoizedState = t);
        },
        useHostTransitionStatus: ks,
        useFormState: rs,
        useActionState: rs,
        useOptimistic: function (e) {
          var t = Po();
          t.memoizedState = t.baseState = e;
          var n = {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: null,
            lastRenderedState: null,
          };
          return ((t.queue = n), (t = Is.bind(null, L, !0, n)), (n.dispatch = t), [e, t]);
        },
        useMemoCache: zo,
        useCacheRefresh: function () {
          return (Po().memoizedState = Ms.bind(null, L));
        },
        useEffectEvent: function (e) {
          var t = Po(),
            n = { impl: e };
          return (
            (t.memoizedState = n),
            function () {
              if (G & 2) throw Error(o(440));
              return n.impl.apply(void 0, arguments);
            }
          );
        },
      },
      Hs = {
        readContext: sa,
        use: Ro,
        useCallback: bs,
        useContext: sa,
        useEffect: fs,
        useImperativeHandle: vs,
        useInsertionEffect: hs,
        useLayoutEffect: gs,
        useMemo: xs,
        useReducer: Vo,
        useRef: ls,
        useState: function () {
          return Vo(Bo);
        },
        useDebugValue: ys,
        useDeferredValue: function (e, t) {
          return Cs(Fo(), R.memoizedState, e, t);
        },
        useTransition: function () {
          var e = Vo(Bo)[0],
            t = Fo().memoizedState;
          return [typeof e == `boolean` ? e : Lo(e), t];
        },
        useSyncExternalStore: Wo,
        useId: As,
        useHostTransitionStatus: ks,
        useFormState: is,
        useActionState: is,
        useOptimistic: function (e, t) {
          return Xo(Fo(), R, e, t);
        },
        useMemoCache: zo,
        useCacheRefresh: js,
      };
    Hs.useEffectEvent = ms;
    var Us = {
      readContext: sa,
      use: Ro,
      useCallback: bs,
      useContext: sa,
      useEffect: fs,
      useImperativeHandle: vs,
      useInsertionEffect: hs,
      useLayoutEffect: gs,
      useMemo: xs,
      useReducer: Uo,
      useRef: ls,
      useState: function () {
        return Uo(Bo);
      },
      useDebugValue: ys,
      useDeferredValue: function (e, t) {
        var n = Fo();
        return R === null ? Ss(n, e, t) : Cs(n, R.memoizedState, e, t);
      },
      useTransition: function () {
        var e = Uo(Bo)[0],
          t = Fo().memoizedState;
        return [typeof e == `boolean` ? e : Lo(e), t];
      },
      useSyncExternalStore: Wo,
      useId: As,
      useHostTransitionStatus: ks,
      useFormState: ss,
      useActionState: ss,
      useOptimistic: function (e, t) {
        var n = Fo();
        return R === null ? ((n.baseState = e), [e, n.queue.dispatch]) : Xo(n, R, e, t);
      },
      useMemoCache: zo,
      useCacheRefresh: js,
    };
    Us.useEffectEvent = ms;
    function Ws(e, t, n, r) {
      ((t = e.memoizedState),
        (n = n(r, t)),
        (n = n == null ? t : h({}, t, n)),
        (e.memoizedState = n),
        e.lanes === 0 && (e.updateQueue.baseState = n));
    }
    var Gs = {
      enqueueSetState: function (e, t, n) {
        e = e._reactInternals;
        var r = mu(),
          i = Ja(r);
        ((i.payload = t),
          n != null && (i.callback = n),
          (t = I(e, i, r)),
          t !== null && (gu(t, e, r), Ya(t, e, r)));
      },
      enqueueReplaceState: function (e, t, n) {
        e = e._reactInternals;
        var r = mu(),
          i = Ja(r);
        ((i.tag = 1),
          (i.payload = t),
          n != null && (i.callback = n),
          (t = I(e, i, r)),
          t !== null && (gu(t, e, r), Ya(t, e, r)));
      },
      enqueueForceUpdate: function (e, t) {
        e = e._reactInternals;
        var n = mu(),
          r = Ja(n);
        ((r.tag = 2),
          t != null && (r.callback = t),
          (t = I(e, r, n)),
          t !== null && (gu(t, e, n), Ya(t, e, n)));
      },
    };
    function Ks(e, t, n, r, i, a, o) {
      return (
        (e = e.stateNode),
        typeof e.shouldComponentUpdate == `function`
          ? e.shouldComponentUpdate(r, a, o)
          : t.prototype && t.prototype.isPureReactComponent
            ? !Ar(n, r) || !Ar(i, a)
            : !0
      );
    }
    function qs(e, t, n, r) {
      ((e = t.state),
        typeof t.componentWillReceiveProps == `function` && t.componentWillReceiveProps(n, r),
        typeof t.UNSAFE_componentWillReceiveProps == `function` &&
          t.UNSAFE_componentWillReceiveProps(n, r),
        t.state !== e && Gs.enqueueReplaceState(t, t.state, null));
    }
    function Js(e, t) {
      var n = t;
      if (`ref` in t) for (var r in ((n = {}), t)) r !== `ref` && (n[r] = t[r]);
      if ((e = e.defaultProps))
        for (var i in (n === t && (n = h({}, n)), e)) n[i] === void 0 && (n[i] = e[i]);
      return n;
    }
    function Ys(e) {
      ri(e);
    }
    function Xs(e) {
      console.error(e);
    }
    function Zs(e) {
      ri(e);
    }
    function Qs(e, t) {
      try {
        var n = e.onUncaughtError;
        n(t.value, { componentStack: t.stack });
      } catch (e) {
        setTimeout(function () {
          throw e;
        });
      }
    }
    function $s(e, t, n) {
      try {
        var r = e.onCaughtError;
        r(n.value, { componentStack: n.stack, errorBoundary: t.tag === 1 ? t.stateNode : null });
      } catch (e) {
        setTimeout(function () {
          throw e;
        });
      }
    }
    function ec(e, t, n) {
      return (
        (n = Ja(n)),
        (n.tag = 3),
        (n.payload = { element: null }),
        (n.callback = function () {
          Qs(e, t);
        }),
        n
      );
    }
    function tc(e) {
      return ((e = Ja(e)), (e.tag = 3), e);
    }
    function nc(e, t, n, r) {
      var i = n.type.getDerivedStateFromError;
      if (typeof i == `function`) {
        var a = r.value;
        ((e.payload = function () {
          return i(a);
        }),
          (e.callback = function () {
            $s(t, n, r);
          }));
      }
      var o = n.stateNode;
      o !== null &&
        typeof o.componentDidCatch == `function` &&
        (e.callback = function () {
          ($s(t, n, r),
            typeof i != `function` && (iu === null ? (iu = new Set([this])) : iu.add(this)));
          var e = r.stack;
          this.componentDidCatch(r.value, { componentStack: e === null ? `` : e });
        });
    }
    function rc(e, t, n, r, i) {
      if (((n.flags |= 32768), typeof r == `object` && r && typeof r.then == `function`)) {
        if (((t = n.alternate), t !== null && ia(t, n, i, !0), (n = so.current), n !== null)) {
          switch (n.tag) {
            case 31:
            case 13:
              return (
                co === null ? Ou() : n.alternate === null && X === 0 && (X = 3),
                (n.flags &= -257),
                (n.flags |= 65536),
                (n.lanes = i),
                r === Aa
                  ? (n.flags |= 16384)
                  : ((t = n.updateQueue),
                    t === null ? (n.updateQueue = new Set([r])) : t.add(r),
                    Ku(e, r, i)),
                !1
              );
            case 22:
              return (
                (n.flags |= 65536),
                r === Aa
                  ? (n.flags |= 16384)
                  : ((t = n.updateQueue),
                    t === null
                      ? ((t = {
                          transitions: null,
                          markerInstances: null,
                          retryQueue: new Set([r]),
                        }),
                        (n.updateQueue = t))
                      : ((n = t.retryQueue), n === null ? (t.retryQueue = new Set([r])) : n.add(r)),
                    Ku(e, r, i)),
                !1
              );
          }
          throw Error(o(435, n.tag));
        }
        return (Ku(e, r, i), Ou(), !1);
      }
      if (P)
        return (
          (t = so.current),
          t === null
            ? (r !== Ui && ((t = Error(o(423), { cause: r })), Xi(Ti(t, n))),
              (e = e.current.alternate),
              (e.flags |= 65536),
              (i &= -i),
              (e.lanes |= i),
              (r = Ti(r, n)),
              (i = ec(e.stateNode, r, i)),
              Xa(e, i),
              X !== 4 && (X = 2))
            : (!(t.flags & 65536) && (t.flags |= 256),
              (t.flags |= 65536),
              (t.lanes = i),
              r !== Ui && ((e = Error(o(422), { cause: r })), Xi(Ti(e, n)))),
          !1
        );
      var a = Error(o(520), { cause: r });
      if (((a = Ti(a, n)), Zl === null ? (Zl = [a]) : Zl.push(a), X !== 4 && (X = 2), t === null))
        return !0;
      ((r = Ti(r, n)), (n = t));
      do {
        switch (n.tag) {
          case 3:
            return (
              (n.flags |= 65536),
              (e = i & -i),
              (n.lanes |= e),
              (e = ec(n.stateNode, r, e)),
              Xa(n, e),
              !1
            );
          case 1:
            if (
              ((t = n.type),
              (a = n.stateNode),
              !(n.flags & 128) &&
                (typeof t.getDerivedStateFromError == `function` ||
                  (a !== null &&
                    typeof a.componentDidCatch == `function` &&
                    (iu === null || !iu.has(a)))))
            )
              return (
                (n.flags |= 65536),
                (i &= -i),
                (n.lanes |= i),
                (i = tc(i)),
                nc(i, e, n, r),
                Xa(n, i),
                !1
              );
        }
        n = n.return;
      } while (n !== null);
      return !1;
    }
    var ic = Error(o(461)),
      ac = !1;
    function oc(e, t, n, r) {
      t.child = e === null ? Wa(t, null, n, r) : Ua(t, e.child, n, r);
    }
    function sc(e, t, n, r, i) {
      n = n.render;
      var a = t.ref;
      if (`ref` in r) {
        var o = {};
        for (var s in r) s !== `ref` && (o[s] = r[s]);
      } else o = r;
      return (
        oa(t),
        (r = Do(e, t, n, o, a, i)),
        (s = jo()),
        e !== null && !ac
          ? (Mo(e, t, i), jc(e, t, i))
          : (P && s && Li(t), (t.flags |= 1), oc(e, t, r, i), t.child)
      );
    }
    function cc(e, t, n, r, i) {
      if (e === null) {
        var a = n.type;
        return typeof a == `function` && !gi(a) && a.defaultProps === void 0 && n.compare === null
          ? ((t.tag = 15), (t.type = a), lc(e, t, a, r, i))
          : ((e = yi(n.type, null, r, t, t.mode, i)),
            (e.ref = t.ref),
            (e.return = t),
            (t.child = e));
      }
      if (((a = e.child), !Mc(e, i))) {
        var o = a.memoizedProps;
        if (((n = n.compare), (n = n === null ? Ar : n), n(o, r) && e.ref === t.ref))
          return jc(e, t, i);
      }
      return ((t.flags |= 1), (e = _i(a, r)), (e.ref = t.ref), (e.return = t), (t.child = e));
    }
    function lc(e, t, n, r, i) {
      if (e !== null) {
        var a = e.memoizedProps;
        if (Ar(a, r) && e.ref === t.ref)
          if (((ac = !1), (t.pendingProps = r = a), Mc(e, i))) e.flags & 131072 && (ac = !0);
          else return ((t.lanes = e.lanes), jc(e, t, i));
      }
      return _c(e, t, n, r, i);
    }
    function uc(e, t, n, r) {
      var i = r.children,
        a = e === null ? null : e.memoizedState;
      if (
        (e === null &&
          t.stateNode === null &&
          (t.stateNode = {
            _visibility: 1,
            _pendingMarkers: null,
            _retryCache: null,
            _transitions: null,
          }),
        r.mode === `hidden`)
      ) {
        if (t.flags & 128) {
          if (((a = a === null ? n : a.baseLanes | n), e !== null)) {
            for (r = t.child = e.child, i = 0; r !== null; )
              ((i = i | r.lanes | r.childLanes), (r = r.sibling));
            r = i & ~a;
          } else ((r = 0), (t.child = null));
          return fc(e, t, a, n, r);
        }
        if (n & 536870912)
          ((t.memoizedState = { baseLanes: 0, cachePool: null }),
            e !== null && Ta(t, a === null ? null : a.cachePool),
            a === null ? ao() : io(t, a),
            fo(t));
        else return ((r = t.lanes = 536870912), fc(e, t, a === null ? n : a.baseLanes | n, n, r));
      } else
        a === null
          ? (e !== null && Ta(t, null), ao(), po(t))
          : (Ta(t, a.cachePool), io(t, a), po(t), (t.memoizedState = null));
      return (oc(e, t, i, n), t.child);
    }
    function dc(e, t) {
      return (
        (e !== null && e.tag === 22) ||
          t.stateNode !== null ||
          (t.stateNode = {
            _visibility: 1,
            _pendingMarkers: null,
            _retryCache: null,
            _transitions: null,
          }),
        t.sibling
      );
    }
    function fc(e, t, n, r, i) {
      var a = wa();
      return (
        (a = a === null ? null : { parent: pa._currentValue, pool: a }),
        (t.memoizedState = { baseLanes: n, cachePool: a }),
        e !== null && Ta(t, null),
        ao(),
        fo(t),
        e !== null && ia(e, t, r, !0),
        (t.childLanes = i),
        null
      );
    }
    function pc(e, t) {
      return (
        (t = Ec({ mode: t.mode, children: t.children }, e.mode)),
        (t.ref = e.ref),
        (e.child = t),
        (t.return = e),
        t
      );
    }
    function mc(e, t, n) {
      return (
        Ua(t, e.child, null, n),
        (e = pc(t, t.pendingProps)),
        (e.flags |= 2),
        mo(t),
        (t.memoizedState = null),
        e
      );
    }
    function hc(e, t, n) {
      var r = t.pendingProps,
        i = (t.flags & 128) != 0;
      if (((t.flags &= -129), e === null)) {
        if (P) {
          if (r.mode === `hidden`) return ((e = pc(t, r)), (t.lanes = 536870912), dc(null, e));
          if (
            (uo(t),
            (e = N)
              ? ((e = af(e, Hi)),
                (e = e !== null && e.data === `&` ? e : null),
                e !== null &&
                  ((t.memoizedState = {
                    dehydrated: e,
                    treeContext: Mi === null ? null : { id: Ni, overflow: Pi },
                    retryLane: 536870912,
                    hydrationErrors: null,
                  }),
                  (n = Si(e)),
                  (n.return = t),
                  (t.child = n),
                  (Bi = t),
                  (N = null)))
              : (e = null),
            e === null)
          )
            throw Wi(t);
          return ((t.lanes = 536870912), null);
        }
        return pc(t, r);
      }
      var a = e.memoizedState;
      if (a !== null) {
        var s = a.dehydrated;
        if ((uo(t), i))
          if (t.flags & 256) ((t.flags &= -257), (t = mc(e, t, n)));
          else if (t.memoizedState !== null) ((t.child = e.child), (t.flags |= 128), (t = null));
          else throw Error(o(558));
        else if ((ac || ia(e, t, n, !1), (i = (n & e.childLanes) !== 0), ac || i)) {
          if (((r = K), r !== null && ((s = ut(r, n)), s !== 0 && s !== a.retryLane)))
            throw ((a.retryLane = s), ui(e, s), gu(r, e, s), ic);
          (Ou(), (t = mc(e, t, n)));
        } else
          ((e = a.treeContext),
            (N = lf(s.nextSibling)),
            (Bi = t),
            (P = !0),
            (Vi = null),
            (Hi = !1),
            e !== null && zi(t, e),
            (t = pc(t, r)),
            (t.flags |= 4096));
        return t;
      }
      return (
        (e = _i(e.child, { mode: r.mode, children: r.children })),
        (e.ref = t.ref),
        (t.child = e),
        (e.return = t),
        e
      );
    }
    function gc(e, t) {
      var n = t.ref;
      if (n === null) e !== null && e.ref !== null && (t.flags |= 4194816);
      else {
        if (typeof n != `function` && typeof n != `object`) throw Error(o(284));
        (e === null || e.ref !== n) && (t.flags |= 4194816);
      }
    }
    function _c(e, t, n, r, i) {
      return (
        oa(t),
        (n = Do(e, t, n, r, void 0, i)),
        (r = jo()),
        e !== null && !ac
          ? (Mo(e, t, i), jc(e, t, i))
          : (P && r && Li(t), (t.flags |= 1), oc(e, t, n, i), t.child)
      );
    }
    function vc(e, t, n, r, i, a) {
      return (
        oa(t),
        (t.updateQueue = null),
        (n = ko(t, r, n, i)),
        Oo(e),
        (r = jo()),
        e !== null && !ac
          ? (Mo(e, t, a), jc(e, t, a))
          : (P && r && Li(t), (t.flags |= 1), oc(e, t, n, a), t.child)
      );
    }
    function yc(e, t, n, r, i) {
      if ((oa(t), t.stateNode === null)) {
        var a = pi,
          o = n.contextType;
        (typeof o == `object` && o && (a = sa(o)),
          (a = new n(r, a)),
          (t.memoizedState = a.state !== null && a.state !== void 0 ? a.state : null),
          (a.updater = Gs),
          (t.stateNode = a),
          (a._reactInternals = t),
          (a = t.stateNode),
          (a.props = r),
          (a.state = t.memoizedState),
          (a.refs = {}),
          Ka(t),
          (o = n.contextType),
          (a.context = typeof o == `object` && o ? sa(o) : pi),
          (a.state = t.memoizedState),
          (o = n.getDerivedStateFromProps),
          typeof o == `function` && (Ws(t, n, o, r), (a.state = t.memoizedState)),
          typeof n.getDerivedStateFromProps == `function` ||
            typeof a.getSnapshotBeforeUpdate == `function` ||
            (typeof a.UNSAFE_componentWillMount != `function` &&
              typeof a.componentWillMount != `function`) ||
            ((o = a.state),
            typeof a.componentWillMount == `function` && a.componentWillMount(),
            typeof a.UNSAFE_componentWillMount == `function` && a.UNSAFE_componentWillMount(),
            o !== a.state && Gs.enqueueReplaceState(a, a.state, null),
            $a(t, r, a, i),
            Qa(),
            (a.state = t.memoizedState)),
          typeof a.componentDidMount == `function` && (t.flags |= 4194308),
          (r = !0));
      } else if (e === null) {
        a = t.stateNode;
        var s = t.memoizedProps,
          c = Js(n, s);
        a.props = c;
        var l = a.context,
          u = n.contextType;
        ((o = pi), typeof u == `object` && u && (o = sa(u)));
        var d = n.getDerivedStateFromProps;
        ((u = typeof d == `function` || typeof a.getSnapshotBeforeUpdate == `function`),
          (s = t.pendingProps !== s),
          u ||
            (typeof a.UNSAFE_componentWillReceiveProps != `function` &&
              typeof a.componentWillReceiveProps != `function`) ||
            ((s || l !== o) && qs(t, a, r, o)),
          (Ga = !1));
        var f = t.memoizedState;
        ((a.state = f),
          $a(t, r, a, i),
          Qa(),
          (l = t.memoizedState),
          s || f !== l || Ga
            ? (typeof d == `function` && (Ws(t, n, d, r), (l = t.memoizedState)),
              (c = Ga || Ks(t, n, c, r, f, l, o))
                ? (u ||
                    (typeof a.UNSAFE_componentWillMount != `function` &&
                      typeof a.componentWillMount != `function`) ||
                    (typeof a.componentWillMount == `function` && a.componentWillMount(),
                    typeof a.UNSAFE_componentWillMount == `function` &&
                      a.UNSAFE_componentWillMount()),
                  typeof a.componentDidMount == `function` && (t.flags |= 4194308))
                : (typeof a.componentDidMount == `function` && (t.flags |= 4194308),
                  (t.memoizedProps = r),
                  (t.memoizedState = l)),
              (a.props = r),
              (a.state = l),
              (a.context = o),
              (r = c))
            : (typeof a.componentDidMount == `function` && (t.flags |= 4194308), (r = !1)));
      } else {
        ((a = t.stateNode),
          qa(e, t),
          (o = t.memoizedProps),
          (u = Js(n, o)),
          (a.props = u),
          (d = t.pendingProps),
          (f = a.context),
          (l = n.contextType),
          (c = pi),
          typeof l == `object` && l && (c = sa(l)),
          (s = n.getDerivedStateFromProps),
          (l = typeof s == `function` || typeof a.getSnapshotBeforeUpdate == `function`) ||
            (typeof a.UNSAFE_componentWillReceiveProps != `function` &&
              typeof a.componentWillReceiveProps != `function`) ||
            ((o !== d || f !== c) && qs(t, a, r, c)),
          (Ga = !1),
          (f = t.memoizedState),
          (a.state = f),
          $a(t, r, a, i),
          Qa());
        var p = t.memoizedState;
        o !== d || f !== p || Ga || (e !== null && e.dependencies !== null && aa(e.dependencies))
          ? (typeof s == `function` && (Ws(t, n, s, r), (p = t.memoizedState)),
            (u =
              Ga ||
              Ks(t, n, u, r, f, p, c) ||
              (e !== null && e.dependencies !== null && aa(e.dependencies)))
              ? (l ||
                  (typeof a.UNSAFE_componentWillUpdate != `function` &&
                    typeof a.componentWillUpdate != `function`) ||
                  (typeof a.componentWillUpdate == `function` && a.componentWillUpdate(r, p, c),
                  typeof a.UNSAFE_componentWillUpdate == `function` &&
                    a.UNSAFE_componentWillUpdate(r, p, c)),
                typeof a.componentDidUpdate == `function` && (t.flags |= 4),
                typeof a.getSnapshotBeforeUpdate == `function` && (t.flags |= 1024))
              : (typeof a.componentDidUpdate != `function` ||
                  (o === e.memoizedProps && f === e.memoizedState) ||
                  (t.flags |= 4),
                typeof a.getSnapshotBeforeUpdate != `function` ||
                  (o === e.memoizedProps && f === e.memoizedState) ||
                  (t.flags |= 1024),
                (t.memoizedProps = r),
                (t.memoizedState = p)),
            (a.props = r),
            (a.state = p),
            (a.context = c),
            (r = u))
          : (typeof a.componentDidUpdate != `function` ||
              (o === e.memoizedProps && f === e.memoizedState) ||
              (t.flags |= 4),
            typeof a.getSnapshotBeforeUpdate != `function` ||
              (o === e.memoizedProps && f === e.memoizedState) ||
              (t.flags |= 1024),
            (r = !1));
      }
      return (
        (a = r),
        gc(e, t),
        (r = (t.flags & 128) != 0),
        a || r
          ? ((a = t.stateNode),
            (n = r && typeof n.getDerivedStateFromError != `function` ? null : a.render()),
            (t.flags |= 1),
            e !== null && r
              ? ((t.child = Ua(t, e.child, null, i)), (t.child = Ua(t, null, n, i)))
              : oc(e, t, n, i),
            (t.memoizedState = a.state),
            (e = t.child))
          : (e = jc(e, t, i)),
        e
      );
    }
    function bc(e, t, n, r) {
      return (Ji(), (t.flags |= 256), oc(e, t, n, r), t.child);
    }
    var xc = { dehydrated: null, treeContext: null, retryLane: 0, hydrationErrors: null };
    function Sc(e) {
      return { baseLanes: e, cachePool: Ea() };
    }
    function Cc(e, t, n) {
      return ((e = e === null ? 0 : e.childLanes & ~n), t && (e |= Yl), e);
    }
    function wc(e, t, n) {
      var r = t.pendingProps,
        i = !1,
        a = (t.flags & 128) != 0,
        s;
      if (
        ((s = a) || (s = e !== null && e.memoizedState === null ? !1 : (ho.current & 2) != 0),
        s && ((i = !0), (t.flags &= -129)),
        (s = (t.flags & 32) != 0),
        (t.flags &= -33),
        e === null)
      ) {
        if (P) {
          if (
            (i ? lo(t) : po(t),
            (e = N)
              ? ((e = af(e, Hi)),
                (e = e !== null && e.data !== `&` ? e : null),
                e !== null &&
                  ((t.memoizedState = {
                    dehydrated: e,
                    treeContext: Mi === null ? null : { id: Ni, overflow: Pi },
                    retryLane: 536870912,
                    hydrationErrors: null,
                  }),
                  (n = Si(e)),
                  (n.return = t),
                  (t.child = n),
                  (Bi = t),
                  (N = null)))
              : (e = null),
            e === null)
          )
            throw Wi(t);
          return (sf(e) ? (t.lanes = 32) : (t.lanes = 536870912), null);
        }
        var c = r.children;
        return (
          (r = r.fallback),
          i
            ? (po(t),
              (i = t.mode),
              (c = Ec({ mode: `hidden`, children: c }, i)),
              (r = bi(r, i, n, null)),
              (c.return = t),
              (r.return = t),
              (c.sibling = r),
              (t.child = c),
              (r = t.child),
              (r.memoizedState = Sc(n)),
              (r.childLanes = Cc(e, s, n)),
              (t.memoizedState = xc),
              dc(null, r))
            : (lo(t), Tc(t, c))
        );
      }
      var l = e.memoizedState;
      if (l !== null && ((c = l.dehydrated), c !== null)) {
        if (a)
          t.flags & 256
            ? (lo(t), (t.flags &= -257), (t = Dc(e, t, n)))
            : t.memoizedState === null
              ? (po(t),
                (c = r.fallback),
                (i = t.mode),
                (r = Ec({ mode: `visible`, children: r.children }, i)),
                (c = bi(c, i, n, null)),
                (c.flags |= 2),
                (r.return = t),
                (c.return = t),
                (r.sibling = c),
                (t.child = r),
                Ua(t, e.child, null, n),
                (r = t.child),
                (r.memoizedState = Sc(n)),
                (r.childLanes = Cc(e, s, n)),
                (t.memoizedState = xc),
                (t = dc(null, r)))
              : (po(t), (t.child = e.child), (t.flags |= 128), (t = null));
        else if ((lo(t), sf(c))) {
          if (((s = c.nextSibling && c.nextSibling.dataset), s)) var u = s.dgst;
          ((s = u),
            (r = Error(o(419))),
            (r.stack = ``),
            (r.digest = s),
            Xi({ value: r, source: null, stack: null }),
            (t = Dc(e, t, n)));
        } else if ((ac || ia(e, t, n, !1), (s = (n & e.childLanes) !== 0), ac || s)) {
          if (((s = K), s !== null && ((r = ut(s, n)), r !== 0 && r !== l.retryLane)))
            throw ((l.retryLane = r), ui(e, r), gu(s, e, r), ic);
          (of(c) || Ou(), (t = Dc(e, t, n)));
        } else
          of(c)
            ? ((t.flags |= 192), (t.child = e.child), (t = null))
            : ((e = l.treeContext),
              (N = lf(c.nextSibling)),
              (Bi = t),
              (P = !0),
              (Vi = null),
              (Hi = !1),
              e !== null && zi(t, e),
              (t = Tc(t, r.children)),
              (t.flags |= 4096));
        return t;
      }
      return i
        ? (po(t),
          (c = r.fallback),
          (i = t.mode),
          (l = e.child),
          (u = l.sibling),
          (r = _i(l, { mode: `hidden`, children: r.children })),
          (r.subtreeFlags = l.subtreeFlags & 65011712),
          u === null ? ((c = bi(c, i, n, null)), (c.flags |= 2)) : (c = _i(u, c)),
          (c.return = t),
          (r.return = t),
          (r.sibling = c),
          (t.child = r),
          dc(null, r),
          (r = t.child),
          (c = e.child.memoizedState),
          c === null
            ? (c = Sc(n))
            : ((i = c.cachePool),
              i === null
                ? (i = Ea())
                : ((l = pa._currentValue), (i = i.parent === l ? i : { parent: l, pool: l })),
              (c = { baseLanes: c.baseLanes | n, cachePool: i })),
          (r.memoizedState = c),
          (r.childLanes = Cc(e, s, n)),
          (t.memoizedState = xc),
          dc(e.child, r))
        : (lo(t),
          (n = e.child),
          (e = n.sibling),
          (n = _i(n, { mode: `visible`, children: r.children })),
          (n.return = t),
          (n.sibling = null),
          e !== null &&
            ((s = t.deletions), s === null ? ((t.deletions = [e]), (t.flags |= 16)) : s.push(e)),
          (t.child = n),
          (t.memoizedState = null),
          n);
    }
    function Tc(e, t) {
      return ((t = Ec({ mode: `visible`, children: t }, e.mode)), (t.return = e), (e.child = t));
    }
    function Ec(e, t) {
      return ((e = hi(22, e, null, t)), (e.lanes = 0), e);
    }
    function Dc(e, t, n) {
      return (
        Ua(t, e.child, null, n),
        (e = Tc(t, t.pendingProps.children)),
        (e.flags |= 2),
        (t.memoizedState = null),
        e
      );
    }
    function Oc(e, t, n) {
      e.lanes |= t;
      var r = e.alternate;
      (r !== null && (r.lanes |= t), na(e.return, t, n));
    }
    function kc(e, t, n, r, i, a) {
      var o = e.memoizedState;
      o === null
        ? (e.memoizedState = {
            isBackwards: t,
            rendering: null,
            renderingStartTime: 0,
            last: r,
            tail: n,
            tailMode: i,
            treeForkCount: a,
          })
        : ((o.isBackwards = t),
          (o.rendering = null),
          (o.renderingStartTime = 0),
          (o.last = r),
          (o.tail = n),
          (o.tailMode = i),
          (o.treeForkCount = a));
    }
    function Ac(e, t, n) {
      var r = t.pendingProps,
        i = r.revealOrder,
        a = r.tail;
      r = r.children;
      var o = ho.current,
        s = (o & 2) != 0;
      if (
        (s ? ((o = (o & 1) | 2), (t.flags |= 128)) : (o &= 1),
        O(ho, o),
        oc(e, t, r, n),
        (r = P ? ki : 0),
        !s && e !== null && e.flags & 128)
      )
        a: for (e = t.child; e !== null; ) {
          if (e.tag === 13) e.memoizedState !== null && Oc(e, n, t);
          else if (e.tag === 19) Oc(e, n, t);
          else if (e.child !== null) {
            ((e.child.return = e), (e = e.child));
            continue;
          }
          if (e === t) break a;
          for (; e.sibling === null; ) {
            if (e.return === null || e.return === t) break a;
            e = e.return;
          }
          ((e.sibling.return = e.return), (e = e.sibling));
        }
      switch (i) {
        case `forwards`:
          for (n = t.child, i = null; n !== null; )
            ((e = n.alternate), e !== null && go(e) === null && (i = n), (n = n.sibling));
          ((n = i),
            n === null ? ((i = t.child), (t.child = null)) : ((i = n.sibling), (n.sibling = null)),
            kc(t, !1, i, n, a, r));
          break;
        case `backwards`:
        case `unstable_legacy-backwards`:
          for (n = null, i = t.child, t.child = null; i !== null; ) {
            if (((e = i.alternate), e !== null && go(e) === null)) {
              t.child = i;
              break;
            }
            ((e = i.sibling), (i.sibling = n), (n = i), (i = e));
          }
          kc(t, !0, n, null, a, r);
          break;
        case `together`:
          kc(t, !1, null, null, void 0, r);
          break;
        default:
          t.memoizedState = null;
      }
      return t.child;
    }
    function jc(e, t, n) {
      if (
        (e !== null && (t.dependencies = e.dependencies), (Kl |= t.lanes), (n & t.childLanes) === 0)
      )
        if (e !== null) {
          if ((ia(e, t, n, !1), (n & t.childLanes) === 0)) return null;
        } else return null;
      if (e !== null && t.child !== e.child) throw Error(o(153));
      if (t.child !== null) {
        for (
          e = t.child, n = _i(e, e.pendingProps), t.child = n, n.return = t;
          e.sibling !== null;
        )
          ((e = e.sibling), (n = n.sibling = _i(e, e.pendingProps)), (n.return = t));
        n.sibling = null;
      }
      return t.child;
    }
    function Mc(e, t) {
      return (e.lanes & t) === 0 ? ((e = e.dependencies), !!(e !== null && aa(e))) : !0;
    }
    function Nc(e, t, n) {
      switch (t.tag) {
        case 3:
          (ye(t, t.stateNode.containerInfo), ea(t, pa, e.memoizedState.cache), Ji());
          break;
        case 27:
        case 5:
          xe(t);
          break;
        case 4:
          ye(t, t.stateNode.containerInfo);
          break;
        case 10:
          ea(t, t.type, t.memoizedProps.value);
          break;
        case 31:
          if (t.memoizedState !== null) return ((t.flags |= 128), uo(t), null);
          break;
        case 13:
          var r = t.memoizedState;
          if (r !== null)
            return r.dehydrated === null
              ? (n & t.child.childLanes) === 0
                ? (lo(t), (e = jc(e, t, n)), e === null ? null : e.sibling)
                : wc(e, t, n)
              : (lo(t), (t.flags |= 128), null);
          lo(t);
          break;
        case 19:
          var i = (e.flags & 128) != 0;
          if (
            ((r = (n & t.childLanes) !== 0), (r ||= (ia(e, t, n, !1), (n & t.childLanes) !== 0)), i)
          ) {
            if (r) return Ac(e, t, n);
            t.flags |= 128;
          }
          if (
            ((i = t.memoizedState),
            i !== null && ((i.rendering = null), (i.tail = null), (i.lastEffect = null)),
            O(ho, ho.current),
            r)
          )
            break;
          return null;
        case 22:
          return ((t.lanes = 0), uc(e, t, n, t.pendingProps));
        case 24:
          ea(t, pa, e.memoizedState.cache);
      }
      return jc(e, t, n);
    }
    function Pc(e, t, n) {
      if (e !== null)
        if (e.memoizedProps !== t.pendingProps) ac = !0;
        else {
          if (!Mc(e, n) && !(t.flags & 128)) return ((ac = !1), Nc(e, t, n));
          ac = !!(e.flags & 131072);
        }
      else ((ac = !1), P && t.flags & 1048576 && Ii(t, ki, t.index));
      switch (((t.lanes = 0), t.tag)) {
        case 16:
          a: {
            var r = t.pendingProps;
            if (((e = Na(t.elementType)), (t.type = e), typeof e == `function`))
              gi(e)
                ? ((r = Js(e, r)), (t.tag = 1), (t = yc(null, t, e, r, n)))
                : ((t.tag = 0), (t = _c(null, t, e, r, n)));
            else {
              if (e != null) {
                var i = e.$$typeof;
                if (i === ee) {
                  ((t.tag = 11), (t = sc(null, t, e, r, n)));
                  break a;
                } else if (i === re) {
                  ((t.tag = 14), (t = cc(null, t, e, r, n)));
                  break a;
                }
              }
              throw ((t = ue(e) || e), Error(o(306, t, ``)));
            }
          }
          return t;
        case 0:
          return _c(e, t, t.type, t.pendingProps, n);
        case 1:
          return ((r = t.type), (i = Js(r, t.pendingProps)), yc(e, t, r, i, n));
        case 3:
          a: {
            if ((ye(t, t.stateNode.containerInfo), e === null)) throw Error(o(387));
            r = t.pendingProps;
            var a = t.memoizedState;
            ((i = a.element), qa(e, t), $a(t, r, null, n));
            var s = t.memoizedState;
            if (
              ((r = s.cache),
              ea(t, pa, r),
              r !== a.cache && ra(t, [pa], n, !0),
              Qa(),
              (r = s.element),
              a.isDehydrated)
            )
              if (
                ((a = { element: r, isDehydrated: !1, cache: s.cache }),
                (t.updateQueue.baseState = a),
                (t.memoizedState = a),
                t.flags & 256)
              ) {
                t = bc(e, t, r, n);
                break a;
              } else if (r !== i) {
                ((i = Ti(Error(o(424)), t)), Xi(i), (t = bc(e, t, r, n)));
                break a;
              } else {
                switch (((e = t.stateNode.containerInfo), e.nodeType)) {
                  case 9:
                    e = e.body;
                    break;
                  default:
                    e = e.nodeName === `HTML` ? e.ownerDocument.body : e;
                }
                for (
                  N = lf(e.firstChild),
                    Bi = t,
                    P = !0,
                    Vi = null,
                    Hi = !0,
                    n = Wa(t, null, r, n),
                    t.child = n;
                  n;
                )
                  ((n.flags = (n.flags & -3) | 4096), (n = n.sibling));
              }
            else {
              if ((Ji(), r === i)) {
                t = jc(e, t, n);
                break a;
              }
              oc(e, t, r, n);
            }
            t = t.child;
          }
          return t;
        case 26:
          return (
            gc(e, t),
            e === null
              ? (n = Af(t.type, null, t.pendingProps, null))
                ? (t.memoizedState = n)
                : P ||
                  ((n = t.type),
                  (e = t.pendingProps),
                  (r = Vd(_e.current).createElement(n)),
                  (r[gt] = t),
                  (r[_t] = e),
                  Fd(r, n, e),
                  kt(r),
                  (t.stateNode = r))
              : (t.memoizedState = Af(t.type, e.memoizedProps, t.pendingProps, e.memoizedState)),
            null
          );
        case 27:
          return (
            xe(t),
            e === null &&
              P &&
              ((r = t.stateNode = pf(t.type, t.pendingProps, _e.current)),
              (Bi = t),
              (Hi = !0),
              (i = N),
              Qd(t.type) ? ((uf = i), (N = lf(r.firstChild))) : (N = i)),
            oc(e, t, t.pendingProps.children, n),
            gc(e, t),
            e === null && (t.flags |= 4194304),
            t.child
          );
        case 5:
          return (
            e === null &&
              P &&
              ((i = r = N) &&
                ((r = nf(r, t.type, t.pendingProps, Hi)),
                r === null
                  ? (i = !1)
                  : ((t.stateNode = r), (Bi = t), (N = lf(r.firstChild)), (Hi = !1), (i = !0))),
              i || Wi(t)),
            xe(t),
            (i = t.type),
            (a = t.pendingProps),
            (s = e === null ? null : e.memoizedProps),
            (r = a.children),
            Wd(i, a) ? (r = null) : s !== null && Wd(i, s) && (t.flags |= 32),
            t.memoizedState !== null && ((i = Do(e, t, Ao, null, null, n)), ($f._currentValue = i)),
            gc(e, t),
            oc(e, t, r, n),
            t.child
          );
        case 6:
          return (
            e === null &&
              P &&
              ((e = n = N) &&
                ((n = rf(n, t.pendingProps, Hi)),
                n === null ? (e = !1) : ((t.stateNode = n), (Bi = t), (N = null), (e = !0))),
              e || Wi(t)),
            null
          );
        case 13:
          return wc(e, t, n);
        case 4:
          return (
            ye(t, t.stateNode.containerInfo),
            (r = t.pendingProps),
            e === null ? (t.child = Ua(t, null, r, n)) : oc(e, t, r, n),
            t.child
          );
        case 11:
          return sc(e, t, t.type, t.pendingProps, n);
        case 7:
          return (oc(e, t, t.pendingProps, n), t.child);
        case 8:
          return (oc(e, t, t.pendingProps.children, n), t.child);
        case 12:
          return (oc(e, t, t.pendingProps.children, n), t.child);
        case 10:
          return ((r = t.pendingProps), ea(t, t.type, r.value), oc(e, t, r.children, n), t.child);
        case 9:
          return (
            (i = t.type._context),
            (r = t.pendingProps.children),
            oa(t),
            (i = sa(i)),
            (r = r(i)),
            (t.flags |= 1),
            oc(e, t, r, n),
            t.child
          );
        case 14:
          return cc(e, t, t.type, t.pendingProps, n);
        case 15:
          return lc(e, t, t.type, t.pendingProps, n);
        case 19:
          return Ac(e, t, n);
        case 31:
          return hc(e, t, n);
        case 22:
          return uc(e, t, n, t.pendingProps);
        case 24:
          return (
            oa(t),
            (r = sa(pa)),
            e === null
              ? ((i = wa()),
                i === null &&
                  ((i = K),
                  (a = ma()),
                  (i.pooledCache = a),
                  a.refCount++,
                  a !== null && (i.pooledCacheLanes |= n),
                  (i = a)),
                (t.memoizedState = { parent: r, cache: i }),
                Ka(t),
                ea(t, pa, i))
              : ((e.lanes & n) !== 0 && (qa(e, t), $a(t, null, null, n), Qa()),
                (i = e.memoizedState),
                (a = t.memoizedState),
                i.parent === r
                  ? ((r = a.cache), ea(t, pa, r), r !== i.cache && ra(t, [pa], n, !0))
                  : ((i = { parent: r, cache: r }),
                    (t.memoizedState = i),
                    t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = i),
                    ea(t, pa, r))),
            oc(e, t, t.pendingProps.children, n),
            t.child
          );
        case 29:
          throw t.pendingProps;
      }
      throw Error(o(156, t.tag));
    }
    function Fc(e) {
      e.flags |= 4;
    }
    function Ic(e, t, n, r, i) {
      if (((t = (e.mode & 32) != 0) && (t = !1), t)) {
        if (((e.flags |= 16777216), (i & 335544128) === i))
          if (e.stateNode.complete) e.flags |= 8192;
          else if (Tu()) e.flags |= 8192;
          else throw ((Pa = Aa), Oa);
      } else e.flags &= -16777217;
    }
    function Lc(e, t) {
      if (t.type !== `stylesheet` || t.state.loading & 4) e.flags &= -16777217;
      else if (((e.flags |= 16777216), !Gf(t)))
        if (Tu()) e.flags |= 8192;
        else throw ((Pa = Aa), Oa);
    }
    function Rc(e, t) {
      (t !== null && (e.flags |= 4),
        e.flags & 16384 && ((t = e.tag === 22 ? 536870912 : it()), (e.lanes |= t), (Xl |= t)));
    }
    function zc(e, t) {
      if (!P)
        switch (e.tailMode) {
          case `hidden`:
            t = e.tail;
            for (var n = null; t !== null; ) (t.alternate !== null && (n = t), (t = t.sibling));
            n === null ? (e.tail = null) : (n.sibling = null);
            break;
          case `collapsed`:
            n = e.tail;
            for (var r = null; n !== null; ) (n.alternate !== null && (r = n), (n = n.sibling));
            r === null
              ? t || e.tail === null
                ? (e.tail = null)
                : (e.tail.sibling = null)
              : (r.sibling = null);
        }
    }
    function U(e) {
      var t = e.alternate !== null && e.alternate.child === e.child,
        n = 0,
        r = 0;
      if (t)
        for (var i = e.child; i !== null; )
          ((n |= i.lanes | i.childLanes),
            (r |= i.subtreeFlags & 65011712),
            (r |= i.flags & 65011712),
            (i.return = e),
            (i = i.sibling));
      else
        for (i = e.child; i !== null; )
          ((n |= i.lanes | i.childLanes),
            (r |= i.subtreeFlags),
            (r |= i.flags),
            (i.return = e),
            (i = i.sibling));
      return ((e.subtreeFlags |= r), (e.childLanes = n), t);
    }
    function Bc(e, t, n) {
      var r = t.pendingProps;
      switch ((Ri(t), t.tag)) {
        case 16:
        case 15:
        case 0:
        case 11:
        case 7:
        case 8:
        case 12:
        case 9:
        case 14:
          return (U(t), null);
        case 1:
          return (U(t), null);
        case 3:
          return (
            (n = t.stateNode),
            (r = null),
            e !== null && (r = e.memoizedState.cache),
            t.memoizedState.cache !== r && (t.flags |= 2048),
            ta(pa),
            be(),
            n.pendingContext && ((n.context = n.pendingContext), (n.pendingContext = null)),
            (e === null || e.child === null) &&
              (qi(t)
                ? Fc(t)
                : e === null ||
                  (e.memoizedState.isDehydrated && !(t.flags & 256)) ||
                  ((t.flags |= 1024), Yi())),
            U(t),
            null
          );
        case 26:
          var i = t.type,
            a = t.memoizedState;
          return (
            e === null
              ? (Fc(t), a === null ? (U(t), Ic(t, i, null, r, n)) : (U(t), Lc(t, a)))
              : a
                ? a === e.memoizedState
                  ? (U(t), (t.flags &= -16777217))
                  : (Fc(t), U(t), Lc(t, a))
                : ((e = e.memoizedProps), e !== r && Fc(t), U(t), Ic(t, i, e, r, n)),
            null
          );
        case 27:
          if ((Se(t), (n = _e.current), (i = t.type), e !== null && t.stateNode != null))
            e.memoizedProps !== r && Fc(t);
          else {
            if (!r) {
              if (t.stateNode === null) throw Error(o(166));
              return (U(t), null);
            }
            ((e = k.current), qi(t) ? Gi(t, e) : ((e = pf(i, r, n)), (t.stateNode = e), Fc(t)));
          }
          return (U(t), null);
        case 5:
          if ((Se(t), (i = t.type), e !== null && t.stateNode != null))
            e.memoizedProps !== r && Fc(t);
          else {
            if (!r) {
              if (t.stateNode === null) throw Error(o(166));
              return (U(t), null);
            }
            if (((a = k.current), qi(t))) Gi(t, a);
            else {
              var s = Vd(_e.current);
              switch (a) {
                case 1:
                  a = s.createElementNS(`http://www.w3.org/2000/svg`, i);
                  break;
                case 2:
                  a = s.createElementNS(`http://www.w3.org/1998/Math/MathML`, i);
                  break;
                default:
                  switch (i) {
                    case `svg`:
                      a = s.createElementNS(`http://www.w3.org/2000/svg`, i);
                      break;
                    case `math`:
                      a = s.createElementNS(`http://www.w3.org/1998/Math/MathML`, i);
                      break;
                    case `script`:
                      ((a = s.createElement(`div`)),
                        (a.innerHTML = `<script><\/script>`),
                        (a = a.removeChild(a.firstChild)));
                      break;
                    case `select`:
                      ((a =
                        typeof r.is == `string`
                          ? s.createElement(`select`, { is: r.is })
                          : s.createElement(`select`)),
                        r.multiple ? (a.multiple = !0) : r.size && (a.size = r.size));
                      break;
                    default:
                      a =
                        typeof r.is == `string`
                          ? s.createElement(i, { is: r.is })
                          : s.createElement(i);
                  }
              }
              ((a[gt] = t), (a[_t] = r));
              a: for (s = t.child; s !== null; ) {
                if (s.tag === 5 || s.tag === 6) a.appendChild(s.stateNode);
                else if (s.tag !== 4 && s.tag !== 27 && s.child !== null) {
                  ((s.child.return = s), (s = s.child));
                  continue;
                }
                if (s === t) break a;
                for (; s.sibling === null; ) {
                  if (s.return === null || s.return === t) break a;
                  s = s.return;
                }
                ((s.sibling.return = s.return), (s = s.sibling));
              }
              t.stateNode = a;
              a: switch ((Fd(a, i, r), i)) {
                case `button`:
                case `input`:
                case `select`:
                case `textarea`:
                  r = !!r.autoFocus;
                  break a;
                case `img`:
                  r = !0;
                  break a;
                default:
                  r = !1;
              }
              r && Fc(t);
            }
          }
          return (
            U(t), Ic(t, t.type, e === null ? null : e.memoizedProps, t.pendingProps, n), null
          );
        case 6:
          if (e && t.stateNode != null) e.memoizedProps !== r && Fc(t);
          else {
            if (typeof r != `string` && t.stateNode === null) throw Error(o(166));
            if (((e = _e.current), qi(t))) {
              if (((e = t.stateNode), (n = t.memoizedProps), (r = null), (i = Bi), i !== null))
                switch (i.tag) {
                  case 27:
                  case 5:
                    r = i.memoizedProps;
                }
              ((e[gt] = t),
                (e = !!(
                  e.nodeValue === n ||
                  (r !== null && !0 === r.suppressHydrationWarning) ||
                  Nd(e.nodeValue, n)
                )),
                e || Wi(t, !0));
            } else ((e = Vd(e).createTextNode(r)), (e[gt] = t), (t.stateNode = e));
          }
          return (U(t), null);
        case 31:
          if (((n = t.memoizedState), e === null || e.memoizedState !== null)) {
            if (((r = qi(t)), n !== null)) {
              if (e === null) {
                if (!r) throw Error(o(318));
                if (((e = t.memoizedState), (e = e === null ? null : e.dehydrated), !e))
                  throw Error(o(557));
                e[gt] = t;
              } else (Ji(), !(t.flags & 128) && (t.memoizedState = null), (t.flags |= 4));
              (U(t), (e = !1));
            } else
              ((n = Yi()),
                e !== null && e.memoizedState !== null && (e.memoizedState.hydrationErrors = n),
                (e = !0));
            if (!e) return t.flags & 256 ? (mo(t), t) : (mo(t), null);
            if (t.flags & 128) throw Error(o(558));
          }
          return (U(t), null);
        case 13:
          if (
            ((r = t.memoizedState),
            e === null || (e.memoizedState !== null && e.memoizedState.dehydrated !== null))
          ) {
            if (((i = qi(t)), r !== null && r.dehydrated !== null)) {
              if (e === null) {
                if (!i) throw Error(o(318));
                if (((i = t.memoizedState), (i = i === null ? null : i.dehydrated), !i))
                  throw Error(o(317));
                i[gt] = t;
              } else (Ji(), !(t.flags & 128) && (t.memoizedState = null), (t.flags |= 4));
              (U(t), (i = !1));
            } else
              ((i = Yi()),
                e !== null && e.memoizedState !== null && (e.memoizedState.hydrationErrors = i),
                (i = !0));
            if (!i) return t.flags & 256 ? (mo(t), t) : (mo(t), null);
          }
          return (
            mo(t),
            t.flags & 128
              ? ((t.lanes = n), t)
              : ((n = r !== null),
                (e = e !== null && e.memoizedState !== null),
                n &&
                  ((r = t.child),
                  (i = null),
                  r.alternate !== null &&
                    r.alternate.memoizedState !== null &&
                    r.alternate.memoizedState.cachePool !== null &&
                    (i = r.alternate.memoizedState.cachePool.pool),
                  (a = null),
                  r.memoizedState !== null &&
                    r.memoizedState.cachePool !== null &&
                    (a = r.memoizedState.cachePool.pool),
                  a !== i && (r.flags |= 2048)),
                n !== e && n && (t.child.flags |= 8192),
                Rc(t, t.updateQueue),
                U(t),
                null)
          );
        case 4:
          return (be(), e === null && Cd(t.stateNode.containerInfo), U(t), null);
        case 10:
          return (ta(t.type), U(t), null);
        case 19:
          if ((D(ho), (r = t.memoizedState), r === null)) return (U(t), null);
          if (((i = (t.flags & 128) != 0), (a = r.rendering), a === null))
            if (i) zc(r, !1);
            else {
              if (X !== 0 || (e !== null && e.flags & 128))
                for (e = t.child; e !== null; ) {
                  if (((a = go(e)), a !== null)) {
                    for (
                      t.flags |= 128,
                        zc(r, !1),
                        e = a.updateQueue,
                        t.updateQueue = e,
                        Rc(t, e),
                        t.subtreeFlags = 0,
                        e = n,
                        n = t.child;
                      n !== null;
                    )
                      (vi(n, e), (n = n.sibling));
                    return (O(ho, (ho.current & 1) | 2), P && Fi(t, r.treeForkCount), t.child);
                  }
                  e = e.sibling;
                }
              r.tail !== null &&
                Fe() > nu &&
                ((t.flags |= 128), (i = !0), zc(r, !1), (t.lanes = 4194304));
            }
          else {
            if (!i)
              if (((e = go(a)), e !== null)) {
                if (
                  ((t.flags |= 128),
                  (i = !0),
                  (e = e.updateQueue),
                  (t.updateQueue = e),
                  Rc(t, e),
                  zc(r, !0),
                  r.tail === null && r.tailMode === `hidden` && !a.alternate && !P)
                )
                  return (U(t), null);
              } else
                2 * Fe() - r.renderingStartTime > nu &&
                  n !== 536870912 &&
                  ((t.flags |= 128), (i = !0), zc(r, !1), (t.lanes = 4194304));
            r.isBackwards
              ? ((a.sibling = t.child), (t.child = a))
              : ((e = r.last), e === null ? (t.child = a) : (e.sibling = a), (r.last = a));
          }
          return r.tail === null
            ? (U(t), null)
            : ((e = r.tail),
              (r.rendering = e),
              (r.tail = e.sibling),
              (r.renderingStartTime = Fe()),
              (e.sibling = null),
              (n = ho.current),
              O(ho, i ? (n & 1) | 2 : n & 1),
              P && Fi(t, r.treeForkCount),
              e);
        case 22:
        case 23:
          return (
            mo(t),
            oo(),
            (r = t.memoizedState !== null),
            e === null
              ? r && (t.flags |= 8192)
              : (e.memoizedState !== null) !== r && (t.flags |= 8192),
            r
              ? n & 536870912 && !(t.flags & 128) && (U(t), t.subtreeFlags & 6 && (t.flags |= 8192))
              : U(t),
            (n = t.updateQueue),
            n !== null && Rc(t, n.retryQueue),
            (n = null),
            e !== null &&
              e.memoizedState !== null &&
              e.memoizedState.cachePool !== null &&
              (n = e.memoizedState.cachePool.pool),
            (r = null),
            t.memoizedState !== null &&
              t.memoizedState.cachePool !== null &&
              (r = t.memoizedState.cachePool.pool),
            r !== n && (t.flags |= 2048),
            e !== null && D(Ca),
            null
          );
        case 24:
          return (
            (n = null),
            e !== null && (n = e.memoizedState.cache),
            t.memoizedState.cache !== n && (t.flags |= 2048),
            ta(pa),
            U(t),
            null
          );
        case 25:
          return null;
        case 30:
          return null;
      }
      throw Error(o(156, t.tag));
    }
    function Vc(e, t) {
      switch ((Ri(t), t.tag)) {
        case 1:
          return ((e = t.flags), e & 65536 ? ((t.flags = (e & -65537) | 128), t) : null);
        case 3:
          return (
            ta(pa),
            be(),
            (e = t.flags),
            e & 65536 && !(e & 128) ? ((t.flags = (e & -65537) | 128), t) : null
          );
        case 26:
        case 27:
        case 5:
          return (Se(t), null);
        case 31:
          if (t.memoizedState !== null) {
            if ((mo(t), t.alternate === null)) throw Error(o(340));
            Ji();
          }
          return ((e = t.flags), e & 65536 ? ((t.flags = (e & -65537) | 128), t) : null);
        case 13:
          if ((mo(t), (e = t.memoizedState), e !== null && e.dehydrated !== null)) {
            if (t.alternate === null) throw Error(o(340));
            Ji();
          }
          return ((e = t.flags), e & 65536 ? ((t.flags = (e & -65537) | 128), t) : null);
        case 19:
          return (D(ho), null);
        case 4:
          return (be(), null);
        case 10:
          return (ta(t.type), null);
        case 22:
        case 23:
          return (
            mo(t),
            oo(),
            e !== null && D(Ca),
            (e = t.flags),
            e & 65536 ? ((t.flags = (e & -65537) | 128), t) : null
          );
        case 24:
          return (ta(pa), null);
        case 25:
          return null;
        default:
          return null;
      }
    }
    function Hc(e, t) {
      switch ((Ri(t), t.tag)) {
        case 3:
          (ta(pa), be());
          break;
        case 26:
        case 27:
        case 5:
          Se(t);
          break;
        case 4:
          be();
          break;
        case 31:
          t.memoizedState !== null && mo(t);
          break;
        case 13:
          mo(t);
          break;
        case 19:
          D(ho);
          break;
        case 10:
          ta(t.type);
          break;
        case 22:
        case 23:
          (mo(t), oo(), e !== null && D(Ca));
          break;
        case 24:
          ta(pa);
      }
    }
    function Uc(e, t) {
      try {
        var n = t.updateQueue,
          r = n === null ? null : n.lastEffect;
        if (r !== null) {
          var i = r.next;
          n = i;
          do {
            if ((n.tag & e) === e) {
              r = void 0;
              var a = n.create,
                o = n.inst;
              ((r = a()), (o.destroy = r));
            }
            n = n.next;
          } while (n !== i);
        }
      } catch (e) {
        Z(t, t.return, e);
      }
    }
    function Wc(e, t, n) {
      try {
        var r = t.updateQueue,
          i = r === null ? null : r.lastEffect;
        if (i !== null) {
          var a = i.next;
          r = a;
          do {
            if ((r.tag & e) === e) {
              var o = r.inst,
                s = o.destroy;
              if (s !== void 0) {
                ((o.destroy = void 0), (i = t));
                var c = n,
                  l = s;
                try {
                  l();
                } catch (e) {
                  Z(i, c, e);
                }
              }
            }
            r = r.next;
          } while (r !== a);
        }
      } catch (e) {
        Z(t, t.return, e);
      }
    }
    function Gc(e) {
      var t = e.updateQueue;
      if (t !== null) {
        var n = e.stateNode;
        try {
          to(t, n);
        } catch (t) {
          Z(e, e.return, t);
        }
      }
    }
    function Kc(e, t, n) {
      ((n.props = Js(e.type, e.memoizedProps)), (n.state = e.memoizedState));
      try {
        n.componentWillUnmount();
      } catch (n) {
        Z(e, t, n);
      }
    }
    function qc(e, t) {
      try {
        var n = e.ref;
        if (n !== null) {
          switch (e.tag) {
            case 26:
            case 27:
            case 5:
              var r = e.stateNode;
              break;
            case 30:
              r = e.stateNode;
              break;
            default:
              r = e.stateNode;
          }
          typeof n == `function` ? (e.refCleanup = n(r)) : (n.current = r);
        }
      } catch (n) {
        Z(e, t, n);
      }
    }
    function Jc(e, t) {
      var n = e.ref,
        r = e.refCleanup;
      if (n !== null)
        if (typeof r == `function`)
          try {
            r();
          } catch (n) {
            Z(e, t, n);
          } finally {
            ((e.refCleanup = null), (e = e.alternate), e != null && (e.refCleanup = null));
          }
        else if (typeof n == `function`)
          try {
            n(null);
          } catch (n) {
            Z(e, t, n);
          }
        else n.current = null;
    }
    function Yc(e) {
      var t = e.type,
        n = e.memoizedProps,
        r = e.stateNode;
      try {
        a: switch (t) {
          case `button`:
          case `input`:
          case `select`:
          case `textarea`:
            n.autoFocus && r.focus();
            break a;
          case `img`:
            n.src ? (r.src = n.src) : n.srcSet && (r.srcset = n.srcSet);
        }
      } catch (t) {
        Z(e, e.return, t);
      }
    }
    function Xc(e, t, n) {
      try {
        var r = e.stateNode;
        (Id(r, e.type, n, t), (r[_t] = t));
      } catch (t) {
        Z(e, e.return, t);
      }
    }
    function Zc(e) {
      return (
        e.tag === 5 || e.tag === 3 || e.tag === 26 || (e.tag === 27 && Qd(e.type)) || e.tag === 4
      );
    }
    function Qc(e) {
      a: for (;;) {
        for (; e.sibling === null; ) {
          if (e.return === null || Zc(e.return)) return null;
          e = e.return;
        }
        for (
          e.sibling.return = e.return, e = e.sibling;
          e.tag !== 5 && e.tag !== 6 && e.tag !== 18;
        ) {
          if ((e.tag === 27 && Qd(e.type)) || e.flags & 2 || e.child === null || e.tag === 4)
            continue a;
          ((e.child.return = e), (e = e.child));
        }
        if (!(e.flags & 2)) return e.stateNode;
      }
    }
    function $c(e, t, n) {
      var r = e.tag;
      if (r === 5 || r === 6)
        ((e = e.stateNode),
          t
            ? (n.nodeType === 9
                ? n.body
                : n.nodeName === `HTML`
                  ? n.ownerDocument.body
                  : n
              ).insertBefore(e, t)
            : ((t = n.nodeType === 9 ? n.body : n.nodeName === `HTML` ? n.ownerDocument.body : n),
              t.appendChild(e),
              (n = n._reactRootContainer),
              n != null || t.onclick !== null || (t.onclick = un)));
      else if (
        r !== 4 &&
        (r === 27 && Qd(e.type) && ((n = e.stateNode), (t = null)), (e = e.child), e !== null)
      )
        for ($c(e, t, n), e = e.sibling; e !== null; ) ($c(e, t, n), (e = e.sibling));
    }
    function el(e, t, n) {
      var r = e.tag;
      if (r === 5 || r === 6) ((e = e.stateNode), t ? n.insertBefore(e, t) : n.appendChild(e));
      else if (r !== 4 && (r === 27 && Qd(e.type) && (n = e.stateNode), (e = e.child), e !== null))
        for (el(e, t, n), e = e.sibling; e !== null; ) (el(e, t, n), (e = e.sibling));
    }
    function tl(e) {
      var t = e.stateNode,
        n = e.memoizedProps;
      try {
        for (var r = e.type, i = t.attributes; i.length; ) t.removeAttributeNode(i[0]);
        (Fd(t, r, n), (t[gt] = e), (t[_t] = n));
      } catch (t) {
        Z(e, e.return, t);
      }
    }
    var nl = !1,
      rl = !1,
      il = !1,
      al = typeof WeakSet == `function` ? WeakSet : Set,
      ol = null;
    function sl(e, t) {
      if (((e = e.containerInfo), (zd = cp), (e = Pr(e)), Fr(e))) {
        if (`selectionStart` in e) var n = { start: e.selectionStart, end: e.selectionEnd };
        else
          a: {
            n = ((n = e.ownerDocument) && n.defaultView) || window;
            var r = n.getSelection && n.getSelection();
            if (r && r.rangeCount !== 0) {
              n = r.anchorNode;
              var i = r.anchorOffset,
                a = r.focusNode;
              r = r.focusOffset;
              try {
                (n.nodeType, a.nodeType);
              } catch {
                n = null;
                break a;
              }
              var s = 0,
                c = -1,
                l = -1,
                u = 0,
                d = 0,
                f = e,
                p = null;
              b: for (;;) {
                for (
                  var m;
                  f !== n || (i !== 0 && f.nodeType !== 3) || (c = s + i),
                    f !== a || (r !== 0 && f.nodeType !== 3) || (l = s + r),
                    f.nodeType === 3 && (s += f.nodeValue.length),
                    (m = f.firstChild) !== null;
                )
                  ((p = f), (f = m));
                for (;;) {
                  if (f === e) break b;
                  if (
                    (p === n && ++u === i && (c = s),
                    p === a && ++d === r && (l = s),
                    (m = f.nextSibling) !== null)
                  )
                    break;
                  ((f = p), (p = f.parentNode));
                }
                f = m;
              }
              n = c === -1 || l === -1 ? null : { start: c, end: l };
            } else n = null;
          }
        n ||= { start: 0, end: 0 };
      } else n = null;
      for (Bd = { focusedElem: e, selectionRange: n }, cp = !1, ol = t; ol !== null; )
        if (((t = ol), (e = t.child), t.subtreeFlags & 1028 && e !== null))
          ((e.return = t), (ol = e));
        else
          for (; ol !== null; ) {
            switch (((t = ol), (a = t.alternate), (e = t.flags), t.tag)) {
              case 0:
                if (e & 4 && ((e = t.updateQueue), (e = e === null ? null : e.events), e !== null))
                  for (n = 0; n < e.length; n++) ((i = e[n]), (i.ref.impl = i.nextImpl));
                break;
              case 11:
              case 15:
                break;
              case 1:
                if (e & 1024 && a !== null) {
                  ((e = void 0),
                    (n = t),
                    (i = a.memoizedProps),
                    (a = a.memoizedState),
                    (r = n.stateNode));
                  try {
                    var h = Js(n.type, i);
                    ((e = r.getSnapshotBeforeUpdate(h, a)),
                      (r.__reactInternalSnapshotBeforeUpdate = e));
                  } catch (e) {
                    Z(n, n.return, e);
                  }
                }
                break;
              case 3:
                if (e & 1024) {
                  if (((e = t.stateNode.containerInfo), (n = e.nodeType), n === 9)) tf(e);
                  else if (n === 1)
                    switch (e.nodeName) {
                      case `HEAD`:
                      case `HTML`:
                      case `BODY`:
                        tf(e);
                        break;
                      default:
                        e.textContent = ``;
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
                if (e & 1024) throw Error(o(163));
            }
            if (((e = t.sibling), e !== null)) {
              ((e.return = t.return), (ol = e));
              break;
            }
            ol = t.return;
          }
    }
    function cl(e, t, n) {
      var r = n.flags;
      switch (n.tag) {
        case 0:
        case 11:
        case 15:
          (Sl(e, n), r & 4 && Uc(5, n));
          break;
        case 1:
          if ((Sl(e, n), r & 4))
            if (((e = n.stateNode), t === null))
              try {
                e.componentDidMount();
              } catch (e) {
                Z(n, n.return, e);
              }
            else {
              var i = Js(n.type, t.memoizedProps);
              t = t.memoizedState;
              try {
                e.componentDidUpdate(i, t, e.__reactInternalSnapshotBeforeUpdate);
              } catch (e) {
                Z(n, n.return, e);
              }
            }
          (r & 64 && Gc(n), r & 512 && qc(n, n.return));
          break;
        case 3:
          if ((Sl(e, n), r & 64 && ((e = n.updateQueue), e !== null))) {
            if (((t = null), n.child !== null))
              switch (n.child.tag) {
                case 27:
                case 5:
                  t = n.child.stateNode;
                  break;
                case 1:
                  t = n.child.stateNode;
              }
            try {
              to(e, t);
            } catch (e) {
              Z(n, n.return, e);
            }
          }
          break;
        case 27:
          t === null && r & 4 && tl(n);
        case 26:
        case 5:
          (Sl(e, n), t === null && r & 4 && Yc(n), r & 512 && qc(n, n.return));
          break;
        case 12:
          Sl(e, n);
          break;
        case 31:
          (Sl(e, n), r & 4 && pl(e, n));
          break;
        case 13:
          (Sl(e, n),
            r & 4 && ml(e, n),
            r & 64 &&
              ((e = n.memoizedState),
              e !== null &&
                ((e = e.dehydrated), e !== null && ((n = Yu.bind(null, n)), cf(e, n)))));
          break;
        case 22:
          if (((r = n.memoizedState !== null || nl), !r)) {
            ((t = (t !== null && t.memoizedState !== null) || rl), (i = nl));
            var a = rl;
            ((nl = r),
              (rl = t) && !a ? wl(e, n, (n.subtreeFlags & 8772) != 0) : Sl(e, n),
              (nl = i),
              (rl = a));
          }
          break;
        case 30:
          break;
        default:
          Sl(e, n);
      }
    }
    function ll(e) {
      var t = e.alternate;
      (t !== null && ((e.alternate = null), ll(t)),
        (e.child = null),
        (e.deletions = null),
        (e.sibling = null),
        e.tag === 5 && ((t = e.stateNode), t !== null && wt(t)),
        (e.stateNode = null),
        (e.return = null),
        (e.dependencies = null),
        (e.memoizedProps = null),
        (e.memoizedState = null),
        (e.pendingProps = null),
        (e.stateNode = null),
        (e.updateQueue = null));
    }
    var W = null,
      ul = !1;
    function dl(e, t, n) {
      for (n = n.child; n !== null; ) (fl(e, t, n), (n = n.sibling));
    }
    function fl(e, t, n) {
      if (Ge && typeof Ge.onCommitFiberUnmount == `function`)
        try {
          Ge.onCommitFiberUnmount(We, n);
        } catch {}
      switch (n.tag) {
        case 26:
          (rl || Jc(n, t),
            dl(e, t, n),
            n.memoizedState
              ? n.memoizedState.count--
              : n.stateNode && ((n = n.stateNode), n.parentNode.removeChild(n)));
          break;
        case 27:
          rl || Jc(n, t);
          var r = W,
            i = ul;
          (Qd(n.type) && ((W = n.stateNode), (ul = !1)),
            dl(e, t, n),
            mf(n.stateNode),
            (W = r),
            (ul = i));
          break;
        case 5:
          rl || Jc(n, t);
        case 6:
          if (((r = W), (i = ul), (W = null), dl(e, t, n), (W = r), (ul = i), W !== null))
            if (ul)
              try {
                (W.nodeType === 9
                  ? W.body
                  : W.nodeName === `HTML`
                    ? W.ownerDocument.body
                    : W
                ).removeChild(n.stateNode);
              } catch (e) {
                Z(n, t, e);
              }
            else
              try {
                W.removeChild(n.stateNode);
              } catch (e) {
                Z(n, t, e);
              }
          break;
        case 18:
          W !== null &&
            (ul
              ? ((e = W),
                $d(
                  e.nodeType === 9 ? e.body : e.nodeName === `HTML` ? e.ownerDocument.body : e,
                  n.stateNode,
                ),
                Pp(e))
              : $d(W, n.stateNode));
          break;
        case 4:
          ((r = W),
            (i = ul),
            (W = n.stateNode.containerInfo),
            (ul = !0),
            dl(e, t, n),
            (W = r),
            (ul = i));
          break;
        case 0:
        case 11:
        case 14:
        case 15:
          (Wc(2, n, t), rl || Wc(4, n, t), dl(e, t, n));
          break;
        case 1:
          (rl ||
            (Jc(n, t),
            (r = n.stateNode),
            typeof r.componentWillUnmount == `function` && Kc(n, t, r)),
            dl(e, t, n));
          break;
        case 21:
          dl(e, t, n);
          break;
        case 22:
          ((rl = (r = rl) || n.memoizedState !== null), dl(e, t, n), (rl = r));
          break;
        default:
          dl(e, t, n);
      }
    }
    function pl(e, t) {
      if (
        t.memoizedState === null &&
        ((e = t.alternate), e !== null && ((e = e.memoizedState), e !== null))
      ) {
        e = e.dehydrated;
        try {
          Pp(e);
        } catch (e) {
          Z(t, t.return, e);
        }
      }
    }
    function ml(e, t) {
      if (
        t.memoizedState === null &&
        ((e = t.alternate),
        e !== null && ((e = e.memoizedState), e !== null && ((e = e.dehydrated), e !== null)))
      )
        try {
          Pp(e);
        } catch (e) {
          Z(t, t.return, e);
        }
    }
    function hl(e) {
      switch (e.tag) {
        case 31:
        case 13:
        case 19:
          var t = e.stateNode;
          return (t === null && (t = e.stateNode = new al()), t);
        case 22:
          return (
            (e = e.stateNode), (t = e._retryCache), t === null && (t = e._retryCache = new al()), t
          );
        default:
          throw Error(o(435, e.tag));
      }
    }
    function gl(e, t) {
      var n = hl(e);
      t.forEach(function (t) {
        if (!n.has(t)) {
          n.add(t);
          var r = Xu.bind(null, e, t);
          t.then(r, r);
        }
      });
    }
    function _l(e, t) {
      var n = t.deletions;
      if (n !== null)
        for (var r = 0; r < n.length; r++) {
          var i = n[r],
            a = e,
            s = t,
            c = s;
          a: for (; c !== null; ) {
            switch (c.tag) {
              case 27:
                if (Qd(c.type)) {
                  ((W = c.stateNode), (ul = !1));
                  break a;
                }
                break;
              case 5:
                ((W = c.stateNode), (ul = !1));
                break a;
              case 3:
              case 4:
                ((W = c.stateNode.containerInfo), (ul = !0));
                break a;
            }
            c = c.return;
          }
          if (W === null) throw Error(o(160));
          (fl(a, s, i),
            (W = null),
            (ul = !1),
            (a = i.alternate),
            a !== null && (a.return = null),
            (i.return = null));
        }
      if (t.subtreeFlags & 13886) for (t = t.child; t !== null; ) (yl(t, e), (t = t.sibling));
    }
    var vl = null;
    function yl(e, t) {
      var n = e.alternate,
        r = e.flags;
      switch (e.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          (_l(t, e), bl(e), r & 4 && (Wc(3, e, e.return), Uc(3, e), Wc(5, e, e.return)));
          break;
        case 1:
          (_l(t, e),
            bl(e),
            r & 512 && (rl || n === null || Jc(n, n.return)),
            r & 64 &&
              nl &&
              ((e = e.updateQueue),
              e !== null &&
                ((r = e.callbacks),
                r !== null &&
                  ((n = e.shared.hiddenCallbacks),
                  (e.shared.hiddenCallbacks = n === null ? r : n.concat(r))))));
          break;
        case 26:
          var i = vl;
          if ((_l(t, e), bl(e), r & 512 && (rl || n === null || Jc(n, n.return)), r & 4)) {
            var a = n === null ? null : n.memoizedState;
            if (((r = e.memoizedState), n === null))
              if (r === null)
                if (e.stateNode === null) {
                  a: {
                    ((r = e.type), (n = e.memoizedProps), (i = i.ownerDocument || i));
                    b: switch (r) {
                      case `title`:
                        ((a = i.getElementsByTagName(`title`)[0]),
                          (!a ||
                            a[Ct] ||
                            a[gt] ||
                            a.namespaceURI === `http://www.w3.org/2000/svg` ||
                            a.hasAttribute(`itemprop`)) &&
                            ((a = i.createElement(r)),
                            i.head.insertBefore(a, i.querySelector(`head > title`))),
                          Fd(a, r, n),
                          (a[gt] = e),
                          kt(a),
                          (r = a));
                        break a;
                      case `link`:
                        var s = Hf(`link`, `href`, i).get(r + (n.href || ``));
                        if (s) {
                          for (var c = 0; c < s.length; c++)
                            if (
                              ((a = s[c]),
                              a.getAttribute(`href`) ===
                                (n.href == null || n.href === `` ? null : n.href) &&
                                a.getAttribute(`rel`) === (n.rel == null ? null : n.rel) &&
                                a.getAttribute(`title`) === (n.title == null ? null : n.title) &&
                                a.getAttribute(`crossorigin`) ===
                                  (n.crossOrigin == null ? null : n.crossOrigin))
                            ) {
                              s.splice(c, 1);
                              break b;
                            }
                        }
                        ((a = i.createElement(r)), Fd(a, r, n), i.head.appendChild(a));
                        break;
                      case `meta`:
                        if ((s = Hf(`meta`, `content`, i).get(r + (n.content || ``)))) {
                          for (c = 0; c < s.length; c++)
                            if (
                              ((a = s[c]),
                              a.getAttribute(`content`) ===
                                (n.content == null ? null : `` + n.content) &&
                                a.getAttribute(`name`) === (n.name == null ? null : n.name) &&
                                a.getAttribute(`property`) ===
                                  (n.property == null ? null : n.property) &&
                                a.getAttribute(`http-equiv`) ===
                                  (n.httpEquiv == null ? null : n.httpEquiv) &&
                                a.getAttribute(`charset`) ===
                                  (n.charSet == null ? null : n.charSet))
                            ) {
                              s.splice(c, 1);
                              break b;
                            }
                        }
                        ((a = i.createElement(r)), Fd(a, r, n), i.head.appendChild(a));
                        break;
                      default:
                        throw Error(o(468, r));
                    }
                    ((a[gt] = e), kt(a), (r = a));
                  }
                  e.stateNode = r;
                } else Uf(i, e.type, e.stateNode);
              else e.stateNode = Lf(i, r, e.memoizedProps);
            else
              a === r
                ? r === null && e.stateNode !== null && Xc(e, e.memoizedProps, n.memoizedProps)
                : (a === null
                    ? n.stateNode !== null && ((n = n.stateNode), n.parentNode.removeChild(n))
                    : a.count--,
                  r === null ? Uf(i, e.type, e.stateNode) : Lf(i, r, e.memoizedProps));
          }
          break;
        case 27:
          (_l(t, e),
            bl(e),
            r & 512 && (rl || n === null || Jc(n, n.return)),
            n !== null && r & 4 && Xc(e, e.memoizedProps, n.memoizedProps));
          break;
        case 5:
          if ((_l(t, e), bl(e), r & 512 && (rl || n === null || Jc(n, n.return)), e.flags & 32)) {
            i = e.stateNode;
            try {
              tn(i, ``);
            } catch (t) {
              Z(e, e.return, t);
            }
          }
          (r & 4 &&
            e.stateNode != null &&
            ((i = e.memoizedProps), Xc(e, i, n === null ? i : n.memoizedProps)),
            r & 1024 && (il = !0));
          break;
        case 6:
          if ((_l(t, e), bl(e), r & 4)) {
            if (e.stateNode === null) throw Error(o(162));
            ((r = e.memoizedProps), (n = e.stateNode));
            try {
              n.nodeValue = r;
            } catch (t) {
              Z(e, e.return, t);
            }
          }
          break;
        case 3:
          if (
            ((Vf = null),
            (i = vl),
            (vl = _f(t.containerInfo)),
            _l(t, e),
            (vl = i),
            bl(e),
            r & 4 && n !== null && n.memoizedState.isDehydrated)
          )
            try {
              Pp(t.containerInfo);
            } catch (t) {
              Z(e, e.return, t);
            }
          il && ((il = !1), xl(e));
          break;
        case 4:
          ((r = vl), (vl = _f(e.stateNode.containerInfo)), _l(t, e), bl(e), (vl = r));
          break;
        case 12:
          (_l(t, e), bl(e));
          break;
        case 31:
          (_l(t, e),
            bl(e),
            r & 4 && ((r = e.updateQueue), r !== null && ((e.updateQueue = null), gl(e, r))));
          break;
        case 13:
          (_l(t, e),
            bl(e),
            e.child.flags & 8192 &&
              (e.memoizedState !== null) != (n !== null && n.memoizedState !== null) &&
              (eu = Fe()),
            r & 4 && ((r = e.updateQueue), r !== null && ((e.updateQueue = null), gl(e, r))));
          break;
        case 22:
          i = e.memoizedState !== null;
          var l = n !== null && n.memoizedState !== null,
            u = nl,
            d = rl;
          if (((nl = u || i), (rl = d || l), _l(t, e), (rl = d), (nl = u), bl(e), r & 8192))
            a: for (
              t = e.stateNode,
                t._visibility = i ? t._visibility & -2 : t._visibility | 1,
                i && (n === null || l || nl || rl || Cl(e)),
                n = null,
                t = e;
              ;
            ) {
              if (t.tag === 5 || t.tag === 26) {
                if (n === null) {
                  l = n = t;
                  try {
                    if (((a = l.stateNode), i))
                      ((s = a.style),
                        typeof s.setProperty == `function`
                          ? s.setProperty(`display`, `none`, `important`)
                          : (s.display = `none`));
                    else {
                      c = l.stateNode;
                      var f = l.memoizedProps.style,
                        p = f != null && f.hasOwnProperty(`display`) ? f.display : null;
                      c.style.display = p == null || typeof p == `boolean` ? `` : (`` + p).trim();
                    }
                  } catch (e) {
                    Z(l, l.return, e);
                  }
                }
              } else if (t.tag === 6) {
                if (n === null) {
                  l = t;
                  try {
                    l.stateNode.nodeValue = i ? `` : l.memoizedProps;
                  } catch (e) {
                    Z(l, l.return, e);
                  }
                }
              } else if (t.tag === 18) {
                if (n === null) {
                  l = t;
                  try {
                    var m = l.stateNode;
                    i ? ef(m, !0) : ef(l.stateNode, !1);
                  } catch (e) {
                    Z(l, l.return, e);
                  }
                }
              } else if (
                ((t.tag !== 22 && t.tag !== 23) || t.memoizedState === null || t === e) &&
                t.child !== null
              ) {
                ((t.child.return = t), (t = t.child));
                continue;
              }
              if (t === e) break a;
              for (; t.sibling === null; ) {
                if (t.return === null || t.return === e) break a;
                (n === t && (n = null), (t = t.return));
              }
              (n === t && (n = null), (t.sibling.return = t.return), (t = t.sibling));
            }
          r & 4 &&
            ((r = e.updateQueue),
            r !== null && ((n = r.retryQueue), n !== null && ((r.retryQueue = null), gl(e, n))));
          break;
        case 19:
          (_l(t, e),
            bl(e),
            r & 4 && ((r = e.updateQueue), r !== null && ((e.updateQueue = null), gl(e, r))));
          break;
        case 30:
          break;
        case 21:
          break;
        default:
          (_l(t, e), bl(e));
      }
    }
    function bl(e) {
      var t = e.flags;
      if (t & 2) {
        try {
          for (var n, r = e.return; r !== null; ) {
            if (Zc(r)) {
              n = r;
              break;
            }
            r = r.return;
          }
          if (n == null) throw Error(o(160));
          switch (n.tag) {
            case 27:
              var i = n.stateNode;
              el(e, Qc(e), i);
              break;
            case 5:
              var a = n.stateNode;
              (n.flags & 32 && (tn(a, ``), (n.flags &= -33)), el(e, Qc(e), a));
              break;
            case 3:
            case 4:
              var s = n.stateNode.containerInfo;
              $c(e, Qc(e), s);
              break;
            default:
              throw Error(o(161));
          }
        } catch (t) {
          Z(e, e.return, t);
        }
        e.flags &= -3;
      }
      t & 4096 && (e.flags &= -4097);
    }
    function xl(e) {
      if (e.subtreeFlags & 1024)
        for (e = e.child; e !== null; ) {
          var t = e;
          (xl(t), t.tag === 5 && t.flags & 1024 && t.stateNode.reset(), (e = e.sibling));
        }
    }
    function Sl(e, t) {
      if (t.subtreeFlags & 8772)
        for (t = t.child; t !== null; ) (cl(e, t.alternate, t), (t = t.sibling));
    }
    function Cl(e) {
      for (e = e.child; e !== null; ) {
        var t = e;
        switch (t.tag) {
          case 0:
          case 11:
          case 14:
          case 15:
            (Wc(4, t, t.return), Cl(t));
            break;
          case 1:
            Jc(t, t.return);
            var n = t.stateNode;
            (typeof n.componentWillUnmount == `function` && Kc(t, t.return, n), Cl(t));
            break;
          case 27:
            mf(t.stateNode);
          case 26:
          case 5:
            (Jc(t, t.return), Cl(t));
            break;
          case 22:
            t.memoizedState === null && Cl(t);
            break;
          case 30:
            Cl(t);
            break;
          default:
            Cl(t);
        }
        e = e.sibling;
      }
    }
    function wl(e, t, n) {
      for (n &&= (t.subtreeFlags & 8772) != 0, t = t.child; t !== null; ) {
        var r = t.alternate,
          i = e,
          a = t,
          o = a.flags;
        switch (a.tag) {
          case 0:
          case 11:
          case 15:
            (wl(i, a, n), Uc(4, a));
            break;
          case 1:
            if ((wl(i, a, n), (r = a), (i = r.stateNode), typeof i.componentDidMount == `function`))
              try {
                i.componentDidMount();
              } catch (e) {
                Z(r, r.return, e);
              }
            if (((r = a), (i = r.updateQueue), i !== null)) {
              var s = r.stateNode;
              try {
                var c = i.shared.hiddenCallbacks;
                if (c !== null)
                  for (i.shared.hiddenCallbacks = null, i = 0; i < c.length; i++) eo(c[i], s);
              } catch (e) {
                Z(r, r.return, e);
              }
            }
            (n && o & 64 && Gc(a), qc(a, a.return));
            break;
          case 27:
            tl(a);
          case 26:
          case 5:
            (wl(i, a, n), n && r === null && o & 4 && Yc(a), qc(a, a.return));
            break;
          case 12:
            wl(i, a, n);
            break;
          case 31:
            (wl(i, a, n), n && o & 4 && pl(i, a));
            break;
          case 13:
            (wl(i, a, n), n && o & 4 && ml(i, a));
            break;
          case 22:
            (a.memoizedState === null && wl(i, a, n), qc(a, a.return));
            break;
          case 30:
            break;
          default:
            wl(i, a, n);
        }
        t = t.sibling;
      }
    }
    function Tl(e, t) {
      var n = null;
      (e !== null &&
        e.memoizedState !== null &&
        e.memoizedState.cachePool !== null &&
        (n = e.memoizedState.cachePool.pool),
        (e = null),
        t.memoizedState !== null &&
          t.memoizedState.cachePool !== null &&
          (e = t.memoizedState.cachePool.pool),
        e !== n && (e != null && e.refCount++, n != null && F(n)));
    }
    function El(e, t) {
      ((e = null),
        t.alternate !== null && (e = t.alternate.memoizedState.cache),
        (t = t.memoizedState.cache),
        t !== e && (t.refCount++, e != null && F(e)));
    }
    function Dl(e, t, n, r) {
      if (t.subtreeFlags & 10256) for (t = t.child; t !== null; ) (Ol(e, t, n, r), (t = t.sibling));
    }
    function Ol(e, t, n, r) {
      var i = t.flags;
      switch (t.tag) {
        case 0:
        case 11:
        case 15:
          (Dl(e, t, n, r), i & 2048 && Uc(9, t));
          break;
        case 1:
          Dl(e, t, n, r);
          break;
        case 3:
          (Dl(e, t, n, r),
            i & 2048 &&
              ((e = null),
              t.alternate !== null && (e = t.alternate.memoizedState.cache),
              (t = t.memoizedState.cache),
              t !== e && (t.refCount++, e != null && F(e))));
          break;
        case 12:
          if (i & 2048) {
            (Dl(e, t, n, r), (e = t.stateNode));
            try {
              var a = t.memoizedProps,
                o = a.id,
                s = a.onPostCommit;
              typeof s == `function` &&
                s(o, t.alternate === null ? `mount` : `update`, e.passiveEffectDuration, -0);
            } catch (e) {
              Z(t, t.return, e);
            }
          } else Dl(e, t, n, r);
          break;
        case 31:
          Dl(e, t, n, r);
          break;
        case 13:
          Dl(e, t, n, r);
          break;
        case 23:
          break;
        case 22:
          ((a = t.stateNode),
            (o = t.alternate),
            t.memoizedState === null
              ? a._visibility & 2
                ? Dl(e, t, n, r)
                : ((a._visibility |= 2), kl(e, t, n, r, (t.subtreeFlags & 10256) != 0 || !1))
              : a._visibility & 2
                ? Dl(e, t, n, r)
                : Al(e, t),
            i & 2048 && Tl(o, t));
          break;
        case 24:
          (Dl(e, t, n, r), i & 2048 && El(t.alternate, t));
          break;
        default:
          Dl(e, t, n, r);
      }
    }
    function kl(e, t, n, r, i) {
      for (i &&= (t.subtreeFlags & 10256) != 0 || !1, t = t.child; t !== null; ) {
        var a = e,
          o = t,
          s = n,
          c = r,
          l = o.flags;
        switch (o.tag) {
          case 0:
          case 11:
          case 15:
            (kl(a, o, s, c, i), Uc(8, o));
            break;
          case 23:
            break;
          case 22:
            var u = o.stateNode;
            (o.memoizedState === null
              ? ((u._visibility |= 2), kl(a, o, s, c, i))
              : u._visibility & 2
                ? kl(a, o, s, c, i)
                : Al(a, o),
              i && l & 2048 && Tl(o.alternate, o));
            break;
          case 24:
            (kl(a, o, s, c, i), i && l & 2048 && El(o.alternate, o));
            break;
          default:
            kl(a, o, s, c, i);
        }
        t = t.sibling;
      }
    }
    function Al(e, t) {
      if (t.subtreeFlags & 10256)
        for (t = t.child; t !== null; ) {
          var n = e,
            r = t,
            i = r.flags;
          switch (r.tag) {
            case 22:
              (Al(n, r), i & 2048 && Tl(r.alternate, r));
              break;
            case 24:
              (Al(n, r), i & 2048 && El(r.alternate, r));
              break;
            default:
              Al(n, r);
          }
          t = t.sibling;
        }
    }
    var jl = 8192;
    function Ml(e, t, n) {
      if (e.subtreeFlags & jl) for (e = e.child; e !== null; ) (Nl(e, t, n), (e = e.sibling));
    }
    function Nl(e, t, n) {
      switch (e.tag) {
        case 26:
          (Ml(e, t, n),
            e.flags & jl &&
              e.memoizedState !== null &&
              Kf(n, vl, e.memoizedState, e.memoizedProps));
          break;
        case 5:
          Ml(e, t, n);
          break;
        case 3:
        case 4:
          var r = vl;
          ((vl = _f(e.stateNode.containerInfo)), Ml(e, t, n), (vl = r));
          break;
        case 22:
          e.memoizedState === null &&
            ((r = e.alternate),
            r !== null && r.memoizedState !== null
              ? ((r = jl), (jl = 16777216), Ml(e, t, n), (jl = r))
              : Ml(e, t, n));
          break;
        default:
          Ml(e, t, n);
      }
    }
    function Pl(e) {
      var t = e.alternate;
      if (t !== null && ((e = t.child), e !== null)) {
        t.child = null;
        do ((t = e.sibling), (e.sibling = null), (e = t));
        while (e !== null);
      }
    }
    function Fl(e) {
      var t = e.deletions;
      if (e.flags & 16) {
        if (t !== null)
          for (var n = 0; n < t.length; n++) {
            var r = t[n];
            ((ol = r), Rl(r, e));
          }
        Pl(e);
      }
      if (e.subtreeFlags & 10256) for (e = e.child; e !== null; ) (Il(e), (e = e.sibling));
    }
    function Il(e) {
      switch (e.tag) {
        case 0:
        case 11:
        case 15:
          (Fl(e), e.flags & 2048 && Wc(9, e, e.return));
          break;
        case 3:
          Fl(e);
          break;
        case 12:
          Fl(e);
          break;
        case 22:
          var t = e.stateNode;
          e.memoizedState !== null &&
          t._visibility & 2 &&
          (e.return === null || e.return.tag !== 13)
            ? ((t._visibility &= -3), Ll(e))
            : Fl(e);
          break;
        default:
          Fl(e);
      }
    }
    function Ll(e) {
      var t = e.deletions;
      if (e.flags & 16) {
        if (t !== null)
          for (var n = 0; n < t.length; n++) {
            var r = t[n];
            ((ol = r), Rl(r, e));
          }
        Pl(e);
      }
      for (e = e.child; e !== null; ) {
        switch (((t = e), t.tag)) {
          case 0:
          case 11:
          case 15:
            (Wc(8, t, t.return), Ll(t));
            break;
          case 22:
            ((n = t.stateNode), n._visibility & 2 && ((n._visibility &= -3), Ll(t)));
            break;
          default:
            Ll(t);
        }
        e = e.sibling;
      }
    }
    function Rl(e, t) {
      for (; ol !== null; ) {
        var n = ol;
        switch (n.tag) {
          case 0:
          case 11:
          case 15:
            Wc(8, n, t);
            break;
          case 23:
          case 22:
            if (n.memoizedState !== null && n.memoizedState.cachePool !== null) {
              var r = n.memoizedState.cachePool.pool;
              r != null && r.refCount++;
            }
            break;
          case 24:
            F(n.memoizedState.cache);
        }
        if (((r = n.child), r !== null)) ((r.return = n), (ol = r));
        else
          a: for (n = e; ol !== null; ) {
            r = ol;
            var i = r.sibling,
              a = r.return;
            if ((ll(r), r === n)) {
              ol = null;
              break a;
            }
            if (i !== null) {
              ((i.return = a), (ol = i));
              break a;
            }
            ol = a;
          }
      }
    }
    var zl = {
        getCacheForType: function (e) {
          var t = sa(pa),
            n = t.data.get(e);
          return (n === void 0 && ((n = e()), t.data.set(e, n)), n);
        },
        cacheSignal: function () {
          return sa(pa).controller.signal;
        },
      },
      Bl = typeof WeakMap == `function` ? WeakMap : Map,
      G = 0,
      K = null,
      q = null,
      J = 0,
      Y = 0,
      Vl = null,
      Hl = !1,
      Ul = !1,
      Wl = !1,
      Gl = 0,
      X = 0,
      Kl = 0,
      ql = 0,
      Jl = 0,
      Yl = 0,
      Xl = 0,
      Zl = null,
      Ql = null,
      $l = !1,
      eu = 0,
      tu = 0,
      nu = 1 / 0,
      ru = null,
      iu = null,
      au = 0,
      ou = null,
      su = null,
      cu = 0,
      lu = 0,
      uu = null,
      du = null,
      fu = 0,
      pu = null;
    function mu() {
      return G & 2 && J !== 0 ? J & -J : w.T === null ? pt() : fd();
    }
    function hu() {
      if (Yl === 0)
        if (!(J & 536870912) || P) {
          var e = Qe;
          ((Qe <<= 1), !(Qe & 3932160) && (Qe = 262144), (Yl = e));
        } else Yl = 536870912;
      return ((e = so.current), e !== null && (e.flags |= 32), Yl);
    }
    function gu(e, t, n) {
      (((e === K && (Y === 2 || Y === 9)) || e.cancelPendingCommit !== null) &&
        (Cu(e, 0), bu(e, J, Yl, !1)),
        ot(e, n),
        (!(G & 2) || e !== K) &&
          (e === K && (!(G & 2) && (ql |= n), X === 4 && bu(e, J, Yl, !1)), id(e)));
    }
    function _u(e, t, n) {
      if (G & 6) throw Error(o(327));
      var r = (!n && (t & 127) == 0 && (t & e.expiredLanes) === 0) || nt(e, t),
        i = r ? ju(e, t) : ku(e, t, !0),
        a = r;
      do {
        if (i === 0) {
          Ul && !r && bu(e, t, 0, !1);
          break;
        } else {
          if (((n = e.current.alternate), a && !yu(n))) {
            ((i = ku(e, t, !1)), (a = !1));
            continue;
          }
          if (i === 2) {
            if (((a = t), e.errorRecoveryDisabledLanes & a)) var s = 0;
            else
              ((s = e.pendingLanes & -536870913),
                (s = s === 0 ? (s & 536870912 ? 536870912 : 0) : s));
            if (s !== 0) {
              t = s;
              a: {
                var c = e;
                i = Zl;
                var l = c.current.memoizedState.isDehydrated;
                if ((l && (Cu(c, s).flags |= 256), (s = ku(c, s, !1)), s !== 2)) {
                  if (Wl && !l) {
                    ((c.errorRecoveryDisabledLanes |= a), (ql |= a), (i = 4));
                    break a;
                  }
                  ((a = Ql),
                    (Ql = i),
                    a !== null && (Ql === null ? (Ql = a) : Ql.push.apply(Ql, a)));
                }
                i = s;
              }
              if (((a = !1), i !== 2)) continue;
            }
          }
          if (i === 1) {
            (Cu(e, 0), bu(e, t, 0, !0));
            break;
          }
          a: {
            switch (((r = e), (a = i), a)) {
              case 0:
              case 1:
                throw Error(o(345));
              case 4:
                if ((t & 4194048) !== t) break;
              case 6:
                bu(r, t, Yl, !Hl);
                break a;
              case 2:
                Ql = null;
                break;
              case 3:
              case 5:
                break;
              default:
                throw Error(o(329));
            }
            if ((t & 62914560) === t && ((i = eu + 300 - Fe()), 10 < i)) {
              if ((bu(r, t, Yl, !Hl), tt(r, 0, !0) !== 0)) break a;
              ((cu = t),
                (r.timeoutHandle = qd(
                  vu.bind(null, r, n, Ql, ru, $l, t, Yl, ql, Xl, Hl, a, `Throttled`, -0, 0),
                  i,
                )));
              break a;
            }
            vu(r, n, Ql, ru, $l, t, Yl, ql, Xl, Hl, a, null, -0, 0);
          }
        }
        break;
      } while (1);
      id(e);
    }
    function vu(e, t, n, r, i, a, o, s, c, l, u, d, f, p) {
      if (((e.timeoutHandle = -1), (d = t.subtreeFlags), d & 8192 || (d & 16785408) == 16785408)) {
        ((d = {
          stylesheets: null,
          count: 0,
          imgCount: 0,
          imgBytes: 0,
          suspenseyImages: [],
          waitingForImages: !0,
          waitingForViewTransition: !1,
          unsuspend: un,
        }),
          Nl(t, a, d));
        var m = (a & 62914560) === a ? eu - Fe() : (a & 4194048) === a ? tu - Fe() : 0;
        if (((m = Jf(d, m)), m !== null)) {
          ((cu = a),
            (e.cancelPendingCommit = m(Ru.bind(null, e, t, a, n, r, i, o, s, c, u, d, null, f, p))),
            bu(e, a, o, !l));
          return;
        }
      }
      Ru(e, t, a, n, r, i, o, s, c);
    }
    function yu(e) {
      for (var t = e; ; ) {
        var n = t.tag;
        if (
          (n === 0 || n === 11 || n === 15) &&
          t.flags & 16384 &&
          ((n = t.updateQueue), n !== null && ((n = n.stores), n !== null))
        )
          for (var r = 0; r < n.length; r++) {
            var i = n[r],
              a = i.getSnapshot;
            i = i.value;
            try {
              if (!kr(a(), i)) return !1;
            } catch {
              return !1;
            }
          }
        if (((n = t.child), t.subtreeFlags & 16384 && n !== null)) ((n.return = t), (t = n));
        else {
          if (t === e) break;
          for (; t.sibling === null; ) {
            if (t.return === null || t.return === e) return !0;
            t = t.return;
          }
          ((t.sibling.return = t.return), (t = t.sibling));
        }
      }
      return !0;
    }
    function bu(e, t, n, r) {
      ((t &= ~Jl),
        (t &= ~ql),
        (e.suspendedLanes |= t),
        (e.pingedLanes &= ~t),
        r && (e.warmLanes |= t),
        (r = e.expirationTimes));
      for (var i = t; 0 < i; ) {
        var a = 31 - qe(i),
          o = 1 << a;
        ((r[a] = -1), (i &= ~o));
      }
      n !== 0 && ct(e, n, t);
    }
    function xu() {
      return G & 6 ? !0 : (ad(0, !1), !1);
    }
    function Su() {
      if (q !== null) {
        if (Y === 0) var e = q.return;
        else ((e = q), ($i = Qi = null), No(e), (La = null), (Ra = 0), (e = q));
        for (; e !== null; ) (Hc(e.alternate, e), (e = e.return));
        q = null;
      }
    }
    function Cu(e, t) {
      var n = e.timeoutHandle;
      (n !== -1 && ((e.timeoutHandle = -1), Jd(n)),
        (n = e.cancelPendingCommit),
        n !== null && ((e.cancelPendingCommit = null), n()),
        (cu = 0),
        Su(),
        (K = e),
        (q = n = _i(e.current, null)),
        (J = t),
        (Y = 0),
        (Vl = null),
        (Hl = !1),
        (Ul = nt(e, t)),
        (Wl = !1),
        (Xl = Yl = Jl = ql = Kl = X = 0),
        (Ql = Zl = null),
        ($l = !1),
        t & 8 && (t |= t & 32));
      var r = e.entangledLanes;
      if (r !== 0)
        for (e = e.entanglements, r &= t; 0 < r; ) {
          var i = 31 - qe(r),
            a = 1 << i;
          ((t |= e[i]), (r &= ~a));
        }
      return ((Gl = t), si(), n);
    }
    function wu(e, t) {
      ((L = null),
        (w.H = Bs),
        t === Da || t === ka
          ? ((t = Fa()), (Y = 3))
          : t === Oa
            ? ((t = Fa()), (Y = 4))
            : (Y = t === ic ? 8 : typeof t == `object` && t && typeof t.then == `function` ? 6 : 1),
        (Vl = t),
        q === null && ((X = 1), Qs(e, Ti(t, e.current))));
    }
    function Tu() {
      var e = so.current;
      return e === null
        ? !0
        : (J & 4194048) === J
          ? co === null
          : (J & 62914560) === J || J & 536870912
            ? e === co
            : !1;
    }
    function Eu() {
      var e = w.H;
      return ((w.H = Bs), e === null ? Bs : e);
    }
    function Du() {
      var e = w.A;
      return ((w.A = zl), e);
    }
    function Ou() {
      ((X = 4),
        Hl || ((J & 4194048) !== J && so.current !== null) || (Ul = !0),
        (!(Kl & 134217727) && !(ql & 134217727)) || K === null || bu(K, J, Yl, !1));
    }
    function ku(e, t, n) {
      var r = G;
      G |= 2;
      var i = Eu(),
        a = Du();
      ((K !== e || J !== t) && ((ru = null), Cu(e, t)), (t = !1));
      var o = X;
      a: do
        try {
          if (Y !== 0 && q !== null) {
            var s = q,
              c = Vl;
            switch (Y) {
              case 8:
                (Su(), (o = 6));
                break a;
              case 3:
              case 2:
              case 9:
              case 6:
                so.current === null && (t = !0);
                var l = Y;
                if (((Y = 0), (Vl = null), Fu(e, s, c, l), n && Ul)) {
                  o = 0;
                  break a;
                }
                break;
              default:
                ((l = Y), (Y = 0), (Vl = null), Fu(e, s, c, l));
            }
          }
          (Au(), (o = X));
          break;
        } catch (t) {
          wu(e, t);
        }
      while (1);
      return (
        t && e.shellSuspendCounter++,
        ($i = Qi = null),
        (G = r),
        (w.H = i),
        (w.A = a),
        q === null && ((K = null), (J = 0), si()),
        o
      );
    }
    function Au() {
      for (; q !== null; ) Nu(q);
    }
    function ju(e, t) {
      var n = G;
      G |= 2;
      var r = Eu(),
        i = Du();
      K !== e || J !== t ? ((ru = null), (nu = Fe() + 500), Cu(e, t)) : (Ul = nt(e, t));
      a: do
        try {
          if (Y !== 0 && q !== null) {
            t = q;
            var a = Vl;
            b: switch (Y) {
              case 1:
                ((Y = 0), (Vl = null), Fu(e, t, a, 1));
                break;
              case 2:
              case 9:
                if (ja(a)) {
                  ((Y = 0), (Vl = null), Pu(t));
                  break;
                }
                ((t = function () {
                  ((Y !== 2 && Y !== 9) || K !== e || (Y = 7), id(e));
                }),
                  a.then(t, t));
                break a;
              case 3:
                Y = 7;
                break a;
              case 4:
                Y = 5;
                break a;
              case 7:
                ja(a) ? ((Y = 0), (Vl = null), Pu(t)) : ((Y = 0), (Vl = null), Fu(e, t, a, 7));
                break;
              case 5:
                var s = null;
                switch (q.tag) {
                  case 26:
                    s = q.memoizedState;
                  case 5:
                  case 27:
                    var c = q;
                    if (s ? Gf(s) : c.stateNode.complete) {
                      ((Y = 0), (Vl = null));
                      var l = c.sibling;
                      if (l !== null) q = l;
                      else {
                        var u = c.return;
                        u === null ? (q = null) : ((q = u), Iu(u));
                      }
                      break b;
                    }
                }
                ((Y = 0), (Vl = null), Fu(e, t, a, 5));
                break;
              case 6:
                ((Y = 0), (Vl = null), Fu(e, t, a, 6));
                break;
              case 8:
                (Su(), (X = 6));
                break a;
              default:
                throw Error(o(462));
            }
          }
          Mu();
          break;
        } catch (t) {
          wu(e, t);
        }
      while (1);
      return (
        ($i = Qi = null),
        (w.H = r),
        (w.A = i),
        (G = n),
        q === null ? ((K = null), (J = 0), si(), X) : 0
      );
    }
    function Mu() {
      for (; q !== null && !Ne(); ) Nu(q);
    }
    function Nu(e) {
      var t = Pc(e.alternate, e, Gl);
      ((e.memoizedProps = e.pendingProps), t === null ? Iu(e) : (q = t));
    }
    function Pu(e) {
      var t = e,
        n = t.alternate;
      switch (t.tag) {
        case 15:
        case 0:
          t = vc(n, t, t.pendingProps, t.type, void 0, J);
          break;
        case 11:
          t = vc(n, t, t.pendingProps, t.type.render, t.ref, J);
          break;
        case 5:
          No(t);
        default:
          (Hc(n, t), (t = q = vi(t, Gl)), (t = Pc(n, t, Gl)));
      }
      ((e.memoizedProps = e.pendingProps), t === null ? Iu(e) : (q = t));
    }
    function Fu(e, t, n, r) {
      (($i = Qi = null), No(t), (La = null), (Ra = 0));
      var i = t.return;
      try {
        if (rc(e, i, t, n, J)) {
          ((X = 1), Qs(e, Ti(n, e.current)), (q = null));
          return;
        }
      } catch (t) {
        if (i !== null) throw ((q = i), t);
        ((X = 1), Qs(e, Ti(n, e.current)), (q = null));
        return;
      }
      t.flags & 32768
        ? (P || r === 1
            ? (e = !0)
            : Ul || J & 536870912
              ? (e = !1)
              : ((Hl = e = !0),
                (r === 2 || r === 9 || r === 3 || r === 6) &&
                  ((r = so.current), r !== null && r.tag === 13 && (r.flags |= 16384))),
          Lu(t, e))
        : Iu(t);
    }
    function Iu(e) {
      var t = e;
      do {
        if (t.flags & 32768) {
          Lu(t, Hl);
          return;
        }
        e = t.return;
        var n = Bc(t.alternate, t, Gl);
        if (n !== null) {
          q = n;
          return;
        }
        if (((t = t.sibling), t !== null)) {
          q = t;
          return;
        }
        q = t = e;
      } while (t !== null);
      X === 0 && (X = 5);
    }
    function Lu(e, t) {
      do {
        var n = Vc(e.alternate, e);
        if (n !== null) {
          ((n.flags &= 32767), (q = n));
          return;
        }
        if (
          ((n = e.return),
          n !== null && ((n.flags |= 32768), (n.subtreeFlags = 0), (n.deletions = null)),
          !t && ((e = e.sibling), e !== null))
        ) {
          q = e;
          return;
        }
        q = e = n;
      } while (e !== null);
      ((X = 6), (q = null));
    }
    function Ru(e, t, n, r, i, a, s, c, l) {
      e.cancelPendingCommit = null;
      do Uu();
      while (au !== 0);
      if (G & 6) throw Error(o(327));
      if (t !== null) {
        if (t === e.current) throw Error(o(177));
        if (
          ((a = t.lanes | t.childLanes),
          (a |= oi),
          st(e, n, a, s, c, l),
          e === K && ((q = K = null), (J = 0)),
          (su = t),
          (ou = e),
          (cu = n),
          (lu = a),
          (uu = i),
          (du = r),
          t.subtreeFlags & 10256 || t.flags & 10256
            ? ((e.callbackNode = null),
              (e.callbackPriority = 0),
              Zu(ze, function () {
                return (Wu(), null);
              }))
            : ((e.callbackNode = null), (e.callbackPriority = 0)),
          (r = (t.flags & 13878) != 0),
          t.subtreeFlags & 13878 || r)
        ) {
          ((r = w.T), (w.T = null), (i = E.p), (E.p = 2), (s = G), (G |= 4));
          try {
            sl(e, t, n);
          } finally {
            ((G = s), (E.p = i), (w.T = r));
          }
        }
        ((au = 1), zu(), Bu(), Vu());
      }
    }
    function zu() {
      if (au === 1) {
        au = 0;
        var e = ou,
          t = su,
          n = (t.flags & 13878) != 0;
        if (t.subtreeFlags & 13878 || n) {
          ((n = w.T), (w.T = null));
          var r = E.p;
          E.p = 2;
          var i = G;
          G |= 4;
          try {
            yl(t, e);
            var a = Bd,
              o = Pr(e.containerInfo),
              s = a.focusedElem,
              c = a.selectionRange;
            if (o !== s && s && s.ownerDocument && Nr(s.ownerDocument.documentElement, s)) {
              if (c !== null && Fr(s)) {
                var l = c.start,
                  u = c.end;
                if ((u === void 0 && (u = l), `selectionStart` in s))
                  ((s.selectionStart = l), (s.selectionEnd = Math.min(u, s.value.length)));
                else {
                  var d = s.ownerDocument || document,
                    f = (d && d.defaultView) || window;
                  if (f.getSelection) {
                    var p = f.getSelection(),
                      m = s.textContent.length,
                      h = Math.min(c.start, m),
                      g = c.end === void 0 ? h : Math.min(c.end, m);
                    !p.extend && h > g && ((o = g), (g = h), (h = o));
                    var _ = Mr(s, h),
                      v = Mr(s, g);
                    if (
                      _ &&
                      v &&
                      (p.rangeCount !== 1 ||
                        p.anchorNode !== _.node ||
                        p.anchorOffset !== _.offset ||
                        p.focusNode !== v.node ||
                        p.focusOffset !== v.offset)
                    ) {
                      var y = d.createRange();
                      (y.setStart(_.node, _.offset),
                        p.removeAllRanges(),
                        h > g
                          ? (p.addRange(y), p.extend(v.node, v.offset))
                          : (y.setEnd(v.node, v.offset), p.addRange(y)));
                    }
                  }
                }
              }
              for (d = [], p = s; (p = p.parentNode); )
                p.nodeType === 1 && d.push({ element: p, left: p.scrollLeft, top: p.scrollTop });
              for (typeof s.focus == `function` && s.focus(), s = 0; s < d.length; s++) {
                var b = d[s];
                ((b.element.scrollLeft = b.left), (b.element.scrollTop = b.top));
              }
            }
            ((cp = !!zd), (Bd = zd = null));
          } finally {
            ((G = i), (E.p = r), (w.T = n));
          }
        }
        ((e.current = t), (au = 2));
      }
    }
    function Bu() {
      if (au === 2) {
        au = 0;
        var e = ou,
          t = su,
          n = (t.flags & 8772) != 0;
        if (t.subtreeFlags & 8772 || n) {
          ((n = w.T), (w.T = null));
          var r = E.p;
          E.p = 2;
          var i = G;
          G |= 4;
          try {
            cl(e, t.alternate, t);
          } finally {
            ((G = i), (E.p = r), (w.T = n));
          }
        }
        au = 3;
      }
    }
    function Vu() {
      if (au === 4 || au === 3) {
        ((au = 0), Pe());
        var e = ou,
          t = su,
          n = cu,
          r = du;
        t.subtreeFlags & 10256 || t.flags & 10256
          ? (au = 5)
          : ((au = 0), (su = ou = null), Hu(e, e.pendingLanes));
        var i = e.pendingLanes;
        if (
          (i === 0 && (iu = null),
          ft(n),
          (t = t.stateNode),
          Ge && typeof Ge.onCommitFiberRoot == `function`)
        )
          try {
            Ge.onCommitFiberRoot(We, t, void 0, (t.current.flags & 128) == 128);
          } catch {}
        if (r !== null) {
          ((t = w.T), (i = E.p), (E.p = 2), (w.T = null));
          try {
            for (var a = e.onRecoverableError, o = 0; o < r.length; o++) {
              var s = r[o];
              a(s.value, { componentStack: s.stack });
            }
          } finally {
            ((w.T = t), (E.p = i));
          }
        }
        (cu & 3 && Uu(),
          id(e),
          (i = e.pendingLanes),
          n & 261930 && i & 42 ? (e === pu ? fu++ : ((fu = 0), (pu = e))) : (fu = 0),
          ad(0, !1));
      }
    }
    function Hu(e, t) {
      (e.pooledCacheLanes &= t) === 0 &&
        ((t = e.pooledCache), t != null && ((e.pooledCache = null), F(t)));
    }
    function Uu() {
      return (zu(), Bu(), Vu(), Wu());
    }
    function Wu() {
      if (au !== 5) return !1;
      var e = ou,
        t = lu;
      lu = 0;
      var n = ft(cu),
        r = w.T,
        i = E.p;
      try {
        ((E.p = 32 > n ? 32 : n), (w.T = null), (n = uu), (uu = null));
        var a = ou,
          s = cu;
        if (((au = 0), (su = ou = null), (cu = 0), G & 6)) throw Error(o(331));
        var c = G;
        if (
          ((G |= 4),
          Il(a.current),
          Ol(a, a.current, s, n),
          (G = c),
          ad(0, !1),
          Ge && typeof Ge.onPostCommitFiberRoot == `function`)
        )
          try {
            Ge.onPostCommitFiberRoot(We, a);
          } catch {}
        return !0;
      } finally {
        ((E.p = i), (w.T = r), Hu(e, t));
      }
    }
    function Gu(e, t, n) {
      ((t = Ti(n, t)),
        (t = ec(e.stateNode, t, 2)),
        (e = I(e, t, 2)),
        e !== null && (ot(e, 2), id(e)));
    }
    function Z(e, t, n) {
      if (e.tag === 3) Gu(e, e, n);
      else
        for (; t !== null; ) {
          if (t.tag === 3) {
            Gu(t, e, n);
            break;
          } else if (t.tag === 1) {
            var r = t.stateNode;
            if (
              typeof t.type.getDerivedStateFromError == `function` ||
              (typeof r.componentDidCatch == `function` && (iu === null || !iu.has(r)))
            ) {
              ((e = Ti(n, e)),
                (n = tc(2)),
                (r = I(t, n, 2)),
                r !== null && (nc(n, r, t, e), ot(r, 2), id(r)));
              break;
            }
          }
          t = t.return;
        }
    }
    function Ku(e, t, n) {
      var r = e.pingCache;
      if (r === null) {
        r = e.pingCache = new Bl();
        var i = new Set();
        r.set(t, i);
      } else ((i = r.get(t)), i === void 0 && ((i = new Set()), r.set(t, i)));
      i.has(n) || ((Wl = !0), i.add(n), (e = qu.bind(null, e, t, n)), t.then(e, e));
    }
    function qu(e, t, n) {
      var r = e.pingCache;
      (r !== null && r.delete(t),
        (e.pingedLanes |= e.suspendedLanes & n),
        (e.warmLanes &= ~n),
        K === e &&
          (J & n) === n &&
          (X === 4 || (X === 3 && (J & 62914560) === J && 300 > Fe() - eu)
            ? !(G & 2) && Cu(e, 0)
            : (Jl |= n),
          Xl === J && (Xl = 0)),
        id(e));
    }
    function Ju(e, t) {
      (t === 0 && (t = it()), (e = ui(e, t)), e !== null && (ot(e, t), id(e)));
    }
    function Yu(e) {
      var t = e.memoizedState,
        n = 0;
      (t !== null && (n = t.retryLane), Ju(e, n));
    }
    function Xu(e, t) {
      var n = 0;
      switch (e.tag) {
        case 31:
        case 13:
          var r = e.stateNode,
            i = e.memoizedState;
          i !== null && (n = i.retryLane);
          break;
        case 19:
          r = e.stateNode;
          break;
        case 22:
          r = e.stateNode._retryCache;
          break;
        default:
          throw Error(o(314));
      }
      (r !== null && r.delete(t), Ju(e, n));
    }
    function Zu(e, t) {
      return je(e, t);
    }
    var Qu = null,
      $u = null,
      ed = !1,
      td = !1,
      nd = !1,
      rd = 0;
    function id(e) {
      (e !== $u && e.next === null && ($u === null ? (Qu = $u = e) : ($u = $u.next = e)),
        (td = !0),
        ed || ((ed = !0), dd()));
    }
    function ad(e, t) {
      if (!nd && td) {
        nd = !0;
        do
          for (var n = !1, r = Qu; r !== null; ) {
            if (!t)
              if (e !== 0) {
                var i = r.pendingLanes;
                if (i === 0) var a = 0;
                else {
                  var o = r.suspendedLanes,
                    s = r.pingedLanes;
                  ((a = (1 << (31 - qe(42 | e) + 1)) - 1),
                    (a &= i & ~(o & ~s)),
                    (a = a & 201326741 ? (a & 201326741) | 1 : a ? a | 2 : 0));
                }
                a !== 0 && ((n = !0), ud(r, a));
              } else
                ((a = J),
                  (a = tt(
                    r,
                    r === K ? a : 0,
                    r.cancelPendingCommit !== null || r.timeoutHandle !== -1,
                  )),
                  !(a & 3) || nt(r, a) || ((n = !0), ud(r, a)));
            r = r.next;
          }
        while (n);
        nd = !1;
      }
    }
    function od() {
      sd();
    }
    function sd() {
      td = ed = !1;
      var e = 0;
      rd !== 0 && Kd() && (e = rd);
      for (var t = Fe(), n = null, r = Qu; r !== null; ) {
        var i = r.next,
          a = cd(r, t);
        (a === 0
          ? ((r.next = null), n === null ? (Qu = i) : (n.next = i), i === null && ($u = n))
          : ((n = r), (e !== 0 || a & 3) && (td = !0)),
          (r = i));
      }
      ((au !== 0 && au !== 5) || ad(e, !1), rd !== 0 && (rd = 0));
    }
    function cd(e, t) {
      for (
        var n = e.suspendedLanes,
          r = e.pingedLanes,
          i = e.expirationTimes,
          a = e.pendingLanes & -62914561;
        0 < a;
      ) {
        var o = 31 - qe(a),
          s = 1 << o,
          c = i[o];
        (c === -1
          ? ((s & n) === 0 || (s & r) !== 0) && (i[o] = rt(s, t))
          : c <= t && (e.expiredLanes |= s),
          (a &= ~s));
      }
      if (
        ((t = K),
        (n = J),
        (n = tt(e, e === t ? n : 0, e.cancelPendingCommit !== null || e.timeoutHandle !== -1)),
        (r = e.callbackNode),
        n === 0 || (e === t && (Y === 2 || Y === 9)) || e.cancelPendingCommit !== null)
      )
        return (
          r !== null && r !== null && Me(r), (e.callbackNode = null), (e.callbackPriority = 0)
        );
      if (!(n & 3) || nt(e, n)) {
        if (((t = n & -n), t === e.callbackPriority)) return t;
        switch ((r !== null && Me(r), ft(n))) {
          case 2:
          case 8:
            n = Re;
            break;
          case 32:
            n = ze;
            break;
          case 268435456:
            n = Ve;
            break;
          default:
            n = ze;
        }
        return (
          (r = ld.bind(null, e)), (n = je(n, r)), (e.callbackPriority = t), (e.callbackNode = n), t
        );
      }
      return (
        r !== null && r !== null && Me(r), (e.callbackPriority = 2), (e.callbackNode = null), 2
      );
    }
    function ld(e, t) {
      if (au !== 0 && au !== 5) return ((e.callbackNode = null), (e.callbackPriority = 0), null);
      var n = e.callbackNode;
      if (Uu() && e.callbackNode !== n) return null;
      var r = J;
      return (
        (r = tt(e, e === K ? r : 0, e.cancelPendingCommit !== null || e.timeoutHandle !== -1)),
        r === 0
          ? null
          : (_u(e, r, t),
            cd(e, Fe()),
            e.callbackNode != null && e.callbackNode === n ? ld.bind(null, e) : null)
      );
    }
    function ud(e, t) {
      if (Uu()) return null;
      _u(e, t, !0);
    }
    function dd() {
      Xd(function () {
        G & 6 ? je(Le, od) : sd();
      });
    }
    function fd() {
      if (rd === 0) {
        var e = _a;
        (e === 0 && ((e = Ze), (Ze <<= 1), !(Ze & 261888) && (Ze = 256)), (rd = e));
      }
      return rd;
    }
    function pd(e) {
      return e == null || typeof e == `symbol` || typeof e == `boolean`
        ? null
        : typeof e == `function`
          ? e
          : ln(`` + e);
    }
    function md(e, t) {
      var n = t.ownerDocument.createElement(`input`);
      return (
        (n.name = t.name),
        (n.value = t.value),
        e.id && n.setAttribute(`form`, e.id),
        t.parentNode.insertBefore(n, t),
        (e = new FormData(e)),
        n.parentNode.removeChild(n),
        e
      );
    }
    function hd(e, t, n, r, i) {
      if (t === `submit` && n && n.stateNode === i) {
        var a = pd((i[_t] || null).action),
          o = r.submitter;
        o &&
          ((t = (t = o[_t] || null) ? pd(t.formAction) : o.getAttribute(`formAction`)),
          t !== null && ((a = t), (o = null)));
        var s = new An(`action`, `action`, null, r, i);
        e.push({
          event: s,
          listeners: [
            {
              instance: null,
              listener: function () {
                if (r.defaultPrevented) {
                  if (rd !== 0) {
                    var e = o ? md(i, o) : new FormData(i);
                    Es(n, { pending: !0, data: e, method: i.method, action: a }, null, e);
                  }
                } else
                  typeof a == `function` &&
                    (s.preventDefault(),
                    (e = o ? md(i, o) : new FormData(i)),
                    Es(n, { pending: !0, data: e, method: i.method, action: a }, a, e));
              },
              currentTarget: i,
            },
          ],
        });
      }
    }
    for (var gd = 0; gd < ti.length; gd++) {
      var _d = ti[gd];
      ni(_d.toLowerCase(), `on` + (_d[0].toUpperCase() + _d.slice(1)));
    }
    (ni(qr, `onAnimationEnd`),
      ni(Jr, `onAnimationIteration`),
      ni(Yr, `onAnimationStart`),
      ni(`dblclick`, `onDoubleClick`),
      ni(`focusin`, `onFocus`),
      ni(`focusout`, `onBlur`),
      ni(Xr, `onTransitionRun`),
      ni(Zr, `onTransitionStart`),
      ni(Qr, `onTransitionCancel`),
      ni($r, `onTransitionEnd`),
      Nt(`onMouseEnter`, [`mouseout`, `mouseover`]),
      Nt(`onMouseLeave`, [`mouseout`, `mouseover`]),
      Nt(`onPointerEnter`, [`pointerout`, `pointerover`]),
      Nt(`onPointerLeave`, [`pointerout`, `pointerover`]),
      Mt(
        `onChange`,
        `change click focusin focusout input keydown keyup selectionchange`.split(` `),
      ),
      Mt(
        `onSelect`,
        `focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange`.split(
          ` `,
        ),
      ),
      Mt(`onBeforeInput`, [`compositionend`, `keypress`, `textInput`, `paste`]),
      Mt(`onCompositionEnd`, `compositionend focusout keydown keypress keyup mousedown`.split(` `)),
      Mt(
        `onCompositionStart`,
        `compositionstart focusout keydown keypress keyup mousedown`.split(` `),
      ),
      Mt(
        `onCompositionUpdate`,
        `compositionupdate focusout keydown keypress keyup mousedown`.split(` `),
      ));
    var vd =
        `abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting`.split(
          ` `,
        ),
      yd = new Set(
        `beforetoggle cancel close invalid load scroll scrollend toggle`.split(` `).concat(vd),
      );
    function bd(e, t) {
      t = (t & 4) != 0;
      for (var n = 0; n < e.length; n++) {
        var r = e[n],
          i = r.event;
        r = r.listeners;
        a: {
          var a = void 0;
          if (t)
            for (var o = r.length - 1; 0 <= o; o--) {
              var s = r[o],
                c = s.instance,
                l = s.currentTarget;
              if (((s = s.listener), c !== a && i.isPropagationStopped())) break a;
              ((a = s), (i.currentTarget = l));
              try {
                a(i);
              } catch (e) {
                ri(e);
              }
              ((i.currentTarget = null), (a = c));
            }
          else
            for (o = 0; o < r.length; o++) {
              if (
                ((s = r[o]),
                (c = s.instance),
                (l = s.currentTarget),
                (s = s.listener),
                c !== a && i.isPropagationStopped())
              )
                break a;
              ((a = s), (i.currentTarget = l));
              try {
                a(i);
              } catch (e) {
                ri(e);
              }
              ((i.currentTarget = null), (a = c));
            }
        }
      }
    }
    function Q(e, t) {
      var n = t[yt];
      n === void 0 && (n = t[yt] = new Set());
      var r = e + `__bubble`;
      n.has(r) || (wd(t, e, 2, !1), n.add(r));
    }
    function xd(e, t, n) {
      var r = 0;
      (t && (r |= 4), wd(n, e, r, t));
    }
    var Sd = `_reactListening` + Math.random().toString(36).slice(2);
    function Cd(e) {
      if (!e[Sd]) {
        ((e[Sd] = !0),
          At.forEach(function (t) {
            t !== `selectionchange` && (yd.has(t) || xd(t, !1, e), xd(t, !0, e));
          }));
        var t = e.nodeType === 9 ? e : e.ownerDocument;
        t === null || t[Sd] || ((t[Sd] = !0), xd(`selectionchange`, !1, t));
      }
    }
    function wd(e, t, n, r) {
      switch (hp(t)) {
        case 2:
          var i = lp;
          break;
        case 8:
          i = up;
          break;
        default:
          i = dp;
      }
      ((n = i.bind(null, t, n, e)),
        (i = void 0),
        !bn || (t !== `touchstart` && t !== `touchmove` && t !== `wheel`) || (i = !0),
        r
          ? i === void 0
            ? e.addEventListener(t, n, !0)
            : e.addEventListener(t, n, { capture: !0, passive: i })
          : i === void 0
            ? e.addEventListener(t, n, !1)
            : e.addEventListener(t, n, { passive: i }));
    }
    function Td(e, t, n, r, i) {
      var a = r;
      if (!(t & 1) && !(t & 2) && r !== null)
        a: for (;;) {
          if (r === null) return;
          var o = r.tag;
          if (o === 3 || o === 4) {
            var s = r.stateNode.containerInfo;
            if (s === i) break;
            if (o === 4)
              for (o = r.return; o !== null; ) {
                var c = o.tag;
                if ((c === 3 || c === 4) && o.stateNode.containerInfo === i) return;
                o = o.return;
              }
            for (; s !== null; ) {
              if (((o = Tt(s)), o === null)) return;
              if (((c = o.tag), c === 5 || c === 6 || c === 26 || c === 27)) {
                r = a = o;
                continue a;
              }
              s = s.parentNode;
            }
          }
          r = r.return;
        }
      _n(function () {
        var r = a,
          i = fn(n),
          o = [];
        a: {
          var s = ei.get(e);
          if (s !== void 0) {
            var c = An,
              u = e;
            switch (e) {
              case `keypress`:
                if (En(n) === 0) break a;
              case `keydown`:
              case `keyup`:
                c = Kn;
                break;
              case `focusin`:
                ((u = `focus`), (c = zn));
                break;
              case `focusout`:
                ((u = `blur`), (c = zn));
                break;
              case `beforeblur`:
              case `afterblur`:
                c = zn;
                break;
              case `click`:
                if (n.button === 2) break a;
              case `auxclick`:
              case `dblclick`:
              case `mousedown`:
              case `mousemove`:
              case `mouseup`:
              case `mouseout`:
              case `mouseover`:
              case `contextmenu`:
                c = Ln;
                break;
              case `drag`:
              case `dragend`:
              case `dragenter`:
              case `dragexit`:
              case `dragleave`:
              case `dragover`:
              case `dragstart`:
              case `drop`:
                c = Rn;
                break;
              case `touchcancel`:
              case `touchend`:
              case `touchmove`:
              case `touchstart`:
                c = Jn;
                break;
              case qr:
              case Jr:
              case Yr:
                c = j;
                break;
              case $r:
                c = Yn;
                break;
              case `scroll`:
              case `scrollend`:
                c = Mn;
                break;
              case `wheel`:
                c = Xn;
                break;
              case `copy`:
              case `cut`:
              case `paste`:
                c = Bn;
                break;
              case `gotpointercapture`:
              case `lostpointercapture`:
              case `pointercancel`:
              case `pointerdown`:
              case `pointermove`:
              case `pointerout`:
              case `pointerover`:
              case `pointerup`:
                c = qn;
                break;
              case `toggle`:
              case `beforetoggle`:
                c = Zn;
            }
            var d = (t & 4) != 0,
              f = !d && (e === `scroll` || e === `scrollend`),
              p = d ? (s === null ? null : s + `Capture`) : s;
            d = [];
            for (var m = r, h; m !== null; ) {
              var g = m;
              if (
                ((h = g.stateNode),
                (g = g.tag),
                (g !== 5 && g !== 26 && g !== 27) ||
                  h === null ||
                  p === null ||
                  ((g = vn(m, p)), g != null && d.push(Ed(m, g, h))),
                f)
              )
                break;
              m = m.return;
            }
            0 < d.length && ((s = new c(s, u, null, n, i)), o.push({ event: s, listeners: d }));
          }
        }
        if (!(t & 7)) {
          a: {
            if (
              ((s = e === `mouseover` || e === `pointerover`),
              (c = e === `mouseout` || e === `pointerout`),
              s && n !== dn && (u = n.relatedTarget || n.fromElement) && (Tt(u) || u[vt]))
            )
              break a;
            if (
              (c || s) &&
              ((s =
                i.window === i
                  ? i
                  : (s = i.ownerDocument)
                    ? s.defaultView || s.parentWindow
                    : window),
              c
                ? ((u = n.relatedTarget || n.toElement),
                  (c = r),
                  (u = u ? Tt(u) : null),
                  u !== null &&
                    ((f = l(u)), (d = u.tag), u !== f || (d !== 5 && d !== 27 && d !== 6)) &&
                    (u = null))
                : ((c = null), (u = r)),
              c !== u)
            ) {
              if (
                ((d = Ln),
                (g = `onMouseLeave`),
                (p = `onMouseEnter`),
                (m = `mouse`),
                (e === `pointerout` || e === `pointerover`) &&
                  ((d = qn), (g = `onPointerLeave`), (p = `onPointerEnter`), (m = `pointer`)),
                (f = c == null ? s : Dt(c)),
                (h = u == null ? s : Dt(u)),
                (s = new d(g, m + `leave`, c, n, i)),
                (s.target = f),
                (s.relatedTarget = h),
                (g = null),
                Tt(i) === r &&
                  ((d = new d(p, m + `enter`, u, n, i)),
                  (d.target = h),
                  (d.relatedTarget = f),
                  (g = d)),
                (f = g),
                c && u)
              )
                b: {
                  for (d = Od, p = c, m = u, h = 0, g = p; g; g = d(g)) h++;
                  g = 0;
                  for (var _ = m; _; _ = d(_)) g++;
                  for (; 0 < h - g; ) ((p = d(p)), h--);
                  for (; 0 < g - h; ) ((m = d(m)), g--);
                  for (; h--; ) {
                    if (p === m || (m !== null && p === m.alternate)) {
                      d = p;
                      break b;
                    }
                    ((p = d(p)), (m = d(m)));
                  }
                  d = null;
                }
              else d = null;
              (c !== null && kd(o, s, c, d, !1), u !== null && f !== null && kd(o, f, u, d, !0));
            }
          }
          a: {
            if (
              ((s = r ? Dt(r) : window),
              (c = s.nodeName && s.nodeName.toLowerCase()),
              c === `select` || (c === `input` && s.type === `file`))
            )
              var v = _r;
            else if (dr(s))
              if (vr) v = Dr;
              else {
                v = Tr;
                var y = wr;
              }
            else
              ((c = s.nodeName),
                !c || c.toLowerCase() !== `input` || (s.type !== `checkbox` && s.type !== `radio`)
                  ? r && on(r.elementType) && (v = _r)
                  : (v = Er));
            if ((v &&= v(e, r))) {
              fr(o, v, n, i);
              break a;
            }
            (y && y(e, s, r),
              e === `focusout` &&
                r &&
                s.type === `number` &&
                r.memoizedProps.value != null &&
                Zt(s, `number`, s.value));
          }
          switch (((y = r ? Dt(r) : window), e)) {
            case `focusin`:
              (dr(y) || y.contentEditable === `true`) && ((Lr = y), (Rr = r), (zr = null));
              break;
            case `focusout`:
              zr = Rr = Lr = null;
              break;
            case `mousedown`:
              Br = !0;
              break;
            case `contextmenu`:
            case `mouseup`:
            case `dragend`:
              ((Br = !1), Vr(o, n, i));
              break;
            case `selectionchange`:
              if (Ir) break;
            case `keydown`:
            case `keyup`:
              Vr(o, n, i);
          }
          var b;
          if ($n)
            b: {
              switch (e) {
                case `compositionstart`:
                  var x = `onCompositionStart`;
                  break b;
                case `compositionend`:
                  x = `onCompositionEnd`;
                  break b;
                case `compositionupdate`:
                  x = `onCompositionUpdate`;
                  break b;
              }
              x = void 0;
            }
          else
            sr
              ? ar(e, n) && (x = `onCompositionEnd`)
              : e === `keydown` && n.keyCode === 229 && (x = `onCompositionStart`);
          (x &&
            (nr &&
              n.locale !== `ko` &&
              (sr || x !== `onCompositionStart`
                ? x === `onCompositionEnd` && sr && (b = Tn())
                : ((Sn = i), (Cn = `value` in Sn ? Sn.value : Sn.textContent), (sr = !0))),
            (y = Dd(r, x)),
            0 < y.length &&
              ((x = new Vn(x, e, null, n, i)),
              o.push({ event: x, listeners: y }),
              b ? (x.data = b) : ((b = or(n)), b !== null && (x.data = b)))),
            (b = tr ? cr(e, n) : lr(e, n)) &&
              ((x = Dd(r, `onBeforeInput`)),
              0 < x.length &&
                ((y = new Vn(`onBeforeInput`, `beforeinput`, null, n, i)),
                o.push({ event: y, listeners: x }),
                (y.data = b))),
            hd(o, e, r, n, i));
        }
        bd(o, t);
      });
    }
    function Ed(e, t, n) {
      return { instance: e, listener: t, currentTarget: n };
    }
    function Dd(e, t) {
      for (var n = t + `Capture`, r = []; e !== null; ) {
        var i = e,
          a = i.stateNode;
        if (
          ((i = i.tag),
          (i !== 5 && i !== 26 && i !== 27) ||
            a === null ||
            ((i = vn(e, n)),
            i != null && r.unshift(Ed(e, i, a)),
            (i = vn(e, t)),
            i != null && r.push(Ed(e, i, a))),
          e.tag === 3)
        )
          return r;
        e = e.return;
      }
      return [];
    }
    function Od(e) {
      if (e === null) return null;
      do e = e.return;
      while (e && e.tag !== 5 && e.tag !== 27);
      return e || null;
    }
    function kd(e, t, n, r, i) {
      for (var a = t._reactName, o = []; n !== null && n !== r; ) {
        var s = n,
          c = s.alternate,
          l = s.stateNode;
        if (((s = s.tag), c !== null && c === r)) break;
        ((s !== 5 && s !== 26 && s !== 27) ||
          l === null ||
          ((c = l),
          i
            ? ((l = vn(n, a)), l != null && o.unshift(Ed(n, l, c)))
            : i || ((l = vn(n, a)), l != null && o.push(Ed(n, l, c)))),
          (n = n.return));
      }
      o.length !== 0 && e.push({ event: t, listeners: o });
    }
    var Ad = /\r\n?/g,
      jd = /\u0000|\uFFFD/g;
    function Md(e) {
      return (typeof e == `string` ? e : `` + e)
        .replace(
          Ad,
          `
`,
        )
        .replace(jd, ``);
    }
    function Nd(e, t) {
      return ((t = Md(t)), Md(e) === t);
    }
    function $(e, t, n, r, i, a) {
      switch (n) {
        case `children`:
          typeof r == `string`
            ? t === `body` || (t === `textarea` && r === ``) || tn(e, r)
            : (typeof r == `number` || typeof r == `bigint`) && t !== `body` && tn(e, `` + r);
          break;
        case `className`:
          zt(e, `class`, r);
          break;
        case `tabIndex`:
          zt(e, `tabindex`, r);
          break;
        case `dir`:
        case `role`:
        case `viewBox`:
        case `width`:
        case `height`:
          zt(e, n, r);
          break;
        case `style`:
          an(e, r, a);
          break;
        case `data`:
          if (t !== `object`) {
            zt(e, `data`, r);
            break;
          }
        case `src`:
        case `href`:
          if (r === `` && (t !== `a` || n !== `href`)) {
            e.removeAttribute(n);
            break;
          }
          if (
            r == null ||
            typeof r == `function` ||
            typeof r == `symbol` ||
            typeof r == `boolean`
          ) {
            e.removeAttribute(n);
            break;
          }
          ((r = ln(`` + r)), e.setAttribute(n, r));
          break;
        case `action`:
        case `formAction`:
          if (typeof r == `function`) {
            e.setAttribute(
              n,
              `javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')`,
            );
            break;
          } else
            typeof a == `function` &&
              (n === `formAction`
                ? (t !== `input` && $(e, t, `name`, i.name, i, null),
                  $(e, t, `formEncType`, i.formEncType, i, null),
                  $(e, t, `formMethod`, i.formMethod, i, null),
                  $(e, t, `formTarget`, i.formTarget, i, null))
                : ($(e, t, `encType`, i.encType, i, null),
                  $(e, t, `method`, i.method, i, null),
                  $(e, t, `target`, i.target, i, null)));
          if (r == null || typeof r == `symbol` || typeof r == `boolean`) {
            e.removeAttribute(n);
            break;
          }
          ((r = ln(`` + r)), e.setAttribute(n, r));
          break;
        case `onClick`:
          r != null && (e.onclick = un);
          break;
        case `onScroll`:
          r != null && Q(`scroll`, e);
          break;
        case `onScrollEnd`:
          r != null && Q(`scrollend`, e);
          break;
        case `dangerouslySetInnerHTML`:
          if (r != null) {
            if (typeof r != `object` || !(`__html` in r)) throw Error(o(61));
            if (((n = r.__html), n != null)) {
              if (i.children != null) throw Error(o(60));
              e.innerHTML = n;
            }
          }
          break;
        case `multiple`:
          e.multiple = r && typeof r != `function` && typeof r != `symbol`;
          break;
        case `muted`:
          e.muted = r && typeof r != `function` && typeof r != `symbol`;
          break;
        case `suppressContentEditableWarning`:
        case `suppressHydrationWarning`:
        case `defaultValue`:
        case `defaultChecked`:
        case `innerHTML`:
        case `ref`:
          break;
        case `autoFocus`:
          break;
        case `xlinkHref`:
          if (
            r == null ||
            typeof r == `function` ||
            typeof r == `boolean` ||
            typeof r == `symbol`
          ) {
            e.removeAttribute(`xlink:href`);
            break;
          }
          ((n = ln(`` + r)), e.setAttributeNS(`http://www.w3.org/1999/xlink`, `xlink:href`, n));
          break;
        case `contentEditable`:
        case `spellCheck`:
        case `draggable`:
        case `value`:
        case `autoReverse`:
        case `externalResourcesRequired`:
        case `focusable`:
        case `preserveAlpha`:
          r != null && typeof r != `function` && typeof r != `symbol`
            ? e.setAttribute(n, `` + r)
            : e.removeAttribute(n);
          break;
        case `inert`:
        case `allowFullScreen`:
        case `async`:
        case `autoPlay`:
        case `controls`:
        case `default`:
        case `defer`:
        case `disabled`:
        case `disablePictureInPicture`:
        case `disableRemotePlayback`:
        case `formNoValidate`:
        case `hidden`:
        case `loop`:
        case `noModule`:
        case `noValidate`:
        case `open`:
        case `playsInline`:
        case `readOnly`:
        case `required`:
        case `reversed`:
        case `scoped`:
        case `seamless`:
        case `itemScope`:
          r && typeof r != `function` && typeof r != `symbol`
            ? e.setAttribute(n, ``)
            : e.removeAttribute(n);
          break;
        case `capture`:
        case `download`:
          !0 === r
            ? e.setAttribute(n, ``)
            : !1 !== r && r != null && typeof r != `function` && typeof r != `symbol`
              ? e.setAttribute(n, r)
              : e.removeAttribute(n);
          break;
        case `cols`:
        case `rows`:
        case `size`:
        case `span`:
          r != null && typeof r != `function` && typeof r != `symbol` && !isNaN(r) && 1 <= r
            ? e.setAttribute(n, r)
            : e.removeAttribute(n);
          break;
        case `rowSpan`:
        case `start`:
          r == null || typeof r == `function` || typeof r == `symbol` || isNaN(r)
            ? e.removeAttribute(n)
            : e.setAttribute(n, r);
          break;
        case `popover`:
          (Q(`beforetoggle`, e), Q(`toggle`, e), Rt(e, `popover`, r));
          break;
        case `xlinkActuate`:
          Bt(e, `http://www.w3.org/1999/xlink`, `xlink:actuate`, r);
          break;
        case `xlinkArcrole`:
          Bt(e, `http://www.w3.org/1999/xlink`, `xlink:arcrole`, r);
          break;
        case `xlinkRole`:
          Bt(e, `http://www.w3.org/1999/xlink`, `xlink:role`, r);
          break;
        case `xlinkShow`:
          Bt(e, `http://www.w3.org/1999/xlink`, `xlink:show`, r);
          break;
        case `xlinkTitle`:
          Bt(e, `http://www.w3.org/1999/xlink`, `xlink:title`, r);
          break;
        case `xlinkType`:
          Bt(e, `http://www.w3.org/1999/xlink`, `xlink:type`, r);
          break;
        case `xmlBase`:
          Bt(e, `http://www.w3.org/XML/1998/namespace`, `xml:base`, r);
          break;
        case `xmlLang`:
          Bt(e, `http://www.w3.org/XML/1998/namespace`, `xml:lang`, r);
          break;
        case `xmlSpace`:
          Bt(e, `http://www.w3.org/XML/1998/namespace`, `xml:space`, r);
          break;
        case `is`:
          Rt(e, `is`, r);
          break;
        case `innerText`:
        case `textContent`:
          break;
        default:
          (!(2 < n.length) || (n[0] !== `o` && n[0] !== `O`) || (n[1] !== `n` && n[1] !== `N`)) &&
            ((n = sn.get(n) || n), Rt(e, n, r));
      }
    }
    function Pd(e, t, n, r, i, a) {
      switch (n) {
        case `style`:
          an(e, r, a);
          break;
        case `dangerouslySetInnerHTML`:
          if (r != null) {
            if (typeof r != `object` || !(`__html` in r)) throw Error(o(61));
            if (((n = r.__html), n != null)) {
              if (i.children != null) throw Error(o(60));
              e.innerHTML = n;
            }
          }
          break;
        case `children`:
          typeof r == `string`
            ? tn(e, r)
            : (typeof r == `number` || typeof r == `bigint`) && tn(e, `` + r);
          break;
        case `onScroll`:
          r != null && Q(`scroll`, e);
          break;
        case `onScrollEnd`:
          r != null && Q(`scrollend`, e);
          break;
        case `onClick`:
          r != null && (e.onclick = un);
          break;
        case `suppressContentEditableWarning`:
        case `suppressHydrationWarning`:
        case `innerHTML`:
        case `ref`:
          break;
        case `innerText`:
        case `textContent`:
          break;
        default:
          if (!jt.hasOwnProperty(n))
            a: {
              if (
                n[0] === `o` &&
                n[1] === `n` &&
                ((i = n.endsWith(`Capture`)),
                (t = n.slice(2, i ? n.length - 7 : void 0)),
                (a = e[_t] || null),
                (a = a == null ? null : a[n]),
                typeof a == `function` && e.removeEventListener(t, a, i),
                typeof r == `function`)
              ) {
                (typeof a != `function` &&
                  a !== null &&
                  (n in e ? (e[n] = null) : e.hasAttribute(n) && e.removeAttribute(n)),
                  e.addEventListener(t, r, i));
                break a;
              }
              n in e ? (e[n] = r) : !0 === r ? e.setAttribute(n, ``) : Rt(e, n, r);
            }
      }
    }
    function Fd(e, t, n) {
      switch (t) {
        case `div`:
        case `span`:
        case `svg`:
        case `path`:
        case `a`:
        case `g`:
        case `p`:
        case `li`:
          break;
        case `img`:
          (Q(`error`, e), Q(`load`, e));
          var r = !1,
            i = !1,
            a;
          for (a in n)
            if (n.hasOwnProperty(a)) {
              var s = n[a];
              if (s != null)
                switch (a) {
                  case `src`:
                    r = !0;
                    break;
                  case `srcSet`:
                    i = !0;
                    break;
                  case `children`:
                  case `dangerouslySetInnerHTML`:
                    throw Error(o(137, t));
                  default:
                    $(e, t, a, s, n, null);
                }
            }
          (i && $(e, t, `srcSet`, n.srcSet, n, null), r && $(e, t, `src`, n.src, n, null));
          return;
        case `input`:
          Q(`invalid`, e);
          var c = (a = s = i = null),
            l = null,
            u = null;
          for (r in n)
            if (n.hasOwnProperty(r)) {
              var d = n[r];
              if (d != null)
                switch (r) {
                  case `name`:
                    i = d;
                    break;
                  case `type`:
                    s = d;
                    break;
                  case `checked`:
                    l = d;
                    break;
                  case `defaultChecked`:
                    u = d;
                    break;
                  case `value`:
                    a = d;
                    break;
                  case `defaultValue`:
                    c = d;
                    break;
                  case `children`:
                  case `dangerouslySetInnerHTML`:
                    if (d != null) throw Error(o(137, t));
                    break;
                  default:
                    $(e, t, r, d, n, null);
                }
            }
          Xt(e, a, c, l, u, s, i, !1);
          return;
        case `select`:
          for (i in (Q(`invalid`, e), (r = s = a = null), n))
            if (n.hasOwnProperty(i) && ((c = n[i]), c != null))
              switch (i) {
                case `value`:
                  a = c;
                  break;
                case `defaultValue`:
                  s = c;
                  break;
                case `multiple`:
                  r = c;
                default:
                  $(e, t, i, c, n, null);
              }
          ((t = a),
            (n = s),
            (e.multiple = !!r),
            t == null ? n != null && Qt(e, !!r, n, !0) : Qt(e, !!r, t, !1));
          return;
        case `textarea`:
          for (s in (Q(`invalid`, e), (a = i = r = null), n))
            if (n.hasOwnProperty(s) && ((c = n[s]), c != null))
              switch (s) {
                case `value`:
                  r = c;
                  break;
                case `defaultValue`:
                  i = c;
                  break;
                case `children`:
                  a = c;
                  break;
                case `dangerouslySetInnerHTML`:
                  if (c != null) throw Error(o(91));
                  break;
                default:
                  $(e, t, s, c, n, null);
              }
          en(e, r, i, a);
          return;
        case `option`:
          for (l in n)
            if (n.hasOwnProperty(l) && ((r = n[l]), r != null))
              switch (l) {
                case `selected`:
                  e.selected = r && typeof r != `function` && typeof r != `symbol`;
                  break;
                default:
                  $(e, t, l, r, n, null);
              }
          return;
        case `dialog`:
          (Q(`beforetoggle`, e), Q(`toggle`, e), Q(`cancel`, e), Q(`close`, e));
          break;
        case `iframe`:
        case `object`:
          Q(`load`, e);
          break;
        case `video`:
        case `audio`:
          for (r = 0; r < vd.length; r++) Q(vd[r], e);
          break;
        case `image`:
          (Q(`error`, e), Q(`load`, e));
          break;
        case `details`:
          Q(`toggle`, e);
          break;
        case `embed`:
        case `source`:
        case `link`:
          (Q(`error`, e), Q(`load`, e));
        case `area`:
        case `base`:
        case `br`:
        case `col`:
        case `hr`:
        case `keygen`:
        case `meta`:
        case `param`:
        case `track`:
        case `wbr`:
        case `menuitem`:
          for (u in n)
            if (n.hasOwnProperty(u) && ((r = n[u]), r != null))
              switch (u) {
                case `children`:
                case `dangerouslySetInnerHTML`:
                  throw Error(o(137, t));
                default:
                  $(e, t, u, r, n, null);
              }
          return;
        default:
          if (on(t)) {
            for (d in n)
              n.hasOwnProperty(d) && ((r = n[d]), r !== void 0 && Pd(e, t, d, r, n, void 0));
            return;
          }
      }
      for (c in n) n.hasOwnProperty(c) && ((r = n[c]), r != null && $(e, t, c, r, n, null));
    }
    function Id(e, t, n, r) {
      switch (t) {
        case `div`:
        case `span`:
        case `svg`:
        case `path`:
        case `a`:
        case `g`:
        case `p`:
        case `li`:
          break;
        case `input`:
          var i = null,
            a = null,
            s = null,
            c = null,
            l = null,
            u = null,
            d = null;
          for (m in n) {
            var f = n[m];
            if (n.hasOwnProperty(m) && f != null)
              switch (m) {
                case `checked`:
                  break;
                case `value`:
                  break;
                case `defaultValue`:
                  l = f;
                default:
                  r.hasOwnProperty(m) || $(e, t, m, null, r, f);
              }
          }
          for (var p in r) {
            var m = r[p];
            if (((f = n[p]), r.hasOwnProperty(p) && (m != null || f != null)))
              switch (p) {
                case `type`:
                  a = m;
                  break;
                case `name`:
                  i = m;
                  break;
                case `checked`:
                  u = m;
                  break;
                case `defaultChecked`:
                  d = m;
                  break;
                case `value`:
                  s = m;
                  break;
                case `defaultValue`:
                  c = m;
                  break;
                case `children`:
                case `dangerouslySetInnerHTML`:
                  if (m != null) throw Error(o(137, t));
                  break;
                default:
                  m !== f && $(e, t, p, m, r, f);
              }
          }
          Yt(e, s, c, l, u, d, a, i);
          return;
        case `select`:
          for (a in ((m = s = c = p = null), n))
            if (((l = n[a]), n.hasOwnProperty(a) && l != null))
              switch (a) {
                case `value`:
                  break;
                case `multiple`:
                  m = l;
                default:
                  r.hasOwnProperty(a) || $(e, t, a, null, r, l);
              }
          for (i in r)
            if (((a = r[i]), (l = n[i]), r.hasOwnProperty(i) && (a != null || l != null)))
              switch (i) {
                case `value`:
                  p = a;
                  break;
                case `defaultValue`:
                  c = a;
                  break;
                case `multiple`:
                  s = a;
                default:
                  a !== l && $(e, t, i, a, r, l);
              }
          ((t = c),
            (n = s),
            (r = m),
            p == null
              ? !!r != !!n && (t == null ? Qt(e, !!n, n ? [] : ``, !1) : Qt(e, !!n, t, !0))
              : Qt(e, !!n, p, !1));
          return;
        case `textarea`:
          for (c in ((m = p = null), n))
            if (((i = n[c]), n.hasOwnProperty(c) && i != null && !r.hasOwnProperty(c)))
              switch (c) {
                case `value`:
                  break;
                case `children`:
                  break;
                default:
                  $(e, t, c, null, r, i);
              }
          for (s in r)
            if (((i = r[s]), (a = n[s]), r.hasOwnProperty(s) && (i != null || a != null)))
              switch (s) {
                case `value`:
                  p = i;
                  break;
                case `defaultValue`:
                  m = i;
                  break;
                case `children`:
                  break;
                case `dangerouslySetInnerHTML`:
                  if (i != null) throw Error(o(91));
                  break;
                default:
                  i !== a && $(e, t, s, i, r, a);
              }
          $t(e, p, m);
          return;
        case `option`:
          for (var h in n)
            if (((p = n[h]), n.hasOwnProperty(h) && p != null && !r.hasOwnProperty(h)))
              switch (h) {
                case `selected`:
                  e.selected = !1;
                  break;
                default:
                  $(e, t, h, null, r, p);
              }
          for (l in r)
            if (
              ((p = r[l]), (m = n[l]), r.hasOwnProperty(l) && p !== m && (p != null || m != null))
            )
              switch (l) {
                case `selected`:
                  e.selected = p && typeof p != `function` && typeof p != `symbol`;
                  break;
                default:
                  $(e, t, l, p, r, m);
              }
          return;
        case `img`:
        case `link`:
        case `area`:
        case `base`:
        case `br`:
        case `col`:
        case `embed`:
        case `hr`:
        case `keygen`:
        case `meta`:
        case `param`:
        case `source`:
        case `track`:
        case `wbr`:
        case `menuitem`:
          for (var g in n)
            ((p = n[g]),
              n.hasOwnProperty(g) && p != null && !r.hasOwnProperty(g) && $(e, t, g, null, r, p));
          for (u in r)
            if (
              ((p = r[u]), (m = n[u]), r.hasOwnProperty(u) && p !== m && (p != null || m != null))
            )
              switch (u) {
                case `children`:
                case `dangerouslySetInnerHTML`:
                  if (p != null) throw Error(o(137, t));
                  break;
                default:
                  $(e, t, u, p, r, m);
              }
          return;
        default:
          if (on(t)) {
            for (var _ in n)
              ((p = n[_]),
                n.hasOwnProperty(_) &&
                  p !== void 0 &&
                  !r.hasOwnProperty(_) &&
                  Pd(e, t, _, void 0, r, p));
            for (d in r)
              ((p = r[d]),
                (m = n[d]),
                !r.hasOwnProperty(d) ||
                  p === m ||
                  (p === void 0 && m === void 0) ||
                  Pd(e, t, d, p, r, m));
            return;
          }
      }
      for (var v in n)
        ((p = n[v]),
          n.hasOwnProperty(v) && p != null && !r.hasOwnProperty(v) && $(e, t, v, null, r, p));
      for (f in r)
        ((p = r[f]),
          (m = n[f]),
          !r.hasOwnProperty(f) || p === m || (p == null && m == null) || $(e, t, f, p, r, m));
    }
    function Ld(e) {
      switch (e) {
        case `css`:
        case `script`:
        case `font`:
        case `img`:
        case `image`:
        case `input`:
        case `link`:
          return !0;
        default:
          return !1;
      }
    }
    function Rd() {
      if (typeof performance.getEntriesByType == `function`) {
        for (
          var e = 0, t = 0, n = performance.getEntriesByType(`resource`), r = 0;
          r < n.length;
          r++
        ) {
          var i = n[r],
            a = i.transferSize,
            o = i.initiatorType,
            s = i.duration;
          if (a && s && Ld(o)) {
            for (o = 0, s = i.responseEnd, r += 1; r < n.length; r++) {
              var c = n[r],
                l = c.startTime;
              if (l > s) break;
              var u = c.transferSize,
                d = c.initiatorType;
              u && Ld(d) && ((c = c.responseEnd), (o += u * (c < s ? 1 : (s - l) / (c - l))));
            }
            if ((--r, (t += (8 * (a + o)) / (i.duration / 1e3)), e++, 10 < e)) break;
          }
        }
        if (0 < e) return t / e / 1e6;
      }
      return navigator.connection && ((e = navigator.connection.downlink), typeof e == `number`)
        ? e
        : 5;
    }
    var zd = null,
      Bd = null;
    function Vd(e) {
      return e.nodeType === 9 ? e : e.ownerDocument;
    }
    function Hd(e) {
      switch (e) {
        case `http://www.w3.org/2000/svg`:
          return 1;
        case `http://www.w3.org/1998/Math/MathML`:
          return 2;
        default:
          return 0;
      }
    }
    function Ud(e, t) {
      if (e === 0)
        switch (t) {
          case `svg`:
            return 1;
          case `math`:
            return 2;
          default:
            return 0;
        }
      return e === 1 && t === `foreignObject` ? 0 : e;
    }
    function Wd(e, t) {
      return (
        e === `textarea` ||
        e === `noscript` ||
        typeof t.children == `string` ||
        typeof t.children == `number` ||
        typeof t.children == `bigint` ||
        (typeof t.dangerouslySetInnerHTML == `object` &&
          t.dangerouslySetInnerHTML !== null &&
          t.dangerouslySetInnerHTML.__html != null)
      );
    }
    var Gd = null;
    function Kd() {
      var e = window.event;
      return e && e.type === `popstate` ? (e === Gd ? !1 : ((Gd = e), !0)) : ((Gd = null), !1);
    }
    var qd = typeof setTimeout == `function` ? setTimeout : void 0,
      Jd = typeof clearTimeout == `function` ? clearTimeout : void 0,
      Yd = typeof Promise == `function` ? Promise : void 0,
      Xd =
        typeof queueMicrotask == `function`
          ? queueMicrotask
          : Yd === void 0
            ? qd
            : function (e) {
                return Yd.resolve(null).then(e).catch(Zd);
              };
    function Zd(e) {
      setTimeout(function () {
        throw e;
      });
    }
    function Qd(e) {
      return e === `head`;
    }
    function $d(e, t) {
      var n = t,
        r = 0;
      do {
        var i = n.nextSibling;
        if ((e.removeChild(n), i && i.nodeType === 8))
          if (((n = i.data), n === `/$` || n === `/&`)) {
            if (r === 0) {
              (e.removeChild(i), Pp(t));
              return;
            }
            r--;
          } else if (n === `$` || n === `$?` || n === `$~` || n === `$!` || n === `&`) r++;
          else if (n === `html`) mf(e.ownerDocument.documentElement);
          else if (n === `head`) {
            ((n = e.ownerDocument.head), mf(n));
            for (var a = n.firstChild; a; ) {
              var o = a.nextSibling,
                s = a.nodeName;
              (a[Ct] ||
                s === `SCRIPT` ||
                s === `STYLE` ||
                (s === `LINK` && a.rel.toLowerCase() === `stylesheet`) ||
                n.removeChild(a),
                (a = o));
            }
          } else n === `body` && mf(e.ownerDocument.body);
        n = i;
      } while (n);
      Pp(t);
    }
    function ef(e, t) {
      var n = e;
      e = 0;
      do {
        var r = n.nextSibling;
        if (
          (n.nodeType === 1
            ? t
              ? ((n._stashedDisplay = n.style.display), (n.style.display = `none`))
              : ((n.style.display = n._stashedDisplay || ``),
                n.getAttribute(`style`) === `` && n.removeAttribute(`style`))
            : n.nodeType === 3 &&
              (t
                ? ((n._stashedText = n.nodeValue), (n.nodeValue = ``))
                : (n.nodeValue = n._stashedText || ``)),
          r && r.nodeType === 8)
        )
          if (((n = r.data), n === `/$`)) {
            if (e === 0) break;
            e--;
          } else (n !== `$` && n !== `$?` && n !== `$~` && n !== `$!`) || e++;
        n = r;
      } while (n);
    }
    function tf(e) {
      var t = e.firstChild;
      for (t && t.nodeType === 10 && (t = t.nextSibling); t; ) {
        var n = t;
        switch (((t = t.nextSibling), n.nodeName)) {
          case `HTML`:
          case `HEAD`:
          case `BODY`:
            (tf(n), wt(n));
            continue;
          case `SCRIPT`:
          case `STYLE`:
            continue;
          case `LINK`:
            if (n.rel.toLowerCase() === `stylesheet`) continue;
        }
        e.removeChild(n);
      }
    }
    function nf(e, t, n, r) {
      for (; e.nodeType === 1; ) {
        var i = n;
        if (e.nodeName.toLowerCase() !== t.toLowerCase()) {
          if (!r && (e.nodeName !== `INPUT` || e.type !== `hidden`)) break;
        } else if (!r)
          if (t === `input` && e.type === `hidden`) {
            var a = i.name == null ? null : `` + i.name;
            if (i.type === `hidden` && e.getAttribute(`name`) === a) return e;
          } else return e;
        else if (!e[Ct])
          switch (t) {
            case `meta`:
              if (!e.hasAttribute(`itemprop`)) break;
              return e;
            case `link`:
              if (
                ((a = e.getAttribute(`rel`)),
                (a === `stylesheet` && e.hasAttribute(`data-precedence`)) ||
                  a !== i.rel ||
                  e.getAttribute(`href`) !== (i.href == null || i.href === `` ? null : i.href) ||
                  e.getAttribute(`crossorigin`) !==
                    (i.crossOrigin == null ? null : i.crossOrigin) ||
                  e.getAttribute(`title`) !== (i.title == null ? null : i.title))
              )
                break;
              return e;
            case `style`:
              if (e.hasAttribute(`data-precedence`)) break;
              return e;
            case `script`:
              if (
                ((a = e.getAttribute(`src`)),
                (a !== (i.src == null ? null : i.src) ||
                  e.getAttribute(`type`) !== (i.type == null ? null : i.type) ||
                  e.getAttribute(`crossorigin`) !==
                    (i.crossOrigin == null ? null : i.crossOrigin)) &&
                  a &&
                  e.hasAttribute(`async`) &&
                  !e.hasAttribute(`itemprop`))
              )
                break;
              return e;
            default:
              return e;
          }
        if (((e = lf(e.nextSibling)), e === null)) break;
      }
      return null;
    }
    function rf(e, t, n) {
      if (t === ``) return null;
      for (; e.nodeType !== 3; )
        if (
          ((e.nodeType !== 1 || e.nodeName !== `INPUT` || e.type !== `hidden`) && !n) ||
          ((e = lf(e.nextSibling)), e === null)
        )
          return null;
      return e;
    }
    function af(e, t) {
      for (; e.nodeType !== 8; )
        if (
          ((e.nodeType !== 1 || e.nodeName !== `INPUT` || e.type !== `hidden`) && !t) ||
          ((e = lf(e.nextSibling)), e === null)
        )
          return null;
      return e;
    }
    function of(e) {
      return e.data === `$?` || e.data === `$~`;
    }
    function sf(e) {
      return e.data === `$!` || (e.data === `$?` && e.ownerDocument.readyState !== `loading`);
    }
    function cf(e, t) {
      var n = e.ownerDocument;
      if (e.data === `$~`) e._reactRetry = t;
      else if (e.data !== `$?` || n.readyState !== `loading`) t();
      else {
        var r = function () {
          (t(), n.removeEventListener(`DOMContentLoaded`, r));
        };
        (n.addEventListener(`DOMContentLoaded`, r), (e._reactRetry = r));
      }
    }
    function lf(e) {
      for (; e != null; e = e.nextSibling) {
        var t = e.nodeType;
        if (t === 1 || t === 3) break;
        if (t === 8) {
          if (
            ((t = e.data),
            t === `$` ||
              t === `$!` ||
              t === `$?` ||
              t === `$~` ||
              t === `&` ||
              t === `F!` ||
              t === `F`)
          )
            break;
          if (t === `/$` || t === `/&`) return null;
        }
      }
      return e;
    }
    var uf = null;
    function df(e) {
      e = e.nextSibling;
      for (var t = 0; e; ) {
        if (e.nodeType === 8) {
          var n = e.data;
          if (n === `/$` || n === `/&`) {
            if (t === 0) return lf(e.nextSibling);
            t--;
          } else (n !== `$` && n !== `$!` && n !== `$?` && n !== `$~` && n !== `&`) || t++;
        }
        e = e.nextSibling;
      }
      return null;
    }
    function ff(e) {
      e = e.previousSibling;
      for (var t = 0; e; ) {
        if (e.nodeType === 8) {
          var n = e.data;
          if (n === `$` || n === `$!` || n === `$?` || n === `$~` || n === `&`) {
            if (t === 0) return e;
            t--;
          } else (n !== `/$` && n !== `/&`) || t++;
        }
        e = e.previousSibling;
      }
      return null;
    }
    function pf(e, t, n) {
      switch (((t = Vd(n)), e)) {
        case `html`:
          if (((e = t.documentElement), !e)) throw Error(o(452));
          return e;
        case `head`:
          if (((e = t.head), !e)) throw Error(o(453));
          return e;
        case `body`:
          if (((e = t.body), !e)) throw Error(o(454));
          return e;
        default:
          throw Error(o(451));
      }
    }
    function mf(e) {
      for (var t = e.attributes; t.length; ) e.removeAttributeNode(t[0]);
      wt(e);
    }
    var hf = new Map(),
      gf = new Set();
    function _f(e) {
      return typeof e.getRootNode == `function`
        ? e.getRootNode()
        : e.nodeType === 9
          ? e
          : e.ownerDocument;
    }
    var vf = E.d;
    E.d = { f: yf, r: bf, D: Cf, C: wf, L: Tf, m: Ef, X: Of, S: Df, M: kf };
    function yf() {
      var e = vf.f(),
        t = xu();
      return e || t;
    }
    function bf(e) {
      var t = Et(e);
      t !== null && t.tag === 5 && t.type === `form` ? Os(t) : vf.r(e);
    }
    var xf = typeof document > `u` ? null : document;
    function Sf(e, t, n) {
      var r = xf;
      if (r && typeof t == `string` && t) {
        var i = Jt(t);
        ((i = `link[rel="` + e + `"][href="` + i + `"]`),
          typeof n == `string` && (i += `[crossorigin="` + n + `"]`),
          gf.has(i) ||
            (gf.add(i),
            (e = { rel: e, crossOrigin: n, href: t }),
            r.querySelector(i) === null &&
              ((t = r.createElement(`link`)), Fd(t, `link`, e), kt(t), r.head.appendChild(t))));
      }
    }
    function Cf(e) {
      (vf.D(e), Sf(`dns-prefetch`, e, null));
    }
    function wf(e, t) {
      (vf.C(e, t), Sf(`preconnect`, e, t));
    }
    function Tf(e, t, n) {
      vf.L(e, t, n);
      var r = xf;
      if (r && e && t) {
        var i = `link[rel="preload"][as="` + Jt(t) + `"]`;
        t === `image` && n && n.imageSrcSet
          ? ((i += `[imagesrcset="` + Jt(n.imageSrcSet) + `"]`),
            typeof n.imageSizes == `string` && (i += `[imagesizes="` + Jt(n.imageSizes) + `"]`))
          : (i += `[href="` + Jt(e) + `"]`);
        var a = i;
        switch (t) {
          case `style`:
            a = jf(e);
            break;
          case `script`:
            a = Ff(e);
        }
        hf.has(a) ||
          ((e = h(
            { rel: `preload`, href: t === `image` && n && n.imageSrcSet ? void 0 : e, as: t },
            n,
          )),
          hf.set(a, e),
          r.querySelector(i) !== null ||
            (t === `style` && r.querySelector(Mf(a))) ||
            (t === `script` && r.querySelector(If(a))) ||
            ((t = r.createElement(`link`)), Fd(t, `link`, e), kt(t), r.head.appendChild(t)));
      }
    }
    function Ef(e, t) {
      vf.m(e, t);
      var n = xf;
      if (n && e) {
        var r = t && typeof t.as == `string` ? t.as : `script`,
          i = `link[rel="modulepreload"][as="` + Jt(r) + `"][href="` + Jt(e) + `"]`,
          a = i;
        switch (r) {
          case `audioworklet`:
          case `paintworklet`:
          case `serviceworker`:
          case `sharedworker`:
          case `worker`:
          case `script`:
            a = Ff(e);
        }
        if (
          !hf.has(a) &&
          ((e = h({ rel: `modulepreload`, href: e }, t)), hf.set(a, e), n.querySelector(i) === null)
        ) {
          switch (r) {
            case `audioworklet`:
            case `paintworklet`:
            case `serviceworker`:
            case `sharedworker`:
            case `worker`:
            case `script`:
              if (n.querySelector(If(a))) return;
          }
          ((r = n.createElement(`link`)), Fd(r, `link`, e), kt(r), n.head.appendChild(r));
        }
      }
    }
    function Df(e, t, n) {
      vf.S(e, t, n);
      var r = xf;
      if (r && e) {
        var i = Ot(r).hoistableStyles,
          a = jf(e);
        t ||= `default`;
        var o = i.get(a);
        if (!o) {
          var s = { loading: 0, preload: null };
          if ((o = r.querySelector(Mf(a)))) s.loading = 5;
          else {
            ((e = h({ rel: `stylesheet`, href: e, "data-precedence": t }, n)),
              (n = hf.get(a)) && zf(e, n));
            var c = (o = r.createElement(`link`));
            (kt(c),
              Fd(c, `link`, e),
              (c._p = new Promise(function (e, t) {
                ((c.onload = e), (c.onerror = t));
              })),
              c.addEventListener(`load`, function () {
                s.loading |= 1;
              }),
              c.addEventListener(`error`, function () {
                s.loading |= 2;
              }),
              (s.loading |= 4),
              Rf(o, t, r));
          }
          ((o = { type: `stylesheet`, instance: o, count: 1, state: s }), i.set(a, o));
        }
      }
    }
    function Of(e, t) {
      vf.X(e, t);
      var n = xf;
      if (n && e) {
        var r = Ot(n).hoistableScripts,
          i = Ff(e),
          a = r.get(i);
        a ||
          ((a = n.querySelector(If(i))),
          a ||
            ((e = h({ src: e, async: !0 }, t)),
            (t = hf.get(i)) && Bf(e, t),
            (a = n.createElement(`script`)),
            kt(a),
            Fd(a, `link`, e),
            n.head.appendChild(a)),
          (a = { type: `script`, instance: a, count: 1, state: null }),
          r.set(i, a));
      }
    }
    function kf(e, t) {
      vf.M(e, t);
      var n = xf;
      if (n && e) {
        var r = Ot(n).hoistableScripts,
          i = Ff(e),
          a = r.get(i);
        a ||
          ((a = n.querySelector(If(i))),
          a ||
            ((e = h({ src: e, async: !0, type: `module` }, t)),
            (t = hf.get(i)) && Bf(e, t),
            (a = n.createElement(`script`)),
            kt(a),
            Fd(a, `link`, e),
            n.head.appendChild(a)),
          (a = { type: `script`, instance: a, count: 1, state: null }),
          r.set(i, a));
      }
    }
    function Af(e, t, n, r) {
      var i = (i = _e.current) ? _f(i) : null;
      if (!i) throw Error(o(446));
      switch (e) {
        case `meta`:
        case `title`:
          return null;
        case `style`:
          return typeof n.precedence == `string` && typeof n.href == `string`
            ? ((t = jf(n.href)),
              (n = Ot(i).hoistableStyles),
              (r = n.get(t)),
              r || ((r = { type: `style`, instance: null, count: 0, state: null }), n.set(t, r)),
              r)
            : { type: `void`, instance: null, count: 0, state: null };
        case `link`:
          if (
            n.rel === `stylesheet` &&
            typeof n.href == `string` &&
            typeof n.precedence == `string`
          ) {
            e = jf(n.href);
            var a = Ot(i).hoistableStyles,
              s = a.get(e);
            if (
              (s ||
                ((i = i.ownerDocument || i),
                (s = {
                  type: `stylesheet`,
                  instance: null,
                  count: 0,
                  state: { loading: 0, preload: null },
                }),
                a.set(e, s),
                (a = i.querySelector(Mf(e))) && !a._p && ((s.instance = a), (s.state.loading = 5)),
                hf.has(e) ||
                  ((n = {
                    rel: `preload`,
                    as: `style`,
                    href: n.href,
                    crossOrigin: n.crossOrigin,
                    integrity: n.integrity,
                    media: n.media,
                    hrefLang: n.hrefLang,
                    referrerPolicy: n.referrerPolicy,
                  }),
                  hf.set(e, n),
                  a || Pf(i, e, n, s.state))),
              t && r === null)
            )
              throw Error(o(528, ``));
            return s;
          }
          if (t && r !== null) throw Error(o(529, ``));
          return null;
        case `script`:
          return (
            (t = n.async),
            (n = n.src),
            typeof n == `string` && t && typeof t != `function` && typeof t != `symbol`
              ? ((t = Ff(n)),
                (n = Ot(i).hoistableScripts),
                (r = n.get(t)),
                r || ((r = { type: `script`, instance: null, count: 0, state: null }), n.set(t, r)),
                r)
              : { type: `void`, instance: null, count: 0, state: null }
          );
        default:
          throw Error(o(444, e));
      }
    }
    function jf(e) {
      return `href="` + Jt(e) + `"`;
    }
    function Mf(e) {
      return `link[rel="stylesheet"][` + e + `]`;
    }
    function Nf(e) {
      return h({}, e, { "data-precedence": e.precedence, precedence: null });
    }
    function Pf(e, t, n, r) {
      e.querySelector(`link[rel="preload"][as="style"][` + t + `]`)
        ? (r.loading = 1)
        : ((t = e.createElement(`link`)),
          (r.preload = t),
          t.addEventListener(`load`, function () {
            return (r.loading |= 1);
          }),
          t.addEventListener(`error`, function () {
            return (r.loading |= 2);
          }),
          Fd(t, `link`, n),
          kt(t),
          e.head.appendChild(t));
    }
    function Ff(e) {
      return `[src="` + Jt(e) + `"]`;
    }
    function If(e) {
      return `script[async]` + e;
    }
    function Lf(e, t, n) {
      if ((t.count++, t.instance === null))
        switch (t.type) {
          case `style`:
            var r = e.querySelector(`style[data-href~="` + Jt(n.href) + `"]`);
            if (r) return ((t.instance = r), kt(r), r);
            var i = h({}, n, {
              "data-href": n.href,
              "data-precedence": n.precedence,
              href: null,
              precedence: null,
            });
            return (
              (r = (e.ownerDocument || e).createElement(`style`)),
              kt(r),
              Fd(r, `style`, i),
              Rf(r, n.precedence, e),
              (t.instance = r)
            );
          case `stylesheet`:
            i = jf(n.href);
            var a = e.querySelector(Mf(i));
            if (a) return ((t.state.loading |= 4), (t.instance = a), kt(a), a);
            ((r = Nf(n)),
              (i = hf.get(i)) && zf(r, i),
              (a = (e.ownerDocument || e).createElement(`link`)),
              kt(a));
            var s = a;
            return (
              (s._p = new Promise(function (e, t) {
                ((s.onload = e), (s.onerror = t));
              })),
              Fd(a, `link`, r),
              (t.state.loading |= 4),
              Rf(a, n.precedence, e),
              (t.instance = a)
            );
          case `script`:
            return (
              (a = Ff(n.src)),
              (i = e.querySelector(If(a)))
                ? ((t.instance = i), kt(i), i)
                : ((r = n),
                  (i = hf.get(a)) && ((r = h({}, n)), Bf(r, i)),
                  (e = e.ownerDocument || e),
                  (i = e.createElement(`script`)),
                  kt(i),
                  Fd(i, `link`, r),
                  e.head.appendChild(i),
                  (t.instance = i))
            );
          case `void`:
            return null;
          default:
            throw Error(o(443, t.type));
        }
      else
        t.type === `stylesheet` &&
          !(t.state.loading & 4) &&
          ((r = t.instance), (t.state.loading |= 4), Rf(r, n.precedence, e));
      return t.instance;
    }
    function Rf(e, t, n) {
      for (
        var r = n.querySelectorAll(
            `link[rel="stylesheet"][data-precedence],style[data-precedence]`,
          ),
          i = r.length ? r[r.length - 1] : null,
          a = i,
          o = 0;
        o < r.length;
        o++
      ) {
        var s = r[o];
        if (s.dataset.precedence === t) a = s;
        else if (a !== i) break;
      }
      a
        ? a.parentNode.insertBefore(e, a.nextSibling)
        : ((t = n.nodeType === 9 ? n.head : n), t.insertBefore(e, t.firstChild));
    }
    function zf(e, t) {
      ((e.crossOrigin ??= t.crossOrigin),
        (e.referrerPolicy ??= t.referrerPolicy),
        (e.title ??= t.title));
    }
    function Bf(e, t) {
      ((e.crossOrigin ??= t.crossOrigin),
        (e.referrerPolicy ??= t.referrerPolicy),
        (e.integrity ??= t.integrity));
    }
    var Vf = null;
    function Hf(e, t, n) {
      if (Vf === null) {
        var r = new Map(),
          i = (Vf = new Map());
        i.set(n, r);
      } else ((i = Vf), (r = i.get(n)), r || ((r = new Map()), i.set(n, r)));
      if (r.has(e)) return r;
      for (r.set(e, null), n = n.getElementsByTagName(e), i = 0; i < n.length; i++) {
        var a = n[i];
        if (
          !(a[Ct] || a[gt] || (e === `link` && a.getAttribute(`rel`) === `stylesheet`)) &&
          a.namespaceURI !== `http://www.w3.org/2000/svg`
        ) {
          var o = a.getAttribute(t) || ``;
          o = e + o;
          var s = r.get(o);
          s ? s.push(a) : r.set(o, [a]);
        }
      }
      return r;
    }
    function Uf(e, t, n) {
      ((e = e.ownerDocument || e),
        e.head.insertBefore(n, t === `title` ? e.querySelector(`head > title`) : null));
    }
    function Wf(e, t, n) {
      if (n === 1 || t.itemProp != null) return !1;
      switch (e) {
        case `meta`:
        case `title`:
          return !0;
        case `style`:
          if (typeof t.precedence != `string` || typeof t.href != `string` || t.href === ``) break;
          return !0;
        case `link`:
          if (
            typeof t.rel != `string` ||
            typeof t.href != `string` ||
            t.href === `` ||
            t.onLoad ||
            t.onError
          )
            break;
          switch (t.rel) {
            case `stylesheet`:
              return ((e = t.disabled), typeof t.precedence == `string` && e == null);
            default:
              return !0;
          }
        case `script`:
          if (
            t.async &&
            typeof t.async != `function` &&
            typeof t.async != `symbol` &&
            !t.onLoad &&
            !t.onError &&
            t.src &&
            typeof t.src == `string`
          )
            return !0;
      }
      return !1;
    }
    function Gf(e) {
      return !(e.type === `stylesheet` && !(e.state.loading & 3));
    }
    function Kf(e, t, n, r) {
      if (
        n.type === `stylesheet` &&
        (typeof r.media != `string` || !1 !== matchMedia(r.media).matches) &&
        !(n.state.loading & 4)
      ) {
        if (n.instance === null) {
          var i = jf(r.href),
            a = t.querySelector(Mf(i));
          if (a) {
            ((t = a._p),
              typeof t == `object` &&
                t &&
                typeof t.then == `function` &&
                (e.count++, (e = Yf.bind(e)), t.then(e, e)),
              (n.state.loading |= 4),
              (n.instance = a),
              kt(a));
            return;
          }
          ((a = t.ownerDocument || t),
            (r = Nf(r)),
            (i = hf.get(i)) && zf(r, i),
            (a = a.createElement(`link`)),
            kt(a));
          var o = a;
          ((o._p = new Promise(function (e, t) {
            ((o.onload = e), (o.onerror = t));
          })),
            Fd(a, `link`, r),
            (n.instance = a));
        }
        (e.stylesheets === null && (e.stylesheets = new Map()),
          e.stylesheets.set(n, t),
          (t = n.state.preload) &&
            !(n.state.loading & 3) &&
            (e.count++,
            (n = Yf.bind(e)),
            t.addEventListener(`load`, n),
            t.addEventListener(`error`, n)));
      }
    }
    var qf = 0;
    function Jf(e, t) {
      return (
        e.stylesheets && e.count === 0 && Zf(e, e.stylesheets),
        0 < e.count || 0 < e.imgCount
          ? function (n) {
              var r = setTimeout(function () {
                if ((e.stylesheets && Zf(e, e.stylesheets), e.unsuspend)) {
                  var t = e.unsuspend;
                  ((e.unsuspend = null), t());
                }
              }, 6e4 + t);
              0 < e.imgBytes && qf === 0 && (qf = 62500 * Rd());
              var i = setTimeout(
                function () {
                  if (
                    ((e.waitingForImages = !1),
                    e.count === 0 && (e.stylesheets && Zf(e, e.stylesheets), e.unsuspend))
                  ) {
                    var t = e.unsuspend;
                    ((e.unsuspend = null), t());
                  }
                },
                (e.imgBytes > qf ? 50 : 800) + t,
              );
              return (
                (e.unsuspend = n),
                function () {
                  ((e.unsuspend = null), clearTimeout(r), clearTimeout(i));
                }
              );
            }
          : null
      );
    }
    function Yf() {
      if ((this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages))) {
        if (this.stylesheets) Zf(this, this.stylesheets);
        else if (this.unsuspend) {
          var e = this.unsuspend;
          ((this.unsuspend = null), e());
        }
      }
    }
    var Xf = null;
    function Zf(e, t) {
      ((e.stylesheets = null),
        e.unsuspend !== null &&
          (e.count++, (Xf = new Map()), t.forEach(Qf, e), (Xf = null), Yf.call(e)));
    }
    function Qf(e, t) {
      if (!(t.state.loading & 4)) {
        var n = Xf.get(e);
        if (n) var r = n.get(null);
        else {
          ((n = new Map()), Xf.set(e, n));
          for (
            var i = e.querySelectorAll(`link[data-precedence],style[data-precedence]`), a = 0;
            a < i.length;
            a++
          ) {
            var o = i[a];
            (o.nodeName === `LINK` || o.getAttribute(`media`) !== `not all`) &&
              (n.set(o.dataset.precedence, o), (r = o));
          }
          r && n.set(null, r);
        }
        ((i = t.instance),
          (o = i.getAttribute(`data-precedence`)),
          (a = n.get(o) || r),
          a === r && n.set(null, i),
          n.set(o, i),
          this.count++,
          (r = Yf.bind(this)),
          i.addEventListener(`load`, r),
          i.addEventListener(`error`, r),
          a
            ? a.parentNode.insertBefore(i, a.nextSibling)
            : ((e = e.nodeType === 9 ? e.head : e), e.insertBefore(i, e.firstChild)),
          (t.state.loading |= 4));
      }
    }
    var $f = {
      $$typeof: C,
      Provider: null,
      Consumer: null,
      _currentValue: fe,
      _currentValue2: fe,
      _threadCount: 0,
    };
    function ep(e, t, n, r, i, a, o, s, c) {
      ((this.tag = 1),
        (this.containerInfo = e),
        (this.pingCache = this.current = this.pendingChildren = null),
        (this.timeoutHandle = -1),
        (this.callbackNode =
          this.next =
          this.pendingContext =
          this.context =
          this.cancelPendingCommit =
            null),
        (this.callbackPriority = 0),
        (this.expirationTimes = at(-1)),
        (this.entangledLanes =
          this.shellSuspendCounter =
          this.errorRecoveryDisabledLanes =
          this.expiredLanes =
          this.warmLanes =
          this.pingedLanes =
          this.suspendedLanes =
          this.pendingLanes =
            0),
        (this.entanglements = at(0)),
        (this.hiddenUpdates = at(null)),
        (this.identifierPrefix = r),
        (this.onUncaughtError = i),
        (this.onCaughtError = a),
        (this.onRecoverableError = o),
        (this.pooledCache = null),
        (this.pooledCacheLanes = 0),
        (this.formState = c),
        (this.incompleteTransitions = new Map()));
    }
    function tp(e, t, n, r, i, a, o, s, c, l, u, d) {
      return (
        (e = new ep(e, t, n, o, c, l, u, d, s)),
        (t = 1),
        !0 === a && (t |= 24),
        (a = hi(3, null, null, t)),
        (e.current = a),
        (a.stateNode = e),
        (t = ma()),
        t.refCount++,
        (e.pooledCache = t),
        t.refCount++,
        (a.memoizedState = { element: r, isDehydrated: n, cache: t }),
        Ka(a),
        e
      );
    }
    function np(e) {
      return e ? ((e = pi), e) : pi;
    }
    function rp(e, t, n, r, i, a) {
      ((i = np(i)),
        r.context === null ? (r.context = i) : (r.pendingContext = i),
        (r = Ja(t)),
        (r.payload = { element: n }),
        (a = a === void 0 ? null : a),
        a !== null && (r.callback = a),
        (n = I(e, r, t)),
        n !== null && (gu(n, e, t), Ya(n, e, t)));
    }
    function ip(e, t) {
      if (((e = e.memoizedState), e !== null && e.dehydrated !== null)) {
        var n = e.retryLane;
        e.retryLane = n !== 0 && n < t ? n : t;
      }
    }
    function ap(e, t) {
      (ip(e, t), (e = e.alternate) && ip(e, t));
    }
    function op(e) {
      if (e.tag === 13 || e.tag === 31) {
        var t = ui(e, 67108864);
        (t !== null && gu(t, e, 67108864), ap(e, 67108864));
      }
    }
    function sp(e) {
      if (e.tag === 13 || e.tag === 31) {
        var t = mu();
        t = dt(t);
        var n = ui(e, t);
        (n !== null && gu(n, e, t), ap(e, t));
      }
    }
    var cp = !0;
    function lp(e, t, n, r) {
      var i = w.T;
      w.T = null;
      var a = E.p;
      try {
        ((E.p = 2), dp(e, t, n, r));
      } finally {
        ((E.p = a), (w.T = i));
      }
    }
    function up(e, t, n, r) {
      var i = w.T;
      w.T = null;
      var a = E.p;
      try {
        ((E.p = 8), dp(e, t, n, r));
      } finally {
        ((E.p = a), (w.T = i));
      }
    }
    function dp(e, t, n, r) {
      if (cp) {
        var i = fp(r);
        if (i === null) (Td(e, t, r, pp, n), wp(e, r));
        else if (Ep(i, e, t, n, r)) r.stopPropagation();
        else if ((wp(e, r), t & 4 && -1 < Cp.indexOf(e))) {
          for (; i !== null; ) {
            var a = Et(i);
            if (a !== null)
              switch (a.tag) {
                case 3:
                  if (((a = a.stateNode), a.current.memoizedState.isDehydrated)) {
                    var o = et(a.pendingLanes);
                    if (o !== 0) {
                      var s = a;
                      for (s.pendingLanes |= 2, s.entangledLanes |= 2; o; ) {
                        var c = 1 << (31 - qe(o));
                        ((s.entanglements[1] |= c), (o &= ~c));
                      }
                      (id(a), !(G & 6) && ((nu = Fe() + 500), ad(0, !1)));
                    }
                  }
                  break;
                case 31:
                case 13:
                  ((s = ui(a, 2)), s !== null && gu(s, a, 2), xu(), ap(a, 2));
              }
            if (((a = fp(r)), a === null && Td(e, t, r, pp, n), a === i)) break;
            i = a;
          }
          i !== null && r.stopPropagation();
        } else Td(e, t, r, null, n);
      }
    }
    function fp(e) {
      return ((e = fn(e)), mp(e));
    }
    var pp = null;
    function mp(e) {
      if (((pp = null), (e = Tt(e)), e !== null)) {
        var t = l(e);
        if (t === null) e = null;
        else {
          var n = t.tag;
          if (n === 13) {
            if (((e = u(t)), e !== null)) return e;
            e = null;
          } else if (n === 31) {
            if (((e = d(t)), e !== null)) return e;
            e = null;
          } else if (n === 3) {
            if (t.stateNode.current.memoizedState.isDehydrated)
              return t.tag === 3 ? t.stateNode.containerInfo : null;
            e = null;
          } else t !== e && (e = null);
        }
      }
      return ((pp = e), null);
    }
    function hp(e) {
      switch (e) {
        case `beforetoggle`:
        case `cancel`:
        case `click`:
        case `close`:
        case `contextmenu`:
        case `copy`:
        case `cut`:
        case `auxclick`:
        case `dblclick`:
        case `dragend`:
        case `dragstart`:
        case `drop`:
        case `focusin`:
        case `focusout`:
        case `input`:
        case `invalid`:
        case `keydown`:
        case `keypress`:
        case `keyup`:
        case `mousedown`:
        case `mouseup`:
        case `paste`:
        case `pause`:
        case `play`:
        case `pointercancel`:
        case `pointerdown`:
        case `pointerup`:
        case `ratechange`:
        case `reset`:
        case `resize`:
        case `seeked`:
        case `submit`:
        case `toggle`:
        case `touchcancel`:
        case `touchend`:
        case `touchstart`:
        case `volumechange`:
        case `change`:
        case `selectionchange`:
        case `textInput`:
        case `compositionstart`:
        case `compositionend`:
        case `compositionupdate`:
        case `beforeblur`:
        case `afterblur`:
        case `beforeinput`:
        case `blur`:
        case `fullscreenchange`:
        case `focus`:
        case `hashchange`:
        case `popstate`:
        case `select`:
        case `selectstart`:
          return 2;
        case `drag`:
        case `dragenter`:
        case `dragexit`:
        case `dragleave`:
        case `dragover`:
        case `mousemove`:
        case `mouseout`:
        case `mouseover`:
        case `pointermove`:
        case `pointerout`:
        case `pointerover`:
        case `scroll`:
        case `touchmove`:
        case `wheel`:
        case `mouseenter`:
        case `mouseleave`:
        case `pointerenter`:
        case `pointerleave`:
          return 8;
        case `message`:
          switch (Ie()) {
            case Le:
              return 2;
            case Re:
              return 8;
            case ze:
            case Be:
              return 32;
            case Ve:
              return 268435456;
            default:
              return 32;
          }
        default:
          return 32;
      }
    }
    var gp = !1,
      _p = null,
      vp = null,
      yp = null,
      bp = new Map(),
      xp = new Map(),
      Sp = [],
      Cp =
        `mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset`.split(
          ` `,
        );
    function wp(e, t) {
      switch (e) {
        case `focusin`:
        case `focusout`:
          _p = null;
          break;
        case `dragenter`:
        case `dragleave`:
          vp = null;
          break;
        case `mouseover`:
        case `mouseout`:
          yp = null;
          break;
        case `pointerover`:
        case `pointerout`:
          bp.delete(t.pointerId);
          break;
        case `gotpointercapture`:
        case `lostpointercapture`:
          xp.delete(t.pointerId);
      }
    }
    function Tp(e, t, n, r, i, a) {
      return e === null || e.nativeEvent !== a
        ? ((e = {
            blockedOn: t,
            domEventName: n,
            eventSystemFlags: r,
            nativeEvent: a,
            targetContainers: [i],
          }),
          t !== null && ((t = Et(t)), t !== null && op(t)),
          e)
        : ((e.eventSystemFlags |= r),
          (t = e.targetContainers),
          i !== null && t.indexOf(i) === -1 && t.push(i),
          e);
    }
    function Ep(e, t, n, r, i) {
      switch (t) {
        case `focusin`:
          return ((_p = Tp(_p, e, t, n, r, i)), !0);
        case `dragenter`:
          return ((vp = Tp(vp, e, t, n, r, i)), !0);
        case `mouseover`:
          return ((yp = Tp(yp, e, t, n, r, i)), !0);
        case `pointerover`:
          var a = i.pointerId;
          return (bp.set(a, Tp(bp.get(a) || null, e, t, n, r, i)), !0);
        case `gotpointercapture`:
          return ((a = i.pointerId), xp.set(a, Tp(xp.get(a) || null, e, t, n, r, i)), !0);
      }
      return !1;
    }
    function Dp(e) {
      var t = Tt(e.target);
      if (t !== null) {
        var n = l(t);
        if (n !== null) {
          if (((t = n.tag), t === 13)) {
            if (((t = u(n)), t !== null)) {
              ((e.blockedOn = t),
                mt(e.priority, function () {
                  sp(n);
                }));
              return;
            }
          } else if (t === 31) {
            if (((t = d(n)), t !== null)) {
              ((e.blockedOn = t),
                mt(e.priority, function () {
                  sp(n);
                }));
              return;
            }
          } else if (t === 3 && n.stateNode.current.memoizedState.isDehydrated) {
            e.blockedOn = n.tag === 3 ? n.stateNode.containerInfo : null;
            return;
          }
        }
      }
      e.blockedOn = null;
    }
    function Op(e) {
      if (e.blockedOn !== null) return !1;
      for (var t = e.targetContainers; 0 < t.length; ) {
        var n = fp(e.nativeEvent);
        if (n === null) {
          n = e.nativeEvent;
          var r = new n.constructor(n.type, n);
          ((dn = r), n.target.dispatchEvent(r), (dn = null));
        } else return ((t = Et(n)), t !== null && op(t), (e.blockedOn = n), !1);
        t.shift();
      }
      return !0;
    }
    function kp(e, t, n) {
      Op(e) && n.delete(t);
    }
    function Ap() {
      ((gp = !1),
        _p !== null && Op(_p) && (_p = null),
        vp !== null && Op(vp) && (vp = null),
        yp !== null && Op(yp) && (yp = null),
        bp.forEach(kp),
        xp.forEach(kp));
    }
    function jp(e, t) {
      e.blockedOn === t &&
        ((e.blockedOn = null),
        gp || ((gp = !0), n.unstable_scheduleCallback(n.unstable_NormalPriority, Ap)));
    }
    var Mp = null;
    function Np(e) {
      Mp !== e &&
        ((Mp = e),
        n.unstable_scheduleCallback(n.unstable_NormalPriority, function () {
          Mp === e && (Mp = null);
          for (var t = 0; t < e.length; t += 3) {
            var n = e[t],
              r = e[t + 1],
              i = e[t + 2];
            if (typeof r != `function`) {
              if (mp(r || n) === null) continue;
              break;
            }
            var a = Et(n);
            a !== null &&
              (e.splice(t, 3),
              (t -= 3),
              Es(a, { pending: !0, data: i, method: n.method, action: r }, r, i));
          }
        }));
    }
    function Pp(e) {
      function t(t) {
        return jp(t, e);
      }
      (_p !== null && jp(_p, e),
        vp !== null && jp(vp, e),
        yp !== null && jp(yp, e),
        bp.forEach(t),
        xp.forEach(t));
      for (var n = 0; n < Sp.length; n++) {
        var r = Sp[n];
        r.blockedOn === e && (r.blockedOn = null);
      }
      for (; 0 < Sp.length && ((n = Sp[0]), n.blockedOn === null); )
        (Dp(n), n.blockedOn === null && Sp.shift());
      if (((n = (e.ownerDocument || e).$$reactFormReplay), n != null))
        for (r = 0; r < n.length; r += 3) {
          var i = n[r],
            a = n[r + 1],
            o = i[_t] || null;
          if (typeof a == `function`) o || Np(n);
          else if (o) {
            var s = null;
            if (a && a.hasAttribute(`formAction`)) {
              if (((i = a), (o = a[_t] || null))) s = o.formAction;
              else if (mp(i) !== null) continue;
            } else s = o.action;
            (typeof s == `function` ? (n[r + 1] = s) : (n.splice(r, 3), (r -= 3)), Np(n));
          }
        }
    }
    function Fp() {
      function e(e) {
        e.canIntercept &&
          e.info === `react-transition` &&
          e.intercept({
            handler: function () {
              return new Promise(function (e) {
                return (i = e);
              });
            },
            focusReset: `manual`,
            scroll: `manual`,
          });
      }
      function t() {
        (i !== null && (i(), (i = null)), r || setTimeout(n, 20));
      }
      function n() {
        if (!r && !navigation.transition) {
          var e = navigation.currentEntry;
          e &&
            e.url != null &&
            navigation.navigate(e.url, {
              state: e.getState(),
              info: `react-transition`,
              history: `replace`,
            });
        }
      }
      if (typeof navigation == `object`) {
        var r = !1,
          i = null;
        return (
          navigation.addEventListener(`navigate`, e),
          navigation.addEventListener(`navigatesuccess`, t),
          navigation.addEventListener(`navigateerror`, t),
          setTimeout(n, 100),
          function () {
            ((r = !0),
              navigation.removeEventListener(`navigate`, e),
              navigation.removeEventListener(`navigatesuccess`, t),
              navigation.removeEventListener(`navigateerror`, t),
              i !== null && (i(), (i = null)));
          }
        );
      }
    }
    function Ip(e) {
      this._internalRoot = e;
    }
    ((Lp.prototype.render = Ip.prototype.render =
      function (e) {
        var t = this._internalRoot;
        if (t === null) throw Error(o(409));
        var n = t.current;
        rp(n, mu(), e, t, null, null);
      }),
      (Lp.prototype.unmount = Ip.prototype.unmount =
        function () {
          var e = this._internalRoot;
          if (e !== null) {
            this._internalRoot = null;
            var t = e.containerInfo;
            (rp(e.current, 2, null, e, null, null), xu(), (t[vt] = null));
          }
        }));
    function Lp(e) {
      this._internalRoot = e;
    }
    Lp.prototype.unstable_scheduleHydration = function (e) {
      if (e) {
        var t = pt();
        e = { blockedOn: null, target: e, priority: t };
        for (var n = 0; n < Sp.length && t !== 0 && t < Sp[n].priority; n++);
        (Sp.splice(n, 0, e), n === 0 && Dp(e));
      }
    };
    var Rp = r.version;
    if (Rp !== `19.2.5`) throw Error(o(527, Rp, `19.2.5`));
    E.findDOMNode = function (e) {
      var t = e._reactInternals;
      if (t === void 0)
        throw typeof e.render == `function`
          ? Error(o(188))
          : ((e = Object.keys(e).join(`,`)), Error(o(268, e)));
      return ((e = p(t)), (e = e === null ? null : m(e)), (e = e === null ? null : e.stateNode), e);
    };
    var zp = {
      bundleType: 0,
      version: `19.2.5`,
      rendererPackageName: `react-dom`,
      currentDispatcherRef: w,
      reconcilerVersion: `19.2.5`,
    };
    if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < `u`) {
      var Bp = __REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!Bp.isDisabled && Bp.supportsFiber)
        try {
          ((We = Bp.inject(zp)), (Ge = Bp));
        } catch {}
    }
    e.hydrateRoot = function (e, t, n) {
      if (!c(e)) throw Error(o(299));
      var r = !1,
        i = ``,
        a = Ys,
        s = Xs,
        l = Zs,
        u = null;
      return (
        n != null &&
          (!0 === n.unstable_strictMode && (r = !0),
          n.identifierPrefix !== void 0 && (i = n.identifierPrefix),
          n.onUncaughtError !== void 0 && (a = n.onUncaughtError),
          n.onCaughtError !== void 0 && (s = n.onCaughtError),
          n.onRecoverableError !== void 0 && (l = n.onRecoverableError),
          n.formState !== void 0 && (u = n.formState)),
        (t = tp(e, 1, !0, t, n ?? null, r, i, u, a, s, l, Fp)),
        (t.context = np(null)),
        (n = t.current),
        (r = mu()),
        (r = dt(r)),
        (i = Ja(r)),
        (i.callback = null),
        I(n, i, r),
        (n = r),
        (t.current.lanes = n),
        ot(t, n),
        id(t),
        (e[vt] = t.current),
        Cd(e),
        new Lp(t)
      );
    };
  }),
  l = n((e, t) => {
    function n() {
      if (
        !(
          typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > `u` ||
          typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != `function`
        )
      )
        try {
          __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
        } catch (e) {
          console.error(e);
        }
    }
    (n(), (t.exports = c()));
  }),
  u = `__TSS_CONTEXT`,
  d = Symbol.for(`TSS_SERVER_FUNCTION`),
  f = Symbol.for(`TSS_SERVER_FUNCTION_FACTORY`),
  p = `application/x-tss-framed`,
  m = { JSON: 0, CHUNK: 1, END: 2, ERROR: 3 };
`${p}`;
var h = /;\s*v=(\d+)/;
function g(e) {
  let t = e.match(h);
  return t ? parseInt(t[1], 10) : void 0;
}
function _(e) {
  let t = g(e);
  if (t !== void 0 && t !== 1)
    throw Error(
      `Incompatible framed protocol version: server=${t}, client=1. Please ensure client and server are using compatible versions.`,
    );
}
var v = () => window.__TSS_START_OPTIONS__;
function y(e) {
  return e[e.length - 1];
}
function b(e) {
  return typeof e == `function`;
}
function x(e, t) {
  return b(e) ? e(t) : e;
}
var S = Object.prototype.hasOwnProperty,
  C = Object.prototype.propertyIsEnumerable,
  ee = () => Object.create(null),
  te = (e, t) => ne(e, t, ee);
function ne(e, t, n = () => ({}), r = 0) {
  if (e === t) return e;
  if (r > 500) return t;
  let i = t,
    a = oe(e) && oe(i);
  if (!a && !(ie(e) && ie(i))) return i;
  let o = a ? e : re(e);
  if (!o) return i;
  let s = a ? i : re(i);
  if (!s) return i;
  let c = o.length,
    l = s.length,
    u = a ? Array(l) : n(),
    d = 0;
  for (let t = 0; t < l; t++) {
    let o = a ? t : s[t],
      l = e[o],
      f = i[o];
    if (l === f) {
      ((u[o] = l), (a ? t < c : S.call(e, o)) && d++);
      continue;
    }
    if (l === null || f === null || typeof l != `object` || typeof f != `object`) {
      u[o] = f;
      continue;
    }
    let p = ne(l, f, n, r + 1);
    ((u[o] = p), p === l && d++);
  }
  return c === l && d === c ? e : u;
}
function re(e) {
  let t = Object.getOwnPropertyNames(e);
  for (let n of t) if (!C.call(e, n)) return !1;
  let n = Object.getOwnPropertySymbols(e);
  if (n.length === 0) return t;
  let r = t;
  for (let t of n) {
    if (!C.call(e, t)) return !1;
    r.push(t);
  }
  return r;
}
function ie(e) {
  if (!ae(e)) return !1;
  let t = e.constructor;
  if (t === void 0) return !0;
  let n = t.prototype;
  return !(!ae(n) || !n.hasOwnProperty(`isPrototypeOf`));
}
function ae(e) {
  return Object.prototype.toString.call(e) === `[object Object]`;
}
function oe(e) {
  return Array.isArray(e) && e.length === Object.keys(e).length;
}
function se(e, t, n) {
  if (e === t) return !0;
  if (typeof e != typeof t) return !1;
  if (Array.isArray(e) && Array.isArray(t)) {
    if (e.length !== t.length) return !1;
    for (let r = 0, i = e.length; r < i; r++) if (!se(e[r], t[r], n)) return !1;
    return !0;
  }
  if (ie(e) && ie(t)) {
    let r = n?.ignoreUndefined ?? !0;
    if (n?.partial) {
      for (let i in t) if ((!r || t[i] !== void 0) && !se(e[i], t[i], n)) return !1;
      return !0;
    }
    let i = 0;
    if (!r) i = Object.keys(e).length;
    else for (let t in e) e[t] !== void 0 && i++;
    let a = 0;
    for (let o in t) if ((!r || t[o] !== void 0) && (a++, a > i || !se(e[o], t[o], n))) return !1;
    return i === a;
  }
  return !1;
}
function ce(e) {
  let t,
    n,
    r = new Promise((e, r) => {
      ((t = e), (n = r));
    });
  return (
    (r.status = `pending`),
    (r.resolve = (n) => {
      ((r.status = `resolved`), (r.value = n), t(n), e?.(n));
    }),
    (r.reject = (e) => {
      ((r.status = `rejected`), n(e));
    }),
    r
  );
}
function le(e) {
  return typeof e?.message == `string`
    ? e.message.startsWith(`Failed to fetch dynamically imported module`) ||
        e.message.startsWith(`error loading dynamically imported module`) ||
        e.message.startsWith(`Importing a module script failed`)
    : !1;
}
function ue(e) {
  return !!(e && typeof e == `object` && typeof e.then == `function`);
}
function de(e) {
  return e.replace(/[\x00-\x1f\x7f]/g, ``);
}
function w(e) {
  let t;
  try {
    t = decodeURI(e);
  } catch {
    t = e.replaceAll(/%[0-9A-F]{2}/gi, (e) => {
      try {
        return decodeURI(e);
      } catch {
        return e;
      }
    });
  }
  return de(t);
}
var E = [`http:`, `https:`, `mailto:`, `tel:`];
function fe(e, t) {
  if (!e) return !1;
  try {
    let n = new URL(e);
    return !t.has(n.protocol);
  } catch {
    return !1;
  }
}
var pe = {
    "&": `\\u0026`,
    ">": `\\u003e`,
    "<": `\\u003c`,
    "\u2028": `\\u2028`,
    "\u2029": `\\u2029`,
  },
  me = /[&><\u2028\u2029]/g;
function he(e) {
  return e.replace(me, (e) => pe[e]);
}
function D(e) {
  if (!e || (!/[%\\\x00-\x1f\x7f]/.test(e) && !e.startsWith(`//`)))
    return { path: e, handledProtocolRelativeURL: !1 };
  let t = /%25|%5C/gi,
    n = 0,
    r = ``,
    i;
  for (; (i = t.exec(e)) !== null; ) ((r += w(e.slice(n, i.index)) + i[0]), (n = t.lastIndex));
  r += w(n ? e.slice(n) : e);
  let a = !1;
  return (
    r.startsWith(`//`) && ((a = !0), (r = `/` + r.replace(/^\/+/, ``))),
    { path: r, handledProtocolRelativeURL: a }
  );
}
function O(e) {
  return /\s|[^\u0000-\u007F]/.test(e) ? e.replace(/\s|[^\u0000-\u007F]/gu, encodeURIComponent) : e;
}
function k(e, t) {
  if (e === t) return !0;
  if (e.length !== t.length) return !1;
  for (let n = 0; n < e.length; n++) if (e[n] !== t[n]) return !1;
  return !0;
}
function ge() {
  throw Error(`Invariant failed`);
}
function _e(e) {
  let t = new Map(),
    n,
    r,
    i = (e) => {
      e.next &&
        (e.prev
          ? ((e.prev.next = e.next),
            (e.next.prev = e.prev),
            (e.next = void 0),
            r && ((r.next = e), (e.prev = r)))
          : ((e.next.prev = void 0),
            (n = e.next),
            (e.next = void 0),
            r && ((e.prev = r), (r.next = e))),
        (r = e));
    };
  return {
    get(e) {
      let n = t.get(e);
      if (n) return (i(n), n.value);
    },
    set(a, o) {
      if (t.size >= e && n) {
        let e = n;
        (t.delete(e.key),
          e.next && ((n = e.next), (e.next.prev = void 0)),
          e === r && (r = void 0));
      }
      let s = t.get(a);
      if (s) ((s.value = o), i(s));
      else {
        let e = { key: a, value: o, prev: r };
        (r && (r.next = e), (r = e), (n ||= e), t.set(a, e));
      }
    },
    clear() {
      (t.clear(), (n = void 0), (r = void 0));
    },
  };
}
var ve = 4,
  ye = 5;
function be(e) {
  let t = e.indexOf(`{`);
  if (t === -1) return null;
  let n = e.indexOf(`}`, t);
  return n === -1 || t + 1 >= e.length ? null : [t, n];
}
function xe(e, t, n = new Uint16Array(6)) {
  let r = e.indexOf(`/`, t),
    i = r === -1 ? e.length : r,
    a = e.substring(t, i);
  if (!a || !a.includes(`$`))
    return ((n[0] = 0), (n[1] = t), (n[2] = t), (n[3] = i), (n[4] = i), (n[5] = i), n);
  if (a === `$`) {
    let r = e.length;
    return ((n[0] = 2), (n[1] = t), (n[2] = t), (n[3] = r), (n[4] = r), (n[5] = r), n);
  }
  if (a.charCodeAt(0) === 36)
    return ((n[0] = 1), (n[1] = t), (n[2] = t + 1), (n[3] = i), (n[4] = i), (n[5] = i), n);
  let o = be(a);
  if (o) {
    let [r, s] = o,
      c = a.charCodeAt(r + 1);
    if (c === 45) {
      if (r + 2 < a.length && a.charCodeAt(r + 2) === 36) {
        let e = r + 3,
          a = s;
        if (e < a)
          return (
            (n[0] = 3),
            (n[1] = t + r),
            (n[2] = t + e),
            (n[3] = t + a),
            (n[4] = t + s + 1),
            (n[5] = i),
            n
          );
      }
    } else if (c === 36) {
      let a = r + 1,
        o = r + 2;
      return o === s
        ? ((n[0] = 2),
          (n[1] = t + r),
          (n[2] = t + a),
          (n[3] = t + o),
          (n[4] = t + s + 1),
          (n[5] = e.length),
          n)
        : ((n[0] = 1),
          (n[1] = t + r),
          (n[2] = t + o),
          (n[3] = t + s),
          (n[4] = t + s + 1),
          (n[5] = i),
          n);
    }
  }
  return ((n[0] = 0), (n[1] = t), (n[2] = t), (n[3] = i), (n[4] = i), (n[5] = i), n);
}
function Se(e, t, n, r, i, a, o) {
  o?.(n);
  let s = r;
  {
    let r = n.fullPath ?? n.from,
      o = r.length,
      c = n.options?.caseSensitive ?? e,
      l = !!(n.options?.params?.parse && n.options?.skipRouteOnParseError?.params);
    for (; s < o; ) {
      let e = xe(r, s, t),
        o,
        u = s,
        d = e[5];
      switch (((s = d + 1), a++, e[0])) {
        case 0: {
          let t = r.substring(e[2], e[3]);
          if (c) {
            let e = i.static?.get(t);
            if (e) o = e;
            else {
              i.static ??= new Map();
              let e = Te(n.fullPath ?? n.from);
              ((e.parent = i), (e.depth = a), (o = e), i.static.set(t, e));
            }
          } else {
            let e = t.toLowerCase(),
              r = i.staticInsensitive?.get(e);
            if (r) o = r;
            else {
              i.staticInsensitive ??= new Map();
              let t = Te(n.fullPath ?? n.from);
              ((t.parent = i), (t.depth = a), (o = t), i.staticInsensitive.set(e, t));
            }
          }
          break;
        }
        case 1: {
          let t = r.substring(u, e[1]),
            s = r.substring(e[4], d),
            f = c && !!(t || s),
            p = t ? (f ? t : t.toLowerCase()) : void 0,
            m = s ? (f ? s : s.toLowerCase()) : void 0,
            h =
              !l &&
              i.dynamic?.find(
                (e) =>
                  !e.skipOnParamError && e.caseSensitive === f && e.prefix === p && e.suffix === m,
              );
          if (h) o = h;
          else {
            let e = Ee(1, n.fullPath ?? n.from, f, p, m);
            ((o = e), (e.depth = a), (e.parent = i), (i.dynamic ??= []), i.dynamic.push(e));
          }
          break;
        }
        case 3: {
          let t = r.substring(u, e[1]),
            s = r.substring(e[4], d),
            f = c && !!(t || s),
            p = t ? (f ? t : t.toLowerCase()) : void 0,
            m = s ? (f ? s : s.toLowerCase()) : void 0,
            h =
              !l &&
              i.optional?.find(
                (e) =>
                  !e.skipOnParamError && e.caseSensitive === f && e.prefix === p && e.suffix === m,
              );
          if (h) o = h;
          else {
            let e = Ee(3, n.fullPath ?? n.from, f, p, m);
            ((o = e), (e.parent = i), (e.depth = a), (i.optional ??= []), i.optional.push(e));
          }
          break;
        }
        case 2: {
          let t = r.substring(u, e[1]),
            s = r.substring(e[4], d),
            l = c && !!(t || s),
            f = t ? (l ? t : t.toLowerCase()) : void 0,
            p = s ? (l ? s : s.toLowerCase()) : void 0,
            m = Ee(2, n.fullPath ?? n.from, l, f, p);
          ((o = m), (m.parent = i), (m.depth = a), (i.wildcard ??= []), i.wildcard.push(m));
        }
      }
      i = o;
    }
    if (l && n.children && !n.isRoot && n.id && n.id.charCodeAt(n.id.lastIndexOf(`/`) + 1) === 95) {
      let e = Te(n.fullPath ?? n.from);
      ((e.kind = ye),
        (e.parent = i),
        a++,
        (e.depth = a),
        (i.pathless ??= []),
        i.pathless.push(e),
        (i = e));
    }
    let u = (n.path || !n.children) && !n.isRoot;
    if (u && r.endsWith(`/`)) {
      let e = Te(n.fullPath ?? n.from);
      ((e.kind = ve), (e.parent = i), a++, (e.depth = a), (i.index = e), (i = e));
    }
    ((i.parse = n.options?.params?.parse ?? null),
      (i.skipOnParamError = l),
      (i.parsingPriority = n.options?.skipRouteOnParseError?.priority ?? 0),
      u && !i.route && ((i.route = n), (i.fullPath = n.fullPath ?? n.from)));
  }
  if (n.children) for (let r of n.children) Se(e, t, r, s, i, a, o);
}
function Ce(e, t) {
  if (e.skipOnParamError && !t.skipOnParamError) return -1;
  if (!e.skipOnParamError && t.skipOnParamError) return 1;
  if (e.skipOnParamError && t.skipOnParamError && (e.parsingPriority || t.parsingPriority))
    return t.parsingPriority - e.parsingPriority;
  if (e.prefix && t.prefix && e.prefix !== t.prefix) {
    if (e.prefix.startsWith(t.prefix)) return -1;
    if (t.prefix.startsWith(e.prefix)) return 1;
  }
  if (e.suffix && t.suffix && e.suffix !== t.suffix) {
    if (e.suffix.endsWith(t.suffix)) return -1;
    if (t.suffix.endsWith(e.suffix)) return 1;
  }
  return e.prefix && !t.prefix
    ? -1
    : !e.prefix && t.prefix
      ? 1
      : e.suffix && !t.suffix
        ? -1
        : !e.suffix && t.suffix
          ? 1
          : e.caseSensitive && !t.caseSensitive
            ? -1
            : !e.caseSensitive && t.caseSensitive
              ? 1
              : 0;
}
function we(e) {
  if (e.pathless) for (let t of e.pathless) we(t);
  if (e.static) for (let t of e.static.values()) we(t);
  if (e.staticInsensitive) for (let t of e.staticInsensitive.values()) we(t);
  if (e.dynamic?.length) {
    e.dynamic.sort(Ce);
    for (let t of e.dynamic) we(t);
  }
  if (e.optional?.length) {
    e.optional.sort(Ce);
    for (let t of e.optional) we(t);
  }
  if (e.wildcard?.length) {
    e.wildcard.sort(Ce);
    for (let t of e.wildcard) we(t);
  }
}
function Te(e) {
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
    fullPath: e,
    parent: null,
    parse: null,
    skipOnParamError: !1,
    parsingPriority: 0,
  };
}
function Ee(e, t, n, r, i) {
  return {
    kind: e,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath: t,
    parent: null,
    parse: null,
    skipOnParamError: !1,
    parsingPriority: 0,
    caseSensitive: n,
    prefix: r,
    suffix: i,
  };
}
function De(e, t) {
  let n = Te(`/`),
    r = new Uint16Array(6);
  for (let t of e) Se(!1, r, t, 1, n, 0);
  (we(n), (t.masksTree = n), (t.flatCache = _e(1e3)));
}
function Oe(e, t) {
  e ||= `/`;
  let n = t.flatCache.get(e);
  if (n) return n;
  let r = Ne(e, t.masksTree);
  return (t.flatCache.set(e, r), r);
}
function ke(e, t, n, r, i) {
  ((e ||= `/`), (r ||= `/`));
  let a = t ? `case\0${e}` : e,
    o = i.singleCache.get(a);
  return (
    o || ((o = Te(`/`)), Se(t, new Uint16Array(6), { from: e }, 1, o, 0), i.singleCache.set(a, o)),
    Ne(r, o, n)
  );
}
function Ae(e, t, n = !1) {
  let r = n ? e : `nofuzz\0${e}`,
    i = t.matchCache.get(r);
  if (i !== void 0) return i;
  e ||= `/`;
  let a;
  try {
    a = Ne(e, t.segmentTree, n);
  } catch (e) {
    if (e instanceof URIError) a = null;
    else throw e;
  }
  return (a && (a.branch = Fe(a.route)), t.matchCache.set(r, a), a);
}
function je(e) {
  return e === `/` ? e : e.replace(/\/{1,}$/, ``);
}
function Me(e, t = !1, n) {
  let r = Te(e.fullPath),
    i = new Uint16Array(6),
    a = {},
    o = {},
    s = 0;
  return (
    Se(t, i, e, 1, r, 0, (e) => {
      if ((n?.(e, s), e.id in a && ge(), (a[e.id] = e), s !== 0 && e.path)) {
        let t = je(e.fullPath);
        (!o[t] || e.fullPath.endsWith(`/`)) && (o[t] = e);
      }
      s++;
    }),
    we(r),
    {
      processedTree: {
        segmentTree: r,
        singleCache: _e(1e3),
        matchCache: _e(1e3),
        flatCache: null,
        masksTree: null,
      },
      routesById: a,
      routesByPath: o,
    }
  );
}
function Ne(e, t, n = !1) {
  let r = e.split(`/`),
    i = Le(e, r, t, n);
  if (!i) return null;
  let [a] = Pe(e, r, i);
  return { route: i.node.route, rawParams: a, parsedParams: i.parsedParams };
}
function Pe(e, t, n) {
  let r = Ie(n.node),
    i = null,
    a = Object.create(null),
    o = n.extract?.part ?? 0,
    s = n.extract?.node ?? 0,
    c = n.extract?.path ?? 0,
    l = n.extract?.segment ?? 0;
  for (; s < r.length; o++, s++, c++, l++) {
    let u = r[s];
    if (u.kind === ve) break;
    if (u.kind === ye) {
      (l--, o--, c--);
      continue;
    }
    let d = t[o],
      f = c;
    if ((d && (c += d.length), u.kind === 1)) {
      i ??= n.node.fullPath.split(`/`);
      let e = i[l],
        t = u.prefix?.length ?? 0;
      if (e.charCodeAt(t) === 123) {
        let n = u.suffix?.length ?? 0,
          r = e.substring(t + 2, e.length - n - 1),
          i = d.substring(t, d.length - n);
        a[r] = decodeURIComponent(i);
      } else {
        let t = e.substring(1);
        a[t] = decodeURIComponent(d);
      }
    } else if (u.kind === 3) {
      if (n.skipped & (1 << s)) {
        (o--, (c = f - 1));
        continue;
      }
      i ??= n.node.fullPath.split(`/`);
      let e = i[l],
        t = u.prefix?.length ?? 0,
        r = u.suffix?.length ?? 0,
        p = e.substring(t + 3, e.length - r - 1),
        m = u.suffix || u.prefix ? d.substring(t, d.length - r) : d;
      m && (a[p] = decodeURIComponent(m));
    } else if (u.kind === 2) {
      let t = u,
        n = e.substring(f + (t.prefix?.length ?? 0), e.length - (t.suffix?.length ?? 0)),
        r = decodeURIComponent(n);
      ((a[`*`] = r), (a._splat = r));
      break;
    }
  }
  return (
    n.rawParams && Object.assign(a, n.rawParams), [a, { part: o, node: s, path: c, segment: l }]
  );
}
function Fe(e) {
  let t = [e];
  for (; e.parentRoute; ) ((e = e.parentRoute), t.push(e));
  return (t.reverse(), t);
}
function Ie(e) {
  let t = Array(e.depth + 1);
  do ((t[e.depth] = e), (e = e.parent));
  while (e);
  return t;
}
function Le(e, t, n, r) {
  if (e === `/` && n.index) return { node: n.index, skipped: 0 };
  let i = !y(t),
    a = i && e !== `/`,
    o = t.length - +!!i,
    s = [{ node: n, index: 1, skipped: 0, depth: 1, statics: 1, dynamics: 0, optionals: 0 }],
    c = null,
    l = null,
    u = null;
  for (; s.length; ) {
    let n = s.pop(),
      { node: i, index: d, skipped: f, depth: p, statics: m, dynamics: h, optionals: g } = n,
      { extract: _, rawParams: v, parsedParams: y } = n;
    if (i.skipOnParamError) {
      if (!Re(e, t, n)) continue;
      ((v = n.rawParams), (_ = n.extract), (y = n.parsedParams));
    }
    r && i.route && i.kind !== ve && ze(l, n) && (l = n);
    let b = d === o;
    if (
      b &&
      (i.route && !a && ze(u, n) && (u = n), !i.optional && !i.wildcard && !i.index && !i.pathless)
    )
      continue;
    let x = b ? void 0 : t[d],
      S;
    if (b && i.index) {
      let n = {
          node: i.index,
          index: d,
          skipped: f,
          depth: p + 1,
          statics: m,
          dynamics: h,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        },
        r = !0;
      if ((i.index.skipOnParamError && (Re(e, t, n) || (r = !1)), r)) {
        if (m === o && !h && !g && !f) return n;
        ze(u, n) && (u = n);
      }
    }
    if (i.wildcard && ze(c, n))
      for (let n of i.wildcard) {
        let { prefix: r, suffix: i } = n;
        if (r && (b || !(n.caseSensitive ? x : (S ??= x.toLowerCase())).startsWith(r))) continue;
        if (i) {
          if (b) continue;
          let e = t.slice(d).join(`/`).slice(-i.length);
          if ((n.caseSensitive ? e : e.toLowerCase()) !== i) continue;
        }
        let a = {
          node: n,
          index: o,
          skipped: f,
          depth: p,
          statics: m,
          dynamics: h,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        };
        if (!(n.skipOnParamError && !Re(e, t, a))) {
          c = a;
          break;
        }
      }
    if (i.optional) {
      let e = f | (1 << p),
        t = p + 1;
      for (let n = i.optional.length - 1; n >= 0; n--) {
        let r = i.optional[n];
        s.push({
          node: r,
          index: d,
          skipped: e,
          depth: t,
          statics: m,
          dynamics: h,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        });
      }
      if (!b)
        for (let e = i.optional.length - 1; e >= 0; e--) {
          let n = i.optional[e],
            { prefix: r, suffix: a } = n;
          if (r || a) {
            let e = n.caseSensitive ? x : (S ??= x.toLowerCase());
            if ((r && !e.startsWith(r)) || (a && !e.endsWith(a))) continue;
          }
          s.push({
            node: n,
            index: d + 1,
            skipped: f,
            depth: t,
            statics: m,
            dynamics: h,
            optionals: g + 1,
            extract: _,
            rawParams: v,
            parsedParams: y,
          });
        }
    }
    if (!b && i.dynamic && x)
      for (let e = i.dynamic.length - 1; e >= 0; e--) {
        let t = i.dynamic[e],
          { prefix: n, suffix: r } = t;
        if (n || r) {
          let e = t.caseSensitive ? x : (S ??= x.toLowerCase());
          if ((n && !e.startsWith(n)) || (r && !e.endsWith(r))) continue;
        }
        s.push({
          node: t,
          index: d + 1,
          skipped: f,
          depth: p + 1,
          statics: m,
          dynamics: h + 1,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        });
      }
    if (!b && i.staticInsensitive) {
      let e = i.staticInsensitive.get((S ??= x.toLowerCase()));
      e &&
        s.push({
          node: e,
          index: d + 1,
          skipped: f,
          depth: p + 1,
          statics: m + 1,
          dynamics: h,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        });
    }
    if (!b && i.static) {
      let e = i.static.get(x);
      e &&
        s.push({
          node: e,
          index: d + 1,
          skipped: f,
          depth: p + 1,
          statics: m + 1,
          dynamics: h,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        });
    }
    if (i.pathless) {
      let e = p + 1;
      for (let t = i.pathless.length - 1; t >= 0; t--) {
        let n = i.pathless[t];
        s.push({
          node: n,
          index: d,
          skipped: f,
          depth: e,
          statics: m,
          dynamics: h,
          optionals: g,
          extract: _,
          rawParams: v,
          parsedParams: y,
        });
      }
    }
  }
  if (u && c) return ze(c, u) ? u : c;
  if (u) return u;
  if (c) return c;
  if (r && l) {
    let n = l.index;
    for (let e = 0; e < l.index; e++) n += t[e].length;
    let r = n === e.length ? `/` : e.slice(n);
    return ((l.rawParams ??= Object.create(null)), (l.rawParams[`**`] = decodeURIComponent(r)), l);
  }
  return null;
}
function Re(e, t, n) {
  try {
    let [r, i] = Pe(e, t, n);
    ((n.rawParams = r), (n.extract = i));
    let a = n.node.parse(r);
    return ((n.parsedParams = Object.assign(Object.create(null), n.parsedParams, a)), !0);
  } catch {
    return null;
  }
}
function ze(e, t) {
  return e
    ? t.statics > e.statics ||
        (t.statics === e.statics &&
          (t.dynamics > e.dynamics ||
            (t.dynamics === e.dynamics &&
              (t.optionals > e.optionals ||
                (t.optionals === e.optionals &&
                  ((t.node.kind === ve) > (e.node.kind === ve) ||
                    ((t.node.kind === ve) == (e.node.kind === ve) && t.depth > e.depth)))))))
    : !0;
}
function Be(e) {
  return Ve(e.filter((e) => e !== void 0).join(`/`));
}
function Ve(e) {
  return e.replace(/\/{2,}/g, `/`);
}
function He(e) {
  return e === `/` ? e : e.replace(/^\/{1,}/, ``);
}
function Ue(e) {
  let t = e.length;
  return t > 1 && e[t - 1] === `/` ? e.replace(/\/{1,}$/, ``) : e;
}
function We(e) {
  return Ue(He(e));
}
function Ge(e, t) {
  return e?.endsWith(`/`) && e !== `/` && e !== `${t}/` ? e.slice(0, -1) : e;
}
function Ke(e, t, n) {
  return Ge(e, n) === Ge(t, n);
}
function qe({ base: e, to: t, trailingSlash: n = `never`, cache: r }) {
  let i = t.startsWith(`/`),
    a = !i && t === `.`,
    o;
  if (r) {
    o = i ? t : a ? e : e + `\0` + t;
    let n = r.get(o);
    if (n) return n;
  }
  let s;
  if (a) s = e.split(`/`);
  else if (i) s = t.split(`/`);
  else {
    for (s = e.split(`/`); s.length > 1 && y(s) === ``; ) s.pop();
    let n = t.split(`/`);
    for (let e = 0, t = n.length; e < t; e++) {
      let r = n[e];
      r === ``
        ? e
          ? e === t - 1 && s.push(r)
          : (s = [r])
        : r === `..`
          ? s.pop()
          : r === `.` || s.push(r);
    }
  }
  s.length > 1 && (y(s) === `` ? n === `never` && s.pop() : n === `always` && s.push(``));
  let c,
    l = ``;
  for (let e = 0; e < s.length; e++) {
    e > 0 && (l += `/`);
    let t = s[e];
    if (!t) continue;
    c = xe(t, 0, c);
    let n = c[0];
    if (n === 0) {
      l += t;
      continue;
    }
    let r = c[5],
      i = t.substring(0, c[1]),
      a = t.substring(c[4], r),
      o = t.substring(c[2], c[3]);
    n === 1
      ? (l += i || a ? `${i}{$${o}}${a}` : `$${o}`)
      : n === 2
        ? (l += i || a ? `${i}{$}${a}` : `$`)
        : (l += `${i}{-$${o}}${a}`);
  }
  l = Ve(l);
  let u = l || `/`;
  return (o && r && r.set(o, u), u);
}
function Je(e) {
  let t = new Map(e.map((e) => [encodeURIComponent(e), e])),
    n = Array.from(t.keys())
      .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`))
      .join(`|`),
    r = new RegExp(n, `g`);
  return (e) => e.replace(r, (e) => t.get(e) ?? e);
}
function Ye(e, t, n) {
  let r = t[e];
  return typeof r == `string`
    ? e === `_splat`
      ? /^[a-zA-Z0-9\-._~!/]*$/.test(r)
        ? r
        : r
            .split(`/`)
            .map((e) => Ze(e, n))
            .join(`/`)
      : Ze(r, n)
    : r;
}
function Xe({ path: e, params: t, decoder: n, ...r }) {
  let i = !1,
    a = Object.create(null);
  if (!e || e === `/`) return { interpolatedPath: `/`, usedParams: a, isMissingParams: i };
  if (!e.includes(`$`)) return { interpolatedPath: e, usedParams: a, isMissingParams: i };
  let o = e.length,
    s = 0,
    c,
    l = ``;
  for (; s < o; ) {
    let r = s;
    c = xe(e, r, c);
    let o = c[5];
    if (((s = o + 1), r === o)) continue;
    let u = c[0];
    if (u === 0) {
      l += `/` + e.substring(r, o);
      continue;
    }
    if (u === 2) {
      let s = t._splat;
      ((a._splat = s), (a[`*`] = s));
      let u = e.substring(r, c[1]),
        d = e.substring(c[4], o);
      if (!s) {
        ((i = !0), (u || d) && (l += `/` + u + d));
        continue;
      }
      let f = Ye(`_splat`, t, n);
      l += `/` + u + f + d;
      continue;
    }
    if (u === 1) {
      let s = e.substring(c[2], c[3]);
      (!i && !(s in t) && (i = !0), (a[s] = t[s]));
      let u = e.substring(r, c[1]),
        d = e.substring(c[4], o),
        f = Ye(s, t, n) ?? `undefined`;
      l += `/` + u + f + d;
      continue;
    }
    if (u === 3) {
      let i = e.substring(c[2], c[3]),
        s = t[i];
      if (s == null) continue;
      a[i] = s;
      let u = e.substring(r, c[1]),
        d = e.substring(c[4], o),
        f = Ye(i, t, n) ?? ``;
      l += `/` + u + f + d;
      continue;
    }
  }
  return (
    e.endsWith(`/`) && (l += `/`), { usedParams: a, interpolatedPath: l || `/`, isMissingParams: i }
  );
}
function Ze(e, t) {
  let n = encodeURIComponent(e);
  return t?.(n) ?? n;
}
function Qe(e) {
  return e?.isNotFound === !0;
}
function $e() {
  try {
    return typeof window < `u` && typeof window.sessionStorage == `object`
      ? window.sessionStorage
      : void 0;
  } catch {
    return;
  }
}
var et = `tsr-scroll-restoration-v1_3`;
function tt() {
  let e = $e();
  if (!e) return null;
  let t = {};
  try {
    let n = JSON.parse(e.getItem(`tsr-scroll-restoration-v1_3`) || `{}`);
    ie(n) && (t = n);
  } catch {}
  return {
    get state() {
      return t;
    },
    set: (e) => {
      t = x(e, t) || t;
    },
    persist: () => {
      try {
        e.setItem(et, JSON.stringify(t));
      } catch {}
    },
  };
}
var nt = tt(),
  rt = (e) => e.state.__TSR_key || e.href;
function it(e) {
  let t = [],
    n;
  for (; (n = e.parentNode); )
    (t.push(`${e.tagName}:nth-child(${Array.prototype.indexOf.call(n.children, e) + 1})`), (e = n));
  return `${t.reverse().join(` > `)}`.toLowerCase();
}
var at = !1,
  ot = `window`,
  st = `data-scroll-restoration-id`;
function ct(e, t) {
  if (!nt) return;
  let n = nt;
  if (
    ((t ?? e.options.scrollRestoration ?? !1) && (e.isScrollRestoring = !0),
    e.isScrollRestorationSetup || !n)
  )
    return;
  ((e.isScrollRestorationSetup = !0), (at = !1));
  let r = e.options.getScrollRestorationKey || rt,
    i = new Map();
  window.history.scrollRestoration = `manual`;
  let a = (t) => {
      if (!(at || !e.isScrollRestoring))
        if (t.target === document || t.target === window)
          i.set(ot, { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 });
        else {
          let e = t.target;
          i.set(e, { scrollX: e.scrollLeft || 0, scrollY: e.scrollTop || 0 });
        }
    },
    o = (t) => {
      if (!e.isScrollRestoring || !t || i.size === 0 || !n) return;
      let r = (n.state[t] ||= {});
      for (let [e, t] of i) {
        let n;
        if (e === ot) n = ot;
        else if (e.isConnected) {
          let t = e.getAttribute(st);
          n = t ? `[${st}="${t}"]` : it(e);
        }
        n && (r[n] = t);
      }
    };
  (document.addEventListener(`scroll`, a, !0),
    e.subscribe(`onBeforeLoad`, (e) => {
      (o(e.fromLocation ? r(e.fromLocation) : void 0), i.clear());
    }),
    window.addEventListener(`pagehide`, () => {
      (o(r(e.stores.resolvedLocation.get() ?? e.stores.location.get())), n.persist());
    }),
    e.subscribe(`onRendered`, (t) => {
      let a = r(t.toLocation),
        o = e.options.scrollRestorationBehavior,
        s = e.options.scrollToTopSelectors;
      if ((i.clear(), !e.resetNextScroll)) {
        e.resetNextScroll = !0;
        return;
      }
      if (
        !(
          typeof e.options.scrollRestoration == `function` &&
          !e.options.scrollRestoration({ location: e.latestLocation })
        )
      ) {
        at = !0;
        try {
          let t = e.isScrollRestoring ? n.state[a] : void 0,
            r = !1;
          if (t)
            for (let e in t) {
              let n = t[e];
              if (!ie(n)) continue;
              let { scrollX: i, scrollY: a } = n;
              if (!(!Number.isFinite(i) || !Number.isFinite(a))) {
                if (e === ot) (window.scrollTo({ top: a, left: i, behavior: o }), (r = !0));
                else if (e) {
                  let t;
                  try {
                    t = document.querySelector(e);
                  } catch {
                    continue;
                  }
                  t && ((t.scrollLeft = i), (t.scrollTop = a), (r = !0));
                }
              }
            }
          if (!r) {
            let t = e.history.location.hash.slice(1);
            if (t) {
              let e = window.history.state?.__hashScrollIntoViewOptions ?? !0;
              if (e) {
                let n = document.getElementById(t);
                n && n.scrollIntoView(e);
              }
            } else {
              let e = { top: 0, left: 0, behavior: o };
              if ((window.scrollTo(e), s))
                for (let t of s) {
                  if (t === ot) continue;
                  let n = typeof t == `function` ? t() : document.querySelector(t);
                  n && n.scrollTo(e);
                }
            }
          }
        } finally {
          at = !1;
        }
        e.isScrollRestoring && n.set((e) => ((e[a] ||= {}), e));
      }
    }));
}
function lt(e, t = String) {
  let n = new URLSearchParams();
  for (let r in e) {
    let i = e[r];
    i !== void 0 && n.set(r, t(i));
  }
  return n.toString();
}
function ut(e) {
  return e ? (e === `false` ? !1 : e === `true` ? !0 : e * 0 == 0 && +e + `` === e ? +e : e) : ``;
}
function dt(e) {
  let t = new URLSearchParams(e),
    n = Object.create(null);
  for (let [e, r] of t.entries()) {
    let t = n[e];
    t == null ? (n[e] = ut(r)) : Array.isArray(t) ? t.push(ut(r)) : (n[e] = [t, ut(r)]);
  }
  return n;
}
var ft = mt(JSON.parse),
  pt = ht(JSON.stringify, JSON.parse);
function mt(e) {
  return (t) => {
    t[0] === `?` && (t = t.substring(1));
    let n = dt(t);
    for (let t in n) {
      let r = n[t];
      if (typeof r == `string`)
        try {
          n[t] = e(r);
        } catch {}
    }
    return n;
  };
}
function ht(e, t) {
  let n = typeof t == `function`;
  function r(r) {
    if (typeof r == `object` && r)
      try {
        return e(r);
      } catch {}
    else if (n && typeof r == `string`)
      try {
        return (t(r), e(r));
      } catch {}
    return r;
  }
  return (e) => {
    let t = lt(e, r);
    return t ? `?${t}` : ``;
  };
}
var gt = `__root__`;
function _t(e) {
  if (
    ((e.statusCode = e.statusCode || e.code || 307),
    !e._builtLocation && !e.reloadDocument && typeof e.href == `string`)
  )
    try {
      (new URL(e.href), (e.reloadDocument = !0));
    } catch {}
  let t = new Headers(e.headers);
  e.href && t.get(`Location`) === null && t.set(`Location`, e.href);
  let n = new Response(null, { status: e.statusCode, headers: t });
  if (((n.options = e), e.throw)) throw n;
  return n;
}
function vt(e) {
  return e instanceof Response && !!e.options;
}
function yt(e) {
  if (typeof e == `object` && e && e.isSerializedRedirect) return _t(e);
}
function bt(e) {
  return {
    input: ({ url: t }) => {
      for (let n of e) t = St(n, t);
      return t;
    },
    output: ({ url: t }) => {
      for (let n = e.length - 1; n >= 0; n--) t = Ct(e[n], t);
      return t;
    },
  };
}
function xt(e) {
  let t = We(e.basepath),
    n = `/${t}`,
    r = `${n}/`,
    i = e.caseSensitive ? n : n.toLowerCase(),
    a = e.caseSensitive ? r : r.toLowerCase();
  return {
    input: ({ url: t }) => {
      let r = e.caseSensitive ? t.pathname : t.pathname.toLowerCase();
      return (
        r === i ? (t.pathname = `/`) : r.startsWith(a) && (t.pathname = t.pathname.slice(n.length)),
        t
      );
    },
    output: ({ url: e }) => ((e.pathname = Be([`/`, t, e.pathname])), e),
  };
}
function St(e, t) {
  let n = e?.input?.({ url: t });
  if (n) {
    if (typeof n == `string`) return new URL(n);
    if (n instanceof URL) return n;
  }
  return t;
}
function Ct(e, t) {
  let n = e?.output?.({ url: t });
  if (n) {
    if (typeof n == `string`) return new URL(n);
    if (n instanceof URL) return n;
  }
  return t;
}
function wt(e, t) {
  let { createMutableStore: n, createReadonlyStore: r, batch: i, init: a } = t,
    o = new Map(),
    s = new Map(),
    c = new Map(),
    l = n(e.status),
    u = n(e.loadedAt),
    d = n(e.isLoading),
    f = n(e.isTransitioning),
    p = n(e.location),
    m = n(e.resolvedLocation),
    h = n(e.statusCode),
    g = n(e.redirect),
    _ = n([]),
    v = n([]),
    y = n([]),
    b = r(() => Tt(o, _.get())),
    x = r(() => Tt(s, v.get())),
    S = r(() => Tt(c, y.get())),
    C = r(() => _.get()[0]),
    ee = r(() => _.get().some((e) => o.get(e)?.get().status === `pending`)),
    te = r(() => ({
      locationHref: p.get().href,
      resolvedLocationHref: m.get()?.href,
      status: l.get(),
    })),
    ne = r(() => ({
      status: l.get(),
      loadedAt: u.get(),
      isLoading: d.get(),
      isTransitioning: f.get(),
      matches: b.get(),
      location: p.get(),
      resolvedLocation: m.get(),
      statusCode: h.get(),
      redirect: g.get(),
    })),
    re = _e(64);
  function ie(e) {
    let t = re.get(e);
    return (
      t ||
        ((t = r(() => {
          let t = _.get();
          for (let n of t) {
            let t = o.get(n);
            if (t && t.routeId === e) return t.get();
          }
        })),
        re.set(e, t)),
      t
    );
  }
  let ae = {
    status: l,
    loadedAt: u,
    isLoading: d,
    isTransitioning: f,
    location: p,
    resolvedLocation: m,
    statusCode: h,
    redirect: g,
    matchesId: _,
    pendingIds: v,
    cachedIds: y,
    matches: b,
    pendingMatches: x,
    cachedMatches: S,
    firstId: C,
    hasPending: ee,
    matchRouteDeps: te,
    matchStores: o,
    pendingMatchStores: s,
    cachedMatchStores: c,
    __store: ne,
    getRouteMatchStore: ie,
    setMatches: oe,
    setPending: se,
    setCached: ce,
  };
  (oe(e.matches), a?.(ae));
  function oe(e) {
    Et(e, o, _, n, i);
  }
  function se(e) {
    Et(e, s, v, n, i);
  }
  function ce(e) {
    Et(e, c, y, n, i);
  }
  return ae;
}
function Tt(e, t) {
  let n = [];
  for (let r of t) {
    let t = e.get(r);
    t && n.push(t.get());
  }
  return n;
}
function Et(e, t, n, r, i) {
  let a = e.map((e) => e.id),
    o = new Set(a);
  i(() => {
    for (let e of t.keys()) o.has(e) || t.delete(e);
    for (let n of e) {
      let e = t.get(n.id);
      if (!e) {
        let e = r(n);
        ((e.routeId = n.routeId), t.set(n.id, e));
        continue;
      }
      ((e.routeId = n.routeId), e.get() !== n && e.set(n));
    }
    k(n.get(), a) || n.set(a);
  });
}
var Dt = (e) => {
    if (!e.rendered) return ((e.rendered = !0), e.onReady?.());
  },
  Ot = (e) =>
    e.stores.matchesId.get().some((t) => e.stores.matchStores.get(t)?.get()._forcePending),
  kt = (e, t) => !!(e.preload && !e.router.stores.matchStores.has(t)),
  At = (e, t, n = !0) => {
    let r = { ...(e.router.options.context ?? {}) },
      i = n ? t : t - 1;
    for (let t = 0; t <= i; t++) {
      let n = e.matches[t];
      if (!n) continue;
      let i = e.router.getMatch(n.id);
      i && Object.assign(r, i.__routeContext, i.__beforeLoadContext);
    }
    return r;
  },
  jt = (e, t) => {
    if (!e.matches.length) return;
    let n = t.routeId,
      r = e.matches.findIndex((t) => t.routeId === e.router.routeTree.id),
      i = r >= 0 ? r : 0,
      a = n
        ? e.matches.findIndex((e) => e.routeId === n)
        : (e.firstBadMatchIndex ?? e.matches.length - 1);
    a < 0 && (a = i);
    for (let t = a; t >= 0; t--) {
      let n = e.matches[t];
      if (e.router.looseRoutesById[n.routeId].options.notFoundComponent) return t;
    }
    return n ? a : i;
  },
  Mt = (e, t, n) => {
    if (!(!vt(n) && !Qe(n)))
      throw vt(n) && n.redirectHandled && !n.options.reloadDocument
        ? n
        : (t &&
            (t._nonReactive.beforeLoadPromise?.resolve(),
            t._nonReactive.loaderPromise?.resolve(),
            (t._nonReactive.beforeLoadPromise = void 0),
            (t._nonReactive.loaderPromise = void 0),
            (t._nonReactive.error = n),
            e.updateMatch(t.id, (r) => ({
              ...r,
              status: vt(n)
                ? `redirected`
                : Qe(n)
                  ? `notFound`
                  : r.status === `pending`
                    ? `success`
                    : r.status,
              context: At(e, t.index),
              isFetching: !1,
              error: n,
            })),
            Qe(n) && !n.routeId && (n.routeId = t.routeId),
            t._nonReactive.loadPromise?.resolve()),
          vt(n) &&
            ((e.rendered = !0),
            (n.options._fromLocation = e.location),
            (n.redirectHandled = !0),
            (n = e.router.resolveRedirect(n))),
          n);
  },
  Nt = (e, t) => {
    let n = e.router.getMatch(t);
    return !!(!n || n._nonReactive.dehydrated);
  },
  Pt = (e, t, n) => {
    let r = At(e, n);
    e.updateMatch(t, (e) => ({ ...e, context: r }));
  },
  Ft = (e, t, n, r) => {
    let { id: i, routeId: a } = e.matches[t],
      o = e.router.looseRoutesById[a];
    if (n instanceof Promise) throw n;
    ((n.routerCode = r), (e.firstBadMatchIndex ??= t), Mt(e, e.router.getMatch(i), n));
    try {
      o.options.onError?.(n);
    } catch (t) {
      ((n = t), Mt(e, e.router.getMatch(i), n));
    }
    (e.updateMatch(
      i,
      (e) => (
        e._nonReactive.beforeLoadPromise?.resolve(),
        (e._nonReactive.beforeLoadPromise = void 0),
        e._nonReactive.loadPromise?.resolve(),
        {
          ...e,
          error: n,
          status: `error`,
          isFetching: !1,
          updatedAt: Date.now(),
          abortController: new AbortController(),
        }
      ),
    ),
      !e.preload && !vt(n) && !Qe(n) && (e.serialError ??= n));
  },
  It = (e, t, n, r) => {
    if (r._nonReactive.pendingTimeout !== void 0) return;
    let i = n.options.pendingMs ?? e.router.options.defaultPendingMs;
    if (
      e.onReady &&
      !kt(e, t) &&
      (n.options.loader || n.options.beforeLoad || qt(n)) &&
      typeof i == `number` &&
      i !== 1 / 0 &&
      (n.options.pendingComponent ?? e.router.options?.defaultPendingComponent)
    ) {
      let t = setTimeout(() => {
        Dt(e);
      }, i);
      r._nonReactive.pendingTimeout = t;
    }
  },
  Lt = (e, t, n) => {
    let r = e.router.getMatch(t);
    if (!r._nonReactive.beforeLoadPromise && !r._nonReactive.loaderPromise) return;
    It(e, t, n, r);
    let i = () => {
      let n = e.router.getMatch(t);
      n.preload && (n.status === `redirected` || n.status === `notFound`) && Mt(e, n, n.error);
    };
    return r._nonReactive.beforeLoadPromise ? r._nonReactive.beforeLoadPromise.then(i) : i();
  },
  Rt = (e, t, n, r) => {
    let i = e.router.getMatch(t),
      a = i._nonReactive.loadPromise;
    i._nonReactive.loadPromise = ce(() => {
      (a?.resolve(), (a = void 0));
    });
    let { paramsError: o, searchError: s } = i;
    (o && Ft(e, n, o, `PARSE_PARAMS`), s && Ft(e, n, s, `VALIDATE_SEARCH`), It(e, t, r, i));
    let c = new AbortController(),
      l = !1,
      u = () => {
        l ||
          ((l = !0),
          e.updateMatch(t, (e) => ({
            ...e,
            isFetching: `beforeLoad`,
            fetchCount: e.fetchCount + 1,
            abortController: c,
          })));
      },
      d = () => {
        (i._nonReactive.beforeLoadPromise?.resolve(),
          (i._nonReactive.beforeLoadPromise = void 0),
          e.updateMatch(t, (e) => ({ ...e, isFetching: !1 })));
      };
    if (!r.options.beforeLoad) {
      e.router.batch(() => {
        (u(), d());
      });
      return;
    }
    i._nonReactive.beforeLoadPromise = ce();
    let f = { ...At(e, n, !1), ...i.__routeContext },
      { search: p, params: m, cause: h } = i,
      g = kt(e, t),
      _ = {
        search: p,
        abortController: c,
        params: m,
        preload: g,
        context: f,
        location: e.location,
        navigate: (t) => e.router.navigate({ ...t, _fromLocation: e.location }),
        buildLocation: e.router.buildLocation,
        cause: g ? `preload` : h,
        matches: e.matches,
        routeId: r.id,
        ...e.router.options.additionalContext,
      },
      v = (r) => {
        if (r === void 0) {
          e.router.batch(() => {
            (u(), d());
          });
          return;
        }
        ((vt(r) || Qe(r)) && (u(), Ft(e, n, r, `BEFORE_LOAD`)),
          e.router.batch(() => {
            (u(), e.updateMatch(t, (e) => ({ ...e, __beforeLoadContext: r })), d());
          }));
      },
      y;
    try {
      if (((y = r.options.beforeLoad(_)), ue(y)))
        return (
          u(),
          y
            .catch((t) => {
              Ft(e, n, t, `BEFORE_LOAD`);
            })
            .then(v)
        );
    } catch (t) {
      (u(), Ft(e, n, t, `BEFORE_LOAD`));
    }
    v(y);
  },
  zt = (e, t) => {
    let { id: n, routeId: r } = e.matches[t],
      i = e.router.looseRoutesById[r],
      a = () => s(),
      o = () => Rt(e, n, t, i),
      s = () => {
        if (Nt(e, n)) return;
        let t = Lt(e, n, i);
        return ue(t) ? t.then(o) : o();
      };
    return a();
  },
  Bt = (e, t, n) => {
    let r = e.router.getMatch(t);
    if (!r || (!n.options.head && !n.options.scripts && !n.options.headers)) return;
    let i = {
      ssr: e.router.options.ssr,
      matches: e.matches,
      match: r,
      params: r.params,
      loaderData: r.loaderData,
    };
    return Promise.all([n.options.head?.(i), n.options.scripts?.(i), n.options.headers?.(i)]).then(
      ([e, t, n]) => ({
        meta: e?.meta,
        links: e?.links,
        headScripts: e?.scripts,
        headers: n,
        scripts: t,
        styles: e?.styles,
      }),
    );
  },
  Vt = (e, t, n, r, i) => {
    let a = t[r - 1],
      { params: o, loaderDeps: s, abortController: c, cause: l } = e.router.getMatch(n),
      u = At(e, r),
      d = kt(e, n);
    return {
      params: o,
      deps: s,
      preload: !!d,
      parentMatchPromise: a,
      abortController: c,
      context: u,
      location: e.location,
      navigate: (t) => e.router.navigate({ ...t, _fromLocation: e.location }),
      cause: d ? `preload` : l,
      route: i,
      ...e.router.options.additionalContext,
    };
  },
  Ht = async (e, t, n, r, i) => {
    try {
      let a = e.router.getMatch(n);
      try {
        Kt(i);
        let o = i.options.loader,
          s = typeof o == `function` ? o : o?.handler,
          c = s?.(Vt(e, t, n, r, i)),
          l = !!s && ue(c);
        if (
          ((l ||
            i._lazyPromise ||
            i._componentsPromise ||
            i.options.head ||
            i.options.scripts ||
            i.options.headers ||
            a._nonReactive.minPendingPromise) &&
            e.updateMatch(n, (e) => ({ ...e, isFetching: `loader` })),
          s)
        ) {
          let t = l ? await c : c;
          (Mt(e, e.router.getMatch(n), t),
            t !== void 0 && e.updateMatch(n, (e) => ({ ...e, loaderData: t })));
        }
        i._lazyPromise && (await i._lazyPromise);
        let u = a._nonReactive.minPendingPromise;
        (u && (await u),
          i._componentsPromise && (await i._componentsPromise),
          e.updateMatch(n, (t) => ({
            ...t,
            error: void 0,
            context: At(e, r),
            status: `success`,
            isFetching: !1,
            updatedAt: Date.now(),
          })));
      } catch (t) {
        let o = t;
        if (o?.name === `AbortError`) {
          if (a.abortController.signal.aborted) {
            (a._nonReactive.loaderPromise?.resolve(), (a._nonReactive.loaderPromise = void 0));
            return;
          }
          e.updateMatch(n, (t) => ({
            ...t,
            status: t.status === `pending` ? `success` : t.status,
            isFetching: !1,
            context: At(e, r),
          }));
          return;
        }
        let s = a._nonReactive.minPendingPromise;
        (s && (await s),
          Qe(t) && (await i.options.notFoundComponent?.preload?.()),
          Mt(e, e.router.getMatch(n), t));
        try {
          i.options.onError?.(t);
        } catch (t) {
          ((o = t), Mt(e, e.router.getMatch(n), t));
        }
        (!vt(o) && !Qe(o) && (await Kt(i, [`errorComponent`])),
          e.updateMatch(n, (t) => ({
            ...t,
            error: o,
            context: At(e, r),
            status: `error`,
            isFetching: !1,
          })));
      }
    } catch (t) {
      let r = e.router.getMatch(n);
      (r && (r._nonReactive.loaderPromise = void 0), Mt(e, r, t));
    }
  },
  Ut = async (e, t, n) => {
    async function r(r, a, c, l, d) {
      let f = Date.now() - a.updatedAt,
        p = r
          ? (d.options.preloadStaleTime ?? e.router.options.defaultPreloadStaleTime ?? 3e4)
          : (d.options.staleTime ?? e.router.options.defaultStaleTime ?? 0),
        m = d.options.shouldReload,
        h = typeof m == `function` ? m(Vt(e, t, i, n, d)) : m,
        { status: g, invalid: _ } = l,
        v = f >= p && (!!e.forceStaleReload || l.cause === `enter` || (c !== void 0 && c !== l.id));
      ((o = g === `success` && (_ || (h ?? v))),
        (r && d.options.preload === !1) ||
          (o && !e.sync && u
            ? ((s = !0),
              (async () => {
                try {
                  await Ht(e, t, i, n, d);
                  let r = e.router.getMatch(i);
                  (r._nonReactive.loaderPromise?.resolve(),
                    r._nonReactive.loadPromise?.resolve(),
                    (r._nonReactive.loaderPromise = void 0),
                    (r._nonReactive.loadPromise = void 0));
                } catch (t) {
                  vt(t) && (await e.router.navigate(t.options));
                }
              })())
            : g !== `success` || o
              ? await Ht(e, t, i, n, d)
              : Pt(e, i, n)));
    }
    let { id: i, routeId: a } = e.matches[n],
      o = !1,
      s = !1,
      c = e.router.looseRoutesById[a],
      l = c.options.loader,
      u =
        ((typeof l == `function` ? void 0 : l?.staleReloadMode) ??
          e.router.options.defaultStaleReloadMode) !== `blocking`;
    if (Nt(e, i)) {
      if (!e.router.getMatch(i)) return e.matches[n];
      Pt(e, i, n);
    } else {
      let t = e.router.getMatch(i),
        o = e.router.stores.matchesId.get()[n],
        s =
          ((o && e.router.stores.matchStores.get(o)) || null)?.routeId === a
            ? o
            : e.router.stores.matches.get().find((e) => e.routeId === a)?.id,
        l = kt(e, i);
      if (t._nonReactive.loaderPromise) {
        if (t.status === `success` && !e.sync && !t.preload && u) return t;
        await t._nonReactive.loaderPromise;
        let n = e.router.getMatch(i),
          a = n._nonReactive.error || n.error;
        (a && Mt(e, n, a), n.status === `pending` && (await r(l, t, s, n, c)));
      } else {
        let n = l && !e.router.stores.matchStores.has(i),
          a = e.router.getMatch(i);
        ((a._nonReactive.loaderPromise = ce()),
          n !== a.preload && e.updateMatch(i, (e) => ({ ...e, preload: n })),
          await r(l, t, s, a, c));
      }
    }
    let d = e.router.getMatch(i);
    (s ||
      (d._nonReactive.loaderPromise?.resolve(),
      d._nonReactive.loadPromise?.resolve(),
      (d._nonReactive.loadPromise = void 0)),
      clearTimeout(d._nonReactive.pendingTimeout),
      (d._nonReactive.pendingTimeout = void 0),
      s || (d._nonReactive.loaderPromise = void 0),
      (d._nonReactive.dehydrated = void 0));
    let f = s ? d.isFetching : !1;
    return f !== d.isFetching || d.invalid !== !1
      ? (e.updateMatch(i, (e) => ({ ...e, isFetching: f, invalid: !1 })), e.router.getMatch(i))
      : d;
  };
async function Wt(e) {
  let t = e,
    n = [];
  Ot(t.router) && Dt(t);
  let r;
  for (let e = 0; e < t.matches.length; e++) {
    try {
      let n = zt(t, e);
      ue(n) && (await n);
    } catch (e) {
      if (vt(e)) throw e;
      if (Qe(e)) r = e;
      else if (!t.preload) throw e;
      break;
    }
    if (t.serialError || t.firstBadMatchIndex != null) break;
  }
  let i = t.firstBadMatchIndex ?? t.matches.length,
    a = r && !t.preload ? jt(t, r) : void 0,
    o = r && t.preload ? 0 : a === void 0 ? i : Math.min(a + 1, i),
    s,
    c;
  for (let e = 0; e < o; e++) n.push(Ut(t, n, e));
  try {
    await Promise.all(n);
  } catch {
    let e = await Promise.allSettled(n);
    for (let t of e) {
      if (t.status !== `rejected`) continue;
      let e = t.reason;
      if (vt(e)) throw e;
      Qe(e) ? (s ??= e) : (c ??= e);
    }
    if (c !== void 0) throw c;
  }
  let l = s ?? (r && !t.preload ? r : void 0),
    u = t.firstBadMatchIndex === void 0 ? t.matches.length - 1 : t.firstBadMatchIndex;
  if (!l && r && t.preload) return t.matches;
  if (l) {
    let e = jt(t, l);
    e === void 0 && ge();
    let n = t.matches[e],
      r = t.router.looseRoutesById[n.routeId],
      i = t.router.options?.defaultNotFoundComponent;
    (!r.options.notFoundComponent && i && (r.options.notFoundComponent = i),
      (l.routeId = n.routeId));
    let a = n.routeId === t.router.routeTree.id;
    (t.updateMatch(n.id, (e) => ({
      ...e,
      ...(a
        ? { status: `success`, globalNotFound: !0, error: void 0 }
        : { status: `notFound`, error: l }),
      isFetching: !1,
    })),
      (u = e),
      await Kt(r, [`notFoundComponent`]));
  } else if (!t.preload) {
    let e = t.matches[0];
    e.globalNotFound ||
      (t.router.getMatch(e.id)?.globalNotFound &&
        t.updateMatch(e.id, (e) => ({ ...e, globalNotFound: !1, error: void 0 })));
  }
  if (t.serialError && t.firstBadMatchIndex !== void 0) {
    let e = t.router.looseRoutesById[t.matches[t.firstBadMatchIndex].routeId];
    await Kt(e, [`errorComponent`]);
  }
  for (let e = 0; e <= u; e++) {
    let { id: n, routeId: r } = t.matches[e],
      i = t.router.looseRoutesById[r];
    try {
      let e = Bt(t, n, i);
      if (e) {
        let r = await e;
        t.updateMatch(n, (e) => ({ ...e, ...r }));
      }
    } catch (e) {
      console.error(`Error executing head for route ${r}:`, e);
    }
  }
  let d = Dt(t);
  if ((ue(d) && (await d), l)) throw l;
  if (t.serialError && !t.preload && !t.onReady) throw t.serialError;
  return t.matches;
}
function Gt(e, t) {
  let n = t.map((t) => e.options[t]?.preload?.()).filter(Boolean);
  if (n.length !== 0) return Promise.all(n);
}
function Kt(e, t = Jt) {
  !e._lazyLoaded &&
    e._lazyPromise === void 0 &&
    (e.lazyFn
      ? (e._lazyPromise = e.lazyFn().then((t) => {
          let { id: n, ...r } = t.options;
          (Object.assign(e.options, r), (e._lazyLoaded = !0), (e._lazyPromise = void 0));
        }))
      : (e._lazyLoaded = !0));
  let n = () =>
    e._componentsLoaded
      ? void 0
      : t === Jt
        ? (() => {
            if (e._componentsPromise === void 0) {
              let t = Gt(e, Jt);
              t
                ? (e._componentsPromise = t.then(() => {
                    ((e._componentsLoaded = !0), (e._componentsPromise = void 0));
                  }))
                : (e._componentsLoaded = !0);
            }
            return e._componentsPromise;
          })()
        : Gt(e, t);
  return e._lazyPromise ? e._lazyPromise.then(n) : n();
}
function qt(e) {
  for (let t of Jt) if (e.options[t]?.preload) return !0;
  return !1;
}
var Jt = [`component`, `errorComponent`, `pendingComponent`, `notFoundComponent`],
  Yt = `__TSR_index`,
  Xt = `popstate`,
  Zt = `beforeunload`;
function Qt(e) {
  let t = e.getLocation(),
    n = new Set(),
    r = (r) => {
      ((t = e.getLocation()), n.forEach((e) => e({ location: t, action: r })));
    },
    i = (n) => {
      (e.notifyOnIndexChange ?? !0) ? r(n) : (t = e.getLocation());
    },
    a = async ({ task: n, navigateOpts: r, ...i }) => {
      if (r?.ignoreBlocker ?? !1) {
        n();
        return;
      }
      let a = e.getBlockers?.() ?? [],
        o = i.type === `PUSH` || i.type === `REPLACE`;
      if (typeof document < `u` && a.length && o)
        for (let n of a) {
          let r = nn(i.path, i.state);
          if (await n.blockerFn({ currentLocation: t, nextLocation: r, action: i.type })) {
            e.onBlocked?.();
            return;
          }
        }
      n();
    };
  return {
    get location() {
      return t;
    },
    get length() {
      return e.getLength();
    },
    subscribers: n,
    subscribe: (e) => (
      n.add(e),
      () => {
        n.delete(e);
      }
    ),
    push: (n, i, o) => {
      let s = t.state[Yt];
      ((i = $t(s + 1, i)),
        a({
          task: () => {
            (e.pushState(n, i), r({ type: `PUSH` }));
          },
          navigateOpts: o,
          type: `PUSH`,
          path: n,
          state: i,
        }));
    },
    replace: (n, i, o) => {
      let s = t.state[Yt];
      ((i = $t(s, i)),
        a({
          task: () => {
            (e.replaceState(n, i), r({ type: `REPLACE` }));
          },
          navigateOpts: o,
          type: `REPLACE`,
          path: n,
          state: i,
        }));
    },
    go: (t, n) => {
      a({
        task: () => {
          (e.go(t), i({ type: `GO`, index: t }));
        },
        navigateOpts: n,
        type: `GO`,
      });
    },
    back: (t) => {
      a({
        task: () => {
          (e.back(t?.ignoreBlocker ?? !1), i({ type: `BACK` }));
        },
        navigateOpts: t,
        type: `BACK`,
      });
    },
    forward: (t) => {
      a({
        task: () => {
          (e.forward(t?.ignoreBlocker ?? !1), i({ type: `FORWARD` }));
        },
        navigateOpts: t,
        type: `FORWARD`,
      });
    },
    canGoBack: () => t.state[Yt] !== 0,
    createHref: (t) => e.createHref(t),
    block: (t) => {
      if (!e.setBlockers) return () => {};
      let n = e.getBlockers?.() ?? [];
      return (
        e.setBlockers([...n, t]),
        () => {
          let n = e.getBlockers?.() ?? [];
          e.setBlockers?.(n.filter((e) => e !== t));
        }
      );
    },
    flush: () => e.flush?.(),
    destroy: () => e.destroy?.(),
    notify: r,
  };
}
function $t(e, t) {
  t ||= {};
  let n = rn();
  return { ...t, key: n, __TSR_key: n, [Yt]: e };
}
function en(e) {
  let t = e?.window ?? (typeof document < `u` ? window : void 0),
    n = t.history.pushState,
    r = t.history.replaceState,
    i = [],
    a = () => i,
    o = (e) => (i = e),
    s = e?.createHref ?? ((e) => e),
    c =
      e?.parseLocation ??
      (() => nn(`${t.location.pathname}${t.location.search}${t.location.hash}`, t.history.state));
  if (!t.history.state?.__TSR_key && !t.history.state?.key) {
    let e = rn();
    t.history.replaceState({ [Yt]: 0, key: e, __TSR_key: e }, ``);
  }
  let l = c(),
    u,
    d = !1,
    f = !1,
    p = !1,
    m = !1,
    h = () => l,
    g,
    _,
    v = () => {
      g &&
        ((C._ignoreSubscribers = !0),
        (g.isPush ? t.history.pushState : t.history.replaceState)(g.state, ``, g.href),
        (C._ignoreSubscribers = !1),
        (g = void 0),
        (_ = void 0),
        (u = void 0));
    },
    y = (e, t, n) => {
      let r = s(t);
      (_ || (u = l),
        (l = nn(t, n)),
        (g = { href: r, state: n, isPush: g?.isPush || e === `push` }),
        (_ ||= Promise.resolve().then(() => v())));
    },
    b = (e) => {
      ((l = c()), C.notify({ type: e }));
    },
    x = async () => {
      if (f) {
        f = !1;
        return;
      }
      let e = c(),
        n = e.state[Yt] - l.state[Yt],
        r = n === 1,
        i = n === -1,
        o = (!r && !i) || d;
      d = !1;
      let s = o ? `GO` : i ? `BACK` : `FORWARD`,
        u = o ? { type: `GO`, index: n } : { type: i ? `BACK` : `FORWARD` };
      if (p) p = !1;
      else {
        let n = a();
        if (typeof document < `u` && n.length) {
          for (let r of n)
            if (await r.blockerFn({ currentLocation: l, nextLocation: e, action: s })) {
              ((f = !0), t.history.go(1), C.notify(u));
              return;
            }
        }
      }
      ((l = c()), C.notify(u));
    },
    S = (e) => {
      if (m) {
        m = !1;
        return;
      }
      let t = !1,
        n = a();
      if (typeof document < `u` && n.length)
        for (let e of n) {
          let n = e.enableBeforeUnload ?? !0;
          if (n === !0) {
            t = !0;
            break;
          }
          if (typeof n == `function` && n() === !0) {
            t = !0;
            break;
          }
        }
      if (t) return (e.preventDefault(), (e.returnValue = ``));
    },
    C = Qt({
      getLocation: h,
      getLength: () => t.history.length,
      pushState: (e, t) => y(`push`, e, t),
      replaceState: (e, t) => y(`replace`, e, t),
      back: (e) => (e && (p = !0), (m = !0), t.history.back()),
      forward: (e) => {
        (e && (p = !0), (m = !0), t.history.forward());
      },
      go: (e) => {
        ((d = !0), t.history.go(e));
      },
      createHref: (e) => s(e),
      flush: v,
      destroy: () => {
        ((t.history.pushState = n),
          (t.history.replaceState = r),
          t.removeEventListener(Zt, S, { capture: !0 }),
          t.removeEventListener(Xt, x));
      },
      onBlocked: () => {
        u && l !== u && (l = u);
      },
      getBlockers: a,
      setBlockers: o,
      notifyOnIndexChange: !1,
    });
  return (
    t.addEventListener(Zt, S, { capture: !0 }),
    t.addEventListener(Xt, x),
    (t.history.pushState = function (...e) {
      let r = n.apply(t.history, e);
      return (C._ignoreSubscribers || b(`PUSH`), r);
    }),
    (t.history.replaceState = function (...e) {
      let n = r.apply(t.history, e);
      return (C._ignoreSubscribers || b(`REPLACE`), n);
    }),
    C
  );
}
function tn(e) {
  let t = e.replace(/[\x00-\x1f\x7f]/g, ``);
  return (t.startsWith(`//`) && (t = `/` + t.replace(/^\/+/, ``)), t);
}
function nn(e, t) {
  let n = tn(e),
    r = n.indexOf(`#`),
    i = n.indexOf(`?`),
    a = rn();
  return {
    href: n,
    pathname: n.substring(0, r > 0 ? (i > 0 ? Math.min(r, i) : r) : i > 0 ? i : n.length),
    hash: r > -1 ? n.substring(r) : ``,
    search: i > -1 ? n.slice(i, r === -1 ? void 0 : r) : ``,
    state: t || { [Yt]: 0, key: a, __TSR_key: a },
  };
}
function rn() {
  return (Math.random() + 1).toString(36).substring(7);
}
function an(e) {
  return e instanceof Error ? { name: e.name, message: e.message } : { data: e };
}
function on(e, t) {
  let n = t,
    r = e;
  return {
    fromLocation: n,
    toLocation: r,
    pathChanged: n?.pathname !== r.pathname,
    hrefChanged: n?.href !== r.href,
    hashChanged: n?.hash !== r.hash,
  };
}
var sn = class {
    constructor(e, t) {
      ((this.tempLocationKey = `${Math.round(Math.random() * 1e7)}`),
        (this.resetNextScroll = !0),
        (this.shouldViewTransition = void 0),
        (this.isViewTransitionTypesSupported = void 0),
        (this.subscribers = new Set()),
        (this.isScrollRestoring = !1),
        (this.isScrollRestorationSetup = !1),
        (this.startTransition = (e) => e()),
        (this.update = (e) => {
          let t = this.options,
            n = this.basepath ?? t?.basepath ?? `/`,
            r = this.basepath === void 0,
            i = t?.rewrite;
          if (
            ((this.options = { ...t, ...e }),
            (this.isServer = this.options.isServer ?? typeof document > `u`),
            (this.protocolAllowlist = new Set(this.options.protocolAllowlist)),
            this.options.pathParamsAllowedCharacters &&
              (this.pathParamsDecoder = Je(this.options.pathParamsAllowedCharacters)),
            (!this.history || (this.options.history && this.options.history !== this.history)) &&
              (this.options.history
                ? (this.history = this.options.history)
                : (this.history = en())),
            (this.origin = this.options.origin),
            this.origin ||
              (window?.origin && window.origin !== `null`
                ? (this.origin = window.origin)
                : (this.origin = `http://localhost`)),
            this.history && this.updateLatestLocation(),
            this.options.routeTree !== this.routeTree)
          ) {
            this.routeTree = this.options.routeTree;
            let e;
            ((this.resolvePathCache = _e(1e3)), (e = this.buildRouteTree()), this.setRoutes(e));
          }
          if (!this.stores && this.latestLocation) {
            let e = this.getStoreConfig(this);
            ((this.batch = e.batch), (this.stores = wt(un(this.latestLocation), e)), ct(this));
          }
          let a = !1,
            o = this.options.basepath ?? `/`,
            s = this.options.rewrite;
          if (r || n !== o || i !== s) {
            this.basepath = o;
            let e = [],
              t = We(o);
            (t && t !== `/` && e.push(xt({ basepath: o })),
              s && e.push(s),
              (this.rewrite = e.length === 0 ? void 0 : e.length === 1 ? e[0] : bt(e)),
              this.history && this.updateLatestLocation(),
              (a = !0));
          }
          (a && this.stores && this.stores.location.set(this.latestLocation),
            typeof window < `u` &&
              `CSS` in window &&
              typeof window.CSS?.supports == `function` &&
              (this.isViewTransitionTypesSupported = window.CSS.supports(
                `selector(:active-view-transition-type(a)`,
              )));
        }),
        (this.updateLatestLocation = () => {
          this.latestLocation = this.parseLocation(this.history.location, this.latestLocation);
        }),
        (this.buildRouteTree = () => {
          let e = Me(this.routeTree, this.options.caseSensitive, (e, t) => {
            e.init({ originalIndex: t });
          });
          return (this.options.routeMasks && De(this.options.routeMasks, e.processedTree), e);
        }),
        (this.subscribe = (e, t) => {
          let n = { eventType: e, fn: t };
          return (
            this.subscribers.add(n),
            () => {
              this.subscribers.delete(n);
            }
          );
        }),
        (this.emit = (e) => {
          this.subscribers.forEach((t) => {
            t.eventType === e.type && t.fn(e);
          });
        }),
        (this.parseLocation = (e, t) => {
          let n = ({ pathname: e, search: n, hash: r, href: i, state: a }) => {
              if (!this.rewrite && !/[ \x00-\x1f\x7f\u0080-\uffff]/.test(e)) {
                let i = this.options.parseSearch(n),
                  o = this.options.stringifySearch(i);
                return {
                  href: e + o + r,
                  publicHref: e + o + r,
                  pathname: D(e).path,
                  external: !1,
                  searchStr: o,
                  search: te(t?.search, i),
                  hash: D(r.slice(1)).path,
                  state: ne(t?.state, a),
                };
              }
              let o = new URL(i, this.origin),
                s = St(this.rewrite, o),
                c = this.options.parseSearch(s.search),
                l = this.options.stringifySearch(c);
              return (
                (s.search = l),
                {
                  href: s.href.replace(s.origin, ``),
                  publicHref: i,
                  pathname: D(s.pathname).path,
                  external: !!this.rewrite && s.origin !== this.origin,
                  searchStr: l,
                  search: te(t?.search, c),
                  hash: D(s.hash.slice(1)).path,
                  state: ne(t?.state, a),
                }
              );
            },
            r = n(e),
            { __tempLocation: i, __tempKey: a } = r.state;
          if (i && (!a || a === this.tempLocationKey)) {
            let e = n(i);
            return (
              (e.state.key = r.state.key),
              (e.state.__TSR_key = r.state.__TSR_key),
              delete e.state.__tempLocation,
              { ...e, maskedLocation: r }
            );
          }
          return r;
        }),
        (this.resolvePathWithBase = (e, t) =>
          qe({
            base: e,
            to: Ve(t),
            trailingSlash: this.options.trailingSlash,
            cache: this.resolvePathCache,
          })),
        (this.matchRoutes = (e, t, n) =>
          typeof e == `string`
            ? this.matchRoutesInternal({ pathname: e, search: t }, n)
            : this.matchRoutesInternal(e, t)),
        (this.getMatchedRoutes = (e) =>
          fn({ pathname: e, routesById: this.routesById, processedTree: this.processedTree })),
        (this.cancelMatch = (e) => {
          let t = this.getMatch(e);
          t &&
            (t.abortController.abort(),
            clearTimeout(t._nonReactive.pendingTimeout),
            (t._nonReactive.pendingTimeout = void 0));
        }),
        (this.cancelMatches = () => {
          (this.stores.pendingIds.get().forEach((e) => {
            this.cancelMatch(e);
          }),
            this.stores.matchesId.get().forEach((e) => {
              if (this.stores.pendingMatchStores.has(e)) return;
              let t = this.stores.matchStores.get(e)?.get();
              t && (t.status === `pending` || t.isFetching === `loader`) && this.cancelMatch(e);
            }));
        }),
        (this.buildLocation = (e) => {
          let t = (t = {}) => {
              let n = t._fromLocation || this.pendingBuiltLocation || this.latestLocation,
                r = this.matchRoutesLightweight(n);
              t.from;
              let i = t.unsafeRelative === `path` ? n.pathname : (t.from ?? r.fullPath),
                a = this.resolvePathWithBase(i, `.`),
                o = r.search,
                s = Object.assign(Object.create(null), r.params),
                c = t.to
                  ? this.resolvePathWithBase(a, `${t.to}`)
                  : this.resolvePathWithBase(a, `.`),
                l =
                  t.params === !1 || t.params === null
                    ? Object.create(null)
                    : (t.params ?? !0) === !0
                      ? s
                      : Object.assign(s, x(t.params, s)),
                u = this.getMatchedRoutes(c),
                d = u.matchedRoutes;
              if (
                ((!u.foundRoute || (u.foundRoute.path !== `/` && u.routeParams[`**`])) &&
                  this.options.notFoundRoute &&
                  (d = [...d, this.options.notFoundRoute]),
                Object.keys(l).length > 0)
              )
                for (let e of d) {
                  let t = e.options.params?.stringify ?? e.options.stringifyParams;
                  if (t)
                    try {
                      Object.assign(l, t(l));
                    } catch {}
                }
              let f = e.leaveParams
                  ? c
                  : D(
                      Xe({
                        path: c,
                        params: l,
                        decoder: this.pathParamsDecoder,
                        server: this.isServer,
                      }).interpolatedPath,
                    ).path,
                p = o;
              if (e._includeValidateSearch && this.options.search?.strict) {
                let e = {};
                (d.forEach((t) => {
                  if (t.options.validateSearch)
                    try {
                      Object.assign(e, dn(t.options.validateSearch, { ...e, ...p }));
                    } catch {}
                }),
                  (p = e));
              }
              ((p = pn({
                search: p,
                dest: t,
                destRoutes: d,
                _includeValidateSearch: e._includeValidateSearch,
              })),
                (p = te(o, p)));
              let m = this.options.stringifySearch(p),
                h = t.hash === !0 ? n.hash : t.hash ? x(t.hash, n.hash) : void 0,
                g = h ? `#${h}` : ``,
                _ = t.state === !0 ? n.state : t.state ? x(t.state, n.state) : {};
              _ = ne(n.state, _);
              let v = `${f}${m}${g}`,
                y,
                b,
                S = !1;
              if (this.rewrite) {
                let e = new URL(v, this.origin),
                  t = Ct(this.rewrite, e);
                ((y = e.href.replace(e.origin, ``)),
                  t.origin === this.origin
                    ? (b = t.pathname + t.search + t.hash)
                    : ((b = t.href), (S = !0)));
              } else ((y = O(v)), (b = y));
              return {
                publicHref: b,
                href: y,
                pathname: f,
                search: p,
                searchStr: m,
                state: _,
                hash: h ?? ``,
                external: S,
                unmaskOnReload: t.unmaskOnReload,
              };
            },
            n = (n = {}, r) => {
              let i = t(n),
                a = r ? t(r) : void 0;
              if (!a) {
                let n = Object.create(null);
                if (this.options.routeMasks) {
                  let o = Oe(i.pathname, this.processedTree);
                  if (o) {
                    Object.assign(n, o.rawParams);
                    let { from: i, params: s, ...c } = o.route,
                      l =
                        s === !1 || s === null
                          ? Object.create(null)
                          : (s ?? !0) === !0
                            ? n
                            : Object.assign(n, x(s, n));
                    ((r = { from: e.from, ...c, params: l }), (a = t(r)));
                  }
                }
              }
              return (a && (i.maskedLocation = a), i);
            };
          return e.mask ? n(e, { from: e.from, ...e.mask }) : n(e);
        }),
        (this.commitLocation = async ({ viewTransition: e, ignoreBlocker: t, ...n }) => {
          let r = () => {
              let e = [`key`, `__TSR_key`, `__TSR_index`, `__hashScrollIntoViewOptions`];
              e.forEach((e) => {
                n.state[e] = this.latestLocation.state[e];
              });
              let t = se(n.state, this.latestLocation.state);
              return (
                e.forEach((e) => {
                  delete n.state[e];
                }),
                t
              );
            },
            i = Ue(this.latestLocation.href) === Ue(n.href),
            a = this.commitLocationPromise;
          if (
            ((this.commitLocationPromise = ce(() => {
              (a?.resolve(), (a = void 0));
            })),
            i && r())
          )
            this.load();
          else {
            let { maskedLocation: r, hashScrollIntoView: i, ...a } = n;
            (r &&
              ((a = {
                ...r,
                state: {
                  ...r.state,
                  __tempKey: void 0,
                  __tempLocation: {
                    ...a,
                    search: a.searchStr,
                    state: {
                      ...a.state,
                      __tempKey: void 0,
                      __tempLocation: void 0,
                      __TSR_key: void 0,
                      key: void 0,
                    },
                  },
                },
              }),
              (a.unmaskOnReload ?? this.options.unmaskOnReload ?? !1) &&
                (a.state.__tempKey = this.tempLocationKey)),
              (a.state.__hashScrollIntoViewOptions =
                i ?? this.options.defaultHashScrollIntoView ?? !0),
              (this.shouldViewTransition = e),
              this.history[n.replace ? `replace` : `push`](a.publicHref, a.state, {
                ignoreBlocker: t,
              }));
          }
          return (
            (this.resetNextScroll = n.resetScroll ?? !0),
            this.history.subscribers.size || this.load(),
            this.commitLocationPromise
          );
        }),
        (this.buildAndCommitLocation = ({
          replace: e,
          resetScroll: t,
          hashScrollIntoView: n,
          viewTransition: r,
          ignoreBlocker: i,
          href: a,
          ...o
        } = {}) => {
          if (a) {
            let t = this.history.location.state.__TSR_index,
              n = nn(a, { __TSR_index: e ? t : t + 1 }),
              r = new URL(n.pathname, this.origin);
            ((o.to = St(this.rewrite, r).pathname),
              (o.search = this.options.parseSearch(n.search)),
              (o.hash = n.hash.slice(1)));
          }
          let s = this.buildLocation({ ...o, _includeValidateSearch: !0 });
          this.pendingBuiltLocation = s;
          let c = this.commitLocation({
            ...s,
            viewTransition: r,
            replace: e,
            resetScroll: t,
            hashScrollIntoView: n,
            ignoreBlocker: i,
          });
          return (
            Promise.resolve().then(() => {
              this.pendingBuiltLocation === s && (this.pendingBuiltLocation = void 0);
            }),
            c
          );
        }),
        (this.navigate = async ({ to: e, reloadDocument: t, href: n, publicHref: r, ...i }) => {
          let a = !1;
          if (n)
            try {
              (new URL(`${n}`), (a = !0));
            } catch {}
          if ((a && !t && (t = !0), t)) {
            if (e !== void 0 || !n) {
              let t = this.buildLocation({ to: e, ...i });
              ((n ??= t.publicHref), (r ??= t.publicHref));
            }
            let t = !a && r ? r : n;
            if (fe(t, this.protocolAllowlist)) return Promise.resolve();
            if (!i.ignoreBlocker) {
              let e = this.history.getBlockers?.() ?? [];
              for (let t of e)
                if (
                  t?.blockerFn &&
                  (await t.blockerFn({
                    currentLocation: this.latestLocation,
                    nextLocation: this.latestLocation,
                    action: `PUSH`,
                  }))
                )
                  return Promise.resolve();
            }
            return (
              i.replace ? window.location.replace(t) : (window.location.href = t), Promise.resolve()
            );
          }
          return this.buildAndCommitLocation({ ...i, href: n, to: e, _isNavigate: !0 });
        }),
        (this.beforeLoad = () => {
          (this.cancelMatches(), this.updateLatestLocation());
          let e = this.matchRoutes(this.latestLocation),
            t = this.stores.cachedMatches.get().filter((t) => !e.some((e) => e.id === t.id));
          this.batch(() => {
            (this.stores.status.set(`pending`),
              this.stores.statusCode.set(200),
              this.stores.isLoading.set(!0),
              this.stores.location.set(this.latestLocation),
              this.stores.setPending(e),
              this.stores.setCached(t));
          });
        }),
        (this.load = async (e) => {
          let t,
            n,
            r,
            i = this.stores.resolvedLocation.get() ?? this.stores.location.get();
          for (
            r = new Promise((a) => {
              this.startTransition(async () => {
                try {
                  this.beforeLoad();
                  let t = this.latestLocation,
                    n = on(t, this.stores.resolvedLocation.get());
                  (this.stores.redirect.get() || this.emit({ type: `onBeforeNavigate`, ...n }),
                    this.emit({ type: `onBeforeLoad`, ...n }),
                    await Wt({
                      router: this,
                      sync: e?.sync,
                      forceStaleReload: i.href === t.href,
                      matches: this.stores.pendingMatches.get(),
                      location: t,
                      updateMatch: this.updateMatch,
                      onReady: async () => {
                        this.startTransition(() => {
                          this.startViewTransition(async () => {
                            let e = null,
                              t = null,
                              n = null,
                              r = null;
                            this.batch(() => {
                              let i = this.stores.pendingMatches.get(),
                                a = i.length,
                                o = this.stores.matches.get();
                              e = a
                                ? o.filter((e) => !this.stores.pendingMatchStores.has(e.id))
                                : null;
                              let s = new Set();
                              for (let e of this.stores.pendingMatchStores.values())
                                e.routeId && s.add(e.routeId);
                              let c = new Set();
                              for (let e of this.stores.matchStores.values())
                                e.routeId && c.add(e.routeId);
                              ((t = a ? o.filter((e) => !s.has(e.routeId)) : null),
                                (n = a ? i.filter((e) => !c.has(e.routeId)) : null),
                                (r = a ? i.filter((e) => c.has(e.routeId)) : o),
                                this.stores.isLoading.set(!1),
                                this.stores.loadedAt.set(Date.now()),
                                a &&
                                  (this.stores.setMatches(i),
                                  this.stores.setPending([]),
                                  this.stores.setCached([
                                    ...this.stores.cachedMatches.get(),
                                    ...e.filter(
                                      (e) =>
                                        e.status !== `error` &&
                                        e.status !== `notFound` &&
                                        e.status !== `redirected`,
                                    ),
                                  ]),
                                  this.clearExpiredCache()));
                            });
                            for (let [e, i] of [
                              [t, `onLeave`],
                              [n, `onEnter`],
                              [r, `onStay`],
                            ])
                              if (e)
                                for (let t of e) this.looseRoutesById[t.routeId].options[i]?.(t);
                          });
                        });
                      },
                    }));
                } catch (e) {
                  vt(e)
                    ? ((t = e), this.navigate({ ...t.options, replace: !0, ignoreBlocker: !0 }))
                    : Qe(e) && (n = e);
                  let r = t
                    ? t.status
                    : n
                      ? 404
                      : this.stores.matches.get().some((e) => e.status === `error`)
                        ? 500
                        : 200;
                  this.batch(() => {
                    (this.stores.statusCode.set(r), this.stores.redirect.set(t));
                  });
                }
                (this.latestLoadPromise === r &&
                  (this.commitLocationPromise?.resolve(),
                  (this.latestLoadPromise = void 0),
                  (this.commitLocationPromise = void 0)),
                  a());
              });
            }),
              this.latestLoadPromise = r,
              await r;
            this.latestLoadPromise && r !== this.latestLoadPromise;
          )
            await this.latestLoadPromise;
          let a;
          (this.hasNotFoundMatch()
            ? (a = 404)
            : this.stores.matches.get().some((e) => e.status === `error`) && (a = 500),
            a !== void 0 && this.stores.statusCode.set(a));
        }),
        (this.startViewTransition = (e) => {
          let t = this.shouldViewTransition ?? this.options.defaultViewTransition;
          if (
            ((this.shouldViewTransition = void 0),
            t &&
              typeof document < `u` &&
              `startViewTransition` in document &&
              typeof document.startViewTransition == `function`)
          ) {
            let n;
            if (typeof t == `object` && this.isViewTransitionTypesSupported) {
              let r = this.latestLocation,
                i = this.stores.resolvedLocation.get(),
                a = typeof t.types == `function` ? t.types(on(r, i)) : t.types;
              if (a === !1) {
                e();
                return;
              }
              n = { update: e, types: a };
            } else n = e;
            document.startViewTransition(n);
          } else e();
        }),
        (this.updateMatch = (e, t) => {
          this.startTransition(() => {
            let n = this.stores.pendingMatchStores.get(e);
            if (n) {
              n.set(t);
              return;
            }
            let r = this.stores.matchStores.get(e);
            if (r) {
              r.set(t);
              return;
            }
            let i = this.stores.cachedMatchStores.get(e);
            if (i) {
              let n = t(i.get());
              n.status === `redirected`
                ? this.stores.cachedMatchStores.delete(e) &&
                  this.stores.cachedIds.set((t) => t.filter((t) => t !== e))
                : i.set(n);
            }
          });
        }),
        (this.getMatch = (e) =>
          this.stores.cachedMatchStores.get(e)?.get() ??
          this.stores.pendingMatchStores.get(e)?.get() ??
          this.stores.matchStores.get(e)?.get()),
        (this.invalidate = (e) => {
          let t = (t) =>
            (e?.filter?.(t) ?? !0)
              ? {
                  ...t,
                  invalid: !0,
                  ...(e?.forcePending || t.status === `error` || t.status === `notFound`
                    ? { status: `pending`, error: void 0 }
                    : void 0),
                }
              : t;
          return (
            this.batch(() => {
              (this.stores.setMatches(this.stores.matches.get().map(t)),
                this.stores.setCached(this.stores.cachedMatches.get().map(t)),
                this.stores.setPending(this.stores.pendingMatches.get().map(t)));
            }),
            (this.shouldViewTransition = !1),
            this.load({ sync: e?.sync })
          );
        }),
        (this.getParsedLocationHref = (e) => e.publicHref || `/`),
        (this.resolveRedirect = (e) => {
          let t = e.headers.get(`Location`);
          if (!e.options.href || e.options._builtLocation) {
            let t = e.options._builtLocation ?? this.buildLocation(e.options),
              n = this.getParsedLocationHref(t);
            ((e.options.href = n), e.headers.set(`Location`, n));
          } else if (t)
            try {
              let n = new URL(t);
              if (this.origin && n.origin === this.origin) {
                let t = n.pathname + n.search + n.hash;
                ((e.options.href = t), e.headers.set(`Location`, t));
              }
            } catch {}
          if (
            e.options.href &&
            !e.options._builtLocation &&
            fe(e.options.href, this.protocolAllowlist)
          )
            throw Error(`Redirect blocked: unsafe protocol`);
          return (e.headers.get(`Location`) || e.headers.set(`Location`, e.options.href), e);
        }),
        (this.clearCache = (e) => {
          let t = e?.filter;
          t === void 0
            ? this.stores.setCached([])
            : this.stores.setCached(this.stores.cachedMatches.get().filter((e) => !t(e)));
        }),
        (this.clearExpiredCache = () => {
          let e = Date.now();
          this.clearCache({
            filter: (t) => {
              let n = this.looseRoutesById[t.routeId];
              if (!n.options.loader) return !0;
              let r =
                (t.preload
                  ? (n.options.preloadGcTime ?? this.options.defaultPreloadGcTime)
                  : (n.options.gcTime ?? this.options.defaultGcTime)) ?? 300 * 1e3;
              return t.status === `error` ? !0 : e - t.updatedAt >= r;
            },
          });
        }),
        (this.loadRouteChunk = Kt),
        (this.preloadRoute = async (e) => {
          let t = e._builtLocation ?? this.buildLocation(e),
            n = this.matchRoutes(t, { throwOnError: !0, preload: !0, dest: e }),
            r = new Set([...this.stores.matchesId.get(), ...this.stores.pendingIds.get()]),
            i = new Set([...r, ...this.stores.cachedIds.get()]),
            a = n.filter((e) => !i.has(e.id));
          if (a.length) {
            let e = this.stores.cachedMatches.get();
            this.stores.setCached([...e, ...a]);
          }
          try {
            return (
              (n = await Wt({
                router: this,
                matches: n,
                location: t,
                preload: !0,
                updateMatch: (e, t) => {
                  r.has(e) ? (n = n.map((n) => (n.id === e ? t(n) : n))) : this.updateMatch(e, t);
                },
              })),
              n
            );
          } catch (e) {
            if (vt(e))
              return e.options.reloadDocument
                ? void 0
                : await this.preloadRoute({ ...e.options, _fromLocation: t });
            Qe(e) || console.error(e);
            return;
          }
        }),
        (this.matchRoute = (e, t) => {
          let n = {
              ...e,
              to: e.to ? this.resolvePathWithBase(e.from || ``, e.to) : void 0,
              params: e.params || {},
              leaveParams: !0,
            },
            r = this.buildLocation(n);
          if (t?.pending && this.stores.status.get() !== `pending`) return !1;
          let i = (t?.pending === void 0 ? !this.stores.isLoading.get() : t.pending)
              ? this.latestLocation
              : this.stores.resolvedLocation.get() || this.stores.location.get(),
            a = ke(
              r.pathname,
              t?.caseSensitive ?? !1,
              t?.fuzzy ?? !1,
              i.pathname,
              this.processedTree,
            );
          return !a || (e.params && !se(a.rawParams, e.params, { partial: !0 }))
            ? !1
            : (t?.includeSearch ?? !0)
              ? se(i.search, r.search, { partial: !0 })
                ? a.rawParams
                : !1
              : a.rawParams;
        }),
        (this.hasNotFoundMatch = () =>
          this.stores.matches.get().some((e) => e.status === `notFound` || e.globalNotFound)),
        (this.getStoreConfig = t),
        this.update({
          defaultPreloadDelay: 50,
          defaultPendingMs: 1e3,
          defaultPendingMinMs: 500,
          context: void 0,
          ...e,
          caseSensitive: e.caseSensitive ?? !1,
          notFoundMode: e.notFoundMode ?? `fuzzy`,
          stringifySearch: e.stringifySearch ?? pt,
          parseSearch: e.parseSearch ?? ft,
          protocolAllowlist: e.protocolAllowlist ?? E,
        }),
        typeof document < `u` && (self.__TSR_ROUTER__ = this));
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
    setRoutes({ routesById: e, routesByPath: t, processedTree: n }) {
      ((this.routesById = e), (this.routesByPath = t), (this.processedTree = n));
      let r = this.options.notFoundRoute;
      r && (r.init({ originalIndex: 99999999999 }), (this.routesById[r.id] = r));
    }
    get looseRoutesById() {
      return this.routesById;
    }
    getParentContext(e) {
      return e?.id
        ? (e.context ?? this.options.context ?? void 0)
        : (this.options.context ?? void 0);
    }
    matchRoutesInternal(e, t) {
      let n = this.getMatchedRoutes(e.pathname),
        { foundRoute: r, routeParams: i, parsedParams: a } = n,
        { matchedRoutes: o } = n,
        s = !1;
      (r ? r.path !== `/` && i[`**`] : Ue(e.pathname)) &&
        (this.options.notFoundRoute ? (o = [...o, this.options.notFoundRoute]) : (s = !0));
      let c = s ? hn(this.options.notFoundMode, o) : void 0,
        l = Array(o.length),
        u = new Map();
      for (let e of this.stores.matchStores.values()) e.routeId && u.set(e.routeId, e.get());
      for (let n = 0; n < o.length; n++) {
        let r = o[n],
          s = l[n - 1],
          d,
          f,
          p;
        {
          let n = s?.search ?? e.search,
            i = s?._strictSearch ?? void 0;
          try {
            let e = dn(r.options.validateSearch, { ...n }) ?? void 0;
            ((d = { ...n, ...e }), (f = { ...i, ...e }), (p = void 0));
          } catch (e) {
            let r = e;
            if ((e instanceof cn || (r = new cn(e.message, { cause: e })), t?.throwOnError))
              throw r;
            ((d = n), (f = {}), (p = r));
          }
        }
        let m = r.options.loaderDeps?.({ search: d }) ?? ``,
          h = m ? JSON.stringify(m) : ``,
          { interpolatedPath: g, usedParams: _ } = Xe({
            path: r.fullPath,
            params: i,
            decoder: this.pathParamsDecoder,
            server: this.isServer,
          }),
          v = r.id + g + h,
          y = this.getMatch(v),
          b = u.get(r.id),
          x = y?._strictParams ?? _,
          S;
        if (!y)
          try {
            gn(r, _, a, x);
          } catch (e) {
            if (((S = Qe(e) || vt(e) ? e : new ln(e.message, { cause: e })), t?.throwOnError))
              throw S;
          }
        Object.assign(i, x);
        let C = b ? `stay` : `enter`,
          ee;
        if (y)
          ee = {
            ...y,
            cause: C,
            params: b?.params ?? i,
            _strictParams: x,
            search: te(b ? b.search : y.search, d),
            _strictSearch: f,
          };
        else {
          let e =
            r.options.loader || r.options.beforeLoad || r.lazyFn || qt(r) ? `pending` : `success`;
          ee = {
            id: v,
            ssr: r.options.ssr,
            index: n,
            routeId: r.id,
            params: b?.params ?? i,
            _strictParams: x,
            pathname: g,
            updatedAt: Date.now(),
            search: b ? te(b.search, d) : d,
            _strictSearch: f,
            searchError: void 0,
            status: e,
            isFetching: !1,
            error: void 0,
            paramsError: S,
            __routeContext: void 0,
            _nonReactive: { loadPromise: ce() },
            __beforeLoadContext: void 0,
            context: {},
            abortController: new AbortController(),
            fetchCount: 0,
            cause: C,
            loaderDeps: b ? ne(b.loaderDeps, m) : m,
            invalid: !1,
            preload: !1,
            links: void 0,
            scripts: void 0,
            headScripts: void 0,
            meta: void 0,
            staticData: r.options.staticData || {},
            fullPath: r.fullPath,
          };
        }
        (t?.preload || (ee.globalNotFound = c === r.id), (ee.searchError = p));
        let re = this.getParentContext(s);
        ((ee.context = { ...re, ...ee.__routeContext, ...ee.__beforeLoadContext }), (l[n] = ee));
      }
      for (let t = 0; t < l.length; t++) {
        let n = l[t],
          r = this.looseRoutesById[n.routeId],
          a = this.getMatch(n.id),
          o = u.get(n.routeId);
        if (((n.params = o ? te(o.params, i) : i), !a)) {
          let i = l[t - 1],
            a = this.getParentContext(i);
          if (r.options.context) {
            let t = {
              deps: n.loaderDeps,
              params: n.params,
              context: a ?? {},
              location: e,
              navigate: (t) => this.navigate({ ...t, _fromLocation: e }),
              buildLocation: this.buildLocation,
              cause: n.cause,
              abortController: n.abortController,
              preload: !!n.preload,
              matches: l,
              routeId: r.id,
            };
            n.__routeContext = r.options.context(t) ?? void 0;
          }
          n.context = { ...a, ...n.__routeContext, ...n.__beforeLoadContext };
        }
      }
      return l;
    }
    matchRoutesLightweight(e) {
      let { matchedRoutes: t, routeParams: n, parsedParams: r } = this.getMatchedRoutes(e.pathname),
        i = y(t),
        a = { ...e.search };
      for (let e of t)
        try {
          Object.assign(a, dn(e.options.validateSearch, a));
        } catch {}
      let o = y(this.stores.matchesId.get()),
        s = o && this.stores.matchStores.get(o)?.get(),
        c = s && s.routeId === i.id && s.pathname === e.pathname,
        l;
      if (c) l = s.params;
      else {
        let e = Object.assign(Object.create(null), n);
        for (let i of t)
          try {
            gn(i, n, r ?? {}, e);
          } catch {}
        l = e;
      }
      return { matchedRoutes: t, fullPath: i.fullPath, search: a, params: l };
    }
  },
  cn = class extends Error {},
  ln = class extends Error {};
function un(e) {
  return {
    loadedAt: 0,
    isLoading: !1,
    isTransitioning: !1,
    status: `idle`,
    resolvedLocation: void 0,
    location: e,
    matches: [],
    statusCode: 200,
  };
}
function dn(e, t) {
  if (e == null) return {};
  if (`~standard` in e) {
    let n = e[`~standard`].validate(t);
    if (n instanceof Promise) throw new cn(`Async validation not supported`);
    if (n.issues) throw new cn(JSON.stringify(n.issues, void 0, 2), { cause: n });
    return n.value;
  }
  return `parse` in e ? e.parse(t) : typeof e == `function` ? e(t) : {};
}
function fn({ pathname: e, routesById: t, processedTree: n }) {
  let r = Object.create(null),
    i = Ue(e),
    a,
    o,
    s = Ae(i, n, !0);
  return (
    s &&
      ((a = s.route),
      Object.assign(r, s.rawParams),
      (o = Object.assign(Object.create(null), s.parsedParams))),
    { matchedRoutes: s?.branch || [t.__root__], routeParams: r, foundRoute: a, parsedParams: o }
  );
}
function pn({ search: e, dest: t, destRoutes: n, _includeValidateSearch: r }) {
  return mn(n)(e, t, r ?? !1);
}
function mn(e) {
  let t = { dest: null, _includeValidateSearch: !1, middlewares: [] };
  for (let n of e)
    (`search` in n.options
      ? n.options.search?.middlewares && t.middlewares.push(...n.options.search.middlewares)
      : (n.options.preSearchFilters || n.options.postSearchFilters) &&
        t.middlewares.push(({ search: e, next: t }) => {
          let r = e;
          `preSearchFilters` in n.options &&
            n.options.preSearchFilters &&
            (r = n.options.preSearchFilters.reduce((e, t) => t(e), e));
          let i = t(r);
          return `postSearchFilters` in n.options && n.options.postSearchFilters
            ? n.options.postSearchFilters.reduce((e, t) => t(e), i)
            : i;
        }),
      n.options.validateSearch &&
        t.middlewares.push(({ search: e, next: r }) => {
          let i = r(e);
          if (!t._includeValidateSearch) return i;
          try {
            return { ...i, ...(dn(n.options.validateSearch, i) ?? void 0) };
          } catch {
            return i;
          }
        }));
  t.middlewares.push(({ search: e }) => {
    let n = t.dest;
    return n.search ? (n.search === !0 ? e : x(n.search, e)) : {};
  });
  let n = (e, t, r) => {
    if (e >= r.length) return t;
    let i = r[e];
    return i({ search: t, next: (t) => n(e + 1, t, r) });
  };
  return function (e, r, i) {
    return ((t.dest = r), (t._includeValidateSearch = i), n(0, e, t.middlewares));
  };
}
function hn(e, t) {
  if (e !== `root`)
    for (let e = t.length - 1; e >= 0; e--) {
      let n = t[e];
      if (n.children) return n.id;
    }
  return gt;
}
function gn(e, t, n, r) {
  let i = e.options.params?.parse ?? e.options.parseParams;
  if (i)
    if (e.options.skipRouteOnParseError) for (let e in t) e in n && (r[e] = n[e]);
    else {
      let e = i(r);
      Object.assign(r, e);
    }
}
var _n = Symbol.for(`TSR_DEFERRED_PROMISE`);
function vn(e, t) {
  let n = e;
  return n[_n]
    ? n
    : ((n[_n] = { status: `pending` }),
      n
        .then((e) => {
          ((n[_n].status = `success`), (n[_n].data = e));
        })
        .catch((e) => {
          ((n[_n].status = `error`),
            (n[_n].error = { data: (t?.serializeError ?? an)(e), __isServerError: !0 }));
        }),
      n);
}
var yn = `Error preloading route! ☝️`;
function bn(e, t) {
  if (e) return typeof e == `string` ? e : e[t];
}
function xn(e) {
  return typeof e == `string` ? { href: e, crossOrigin: void 0 } : e;
}
var Sn = class {
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
    constructor(e) {
      if (
        ((this.init = (e) => {
          this.originalIndex = e.originalIndex;
          let t = this.options,
            n = !t?.path && !t?.id;
          ((this.parentRoute = this.options.getParentRoute?.()),
            n ? (this._path = gt) : this.parentRoute || ge());
          let r = n ? gt : t?.path;
          r && r !== `/` && (r = He(r));
          let i = t?.id || r,
            a = n ? gt : Be([this.parentRoute.id === `__root__` ? `` : this.parentRoute.id, i]);
          (r === `__root__` && (r = `/`), a !== `__root__` && (a = Be([`/`, a])));
          let o = a === `__root__` ? `/` : Be([this.parentRoute.fullPath, r]);
          ((this._path = r), (this._id = a), (this._fullPath = o), (this._to = Ue(o)));
        }),
        (this.addChildren = (e) => this._addFileChildren(e)),
        (this._addFileChildren = (e) => (
          Array.isArray(e) && (this.children = e),
          typeof e == `object` && e && (this.children = Object.values(e)),
          this
        )),
        (this._addFileTypes = () => this),
        (this.updateLoader = (e) => (Object.assign(this.options, e), this)),
        (this.update = (e) => (Object.assign(this.options, e), this)),
        (this.lazy = (e) => ((this.lazyFn = e), this)),
        (this.redirect = (e) => _t({ from: this.fullPath, ...e })),
        (this.options = e || {}),
        (this.isRoot = !e?.getParentRoute),
        e?.id && e?.path)
      )
        throw Error(`Route cannot have both an 'id' and a 'path' option.`);
    }
  },
  Cn = class extends Sn {
    constructor(e) {
      super(e);
    }
  };
function wn(e) {
  if (typeof document < `u` && document.querySelector) {
    let t = e.stores.location.get(),
      n = t.state.__hashScrollIntoViewOptions ?? !0;
    if (n && t.hash !== ``) {
      let e = document.getElementById(t.hash);
      e && e.scrollIntoView(n);
    }
  }
}
var Tn = ((e) => (
    (e[(e.AggregateError = 1)] = `AggregateError`),
    (e[(e.ArrowFunction = 2)] = `ArrowFunction`),
    (e[(e.ErrorPrototypeStack = 4)] = `ErrorPrototypeStack`),
    (e[(e.ObjectAssign = 8)] = `ObjectAssign`),
    (e[(e.BigIntTypedArray = 16)] = `BigIntTypedArray`),
    (e[(e.RegExp = 32)] = `RegExp`),
    e
  ))(Tn || {}),
  En = Symbol.asyncIterator,
  Dn = Symbol.hasInstance,
  On = Symbol.isConcatSpreadable,
  A = Symbol.iterator,
  kn = Symbol.match,
  An = Symbol.matchAll,
  jn = Symbol.replace,
  Mn = Symbol.search,
  Nn = Symbol.species,
  Pn = Symbol.split,
  Fn = Symbol.toPrimitive,
  In = Symbol.toStringTag,
  Ln = Symbol.unscopables,
  Rn = {
    [En]: 0,
    [Dn]: 1,
    [On]: 2,
    [A]: 3,
    [kn]: 4,
    [An]: 5,
    [jn]: 6,
    [Mn]: 7,
    [Nn]: 8,
    [Pn]: 9,
    [Fn]: 10,
    [In]: 11,
    [Ln]: 12,
  },
  zn = {
    0: En,
    1: Dn,
    2: On,
    3: A,
    4: kn,
    5: An,
    6: jn,
    7: Mn,
    8: Nn,
    9: Pn,
    10: Fn,
    11: In,
    12: Ln,
  },
  j = void 0,
  Bn = { 2: !0, 3: !1, 1: j, 0: null, 4: -0, 5: 1 / 0, 6: -1 / 0, 7: NaN },
  Vn = {
    0: `Error`,
    1: `EvalError`,
    2: `RangeError`,
    3: `ReferenceError`,
    4: `SyntaxError`,
    5: `TypeError`,
    6: `URIError`,
  },
  Hn = {
    0: Error,
    1: EvalError,
    2: RangeError,
    3: ReferenceError,
    4: SyntaxError,
    5: TypeError,
    6: URIError,
  };
function M(e, t, n, r, i, a, o, s, c, l, u, d) {
  return { t: e, i: t, s: n, c: r, m: i, p: a, e: o, a: s, f: c, b: l, o: u, l: d };
}
function Un(e) {
  return M(2, j, e, j, j, j, j, j, j, j, j, j);
}
var Wn = Un(2),
  Gn = Un(3),
  Kn = Un(1),
  qn = Un(0),
  Jn = Un(4),
  Yn = Un(5),
  Xn = Un(6),
  Zn = Un(7);
function Qn(e) {
  switch (e) {
    case `"`:
      return `\\"`;
    case `\\`:
      return `\\\\`;
    case `
`:
      return `\\n`;
    case `\r`:
      return `\\r`;
    case `\b`:
      return `\\b`;
    case `	`:
      return `\\t`;
    case `\f`:
      return `\\f`;
    case `<`:
      return `\\x3C`;
    case `\u2028`:
      return `\\u2028`;
    case `\u2029`:
      return `\\u2029`;
    default:
      return j;
  }
}
function $n(e) {
  let t = ``,
    n = 0,
    r;
  for (let i = 0, a = e.length; i < a; i++)
    ((r = Qn(e[i])), r && ((t += e.slice(n, i) + r), (n = i + 1)));
  return (n === 0 ? (t = e) : (t += e.slice(n)), t);
}
function er(e) {
  switch (e) {
    case `\\\\`:
      return `\\`;
    case `\\"`:
      return `"`;
    case `\\n`:
      return `
`;
    case `\\r`:
      return `\r`;
    case `\\b`:
      return `\b`;
    case `\\t`:
      return `	`;
    case `\\f`:
      return `\f`;
    case `\\x3C`:
      return `<`;
    case `\\u2028`:
      return `\u2028`;
    case `\\u2029`:
      return `\u2029`;
    default:
      return e;
  }
}
function tr(e) {
  return e.replace(/(\\\\|\\"|\\n|\\r|\\b|\\t|\\f|\\u2028|\\u2029|\\x3C)/g, er);
}
var nr = `__SEROVAL_REFS__`,
  rr = new Map(),
  ir = new Map();
function ar(e) {
  return rr.has(e);
}
function or(e) {
  return ir.has(e);
}
function sr(e) {
  if (ar(e)) return rr.get(e);
  throw new Yr(e);
}
function cr(e) {
  if (or(e)) return ir.get(e);
  throw new Xr(e);
}
typeof globalThis < `u`
  ? Object.defineProperty(globalThis, nr, {
      value: ir,
      configurable: !0,
      writable: !1,
      enumerable: !1,
    })
  : typeof window < `u`
    ? Object.defineProperty(window, nr, {
        value: ir,
        configurable: !0,
        writable: !1,
        enumerable: !1,
      })
    : typeof self < `u`
      ? Object.defineProperty(self, nr, {
          value: ir,
          configurable: !0,
          writable: !1,
          enumerable: !1,
        })
      : typeof global < `u` &&
        Object.defineProperty(global, nr, {
          value: ir,
          configurable: !0,
          writable: !1,
          enumerable: !1,
        });
function lr(e) {
  return e instanceof EvalError
    ? 1
    : e instanceof RangeError
      ? 2
      : e instanceof ReferenceError
        ? 3
        : e instanceof SyntaxError
          ? 4
          : e instanceof TypeError
            ? 5
            : e instanceof URIError
              ? 6
              : 0;
}
function ur(e) {
  let t = Vn[lr(e)];
  return e.name === t
    ? e.constructor.name === t
      ? {}
      : { name: e.constructor.name }
    : { name: e.name };
}
function dr(e, t) {
  let n = ur(e),
    r = Object.getOwnPropertyNames(e);
  for (let i = 0, a = r.length, o; i < a; i++)
    ((o = r[i]),
      o !== `name` &&
        o !== `message` &&
        (o === `stack` ? t & 4 && ((n ||= {}), (n[o] = e[o])) : ((n ||= {}), (n[o] = e[o]))));
  return n;
}
function fr(e) {
  return Object.isFrozen(e) ? 3 : Object.isSealed(e) ? 2 : +!Object.isExtensible(e);
}
function pr(e) {
  switch (e) {
    case 1 / 0:
      return Yn;
    case -1 / 0:
      return Xn;
  }
  return e === e ? (Object.is(e, -0) ? Jn : M(0, j, e, j, j, j, j, j, j, j, j, j)) : Zn;
}
function mr(e) {
  return M(1, j, $n(e), j, j, j, j, j, j, j, j, j);
}
function hr(e) {
  return M(3, j, `` + e, j, j, j, j, j, j, j, j, j);
}
function gr(e) {
  return M(4, e, j, j, j, j, j, j, j, j, j, j);
}
function _r(e, t) {
  let n = t.valueOf();
  return M(5, e, n === n ? t.toISOString() : ``, j, j, j, j, j, j, j, j, j);
}
function vr(e, t) {
  return M(6, e, j, $n(t.source), t.flags, j, j, j, j, j, j, j);
}
function yr(e, t) {
  return M(17, e, Rn[t], j, j, j, j, j, j, j, j, j);
}
function br(e, t) {
  return M(18, e, $n(sr(t)), j, j, j, j, j, j, j, j, j);
}
function xr(e, t, n) {
  return M(25, e, n, $n(t), j, j, j, j, j, j, j, j);
}
function Sr(e, t, n) {
  return M(9, e, j, j, j, j, j, n, j, j, fr(t), j);
}
function Cr(e, t) {
  return M(21, e, j, j, j, j, j, j, t, j, j, j);
}
function wr(e, t, n) {
  return M(15, e, j, t.constructor.name, j, j, j, j, n, t.byteOffset, j, t.length);
}
function Tr(e, t, n) {
  return M(16, e, j, t.constructor.name, j, j, j, j, n, t.byteOffset, j, t.byteLength);
}
function Er(e, t, n) {
  return M(20, e, j, j, j, j, j, j, n, t.byteOffset, j, t.byteLength);
}
function Dr(e, t, n) {
  return M(13, e, lr(t), j, $n(t.message), n, j, j, j, j, j, j);
}
function Or(e, t, n) {
  return M(14, e, lr(t), j, $n(t.message), n, j, j, j, j, j, j);
}
function kr(e, t) {
  return M(7, e, j, j, j, j, j, t, j, j, j, j);
}
function Ar(e, t) {
  return M(28, j, j, j, j, j, j, [e, t], j, j, j, j);
}
function jr(e, t) {
  return M(30, j, j, j, j, j, j, [e, t], j, j, j, j);
}
function Mr(e, t, n) {
  return M(31, e, j, j, j, j, j, n, t, j, j, j);
}
function Nr(e, t) {
  return M(32, e, j, j, j, j, j, j, t, j, j, j);
}
function Pr(e, t) {
  return M(33, e, j, j, j, j, j, j, t, j, j, j);
}
function Fr(e, t) {
  return M(34, e, j, j, j, j, j, j, t, j, j, j);
}
function Ir(e, t, n, r) {
  return M(35, e, n, j, j, j, j, t, j, j, j, r);
}
var { toString: Lr } = Object.prototype,
  Rr = { parsing: 1, serialization: 2, deserialization: 3 };
function zr(e) {
  return `Seroval Error (step: ${Rr[e]})`;
}
var Br = (e, t) => zr(e),
  Vr = class extends Error {
    constructor(e, t) {
      (super(Br(e, t)), (this.cause = t));
    }
  },
  Hr = class extends Vr {
    constructor(e) {
      super(`parsing`, e);
    }
  },
  Ur = class extends Vr {
    constructor(e) {
      super(`deserialization`, e);
    }
  };
function Wr(e) {
  return `Seroval Error (specific: ${e})`;
}
var Gr = class extends Error {
    constructor(e) {
      (super(Wr(1)), (this.value = e));
    }
  },
  Kr = class extends Error {
    constructor(e) {
      super(Wr(2));
    }
  },
  qr = class extends Error {
    constructor(e) {
      super(Wr(3));
    }
  },
  Jr = class extends Error {
    constructor(e) {
      super(Wr(4));
    }
  },
  Yr = class extends Error {
    constructor(e) {
      (super(Wr(5)), (this.value = e));
    }
  },
  Xr = class extends Error {
    constructor(e) {
      super(Wr(6));
    }
  },
  Zr = class extends Error {
    constructor(e) {
      super(Wr(7));
    }
  },
  Qr = class extends Error {
    constructor(e) {
      super(Wr(8));
    }
  },
  $r = class extends Error {
    constructor(e) {
      super(Wr(9));
    }
  },
  ei = class {
    constructor(e, t) {
      ((this.value = e), (this.replacement = t));
    }
  },
  ti = () => {
    let e = { p: 0, s: 0, f: 0 };
    return (
      (e.p = new Promise((t, n) => {
        ((e.s = t), (e.f = n));
      })),
      e
    );
  };
(ti.toString(),
  ((e, t) => {
    (e.s(t), (e.p.s = 1), (e.p.v = t));
  }).toString(),
  ((e, t) => {
    (e.f(t), (e.p.s = 2), (e.p.v = t));
  }).toString());
var ni = () => {
  let e = [],
    t = [],
    n = !0,
    r = !1,
    i = 0,
    a = (e, n, r) => {
      for (r = 0; r < i; r++) t[r] && t[r][n](e);
    },
    o = (t, i, a, o) => {
      for (i = 0, a = e.length; i < a; i++)
        ((o = e[i]), !n && i === a - 1 ? t[r ? `return` : `throw`](o) : t.next(o));
    },
    s = (e, r) => (
      n && ((r = i++), (t[r] = e)),
      o(e),
      () => {
        n && ((t[r] = t[i]), (t[i--] = void 0));
      }
    );
  return {
    __SEROVAL_STREAM__: !0,
    on: (e) => s(e),
    next: (t) => {
      n && (e.push(t), a(t, `next`));
    },
    throw: (i) => {
      n && (e.push(i), a(i, `throw`), (n = !1), (r = !1), (t.length = 0));
    },
    return: (i) => {
      n && (e.push(i), a(i, `return`), (n = !1), (r = !0), (t.length = 0));
    },
  };
};
ni.toString();
var ri = (e) => (t) => () => {
  let n = 0,
    r = {
      [e]: () => r,
      next: () => {
        if (n > t.d) return { done: !0, value: void 0 };
        let e = n++,
          r = t.v[e];
        if (e === t.t) throw r;
        return { done: e === t.d, value: r };
      },
    };
  return r;
};
ri.toString();
var ii = (e, t) => (n) => () => {
  let r = 0,
    i = -1,
    a = !1,
    o = [],
    s = [],
    c = (e = 0, t = s.length) => {
      for (; e < t; e++) s[e].s({ done: !0, value: void 0 });
    };
  n.on({
    next: (e) => {
      let t = s.shift();
      (t && t.s({ done: !1, value: e }), o.push(e));
    },
    throw: (e) => {
      let t = s.shift();
      (t && t.f(e), c(), (i = o.length), (a = !0), o.push(e));
    },
    return: (e) => {
      let t = s.shift();
      (t && t.s({ done: !0, value: e }), c(), (i = o.length), o.push(e));
    },
  });
  let l = {
    [e]: () => l,
    next: () => {
      if (i === -1) {
        let e = r++;
        if (e >= o.length) {
          let e = t();
          return (s.push(e), e.p);
        }
        return { done: !1, value: o[e] };
      }
      if (r > i) return { done: !0, value: void 0 };
      let e = r++,
        n = o[e];
      if (e !== i) return { done: !1, value: n };
      if (a) throw n;
      return { done: !0, value: n };
    },
  };
  return l;
};
ii.toString();
var ai = (e) => {
  let t = atob(e),
    n = t.length,
    r = new Uint8Array(n);
  for (let e = 0; e < n; e++) r[e] = t.charCodeAt(e);
  return r.buffer;
};
ai.toString();
function oi(e) {
  return `__SEROVAL_SEQUENCE__` in e;
}
function si(e, t, n) {
  return { __SEROVAL_SEQUENCE__: !0, v: e, t, d: n };
}
function ci(e) {
  let t = [],
    n = -1,
    r = -1,
    i = e[A]();
  for (;;)
    try {
      let e = i.next();
      if ((t.push(e.value), e.done)) {
        r = t.length - 1;
        break;
      }
    } catch (e) {
      ((n = t.length), t.push(e));
    }
  return si(t, n, r);
}
var li = ri(A);
function ui(e) {
  return li(e);
}
var di = {},
  fi = {},
  pi = { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {} };
function mi(e) {
  return `__SEROVAL_STREAM__` in e;
}
function hi() {
  return ni();
}
function gi(e) {
  let t = hi(),
    n = e[En]();
  async function r() {
    try {
      let e = await n.next();
      e.done ? t.return(e.value) : (t.next(e.value), await r());
    } catch (e) {
      t.throw(e);
    }
  }
  return (r().catch(() => {}), t);
}
var _i = ii(En, ti);
function vi(e) {
  return _i(e);
}
async function yi(e) {
  try {
    return [1, await e];
  } catch (e) {
    return [0, e];
  }
}
function bi(e, t) {
  return {
    plugins: t.plugins,
    mode: e,
    marked: new Set(),
    features: 63 ^ (t.disabledFeatures || 0),
    refs: t.refs || new Map(),
    depthLimit: t.depthLimit || 1e3,
  };
}
function xi(e, t) {
  e.marked.add(t);
}
function Si(e, t) {
  let n = e.refs.size;
  return (e.refs.set(t, n), n);
}
function Ci(e, t) {
  let n = e.refs.get(t);
  return n == null ? { type: 0, value: Si(e, t) } : (xi(e, n), { type: 1, value: gr(n) });
}
function wi(e, t) {
  let n = Ci(e, t);
  return n.type === 1 ? n : ar(t) ? { type: 2, value: br(n.value, t) } : n;
}
function Ti(e, t) {
  let n = wi(e, t);
  if (n.type !== 0) return n.value;
  if (t in Rn) return yr(n.value, t);
  throw new Gr(t);
}
function Ei(e, t) {
  let n = Ci(e, pi[t]);
  return n.type === 1 ? n.value : M(26, n.value, t, j, j, j, j, j, j, j, j, j);
}
function Di(e) {
  let t = Ci(e, di);
  return t.type === 1 ? t.value : M(27, t.value, j, j, j, j, j, j, Ti(e, A), j, j, j);
}
function Oi(e) {
  let t = Ci(e, fi);
  return t.type === 1 ? t.value : M(29, t.value, j, j, j, j, j, [Ei(e, 1), Ti(e, En)], j, j, j, j);
}
function ki(e, t, n, r) {
  return M(n ? 11 : 10, e, j, j, j, r, j, j, j, j, fr(t), j);
}
function Ai(e, t, n, r) {
  return M(8, t, j, j, j, j, { k: n, v: r }, j, Ei(e, 0), j, j, j);
}
function ji(e, t, n) {
  let r = new Uint8Array(n),
    i = ``;
  for (let e = 0, t = r.length; e < t; e++) i += String.fromCharCode(r[e]);
  return M(19, t, $n(btoa(i)), j, j, j, j, j, Ei(e, 5), j, j, j);
}
function Mi(e, t) {
  return { base: bi(e, t), child: void 0 };
}
var Ni = class {
  constructor(e, t) {
    ((this._p = e), (this.depth = t));
  }
  parse(e) {
    return Zi(this._p, this.depth, e);
  }
};
async function Pi(e, t, n) {
  let r = [];
  for (let i = 0, a = n.length; i < a; i++) i in n ? (r[i] = await Zi(e, t, n[i])) : (r[i] = 0);
  return r;
}
async function Fi(e, t, n, r) {
  return Sr(n, r, await Pi(e, t, r));
}
async function Ii(e, t, n) {
  let r = Object.entries(n),
    i = [],
    a = [];
  for (let n = 0, o = r.length; n < o; n++) (i.push($n(r[n][0])), a.push(await Zi(e, t, r[n][1])));
  return (
    A in n && (i.push(Ti(e.base, A)), a.push(Ar(Di(e.base), await Zi(e, t, ci(n))))),
    En in n && (i.push(Ti(e.base, En)), a.push(jr(Oi(e.base), await Zi(e, t, gi(n))))),
    In in n && (i.push(Ti(e.base, In)), a.push(mr(n[In]))),
    On in n && (i.push(Ti(e.base, On)), a.push(n[On] ? Wn : Gn)),
    { k: i, v: a }
  );
}
async function Li(e, t, n, r, i) {
  return ki(n, r, i, await Ii(e, t, r));
}
async function Ri(e, t, n, r) {
  return Cr(n, await Zi(e, t, r.valueOf()));
}
async function zi(e, t, n, r) {
  return wr(n, r, await Zi(e, t, r.buffer));
}
async function Bi(e, t, n, r) {
  return Tr(n, r, await Zi(e, t, r.buffer));
}
async function N(e, t, n, r) {
  return Er(n, r, await Zi(e, t, r.buffer));
}
async function P(e, t, n, r) {
  let i = dr(r, e.base.features);
  return Dr(n, r, i ? await Ii(e, t, i) : j);
}
async function Vi(e, t, n, r) {
  let i = dr(r, e.base.features);
  return Or(n, r, i ? await Ii(e, t, i) : j);
}
async function Hi(e, t, n, r) {
  let i = [],
    a = [];
  for (let [n, o] of r.entries()) (i.push(await Zi(e, t, n)), a.push(await Zi(e, t, o)));
  return Ai(e.base, n, i, a);
}
async function Ui(e, t, n, r) {
  let i = [];
  for (let n of r.keys()) i.push(await Zi(e, t, n));
  return kr(n, i);
}
async function Wi(e, t, n, r) {
  let i = e.base.plugins;
  if (i)
    for (let a = 0, o = i.length; a < o; a++) {
      let o = i[a];
      if (o.parse.async && o.test(r))
        return xr(n, o.tag, await o.parse.async(r, new Ni(e, t), { id: n }));
    }
  return j;
}
async function Gi(e, t, n, r) {
  let [i, a] = await yi(r);
  return M(12, n, i, j, j, j, j, j, await Zi(e, t, a), j, j, j);
}
function Ki(e, t, n, r, i) {
  let a = [],
    o = n.on({
      next: (n) => {
        (xi(this.base, t),
          Zi(this, e, n).then(
            (e) => {
              a.push(Nr(t, e));
            },
            (e) => {
              (i(e), o());
            },
          ));
      },
      throw: (n) => {
        (xi(this.base, t),
          Zi(this, e, n).then(
            (e) => {
              (a.push(Pr(t, e)), r(a), o());
            },
            (e) => {
              (i(e), o());
            },
          ));
      },
      return: (n) => {
        (xi(this.base, t),
          Zi(this, e, n).then(
            (e) => {
              (a.push(Fr(t, e)), r(a), o());
            },
            (e) => {
              (i(e), o());
            },
          ));
      },
    });
}
async function qi(e, t, n, r) {
  return Mr(n, Ei(e.base, 4), await new Promise(Ki.bind(e, t, n, r)));
}
async function Ji(e, t, n, r) {
  let i = [];
  for (let n = 0, a = r.v.length; n < a; n++) i[n] = await Zi(e, t, r.v[n]);
  return Ir(n, i, r.t, r.d);
}
async function Yi(e, t, n, r) {
  if (Array.isArray(r)) return Fi(e, t, n, r);
  if (mi(r)) return qi(e, t, n, r);
  if (oi(r)) return Ji(e, t, n, r);
  let i = r.constructor;
  if (i === ei) return Zi(e, t, r.replacement);
  let a = await Wi(e, t, n, r);
  if (a) return a;
  switch (i) {
    case Object:
      return Li(e, t, n, r, !1);
    case j:
      return Li(e, t, n, r, !0);
    case Date:
      return _r(n, r);
    case Error:
    case EvalError:
    case RangeError:
    case ReferenceError:
    case SyntaxError:
    case TypeError:
    case URIError:
      return P(e, t, n, r);
    case Number:
    case Boolean:
    case String:
    case BigInt:
      return Ri(e, t, n, r);
    case ArrayBuffer:
      return ji(e.base, n, r);
    case Int8Array:
    case Int16Array:
    case Int32Array:
    case Uint8Array:
    case Uint16Array:
    case Uint32Array:
    case Uint8ClampedArray:
    case Float32Array:
    case Float64Array:
      return zi(e, t, n, r);
    case DataView:
      return N(e, t, n, r);
    case Map:
      return Hi(e, t, n, r);
    case Set:
      return Ui(e, t, n, r);
    default:
      break;
  }
  if (i === Promise || r instanceof Promise) return Gi(e, t, n, r);
  let o = e.base.features;
  if (o & 32 && i === RegExp) return vr(n, r);
  if (o & 16)
    switch (i) {
      case BigInt64Array:
      case BigUint64Array:
        return Bi(e, t, n, r);
      default:
        break;
    }
  if (o & 1 && typeof AggregateError < `u` && (i === AggregateError || r instanceof AggregateError))
    return Vi(e, t, n, r);
  if (r instanceof Error) return P(e, t, n, r);
  if (A in r || En in r) return Li(e, t, n, r, !!i);
  throw new Gr(r);
}
async function Xi(e, t, n) {
  let r = wi(e.base, n);
  if (r.type !== 0) return r.value;
  let i = await Wi(e, t, r.value, n);
  if (i) return i;
  throw new Gr(n);
}
async function Zi(e, t, n) {
  switch (typeof n) {
    case `boolean`:
      return n ? Wn : Gn;
    case `undefined`:
      return Kn;
    case `string`:
      return mr(n);
    case `number`:
      return pr(n);
    case `bigint`:
      return hr(n);
    case `object`:
      if (n) {
        let r = wi(e.base, n);
        return r.type === 0 ? await Yi(e, t + 1, r.value, n) : r.value;
      }
      return qn;
    case `symbol`:
      return Ti(e.base, n);
    case `function`:
      return Xi(e, t, n);
    default:
      throw new Gr(n);
  }
}
async function Qi(e, t) {
  try {
    return await Zi(e, 0, t);
  } catch (e) {
    throw e instanceof Hr ? e : new Hr(e);
  }
}
var $i = ((e) => ((e[(e.Vanilla = 1)] = `Vanilla`), (e[(e.Cross = 2)] = `Cross`), e))($i || {});
function ea(e) {
  return e;
}
function ta(e, t) {
  for (let n = 0, r = t.length; n < r; n++) {
    let r = t[n];
    e.has(r) || (e.add(r), r.extends && ta(e, r.extends));
  }
}
function na(e) {
  if (e) {
    let t = new Set();
    return (ta(t, e), [...t]);
  }
}
function ra(e) {
  switch (e) {
    case `Int8Array`:
      return Int8Array;
    case `Int16Array`:
      return Int16Array;
    case `Int32Array`:
      return Int32Array;
    case `Uint8Array`:
      return Uint8Array;
    case `Uint16Array`:
      return Uint16Array;
    case `Uint32Array`:
      return Uint32Array;
    case `Uint8ClampedArray`:
      return Uint8ClampedArray;
    case `Float32Array`:
      return Float32Array;
    case `Float64Array`:
      return Float64Array;
    case `BigInt64Array`:
      return BigInt64Array;
    case `BigUint64Array`:
      return BigUint64Array;
    default:
      throw new Zr(e);
  }
}
var ia = 1e6,
  aa = 1e4,
  oa = 2e4;
function sa(e, t) {
  switch (t) {
    case 3:
      return Object.freeze(e);
    case 1:
      return Object.preventExtensions(e);
    case 2:
      return Object.seal(e);
    default:
      return e;
  }
}
var ca = 1e3;
function la(e, t) {
  return {
    mode: e,
    plugins: t.plugins,
    refs: t.refs || new Map(),
    features: t.features ?? 63 ^ (t.disabledFeatures || 0),
    depthLimit: t.depthLimit || ca,
  };
}
function ua(e) {
  return { mode: 2, base: la(2, e), child: j };
}
var da = class {
  constructor(e, t) {
    ((this._p = e), (this.depth = t));
  }
  deserialize(e) {
    return I(this._p, this.depth, e);
  }
};
function fa(e, t) {
  if (t < 0 || !Number.isFinite(t) || !Number.isInteger(t)) throw new Qr({ t: 4, i: t });
  if (e.refs.has(t)) throw Error(`Conflicted ref id: ` + t);
}
function pa(e, t, n) {
  return (fa(e.base, t), e.state.marked.has(t) && e.base.refs.set(t, n), n);
}
function ma(e, t, n) {
  return (fa(e.base, t), e.base.refs.set(t, n), n);
}
function F(e, t, n) {
  return e.mode === 1 ? pa(e, t, n) : ma(e, t, n);
}
function ha(e, t, n) {
  if (Object.hasOwn(t, n)) return t[n];
  throw new Qr(e);
}
function ga(e, t) {
  return F(e, t.i, cr(tr(t.s)));
}
function _a(e, t, n) {
  let r = n.a,
    i = r.length,
    a = F(e, n.i, Array(i));
  for (let n = 0, o; n < i; n++) ((o = r[n]), o && (a[n] = I(e, t, o)));
  return (sa(a, n.o), a);
}
function va(e) {
  switch (e) {
    case `constructor`:
    case `__proto__`:
    case `prototype`:
    case `__defineGetter__`:
    case `__defineSetter__`:
    case `__lookupGetter__`:
    case `__lookupSetter__`:
      return !1;
    default:
      return !0;
  }
}
function ya(e) {
  switch (e) {
    case En:
    case On:
    case In:
    case A:
      return !0;
    default:
      return !1;
  }
}
function ba(e, t, n) {
  va(t)
    ? (e[t] = n)
    : Object.defineProperty(e, t, { value: n, configurable: !0, enumerable: !0, writable: !0 });
}
function xa(e, t, n, r, i) {
  if (typeof r == `string`) ba(n, tr(r), I(e, t, i));
  else {
    let a = I(e, t, r);
    switch (typeof a) {
      case `string`:
        ba(n, a, I(e, t, i));
        break;
      case `symbol`:
        ya(a) && (n[a] = I(e, t, i));
        break;
      default:
        throw new Qr(r);
    }
  }
}
function Sa(e, t, n, r) {
  let i = n.k;
  if (i.length > 0) for (let a = 0, o = n.v, s = i.length; a < s; a++) xa(e, t, r, i[a], o[a]);
  return r;
}
function Ca(e, t, n) {
  let r = F(e, n.i, n.t === 10 ? {} : Object.create(null));
  return (Sa(e, t, n.p, r), sa(r, n.o), r);
}
function wa(e, t) {
  return F(e, t.i, new Date(t.s));
}
function Ta(e, t) {
  if (e.base.features & 32) {
    let n = tr(t.c);
    if (n.length > oa) throw new Qr(t);
    return F(e, t.i, new RegExp(n, t.m));
  }
  throw new Kr(t);
}
function Ea(e, t, n) {
  let r = F(e, n.i, new Set());
  for (let i = 0, a = n.a, o = a.length; i < o; i++) r.add(I(e, t, a[i]));
  return r;
}
function Da(e, t, n) {
  let r = F(e, n.i, new Map());
  for (let i = 0, a = n.e.k, o = n.e.v, s = a.length; i < s; i++)
    r.set(I(e, t, a[i]), I(e, t, o[i]));
  return r;
}
function Oa(e, t) {
  if (t.s.length > ia) throw new Qr(t);
  return F(e, t.i, ai(tr(t.s)));
}
function ka(e, t, n) {
  let r = ra(n.c),
    i = I(e, t, n.f),
    a = n.b ?? 0;
  if (a < 0 || a > i.byteLength) throw new Qr(n);
  return F(e, n.i, new r(i, a, n.l));
}
function Aa(e, t, n) {
  let r = I(e, t, n.f),
    i = n.b ?? 0;
  if (i < 0 || i > r.byteLength) throw new Qr(n);
  return F(e, n.i, new DataView(r, i, n.l));
}
function ja(e, t, n, r) {
  if (n.p) {
    let i = Sa(e, t, n.p, {});
    Object.defineProperties(r, Object.getOwnPropertyDescriptors(i));
  }
  return r;
}
function Ma(e, t, n) {
  return ja(e, t, n, F(e, n.i, AggregateError([], tr(n.m))));
}
function Na(e, t, n) {
  let r = ha(n, Hn, n.s);
  return ja(e, t, n, F(e, n.i, new r(tr(n.m))));
}
function Pa(e, t, n) {
  let r = ti(),
    i = F(e, n.i, r.p),
    a = I(e, t, n.f);
  return (n.s ? r.s(a) : r.f(a), i);
}
function Fa(e, t, n) {
  return F(e, n.i, Object(I(e, t, n.f)));
}
function Ia(e, t, n) {
  let r = e.base.plugins;
  if (r) {
    let i = tr(n.c);
    for (let a = 0, o = r.length; a < o; a++) {
      let o = r[a];
      if (o.tag === i) return F(e, n.i, o.deserialize(n.s, new da(e, t), { id: n.i }));
    }
  }
  throw new qr(n.c);
}
function La(e, t) {
  return F(e, t.i, F(e, t.s, ti()).p);
}
function Ra(e, t, n) {
  let r = e.base.refs.get(n.i);
  if (r) return (r.s(I(e, t, n.a[1])), j);
  throw new Jr(`Promise`);
}
function za(e, t, n) {
  let r = e.base.refs.get(n.i);
  if (r) return (r.f(I(e, t, n.a[1])), j);
  throw new Jr(`Promise`);
}
function Ba(e, t, n) {
  return (I(e, t, n.a[0]), ui(I(e, t, n.a[1])));
}
function Va(e, t, n) {
  return (I(e, t, n.a[0]), vi(I(e, t, n.a[1])));
}
function Ha(e, t, n) {
  let r = F(e, n.i, hi()),
    i = n.a,
    a = i.length;
  if (a) for (let n = 0; n < a; n++) I(e, t, i[n]);
  return r;
}
function Ua(e, t, n) {
  let r = e.base.refs.get(n.i);
  if (r && mi(r)) return (r.next(I(e, t, n.f)), j);
  throw new Jr(`Stream`);
}
function Wa(e, t, n) {
  let r = e.base.refs.get(n.i);
  if (r && mi(r)) return (r.throw(I(e, t, n.f)), j);
  throw new Jr(`Stream`);
}
function Ga(e, t, n) {
  let r = e.base.refs.get(n.i);
  if (r && mi(r)) return (r.return(I(e, t, n.f)), j);
  throw new Jr(`Stream`);
}
function Ka(e, t, n) {
  return (I(e, t, n.f), j);
}
function qa(e, t, n) {
  return (I(e, t, n.a[1]), j);
}
function Ja(e, t, n) {
  let r = F(e, n.i, si([], n.s, n.l));
  for (let i = 0, a = n.a.length; i < a; i++) r.v[i] = I(e, t, n.a[i]);
  return r;
}
function I(e, t, n) {
  if (t > e.base.depthLimit) throw new $r(e.base.depthLimit);
  switch (((t += 1), n.t)) {
    case 2:
      return ha(n, Bn, n.s);
    case 0:
      return Number(n.s);
    case 1:
      return tr(String(n.s));
    case 3:
      if (String(n.s).length > aa) throw new Qr(n);
      return BigInt(n.s);
    case 4:
      return e.base.refs.get(n.i);
    case 18:
      return ga(e, n);
    case 9:
      return _a(e, t, n);
    case 10:
    case 11:
      return Ca(e, t, n);
    case 5:
      return wa(e, n);
    case 6:
      return Ta(e, n);
    case 7:
      return Ea(e, t, n);
    case 8:
      return Da(e, t, n);
    case 19:
      return Oa(e, n);
    case 16:
    case 15:
      return ka(e, t, n);
    case 20:
      return Aa(e, t, n);
    case 14:
      return Ma(e, t, n);
    case 13:
      return Na(e, t, n);
    case 12:
      return Pa(e, t, n);
    case 17:
      return ha(n, zn, n.s);
    case 21:
      return Fa(e, t, n);
    case 25:
      return Ia(e, t, n);
    case 22:
      return La(e, n);
    case 23:
      return Ra(e, t, n);
    case 24:
      return za(e, t, n);
    case 28:
      return Ba(e, t, n);
    case 30:
      return Va(e, t, n);
    case 31:
      return Ha(e, t, n);
    case 32:
      return Ua(e, t, n);
    case 33:
      return Wa(e, t, n);
    case 34:
      return Ga(e, t, n);
    case 27:
      return Ka(e, t, n);
    case 29:
      return qa(e, t, n);
    case 35:
      return Ja(e, t, n);
    default:
      throw new Kr(n);
  }
}
function Ya(e, t) {
  try {
    return I(e, 0, t);
  } catch (e) {
    throw new Ur(e);
  }
}
var Xa = (() => T).toString();
/=>/.test(Xa);
function Za(e, t) {
  return Ya(
    ua({
      plugins: na(t.plugins),
      refs: t.refs,
      features: t.features,
      disabledFeatures: t.disabledFeatures,
      depthLimit: t.depthLimit,
    }),
    e,
  );
}
async function Qa(e, t = {}) {
  let n = Mi(1, { plugins: na(t.plugins), disabledFeatures: t.disabledFeatures });
  return { t: await Qi(n, e), f: n.base.features, m: Array.from(n.base.marked) };
}
function $a(e) {
  return e;
}
function eo(e) {
  return ea({
    tag: `$TSR/t/` + e.key,
    test: e.test,
    parse: {
      sync(t, n, r) {
        return { v: n.parse(e.toSerializable(t)) };
      },
      async async(t, n, r) {
        return { v: await n.parse(e.toSerializable(t)) };
      },
      stream(t, n, r) {
        return { v: n.parse(e.toSerializable(t)) };
      },
    },
    serialize: void 0,
    deserialize(t, n, r) {
      return e.fromSerializable(n.deserialize(t.v));
    },
  });
}
var to = class {
    constructor(e, t) {
      ((this.stream = e), (this.hint = t?.hint ?? `binary`));
    }
  },
  no = globalThis.Buffer,
  ro = !!no && typeof no.from == `function`;
function io(e) {
  if (e.length === 0) return ``;
  if (ro) return no.from(e).toString(`base64`);
  let t = 32768,
    n = [];
  for (let r = 0; r < e.length; r += t) {
    let i = e.subarray(r, r + t);
    n.push(String.fromCharCode.apply(null, i));
  }
  return btoa(n.join(``));
}
function ao(e) {
  if (e.length === 0) return new Uint8Array();
  if (ro) {
    let t = no.from(e, `base64`);
    return new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
  }
  let t = atob(e),
    n = new Uint8Array(t.length);
  for (let e = 0; e < t.length; e++) n[e] = t.charCodeAt(e);
  return n;
}
var oo = Object.create(null),
  so = Object.create(null),
  co = (e) =>
    new ReadableStream({
      start(t) {
        e.on({
          next(e) {
            try {
              t.enqueue(ao(e));
            } catch {}
          },
          throw(e) {
            t.error(e);
          },
          return() {
            try {
              t.close();
            } catch {}
          },
        });
      },
    }),
  lo = new TextEncoder(),
  uo = (e) =>
    new ReadableStream({
      start(t) {
        e.on({
          next(e) {
            try {
              typeof e == `string` ? t.enqueue(lo.encode(e)) : t.enqueue(ao(e.$b64));
            } catch {}
          },
          throw(e) {
            t.error(e);
          },
          return() {
            try {
              t.close();
            } catch {}
          },
        });
      },
    }),
  fo = `(s=>new ReadableStream({start(c){s.on({next(b){try{const d=atob(b),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}catch(_){}},throw(e){c.error(e)},return(){try{c.close()}catch(_){}}})}}))`,
  po = `(s=>{const e=new TextEncoder();return new ReadableStream({start(c){s.on({next(v){try{if(typeof v==='string'){c.enqueue(e.encode(v))}else{const d=atob(v.$b64),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}}catch(_){}},throw(x){c.error(x)},return(){try{c.close()}catch(_){}}})}})})`;
function mo(e) {
  let t = hi(),
    n = e.getReader();
  return (
    (async () => {
      try {
        for (;;) {
          let { done: e, value: r } = await n.read();
          if (e) {
            t.return(void 0);
            break;
          }
          t.next(io(r));
        }
      } catch (e) {
        t.throw(e);
      } finally {
        n.releaseLock();
      }
    })(),
    t
  );
}
function ho(e) {
  let t = hi(),
    n = e.getReader(),
    r = new TextDecoder(`utf-8`, { fatal: !0 });
  return (
    (async () => {
      try {
        for (;;) {
          let { done: e, value: i } = await n.read();
          if (e) {
            try {
              let e = r.decode();
              e.length > 0 && t.next(e);
            } catch {}
            t.return(void 0);
            break;
          }
          try {
            let e = r.decode(i, { stream: !0 });
            e.length > 0 && t.next(e);
          } catch {
            t.next({ $b64: io(i) });
          }
        }
      } catch (e) {
        t.throw(e);
      } finally {
        n.releaseLock();
      }
    })(),
    t
  );
}
var go = ea({
  tag: `tss/RawStream`,
  extends: [
    ea({
      tag: `tss/RawStreamFactory`,
      test(e) {
        return e === oo;
      },
      parse: {
        sync(e, t, n) {
          return {};
        },
        async async(e, t, n) {
          return {};
        },
        stream(e, t, n) {
          return {};
        },
      },
      serialize(e, t, n) {
        return fo;
      },
      deserialize(e, t, n) {
        return oo;
      },
    }),
    ea({
      tag: `tss/RawStreamFactoryText`,
      test(e) {
        return e === so;
      },
      parse: {
        sync(e, t, n) {
          return {};
        },
        async async(e, t, n) {
          return {};
        },
        stream(e, t, n) {
          return {};
        },
      },
      serialize(e, t, n) {
        return po;
      },
      deserialize(e, t, n) {
        return so;
      },
    }),
  ],
  test(e) {
    return e instanceof to;
  },
  parse: {
    sync(e, t, n) {
      let r = e.hint === `text` ? so : oo;
      return { hint: t.parse(e.hint), factory: t.parse(r), stream: t.parse(hi()) };
    },
    async async(e, t, n) {
      let r = e.hint === `text` ? so : oo,
        i = e.hint === `text` ? ho(e.stream) : mo(e.stream);
      return { hint: await t.parse(e.hint), factory: await t.parse(r), stream: await t.parse(i) };
    },
    stream(e, t, n) {
      let r = e.hint === `text` ? so : oo,
        i = e.hint === `text` ? ho(e.stream) : mo(e.stream);
      return { hint: t.parse(e.hint), factory: t.parse(r), stream: t.parse(i) };
    },
  },
  serialize(e, t, n) {
    return `(` + t.serialize(e.factory) + `)(` + t.serialize(e.stream) + `)`;
  },
  deserialize(e, t, n) {
    let r = t.deserialize(e.stream);
    return t.deserialize(e.hint) === `text` ? uo(r) : co(r);
  },
});
function _o(e) {
  return ea({
    tag: `tss/RawStream`,
    test: () => !1,
    parse: {},
    serialize() {
      throw Error(
        `RawStreamDeserializePlugin.serialize should not be called. Client only deserializes.`,
      );
    },
    deserialize(t, n, r) {
      return e(typeof n?.deserialize == `function` ? n.deserialize(t.streamId) : t.streamId);
    },
  });
}
var L = ea({
    tag: `$TSR/Error`,
    test(e) {
      return e instanceof Error;
    },
    parse: {
      sync(e, t) {
        return { message: t.parse(e.message) };
      },
      async async(e, t) {
        return { message: await t.parse(e.message) };
      },
      stream(e, t) {
        return { message: t.parse(e.message) };
      },
    },
    serialize(e, t) {
      return `new Error(` + t.serialize(e.message) + `)`;
    },
    deserialize(e, t) {
      return Error(t.deserialize(e.message));
    },
  }),
  R = {},
  vo = (e) =>
    new ReadableStream({
      start: (t) => {
        e.on({
          next: (e) => {
            try {
              t.enqueue(e);
            } catch {}
          },
          throw: (e) => {
            t.error(e);
          },
          return: () => {
            try {
              t.close();
            } catch {}
          },
        });
      },
    }),
  yo = ea({
    tag: `seroval-plugins/web/ReadableStreamFactory`,
    test(e) {
      return e === R;
    },
    parse: {
      sync() {
        return R;
      },
      async async() {
        return await Promise.resolve(R);
      },
      stream() {
        return R;
      },
    },
    serialize() {
      return vo.toString();
    },
    deserialize() {
      return R;
    },
  });
function bo(e) {
  let t = hi(),
    n = e.getReader();
  async function r() {
    try {
      let e = await n.read();
      e.done ? t.return(e.value) : (t.next(e.value), await r());
    } catch (e) {
      t.throw(e);
    }
  }
  return (r().catch(() => {}), t);
}
var xo = [
  L,
  go,
  ea({
    tag: `seroval/plugins/web/ReadableStream`,
    extends: [yo],
    test(e) {
      return typeof ReadableStream > `u` ? !1 : e instanceof ReadableStream;
    },
    parse: {
      sync(e, t) {
        return { factory: t.parse(R), stream: t.parse(hi()) };
      },
      async async(e, t) {
        return { factory: await t.parse(R), stream: await t.parse(bo(e)) };
      },
      stream(e, t) {
        return { factory: t.parse(R), stream: t.parse(bo(e)) };
      },
    },
    serialize(e, t) {
      return `(` + t.serialize(e.factory) + `)(` + t.serialize(e.stream) + `)`;
    },
    deserialize(e, t) {
      return vo(t.deserialize(e.stream));
    },
  }),
];
function So() {
  return [...(v()?.serializationAdapters?.map(eo) ?? []), ...xo];
}
var Co = new TextDecoder(),
  wo = new Uint8Array(),
  To = 16 * 1024 * 1024,
  z = 32 * 1024 * 1024,
  Eo = 1024,
  Do = 1e5;
function Oo(e) {
  let t = new Map(),
    n = new Map(),
    r = new Set(),
    i = !1,
    a = null,
    o = 0,
    s,
    c = new ReadableStream({
      start(e) {
        s = e;
      },
      cancel() {
        i = !0;
        try {
          a?.cancel();
        } catch {}
        (t.forEach((e) => {
          try {
            e.error(Error(`Framed response cancelled`));
          } catch {}
        }),
          t.clear(),
          n.clear(),
          r.clear());
      },
    });
  function l(e) {
    let i = n.get(e);
    if (i) return i;
    if (r.has(e))
      return new ReadableStream({
        start(e) {
          e.close();
        },
      });
    if (n.size >= Eo) throw Error(`Too many raw streams in framed response (max ${Eo})`);
    let a = new ReadableStream({
      start(n) {
        t.set(e, n);
      },
      cancel() {
        (r.add(e), t.delete(e), n.delete(e));
      },
    });
    return (n.set(e, a), a);
  }
  function u(e) {
    return (l(e), t.get(e));
  }
  return (
    (async () => {
      let n = e.getReader();
      a = n;
      let c = [],
        l = 0;
      function d() {
        if (l < 9) return null;
        let e = c[0];
        if (e.length >= 9)
          return {
            type: e[0],
            streamId: ((e[1] << 24) | (e[2] << 16) | (e[3] << 8) | e[4]) >>> 0,
            length: ((e[5] << 24) | (e[6] << 16) | (e[7] << 8) | e[8]) >>> 0,
          };
        let t = new Uint8Array(9),
          n = 0,
          r = 9;
        for (let e = 0; e < c.length && r > 0; e++) {
          let i = c[e],
            a = Math.min(i.length, r);
          (t.set(i.subarray(0, a), n), (n += a), (r -= a));
        }
        return {
          type: t[0],
          streamId: ((t[1] << 24) | (t[2] << 16) | (t[3] << 8) | t[4]) >>> 0,
          length: ((t[5] << 24) | (t[6] << 16) | (t[7] << 8) | t[8]) >>> 0,
        };
      }
      function f(e) {
        if (e === 0) return wo;
        let t = new Uint8Array(e),
          n = 0,
          r = e;
        for (; r > 0 && c.length > 0; ) {
          let e = c[0];
          if (!e) break;
          let i = Math.min(e.length, r);
          (t.set(e.subarray(0, i), n),
            (n += i),
            (r -= i),
            i === e.length ? c.shift() : (c[0] = e.subarray(i)));
        }
        return ((l -= e), t);
      }
      try {
        for (;;) {
          let { done: e, value: a } = await n.read();
          if (i || e) break;
          if (a) {
            if (l + a.length > z) throw Error(`Framed response buffer exceeded ${z} bytes`);
            for (c.push(a), l += a.length; ; ) {
              let e = d();
              if (!e) break;
              let { type: n, streamId: i, length: a } = e;
              if (n !== m.JSON && n !== m.CHUNK && n !== m.END && n !== m.ERROR)
                throw Error(`Unknown frame type: ${n}`);
              if (n === m.JSON) {
                if (i !== 0) throw Error(`Invalid JSON frame streamId (expected 0)`);
              } else if (i === 0) throw Error(`Invalid raw frame streamId (expected non-zero)`);
              if (a > To) throw Error(`Frame payload too large: ${a} bytes (max ${To})`);
              let c = 9 + a;
              if (l < c) break;
              if (++o > Do) throw Error(`Too many frames in framed response (max ${Do})`);
              f(9);
              let p = f(a);
              switch (n) {
                case m.JSON:
                  try {
                    s.enqueue(Co.decode(p));
                  } catch {}
                  break;
                case m.CHUNK: {
                  let e = u(i);
                  e && e.enqueue(p);
                  break;
                }
                case m.END: {
                  let e = u(i);
                  if ((r.add(i), e)) {
                    try {
                      e.close();
                    } catch {}
                    t.delete(i);
                  }
                  break;
                }
                case m.ERROR: {
                  let e = u(i);
                  if ((r.add(i), e)) {
                    let n = Co.decode(p);
                    (e.error(Error(n)), t.delete(i));
                  }
                  break;
                }
              }
            }
          }
        }
        if (l !== 0) throw Error(`Incomplete frame at end of framed response`);
        try {
          s.close();
        } catch {}
        (t.forEach((e) => {
          try {
            e.close();
          } catch {}
        }),
          t.clear());
      } catch (e) {
        try {
          s.error(e);
        } catch {}
        (t.forEach((t) => {
          try {
            t.error(e);
          } catch {}
        }),
          t.clear());
      } finally {
        try {
          n.releaseLock();
        } catch {}
        a = null;
      }
    })(),
    { getOrCreateStream: l, jsonChunks: c }
  );
}
var ko = null;
async function Ao(e) {
  e.length > 0 && (await Promise.allSettled(e));
}
var jo = Object.prototype.hasOwnProperty;
function Mo(e) {
  for (let t in e) if (jo.call(e, t)) return !0;
  return !1;
}
async function No(e, t, n) {
  ko ||= So();
  let r = t[0],
    i = r.fetch ?? n,
    a = r.data instanceof FormData ? `formData` : `payload`,
    o = r.headers ? new Headers(r.headers) : new Headers();
  if (
    (o.set(`x-tsr-serverFn`, `true`),
    a === `payload` && o.set(`accept`, `${p}, application/x-ndjson, application/json`),
    r.method === `GET`)
  ) {
    if (a === `formData`) throw Error(`FormData is not supported with GET requests`);
    let t = await Po(r);
    if (t !== void 0) {
      let n = lt({ payload: t });
      e.includes(`?`) ? (e += `&${n}`) : (e += `?${n}`);
    }
  }
  let s;
  if (r.method === `POST`) {
    let e = await Io(r);
    (e?.contentType && o.set(`content-type`, e.contentType), (s = e?.body));
  }
  return await Lo(async () => i(e, { method: r.method, headers: o, signal: r.signal, body: s }));
}
async function Po(e) {
  let t = !1,
    n = {};
  if (
    (e.data !== void 0 && ((t = !0), (n.data = e.data)),
    e.context && Mo(e.context) && ((t = !0), (n.context = e.context)),
    t)
  )
    return Fo(n);
}
async function Fo(e) {
  return JSON.stringify(await Promise.resolve(Qa(e, { plugins: ko })));
}
async function Io(e) {
  if (e.data instanceof FormData) {
    let t;
    return (
      e.context && Mo(e.context) && (t = await Fo(e.context)),
      t !== void 0 && e.data.set(u, t),
      { body: e.data }
    );
  }
  let t = await Po(e);
  if (t) return { body: t, contentType: `application/json` };
}
async function Lo(e) {
  let t;
  try {
    t = await e();
  } catch (e) {
    if (e instanceof Response) t = e;
    else throw (console.log(e), e);
  }
  if (t.headers.get(`x-tss-raw`) === `true`) return t;
  let n = t.headers.get(`content-type`);
  if ((n || ge(), t.headers.get(`x-tss-serialized`))) {
    let e;
    if (n.includes(`application/x-tss-framed`)) {
      if ((_(n), !t.body)) throw Error(`No response body for framed response`);
      let { getOrCreateStream: r, jsonChunks: i } = Oo(t.body),
        a = [_o(r), ...(ko || [])],
        o = new Map();
      e = await Ro({
        jsonStream: i,
        onMessage: (e) => Za(e, { refs: o, plugins: a }),
        onError(e, t) {
          console.error(e, t);
        },
      });
    } else if (n.includes(`application/json`)) {
      let n = await t.json(),
        r = [];
      try {
        e = Za(n, { plugins: ko });
      } finally {
      }
      await Ao(r);
    }
    if ((e || ge(), e instanceof Error)) throw e;
    return e;
  }
  if (n.includes(`application/json`)) {
    let e = await t.json(),
      n = yt(e);
    if (n) throw n;
    if (Qe(e)) throw e;
    return e;
  }
  if (!t.ok) throw Error(await t.text());
  return t;
}
async function Ro({ jsonStream: e, onMessage: t, onError: n }) {
  let r = e.getReader(),
    { value: i, done: a } = await r.read();
  if (a || !i) throw Error(`Stream ended before first object`);
  let o = JSON.parse(i),
    s = !1,
    c = (async () => {
      try {
        for (;;) {
          let { value: e, done: i } = await r.read();
          if (i) break;
          if (e)
            try {
              let n = [];
              try {
                t(JSON.parse(e));
              } finally {
              }
              await Ao(n);
            } catch (t) {
              n?.(`Invalid JSON: ${e}`, t);
            }
        }
      } catch (e) {
        s || n?.(`Stream processing error:`, e);
      }
    })(),
    l,
    u = [];
  try {
    l = t(o);
  } catch (e) {
    throw ((s = !0), r.cancel().catch(() => {}), e);
  }
  return (
    await Ao(u),
    Promise.resolve(l).catch(() => {
      ((s = !0), r.cancel().catch(() => {}));
    }),
    c.finally(() => {
      try {
        r.releaseLock();
      } catch {}
    }),
    l
  );
}
function zo(e) {
  let t = `/_serverFn/` + e;
  return Object.assign(
    (...e) => {
      let n = v()?.serverFns?.fetch;
      return No(t, e, n ?? fetch);
    },
    { url: t, serverFnMeta: { id: e }, [d]: !0 },
  );
}
var Bo = $a({
  key: `$TSS/serverfn`,
  test: (e) => (typeof e != `function` || !(d in e) ? !1 : !!e[d]),
  toSerializable: ({ serverFnMeta: e }) => ({ functionId: e.id }),
  fromSerializable: ({ functionId: e }) => zo(e),
});
function Vo(e) {
  if (Array.isArray(e)) return e.flatMap((e) => Vo(e));
  if (typeof e != `string`) return [];
  let t = [],
    n = 0,
    r,
    i,
    a,
    o,
    s,
    c = () => {
      for (; n < e.length && /\s/.test(e.charAt(n)); ) n += 1;
      return n < e.length;
    },
    l = () => ((i = e.charAt(n)), i !== `=` && i !== `;` && i !== `,`);
  for (; n < e.length; ) {
    for (r = n, s = !1; c(); )
      if (((i = e.charAt(n)), i === `,`)) {
        for (a = n, n += 1, c(), o = n; n < e.length && l(); ) n += 1;
        n < e.length && e.charAt(n) === `=`
          ? ((s = !0), (n = o), t.push(e.slice(r, a)), (r = n))
          : (n = a + 1);
      } else n += 1;
    (!s || n >= e.length) && t.push(e.slice(r));
  }
  return t;
}
function Ho(e) {
  return e instanceof Headers
    ? e
    : Array.isArray(e) || typeof e == `object`
      ? new Headers(e)
      : null;
}
function Uo(...e) {
  return e.reduce((e, t) => {
    let n = Ho(t);
    if (!n) return e;
    for (let [t, r] of n.entries())
      t === `set-cookie` ? Vo(r).forEach((t) => e.append(`set-cookie`, t)) : e.set(t, r);
    return e;
  }, new Headers());
}
function Wo(e) {
  return e.replaceAll(`\0`, `/`).replaceAll(`�`, `/`);
}
function Go(e, t) {
  ((e.id = t.i),
    (e.__beforeLoadContext = t.b),
    (e.loaderData = t.l),
    (e.status = t.s),
    (e.ssr = t.ssr),
    (e.updatedAt = t.u),
    (e.error = t.e),
    t.g !== void 0 && (e.globalNotFound = t.g));
}
async function Ko(e) {
  window.$_TSR || ge();
  let t = e.options.serializationAdapters;
  if (t?.length) {
    let e = new Map();
    (t.forEach((t) => {
      e.set(t.key, t.fromSerializable);
    }),
      (window.$_TSR.t = e),
      window.$_TSR.buffer.forEach((e) => e()));
  }
  ((window.$_TSR.initialized = !0), window.$_TSR.router || ge());
  let n = window.$_TSR.router;
  (n.matches.forEach((e) => {
    e.i = Wo(e.i);
  }),
    (n.lastMatchId &&= Wo(n.lastMatchId)));
  let { manifest: r, dehydratedData: i, lastMatchId: a } = n;
  e.ssr = { manifest: r };
  let o = document.querySelector(`meta[property="csp-nonce"]`)?.content;
  e.options.ssr = { nonce: o };
  let s = e.matchRoutes(e.stores.location.get()),
    c = Promise.all(s.map((t) => e.loadRouteChunk(e.looseRoutesById[t.routeId])));
  function l(t) {
    let n = e.looseRoutesById[t.routeId].options.pendingMinMs ?? e.options.defaultPendingMinMs;
    if (n) {
      let r = ce();
      ((t._nonReactive.minPendingPromise = r),
        (t._forcePending = !0),
        setTimeout(() => {
          (r.resolve(),
            e.updateMatch(
              t.id,
              (e) => ((e._nonReactive.minPendingPromise = void 0), { ...e, _forcePending: void 0 }),
            ));
        }, n));
    }
  }
  function u(t) {
    let n = e.looseRoutesById[t.routeId];
    n && (n.options.ssr = t.ssr);
  }
  let d;
  (s.forEach((e) => {
    let t = n.matches.find((t) => t.i === e.id);
    if (!t) {
      ((e._nonReactive.dehydrated = !1), (e.ssr = !1), u(e));
      return;
    }
    (Go(e, t),
      u(e),
      (e._nonReactive.dehydrated = e.ssr !== !1),
      (e.ssr === `data-only` || e.ssr === !1) && d === void 0 && ((d = e.index), l(e)));
  }),
    e.stores.setMatches(s),
    await e.options.hydrate?.(i));
  let f = e.stores.matches.get(),
    p = e.stores.location.get();
  await Promise.all(
    f.map(async (t) => {
      try {
        let n = e.looseRoutesById[t.routeId],
          r = f[t.index - 1]?.context ?? e.options.context;
        if (n.options.context) {
          let i = {
            deps: t.loaderDeps,
            params: t.params,
            context: r ?? {},
            location: p,
            navigate: (t) => e.navigate({ ...t, _fromLocation: p }),
            buildLocation: e.buildLocation,
            cause: t.cause,
            abortController: t.abortController,
            preload: !1,
            matches: s,
            routeId: n.id,
          };
          t.__routeContext = n.options.context(i) ?? void 0;
        }
        t.context = { ...r, ...t.__routeContext, ...t.__beforeLoadContext };
        let i = {
            ssr: e.options.ssr,
            matches: f,
            match: t,
            params: t.params,
            loaderData: t.loaderData,
          },
          a = await n.options.head?.(i),
          o = await n.options.scripts?.(i);
        ((t.meta = a?.meta),
          (t.links = a?.links),
          (t.headScripts = a?.scripts),
          (t.styles = a?.styles),
          (t.scripts = o));
      } catch (e) {
        if (Qe(e))
          ((t.error = { isNotFound: !0 }),
            console.error(`NotFound error during hydration for routeId: ${t.routeId}`, e));
        else
          throw (
            (t.error = e), console.error(`Error during hydration for route ${t.routeId}:`, e), e
          );
      }
    }),
  );
  let m = s[s.length - 1].id !== a;
  if (!s.some((e) => e.ssr === !1) && !m)
    return (
      s.forEach((e) => {
        e._nonReactive.dehydrated = void 0;
      }),
      e.stores.resolvedLocation.set(e.stores.location.get()),
      c
    );
  let h = Promise.resolve()
    .then(() => e.load())
    .catch((e) => {
      console.error(`Error during router hydration:`, e);
    });
  if (m) {
    let t = s[1];
    (t || ge(),
      l(t),
      (t._displayPending = !0),
      (t._nonReactive.displayPendingPromise = h),
      h.then(() => {
        e.batch(() => {
          (e.stores.status.get() === `pending` &&
            (e.stores.status.set(`idle`), e.stores.resolvedLocation.set(e.stores.location.get())),
            e.updateMatch(t.id, (e) => ({
              ...e,
              _displayPending: void 0,
              displayPendingPromise: void 0,
            })));
        });
      }));
  }
  return c;
}
var B = e(t(), 1),
  qo = B.use,
  Jo = typeof window < `u` ? B.useLayoutEffect : B.useEffect;
function Yo(e) {
  let t = B.useRef({ value: e, prev: null }),
    n = t.current.value;
  return (e !== n && (t.current = { value: e, prev: n }), t.current.prev);
}
function Xo(e, t, n = {}, r = {}) {
  B.useEffect(() => {
    if (!e.current || r.disabled || typeof IntersectionObserver != `function`) return;
    let i = new IntersectionObserver(([e]) => {
      t(e);
    }, n);
    return (
      i.observe(e.current),
      () => {
        i.disconnect();
      }
    );
  }, [t, n, r.disabled, e]);
}
function Zo(e) {
  let t = B.useRef(null);
  return (B.useImperativeHandle(e, () => t.current, []), t);
}
var V = r();
function Qo({ promise: e }) {
  if (qo) return qo(e);
  let t = vn(e);
  if (t[_n].status === `pending`) throw t;
  if (t[_n].status === `error`) throw t[_n].error;
  return t[_n].data;
}
function $o(e) {
  let t = (0, V.jsx)(es, { ...e });
  return e.fallback ? (0, V.jsx)(B.Suspense, { fallback: e.fallback, children: t }) : t;
}
function es(e) {
  let t = Qo(e);
  return e.children(t);
}
function ts(e) {
  let t = e.errorComponent ?? rs;
  return (0, V.jsx)(ns, {
    getResetKey: e.getResetKey,
    onCatch: e.onCatch,
    children: ({ error: n, reset: r }) =>
      n ? B.createElement(t, { error: n, reset: r }) : e.children,
  });
}
var ns = class extends B.Component {
  constructor(...e) {
    (super(...e), (this.state = { error: null }));
  }
  static getDerivedStateFromProps(e, t) {
    let n = e.getResetKey();
    return t.error && t.resetKey !== n ? { resetKey: n, error: null } : { resetKey: n };
  }
  static getDerivedStateFromError(e) {
    return { error: e };
  }
  reset() {
    this.setState({ error: null });
  }
  componentDidCatch(e, t) {
    this.props.onCatch && this.props.onCatch(e, t);
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
function rs({ error: e }) {
  let [t, n] = B.useState(!1);
  return (0, V.jsxs)(`div`, {
    style: { padding: `.5rem`, maxWidth: `100%` },
    children: [
      (0, V.jsxs)(`div`, {
        style: { display: `flex`, alignItems: `center`, gap: `.5rem` },
        children: [
          (0, V.jsx)(`strong`, { style: { fontSize: `1rem` }, children: `Something went wrong!` }),
          (0, V.jsx)(`button`, {
            style: {
              appearance: `none`,
              fontSize: `.6em`,
              border: `1px solid currentColor`,
              padding: `.1rem .2rem`,
              fontWeight: `bold`,
              borderRadius: `.25rem`,
            },
            onClick: () => n((e) => !e),
            children: t ? `Hide Error` : `Show Error`,
          }),
        ],
      }),
      (0, V.jsx)(`div`, { style: { height: `.25rem` } }),
      t
        ? (0, V.jsx)(`div`, {
            children: (0, V.jsx)(`pre`, {
              style: {
                fontSize: `.7em`,
                border: `1px solid red`,
                borderRadius: `.25rem`,
                padding: `.3rem`,
                color: `red`,
                overflow: `auto`,
              },
              children: e.message ? (0, V.jsx)(`code`, { children: e.message }) : null,
            }),
          })
        : null,
    ],
  });
}
function is({ children: e, fallback: t = null }) {
  return as() ? (0, V.jsx)(B.Fragment, { children: e }) : (0, V.jsx)(B.Fragment, { children: t });
}
function as() {
  return B.useSyncExternalStore(
    os,
    () => !0,
    () => !1,
  );
}
function os() {
  return () => {};
}
var ss = B.createContext(null);
function cs(e) {
  return B.useContext(ss);
}
var ls = B.createContext(void 0),
  us = B.createContext(void 0),
  H = ((e) => (
    (e[(e.None = 0)] = `None`),
    (e[(e.Mutable = 1)] = `Mutable`),
    (e[(e.Watching = 2)] = `Watching`),
    (e[(e.RecursedCheck = 4)] = `RecursedCheck`),
    (e[(e.Recursed = 8)] = `Recursed`),
    (e[(e.Dirty = 16)] = `Dirty`),
    (e[(e.Pending = 32)] = `Pending`),
    e
  ))(H || {});
function ds({ update: e, notify: t, unwatched: n }) {
  return { link: r, unlink: i, propagate: a, checkDirty: o, shallowPropagate: s };
  function r(e, t, n) {
    let r = t.depsTail;
    if (r !== void 0 && r.dep === e) return;
    let i = r === void 0 ? t.deps : r.nextDep;
    if (i !== void 0 && i.dep === e) {
      ((i.version = n), (t.depsTail = i));
      return;
    }
    let a = e.subsTail;
    if (a !== void 0 && a.version === n && a.sub === t) return;
    let o =
      (t.depsTail =
      e.subsTail =
        { version: n, dep: e, sub: t, prevDep: r, nextDep: i, prevSub: a, nextSub: void 0 });
    (i !== void 0 && (i.prevDep = o),
      r === void 0 ? (t.deps = o) : (r.nextDep = o),
      a === void 0 ? (e.subs = o) : (a.nextSub = o));
  }
  function i(e, t = e.sub) {
    let r = e.dep,
      i = e.prevDep,
      a = e.nextDep,
      o = e.nextSub,
      s = e.prevSub;
    return (
      a === void 0 ? (t.depsTail = i) : (a.prevDep = i),
      i === void 0 ? (t.deps = a) : (i.nextDep = a),
      o === void 0 ? (r.subsTail = s) : (o.prevSub = s),
      s === void 0 ? (r.subs = o) === void 0 && n(r) : (s.nextSub = o),
      a
    );
  }
  function a(e) {
    let n = e.nextSub,
      r;
    top: do {
      let i = e.sub,
        a = i.flags;
      if (
        (a & 60
          ? a & 12
            ? a & 4
              ? !(a & 48) && c(e, i)
                ? ((i.flags = a | 40), (a &= 1))
                : (a = 0)
              : (i.flags = (a & -9) | 32)
            : (a = 0)
          : (i.flags = a | 32),
        a & 2 && t(i),
        a & 1)
      ) {
        let t = i.subs;
        if (t !== void 0) {
          let i = (e = t).nextSub;
          i !== void 0 && ((r = { value: n, prev: r }), (n = i));
          continue;
        }
      }
      if ((e = n) !== void 0) {
        n = e.nextSub;
        continue;
      }
      for (; r !== void 0; )
        if (((e = r.value), (r = r.prev), e !== void 0)) {
          n = e.nextSub;
          continue top;
        }
      break;
    } while (!0);
  }
  function o(t, n) {
    let r,
      i = 0,
      a = !1;
    top: do {
      let o = t.dep,
        c = o.flags;
      if (n.flags & 16) a = !0;
      else if ((c & 17) == 17) {
        if (e(o)) {
          let e = o.subs;
          (e.nextSub !== void 0 && s(e), (a = !0));
        }
      } else if ((c & 33) == 33) {
        ((t.nextSub !== void 0 || t.prevSub !== void 0) && (r = { value: t, prev: r }),
          (t = o.deps),
          (n = o),
          ++i);
        continue;
      }
      if (!a) {
        let e = t.nextDep;
        if (e !== void 0) {
          t = e;
          continue;
        }
      }
      for (; i--; ) {
        let i = n.subs,
          o = i.nextSub !== void 0;
        if ((o ? ((t = r.value), (r = r.prev)) : (t = i), a)) {
          if (e(n)) {
            (o && s(i), (n = t.sub));
            continue;
          }
          a = !1;
        } else n.flags &= -33;
        n = t.sub;
        let c = t.nextDep;
        if (c !== void 0) {
          t = c;
          continue top;
        }
      }
      return a;
    } while (!0);
  }
  function s(e) {
    do {
      let n = e.sub,
        r = n.flags;
      (r & 48) == 32 && ((n.flags = r | 16), (r & 6) == 2 && t(n));
    } while ((e = e.nextSub) !== void 0);
  }
  function c(e, t) {
    let n = t.depsTail;
    for (; n !== void 0; ) {
      if (n === e) return !0;
      n = n.prevDep;
    }
    return !1;
  }
}
function fs(e, t, n) {
  let r = typeof e == `object`,
    i = r ? e : void 0;
  return {
    next: (r ? e.next : e)?.bind(i),
    error: (r ? e.error : t)?.bind(i),
    complete: (r ? e.complete : n)?.bind(i),
  };
}
var ps = [],
  ms = 0,
  {
    link: hs,
    unlink: gs,
    propagate: _s,
    checkDirty: vs,
    shallowPropagate: ys,
  } = ds({
    update(e) {
      return e._update();
    },
    notify(e) {
      ((ps[xs++] = e), (e.flags &= ~H.Watching));
    },
    unwatched(e) {
      e.depsTail !== void 0 && ((e.depsTail = void 0), (e.flags = H.Mutable | H.Dirty), Ts(e));
    },
  }),
  bs = 0,
  xs = 0,
  Ss,
  Cs = 0;
function ws(e) {
  try {
    (++Cs, e());
  } finally {
    --Cs || Es();
  }
}
function Ts(e) {
  let t = e.depsTail,
    n = t === void 0 ? e.deps : t.nextDep;
  for (; n !== void 0; ) n = gs(n, e);
}
function Es() {
  if (!(Cs > 0)) {
    for (; bs < xs; ) {
      let e = ps[bs];
      ((ps[bs++] = void 0), e.notify());
    }
    ((bs = 0), (xs = 0));
  }
}
function Ds(e, t) {
  let n = typeof e == `function`,
    r = e,
    i = {
      _snapshot: n ? void 0 : e,
      subs: void 0,
      subsTail: void 0,
      deps: void 0,
      depsTail: void 0,
      flags: n ? H.None : H.Mutable,
      get() {
        return (Ss !== void 0 && hs(i, Ss, ms), i._snapshot);
      },
      subscribe(e) {
        let t = fs(e),
          n = { current: !1 },
          r = Os(() => {
            (i.get(), n.current ? t.next?.(i._snapshot) : (n.current = !0));
          });
        return {
          unsubscribe: () => {
            r.stop();
          },
        };
      },
      _update(e) {
        let a = Ss,
          o = t?.compare ?? Object.is;
        if (n) ((Ss = i), ++ms, (i.depsTail = void 0));
        else if (e === void 0) return !1;
        n && (i.flags = H.Mutable | H.RecursedCheck);
        try {
          let t = i._snapshot,
            a = typeof e == `function` ? e(t) : e === void 0 && n ? r(t) : e;
          return t === void 0 || !o(t, a) ? ((i._snapshot = a), !0) : !1;
        } finally {
          ((Ss = a), n && (i.flags &= ~H.RecursedCheck), Ts(i));
        }
      },
    };
  return (
    n
      ? ((i.flags = H.Mutable | H.Dirty),
        (i.get = function () {
          let e = i.flags;
          if (e & H.Dirty || (e & H.Pending && vs(i.deps, i))) {
            if (i._update()) {
              let e = i.subs;
              e !== void 0 && ys(e);
            }
          } else e & H.Pending && (i.flags = e & ~H.Pending);
          return (Ss !== void 0 && hs(i, Ss, ms), i._snapshot);
        }))
      : (i.set = function (e) {
          if (i._update(e)) {
            let e = i.subs;
            e !== void 0 && (_s(e), ys(e), Es());
          }
        }),
    i
  );
}
function Os(e) {
  let t = () => {
      let t = Ss;
      ((Ss = n), ++ms, (n.depsTail = void 0), (n.flags = H.Watching | H.RecursedCheck));
      try {
        return e();
      } finally {
        ((Ss = t), (n.flags &= ~H.RecursedCheck), Ts(n));
      }
    },
    n = {
      deps: void 0,
      depsTail: void 0,
      subs: void 0,
      subsTail: void 0,
      flags: H.Watching | H.RecursedCheck,
      notify() {
        let e = this.flags;
        e & H.Dirty || (e & H.Pending && vs(this.deps, this)) ? t() : (this.flags = H.Watching);
      },
      stop() {
        ((this.flags = H.None), (this.depsTail = void 0), Ts(this));
      },
    };
  return (t(), n);
}
var ks = n((e) => {
    var n = t();
    function r(e, t) {
      return (e === t && (e !== 0 || 1 / e == 1 / t)) || (e !== e && t !== t);
    }
    var i = typeof Object.is == `function` ? Object.is : r,
      a = n.useState,
      o = n.useEffect,
      s = n.useLayoutEffect,
      c = n.useDebugValue;
    function l(e, t) {
      var n = t(),
        r = a({ inst: { value: n, getSnapshot: t } }),
        i = r[0].inst,
        l = r[1];
      return (
        s(
          function () {
            ((i.value = n), (i.getSnapshot = t), u(i) && l({ inst: i }));
          },
          [e, n, t],
        ),
        o(
          function () {
            return (
              u(i) && l({ inst: i }),
              e(function () {
                u(i) && l({ inst: i });
              })
            );
          },
          [e],
        ),
        c(n),
        n
      );
    }
    function u(e) {
      var t = e.getSnapshot;
      e = e.value;
      try {
        var n = t();
        return !i(e, n);
      } catch {
        return !0;
      }
    }
    function d(e, t) {
      return t();
    }
    var f =
      typeof window > `u` || window.document === void 0 || window.document.createElement === void 0
        ? d
        : l;
    e.useSyncExternalStore = n.useSyncExternalStore === void 0 ? f : n.useSyncExternalStore;
  }),
  As = n((e, t) => {
    t.exports = ks();
  }),
  js = n((e) => {
    var n = t(),
      r = As();
    function i(e, t) {
      return (e === t && (e !== 0 || 1 / e == 1 / t)) || (e !== e && t !== t);
    }
    var a = typeof Object.is == `function` ? Object.is : i,
      o = r.useSyncExternalStore,
      s = n.useRef,
      c = n.useEffect,
      l = n.useMemo,
      u = n.useDebugValue;
    e.useSyncExternalStoreWithSelector = function (e, t, n, r, i) {
      var d = s(null);
      if (d.current === null) {
        var f = { hasValue: !1, value: null };
        d.current = f;
      } else f = d.current;
      d = l(
        function () {
          function e(e) {
            if (!o) {
              if (((o = !0), (s = e), (e = r(e)), i !== void 0 && f.hasValue)) {
                var t = f.value;
                if (i(t, e)) return (c = t);
              }
              return (c = e);
            }
            if (((t = c), a(s, e))) return t;
            var n = r(e);
            return i !== void 0 && i(t, n) ? ((s = e), t) : ((s = e), (c = n));
          }
          var o = !1,
            s,
            c,
            l = n === void 0 ? null : n;
          return [
            function () {
              return e(t());
            },
            l === null
              ? void 0
              : function () {
                  return e(l());
                },
          ];
        },
        [t, n, r, i],
      );
      var p = o(e, d[0], d[1]);
      return (
        c(
          function () {
            ((f.hasValue = !0), (f.value = p));
          },
          [p],
        ),
        u(p),
        p
      );
    };
  }),
  Ms = n((e, t) => {
    t.exports = js();
  })();
function Ns(e, t) {
  return e === t;
}
function Ps(e, t, n = Ns) {
  let r = (0, B.useCallback)(
      (t) => {
        if (!e) return () => {};
        let { unsubscribe: n } = e.subscribe(t);
        return n;
      },
      [e],
    ),
    i = (0, B.useCallback)(() => e?.get(), [e]);
  return (0, Ms.useSyncExternalStoreWithSelector)(r, i, i, t, n);
}
var Fs = { get: () => void 0, subscribe: () => ({ unsubscribe: () => {} }) };
function Is(e) {
  let t = cs(),
    n = B.useContext(e.from ? us : ls),
    r = e.from ?? n,
    i = r ? (e.from ? t.stores.getRouteMatchStore(r) : t.stores.matchStores.get(r)) : void 0,
    a = B.useRef(void 0);
  return Ps(i ?? Fs, (n) => {
    if (((e.shouldThrow ?? !0) && !n && ge(), n === void 0)) return;
    let r = e.select ? e.select(n) : n;
    if (e.structuralSharing ?? t.options.defaultStructuralSharing) {
      let e = ne(a.current, r);
      return ((a.current = e), e);
    }
    return r;
  });
}
function Ls(e) {
  return Is({
    from: e.from,
    strict: e.strict,
    structuralSharing: e.structuralSharing,
    select: (t) => (e.select ? e.select(t.loaderData) : t.loaderData),
  });
}
function Rs(e) {
  let { select: t, ...n } = e;
  return Is({ ...n, select: (e) => (t ? t(e.loaderDeps) : e.loaderDeps) });
}
function zs(e) {
  return Is({
    from: e.from,
    shouldThrow: e.shouldThrow,
    structuralSharing: e.structuralSharing,
    strict: e.strict,
    select: (t) => {
      let n = e.strict === !1 ? t.params : t._strictParams;
      return e.select ? e.select(n) : n;
    },
  });
}
function Bs(e) {
  return Is({
    from: e.from,
    strict: e.strict,
    shouldThrow: e.shouldThrow,
    structuralSharing: e.structuralSharing,
    select: (t) => (e.select ? e.select(t.search) : t.search),
  });
}
function Vs(e) {
  let t = cs();
  return B.useCallback((n) => t.navigate({ ...n, from: n.from ?? e?.from }), [e?.from, t]);
}
function Hs(e) {
  return Is({ ...e, select: (t) => (e.select ? e.select(t.context) : t.context) });
}
var Us = s();
function Ws(e, t) {
  let n = cs(),
    r = Zo(t),
    {
      activeProps: i,
      inactiveProps: a,
      activeOptions: o,
      to: s,
      preload: c,
      preloadDelay: l,
      preloadIntentProximity: u,
      hashScrollIntoView: d,
      replace: f,
      startTransition: p,
      resetScroll: m,
      viewTransition: h,
      children: g,
      target: _,
      disabled: v,
      style: y,
      className: b,
      onClick: S,
      onBlur: C,
      onFocus: ee,
      onMouseEnter: te,
      onMouseLeave: ne,
      onTouchStart: re,
      ignoreBlocker: ie,
      params: ae,
      search: oe,
      hash: ce,
      state: le,
      mask: ue,
      reloadDocument: de,
      unsafeRelative: w,
      from: E,
      _fromLocation: pe,
      ...me
    } = e,
    he = as(),
    D = B.useMemo(
      () => e,
      [
        n,
        e.from,
        e._fromLocation,
        e.hash,
        e.to,
        e.search,
        e.params,
        e.state,
        e.mask,
        e.unsafeRelative,
      ],
    ),
    O = Ps(
      n.stores.location,
      (e) => e,
      (e, t) => e.href === t.href,
    ),
    k = B.useMemo(() => {
      let e = { _fromLocation: O, ...D };
      return n.buildLocation(e);
    }, [n, O, D]),
    ge = k.maskedLocation ? k.maskedLocation.publicHref : k.publicHref,
    _e = k.maskedLocation ? k.maskedLocation.external : k.external,
    ve = B.useMemo(() => $s(ge, _e, n.history, v), [v, _e, ge, n.history]),
    ye = B.useMemo(() => {
      if (ve?.external) return fe(ve.href, n.protocolAllowlist) ? void 0 : ve.href;
      if (!ec(s) && !(typeof s != `string` || s.indexOf(`:`) === -1))
        try {
          return (new URL(s), fe(s, n.protocolAllowlist) ? void 0 : s);
        } catch {}
    }, [s, ve, n.protocolAllowlist]),
    be = B.useMemo(() => {
      if (ye) return !1;
      if (o?.exact) {
        if (!Ke(O.pathname, k.pathname, n.basepath)) return !1;
      } else {
        let e = Ge(O.pathname, n.basepath),
          t = Ge(k.pathname, n.basepath);
        if (!(e.startsWith(t) && (e.length === t.length || e[t.length] === `/`))) return !1;
      }
      return (o?.includeSearch ?? !0) &&
        !se(O.search, k.search, { partial: !o?.exact, ignoreUndefined: !o?.explicitUndefined })
        ? !1
        : o?.includeHash
          ? he && O.hash === k.hash
          : !0;
    }, [
      o?.exact,
      o?.explicitUndefined,
      o?.includeHash,
      o?.includeSearch,
      O,
      ye,
      he,
      k.hash,
      k.pathname,
      k.search,
      n.basepath,
    ]),
    xe = be ? (x(i, {}) ?? Ks) : Gs,
    Se = be ? Gs : (x(a, {}) ?? Gs),
    Ce = [b, xe.className, Se.className].filter(Boolean).join(` `),
    we = (y || xe.style || Se.style) && { ...y, ...xe.style, ...Se.style },
    [Te, Ee] = B.useState(!1),
    De = B.useRef(!1),
    Oe = e.reloadDocument || ye ? !1 : (c ?? n.options.defaultPreload),
    ke = l ?? n.options.defaultPreloadDelay ?? 0,
    Ae = B.useCallback(() => {
      n.preloadRoute({ ...D, _builtLocation: k }).catch((e) => {
        (console.warn(e), console.warn(yn));
      });
    }, [n, D, k]);
  (Xo(
    r,
    B.useCallback(
      (e) => {
        e?.isIntersecting && Ae();
      },
      [Ae],
    ),
    Zs,
    { disabled: !!v || Oe !== `viewport` },
  ),
    B.useEffect(() => {
      De.current || (!v && Oe === `render` && (Ae(), (De.current = !0)));
    }, [v, Ae, Oe]));
  let je = (e) => {
    let t = e.currentTarget.getAttribute(`target`),
      r = _ === void 0 ? t : _;
    if (!v && !nc(e) && !e.defaultPrevented && (!r || r === `_self`) && e.button === 0) {
      (e.preventDefault(),
        (0, Us.flushSync)(() => {
          Ee(!0);
        }));
      let t = n.subscribe(`onResolved`, () => {
        (t(), Ee(!1));
      });
      n.navigate({
        ...D,
        replace: f,
        resetScroll: m,
        hashScrollIntoView: d,
        startTransition: p,
        viewTransition: h,
        ignoreBlocker: ie,
      });
    }
  };
  if (ye)
    return {
      ...me,
      ref: r,
      href: ye,
      ...(g && { children: g }),
      ...(_ && { target: _ }),
      ...(v && { disabled: v }),
      ...(y && { style: y }),
      ...(b && { className: b }),
      ...(S && { onClick: S }),
      ...(C && { onBlur: C }),
      ...(ee && { onFocus: ee }),
      ...(te && { onMouseEnter: te }),
      ...(ne && { onMouseLeave: ne }),
      ...(re && { onTouchStart: re }),
    };
  let Me = (e) => {
      if (v || Oe !== `intent`) return;
      if (!ke) {
        Ae();
        return;
      }
      let t = e.currentTarget;
      if (Xs.has(t)) return;
      let n = setTimeout(() => {
        (Xs.delete(t), Ae());
      }, ke);
      Xs.set(t, n);
    },
    Ne = (e) => {
      v || Oe !== `intent` || Ae();
    },
    Pe = (e) => {
      if (v || !Oe || !ke) return;
      let t = e.currentTarget,
        n = Xs.get(t);
      n && (clearTimeout(n), Xs.delete(t));
    };
  return {
    ...me,
    ...xe,
    ...Se,
    href: ve?.href,
    ref: r,
    onClick: Qs([S, je]),
    onBlur: Qs([C, Pe]),
    onFocus: Qs([ee, Me]),
    onMouseEnter: Qs([te, Me]),
    onMouseLeave: Qs([ne, Pe]),
    onTouchStart: Qs([re, Ne]),
    disabled: !!v,
    target: _,
    ...(we && { style: we }),
    ...(Ce && { className: Ce }),
    ...(v && qs),
    ...(be && Js),
    ...(he && Te && Ys),
  };
}
var Gs = {},
  Ks = { className: `active` },
  qs = { role: `link`, "aria-disabled": !0 },
  Js = { "data-status": `active`, "aria-current": `page` },
  Ys = { "data-transitioning": `transitioning` },
  Xs = new WeakMap(),
  Zs = { rootMargin: `100px` },
  Qs = (e) => (t) => {
    for (let n of e)
      if (n) {
        if (t.defaultPrevented) return;
        n(t);
      }
  };
function $s(e, t, n, r) {
  if (!r) return t ? { href: e, external: !0 } : { href: n.createHref(e) || `/`, external: !1 };
}
function ec(e) {
  if (typeof e != `string`) return !1;
  let t = e.charCodeAt(0);
  return t === 47 ? e.charCodeAt(1) !== 47 : t === 46;
}
var tc = B.forwardRef((e, t) => {
  let { _asChild: n, ...r } = e,
    { type: i, ...a } = Ws(r, t),
    o =
      typeof r.children == `function`
        ? r.children({ isActive: a[`data-status`] === `active` })
        : r.children;
  if (!n) {
    let { disabled: e, ...t } = a;
    return B.createElement(`a`, t, o);
  }
  return B.createElement(n, a, o);
});
function nc(e) {
  return !!(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey);
}
var rc = class extends Sn {
  constructor(e) {
    (super(e),
      (this.useMatch = (e) =>
        Is({ select: e?.select, from: this.id, structuralSharing: e?.structuralSharing })),
      (this.useRouteContext = (e) => Hs({ ...e, from: this.id })),
      (this.useSearch = (e) =>
        Bs({ select: e?.select, structuralSharing: e?.structuralSharing, from: this.id })),
      (this.useParams = (e) =>
        zs({ select: e?.select, structuralSharing: e?.structuralSharing, from: this.id })),
      (this.useLoaderDeps = (e) => Rs({ ...e, from: this.id })),
      (this.useLoaderData = (e) => Ls({ ...e, from: this.id })),
      (this.useNavigate = () => Vs({ from: this.fullPath })),
      (this.Link = B.forwardRef((e, t) => (0, V.jsx)(tc, { ref: t, from: this.fullPath, ...e }))));
  }
};
function ic(e) {
  return new rc(e);
}
var ac = class extends Cn {
  constructor(e) {
    (super(e),
      (this.useMatch = (e) =>
        Is({ select: e?.select, from: this.id, structuralSharing: e?.structuralSharing })),
      (this.useRouteContext = (e) => Hs({ ...e, from: this.id })),
      (this.useSearch = (e) =>
        Bs({ select: e?.select, structuralSharing: e?.structuralSharing, from: this.id })),
      (this.useParams = (e) =>
        zs({ select: e?.select, structuralSharing: e?.structuralSharing, from: this.id })),
      (this.useLoaderDeps = (e) => Rs({ ...e, from: this.id })),
      (this.useLoaderData = (e) => Ls({ ...e, from: this.id })),
      (this.useNavigate = () => Vs({ from: this.fullPath })),
      (this.Link = B.forwardRef((e, t) => (0, V.jsx)(tc, { ref: t, from: this.fullPath, ...e }))));
  }
};
function oc(e) {
  return new ac(e);
}
function sc(e) {
  return new cc(e, { silent: !0 }).createRoute;
}
var cc = class {
  constructor(e, t) {
    ((this.path = e),
      (this.createRoute = (e) => {
        let t = ic(e);
        return ((t.isRoot = !1), t);
      }),
      (this.silent = t?.silent));
  }
};
function lc(e, t) {
  let n,
    r,
    i,
    a,
    o = () => (
      (n ||= e()
        .then((e) => {
          ((n = void 0), (r = e[t ?? `default`]));
        })
        .catch((e) => {
          if (
            ((i = e),
            le(i) && i instanceof Error && typeof window < `u` && typeof sessionStorage < `u`)
          ) {
            let e = `tanstack_router_reload:${i.message}`;
            sessionStorage.getItem(e) || (sessionStorage.setItem(e, `1`), (a = !0));
          }
        })),
      n
    ),
    s = function (e) {
      if (a) throw (window.location.reload(), new Promise(() => {}));
      if (i) throw i;
      if (!r)
        if (qo) qo(o());
        else throw o();
      return B.createElement(r, e);
    };
  return ((s.preload = o), s);
}
function uc(e) {
  let t = cs(),
    n = `not-found-${Ps(t.stores.location, (e) => e.pathname)}-${Ps(t.stores.status, (e) => e)}`;
  return (0, V.jsx)(ts, {
    getResetKey: () => n,
    onCatch: (t, n) => {
      if (Qe(t)) e.onCatch?.(t, n);
      else throw t;
    },
    errorComponent: ({ error: t }) => {
      if (Qe(t)) return e.fallback?.(t);
      throw t;
    },
    children: e.children,
  });
}
function dc() {
  return (0, V.jsx)(`p`, { children: `Not Found` });
}
function fc(e) {
  return (0, V.jsx)(V.Fragment, { children: e.children });
}
function pc(e, t, n) {
  return t.options.notFoundComponent
    ? (0, V.jsx)(t.options.notFoundComponent, { ...n })
    : e.options.defaultNotFoundComponent
      ? (0, V.jsx)(e.options.defaultNotFoundComponent, { ...n })
      : (0, V.jsx)(dc, {});
}
var mc = B.memo(function ({ matchId: e }) {
  let t = cs(),
    n = t.stores.matchStores.get(e);
  n || ge();
  let r = Ps(t.stores.loadedAt, (e) => e),
    i = Ps(n, (e) => e);
  return (0, V.jsx)(hc, {
    router: t,
    matchId: e,
    resetKey: r,
    matchState: B.useMemo(() => {
      let e = i.routeId,
        n = t.routesById[e].parentRoute?.id;
      return { routeId: e, ssr: i.ssr, _displayPending: i._displayPending, parentRouteId: n };
    }, [i._displayPending, i.routeId, i.ssr, t.routesById]),
  });
});
function hc({ router: e, matchId: t, resetKey: n, matchState: r }) {
  let i = e.routesById[r.routeId],
    a = i.options.pendingComponent ?? e.options.defaultPendingComponent,
    o = a ? (0, V.jsx)(a, {}) : null,
    s = i.options.errorComponent ?? e.options.defaultErrorComponent,
    c = i.options.onCatch ?? e.options.defaultOnCatch,
    l = i.isRoot
      ? (i.options.notFoundComponent ?? e.options.notFoundRoute?.options.component)
      : i.options.notFoundComponent,
    u = r.ssr === !1 || r.ssr === `data-only`,
    d =
      (!i.isRoot || i.options.wrapInSuspense || u) &&
      (i.options.wrapInSuspense ?? a ?? (i.options.errorComponent?.preload || u))
        ? B.Suspense
        : fc,
    f = s ? ts : fc,
    p = l ? uc : fc;
  return (0, V.jsxs)(i.isRoot ? (i.options.shellComponent ?? fc) : fc, {
    children: [
      (0, V.jsx)(ls.Provider, {
        value: t,
        children: (0, V.jsx)(d, {
          fallback: o,
          children: (0, V.jsx)(f, {
            getResetKey: () => n,
            errorComponent: s || rs,
            onCatch: (e, t) => {
              if (Qe(e)) throw ((e.routeId ??= r.routeId), e);
              c?.(e, t);
            },
            children: (0, V.jsx)(p, {
              fallback: (e) => {
                if (
                  ((e.routeId ??= r.routeId),
                  !l || (e.routeId && e.routeId !== r.routeId) || (!e.routeId && !i.isRoot))
                )
                  throw e;
                return B.createElement(l, e);
              },
              children:
                u || r._displayPending
                  ? (0, V.jsx)(is, { fallback: o, children: (0, V.jsx)(_c, { matchId: t }) })
                  : (0, V.jsx)(_c, { matchId: t }),
            }),
          }),
        }),
      }),
      r.parentRouteId === `__root__`
        ? (0, V.jsxs)(V.Fragment, {
            children: [(0, V.jsx)(gc, { resetKey: n }), (e.options.scrollRestoration, null)],
          })
        : null,
    ],
  });
}
function gc({ resetKey: e }) {
  let t = cs(),
    n = B.useRef(void 0);
  return (
    Jo(() => {
      let e = t.latestLocation.href;
      (n.current === void 0 || n.current !== e) &&
        (t.emit({
          type: `onRendered`,
          ...on(t.stores.location.get(), t.stores.resolvedLocation.get()),
        }),
        (n.current = e));
    }, [t.latestLocation.state.__TSR_key, e, t]),
    null
  );
}
var _c = B.memo(function ({ matchId: e }) {
    let t = cs(),
      n = (e, n) => t.getMatch(e.id)?._nonReactive[n] ?? e._nonReactive[n],
      r = t.stores.matchStores.get(e);
    r || ge();
    let i = Ps(r, (e) => e),
      a = i.routeId,
      o = t.routesById[a],
      s = B.useMemo(() => {
        let e = (t.routesById[a].options.remountDeps ?? t.options.defaultRemountDeps)?.({
          routeId: a,
          loaderDeps: i.loaderDeps,
          params: i._strictParams,
          search: i._strictSearch,
        });
        return e ? JSON.stringify(e) : void 0;
      }, [
        a,
        i.loaderDeps,
        i._strictParams,
        i._strictSearch,
        t.options.defaultRemountDeps,
        t.routesById,
      ]),
      c = B.useMemo(() => {
        let e = o.options.component ?? t.options.defaultComponent;
        return e ? (0, V.jsx)(e, {}, s) : (0, V.jsx)(vc, {});
      }, [s, o.options.component, t.options.defaultComponent]);
    if (i._displayPending) throw n(i, `displayPendingPromise`);
    if (i._forcePending) throw n(i, `minPendingPromise`);
    if (i.status === `pending`) {
      let e = o.options.pendingMinMs ?? t.options.defaultPendingMinMs;
      if (e) {
        let n = t.getMatch(i.id);
        if (n && !n._nonReactive.minPendingPromise) {
          let t = ce();
          ((n._nonReactive.minPendingPromise = t),
            setTimeout(() => {
              (t.resolve(), (n._nonReactive.minPendingPromise = void 0));
            }, e));
        }
      }
      throw n(i, `loadPromise`);
    }
    if (i.status === `notFound`) return (Qe(i.error) || ge(), pc(t, o, i.error));
    if (i.status === `redirected`) throw (vt(i.error) || ge(), n(i, `loadPromise`));
    if (i.status === `error`) throw i.error;
    return c;
  }),
  vc = B.memo(function () {
    let e = cs(),
      t = B.useContext(ls),
      n,
      r = !1,
      i;
    {
      let a = t ? e.stores.matchStores.get(t) : void 0;
      (([n, r] = Ps(a, (e) => [e?.routeId, e?.globalNotFound ?? !1])),
        (i = Ps(e.stores.matchesId, (e) => e[e.findIndex((e) => e === t) + 1])));
    }
    let a = n ? e.routesById[n] : void 0,
      o = e.options.defaultPendingComponent
        ? (0, V.jsx)(e.options.defaultPendingComponent, {})
        : null;
    if (r) return (a || ge(), pc(e, a, void 0));
    if (!i) return null;
    let s = (0, V.jsx)(mc, { matchId: i });
    return n === `__root__` ? (0, V.jsx)(B.Suspense, { fallback: o, children: s }) : s;
  });
function yc() {
  let e = cs(),
    t = B.useRef({ router: e, mounted: !1 }),
    [n, r] = B.useState(!1),
    i = Ps(e.stores.isLoading, (e) => e),
    a = Ps(e.stores.hasPending, (e) => e),
    o = Yo(i),
    s = i || n || a,
    c = Yo(s),
    l = i || a,
    u = Yo(l);
  return (
    (e.startTransition = (e) => {
      (r(!0),
        B.startTransition(() => {
          (e(), r(!1));
        }));
    }),
    B.useEffect(() => {
      let t = e.history.subscribe(e.load),
        n = e.buildLocation({
          to: e.latestLocation.pathname,
          search: !0,
          params: !0,
          hash: !0,
          state: !0,
          _includeValidateSearch: !0,
        });
      return (
        Ue(e.latestLocation.publicHref) !== Ue(n.publicHref) &&
          e.commitLocation({ ...n, replace: !0 }),
        () => {
          t();
        }
      );
    }, [e, e.history]),
    Jo(() => {
      (typeof window < `u` && e.ssr) ||
        (t.current.router === e && t.current.mounted) ||
        ((t.current = { router: e, mounted: !0 }),
        (async () => {
          try {
            await e.load();
          } catch (e) {
            console.error(e);
          }
        })());
    }, [e]),
    Jo(() => {
      o &&
        !i &&
        e.emit({ type: `onLoad`, ...on(e.stores.location.get(), e.stores.resolvedLocation.get()) });
    }, [o, e, i]),
    Jo(() => {
      u &&
        !l &&
        e.emit({
          type: `onBeforeRouteMount`,
          ...on(e.stores.location.get(), e.stores.resolvedLocation.get()),
        });
    }, [l, u, e]),
    Jo(() => {
      if (c && !s) {
        let t = on(e.stores.location.get(), e.stores.resolvedLocation.get());
        (e.emit({ type: `onResolved`, ...t }),
          ws(() => {
            (e.stores.status.set(`idle`), e.stores.resolvedLocation.set(e.stores.location.get()));
          }),
          t.hrefChanged && wn(e));
      }
    }, [s, c, e]),
    null
  );
}
function bc() {
  let e = cs(),
    t = e.routesById.__root__.options.pendingComponent ?? e.options.defaultPendingComponent,
    n = t ? (0, V.jsx)(t, {}) : null,
    r = (0, V.jsxs)(typeof document < `u` && e.ssr ? fc : B.Suspense, {
      fallback: n,
      children: [(0, V.jsx)(yc, {}), (0, V.jsx)(xc, {})],
    });
  return e.options.InnerWrap ? (0, V.jsx)(e.options.InnerWrap, { children: r }) : r;
}
function xc() {
  let e = cs(),
    t = Ps(e.stores.firstId, (e) => e),
    n = Ps(e.stores.loadedAt, (e) => e),
    r = t ? (0, V.jsx)(mc, { matchId: t }) : null;
  return (0, V.jsx)(ls.Provider, {
    value: t,
    children: e.options.disableGlobalCatchBoundary
      ? r
      : (0, V.jsx)(ts, { getResetKey: () => n, errorComponent: rs, onCatch: void 0, children: r }),
  });
}
var Sc = (e) => ({ createMutableStore: Ds, createReadonlyStore: Ds, batch: ws }),
  Cc = (e) => new wc(e),
  wc = class extends sn {
    constructor(e) {
      super(e, Sc);
    }
  };
function Tc({ router: e, children: t, ...n }) {
  Object.keys(n).length > 0 &&
    e.update({ ...e.options, ...n, context: { ...e.options.context, ...n.context } });
  let r = (0, V.jsx)(ss.Provider, { value: e, children: t });
  return e.options.Wrap ? (0, V.jsx)(e.options.Wrap, { children: r }) : r;
}
function Ec({ router: e, ...t }) {
  return (0, V.jsx)(Tc, { router: e, ...t, children: (0, V.jsx)(bc, {}) });
}
function Dc({ tag: e, attrs: t, children: n, nonce: r }) {
  switch (e) {
    case `title`:
      return (0, V.jsx)(`title`, { ...t, suppressHydrationWarning: !0, children: n });
    case `meta`:
      return (0, V.jsx)(`meta`, { ...t, suppressHydrationWarning: !0 });
    case `link`:
      return (0, V.jsx)(`link`, {
        ...t,
        precedence: t?.precedence ?? (t?.rel === `stylesheet` ? `default` : void 0),
        nonce: r,
        suppressHydrationWarning: !0,
      });
    case `style`:
      return (0, V.jsx)(`style`, { ...t, dangerouslySetInnerHTML: { __html: n }, nonce: r });
    case `script`:
      return (0, V.jsx)(Oc, { attrs: t, children: n });
    default:
      return null;
  }
}
function Oc({ attrs: e, children: t }) {
  cs();
  let n = as(),
    r =
      typeof e?.type == `string` &&
      e.type !== `` &&
      e.type !== `text/javascript` &&
      e.type !== `module`;
  if (
    (B.useEffect(() => {
      if (!r) {
        if (e?.src) {
          let t = (() => {
            try {
              let t = document.baseURI || window.location.href;
              return new URL(e.src, t).href;
            } catch {
              return e.src;
            }
          })();
          if (Array.from(document.querySelectorAll(`script[src]`)).find((e) => e.src === t)) return;
          let n = document.createElement(`script`);
          for (let [t, r] of Object.entries(e))
            t !== `suppressHydrationWarning` &&
              r !== void 0 &&
              r !== !1 &&
              n.setAttribute(t, typeof r == `boolean` ? `` : String(r));
          return (
            document.head.appendChild(n),
            () => {
              n.parentNode && n.parentNode.removeChild(n);
            }
          );
        }
        if (typeof t == `string`) {
          let n = typeof e?.type == `string` ? e.type : `text/javascript`,
            r = typeof e?.nonce == `string` ? e.nonce : void 0;
          if (
            Array.from(document.querySelectorAll(`script:not([src])`)).find((e) => {
              if (!(e instanceof HTMLScriptElement)) return !1;
              let i = e.getAttribute(`type`) ?? `text/javascript`,
                a = e.getAttribute(`nonce`) ?? void 0;
              return e.textContent === t && i === n && a === r;
            })
          )
            return;
          let i = document.createElement(`script`);
          if (((i.textContent = t), e))
            for (let [t, n] of Object.entries(e))
              t !== `suppressHydrationWarning` &&
                n !== void 0 &&
                n !== !1 &&
                i.setAttribute(t, typeof n == `boolean` ? `` : String(n));
          return (
            document.head.appendChild(i),
            () => {
              i.parentNode && i.parentNode.removeChild(i);
            }
          );
        }
      }
    }, [e, t, r]),
    r && typeof t == `string`)
  )
    return (0, V.jsx)(`script`, {
      ...e,
      suppressHydrationWarning: !0,
      dangerouslySetInnerHTML: { __html: t },
    });
  if (!n) {
    if (e?.src) return (0, V.jsx)(`script`, { ...e, suppressHydrationWarning: !0 });
    if (typeof t == `string`)
      return (0, V.jsx)(`script`, {
        ...e,
        dangerouslySetInnerHTML: { __html: t },
        suppressHydrationWarning: !0,
      });
  }
  return null;
}
var kc = (e) => {
  let t = cs(),
    n = t.options.ssr?.nonce,
    r = Ps(t.stores.matches, (e) => e.map((e) => e.meta).filter(Boolean), se),
    i = B.useMemo(() => {
      let e = [],
        t = {},
        i;
      for (let a = r.length - 1; a >= 0; a--) {
        let o = r[a];
        for (let r = o.length - 1; r >= 0; r--) {
          let a = o[r];
          if (a)
            if (a.title) i ||= { tag: `title`, children: a.title };
            else if (`script:ld+json` in a)
              try {
                let t = JSON.stringify(a[`script:ld+json`]);
                e.push({ tag: `script`, attrs: { type: `application/ld+json` }, children: he(t) });
              } catch {}
            else {
              let r = a.name ?? a.property;
              if (r) {
                if (t[r]) continue;
                t[r] = !0;
              }
              e.push({ tag: `meta`, attrs: { ...a, nonce: n } });
            }
        }
      }
      return (
        i && e.push(i),
        n && e.push({ tag: `meta`, attrs: { property: `csp-nonce`, content: n } }),
        e.reverse(),
        e
      );
    }, [r, n]),
    a = Ps(
      t.stores.matches,
      (r) => {
        let i = r
            .map((e) => e.links)
            .filter(Boolean)
            .flat(1)
            .map((e) => ({ tag: `link`, attrs: { ...e, nonce: n } })),
          a = t.ssr?.manifest,
          o = r
            .map((e) => a?.routes[e.routeId]?.assets ?? [])
            .filter(Boolean)
            .flat(1)
            .filter((e) => e.tag === `link`)
            .map((t) => ({
              tag: `link`,
              attrs: {
                ...t.attrs,
                crossOrigin: bn(e, `stylesheet`) ?? t.attrs?.crossOrigin,
                suppressHydrationWarning: !0,
                nonce: n,
              },
            }));
        return [...i, ...o];
      },
      se,
    ),
    o = Ps(
      t.stores.matches,
      (r) => {
        let i = [];
        return (
          r
            .map((e) => t.looseRoutesById[e.routeId])
            .forEach((r) =>
              t.ssr?.manifest?.routes[r.id]?.preloads?.filter(Boolean).forEach((t) => {
                let r = xn(t);
                i.push({
                  tag: `link`,
                  attrs: {
                    rel: `modulepreload`,
                    href: r.href,
                    crossOrigin: bn(e, `modulepreload`) ?? r.crossOrigin,
                    nonce: n,
                  },
                });
              }),
            ),
          i
        );
      },
      se,
    ),
    s = Ps(
      t.stores.matches,
      (e) =>
        e
          .map((e) => e.styles)
          .flat(1)
          .filter(Boolean)
          .map(({ children: e, ...t }) => ({
            tag: `style`,
            attrs: { ...t, nonce: n },
            children: e,
          })),
      se,
    ),
    c = Ps(
      t.stores.matches,
      (e) =>
        e
          .map((e) => e.headScripts)
          .flat(1)
          .filter(Boolean)
          .map(({ children: e, ...t }) => ({
            tag: `script`,
            attrs: { ...t, nonce: n },
            children: e,
          })),
      se,
    );
  return Ac([...i, ...o, ...a, ...s, ...c], (e) => JSON.stringify(e));
};
function Ac(e, t) {
  let n = new Set();
  return e.filter((e) => {
    let r = t(e);
    return n.has(r) ? !1 : (n.add(r), !0);
  });
}
function jc(e) {
  let t = kc(e.assetCrossOrigin),
    n = cs().options.ssr?.nonce;
  return (0, V.jsx)(V.Fragment, {
    children: t.map((e) =>
      (0, B.createElement)(Dc, { ...e, key: `tsr-meta-${JSON.stringify(e)}`, nonce: n }),
    ),
  });
}
var Mc = () => {
  let e = cs(),
    t = e.options.ssr?.nonce,
    n = (n) => {
      let r = [],
        i = e.ssr?.manifest;
      return i
        ? (n
            .map((t) => e.looseRoutesById[t.routeId])
            .forEach((e) =>
              i.routes[e.id]?.assets
                ?.filter((e) => e.tag === `script`)
                .forEach((e) => {
                  r.push({ tag: `script`, attrs: { ...e.attrs, nonce: t }, children: e.children });
                }),
            ),
          r)
        : [];
    },
    r = (e) =>
      e
        .map((e) => e.scripts)
        .flat(1)
        .filter(Boolean)
        .map(({ children: e, ...n }) => ({
          tag: `script`,
          attrs: { ...n, suppressHydrationWarning: !0, nonce: t },
          children: e,
        })),
    i = Ps(e.stores.matches, n, se);
  return Nc(e, Ps(e.stores.matches, r, se), i);
};
function Nc(e, t, n) {
  let r;
  e.serverSsr && (r = e.serverSsr.takeBufferedScripts());
  let i = [...t, ...n];
  return (
    r && i.unshift(r),
    (0, V.jsx)(V.Fragment, {
      children: i.map((e, t) =>
        (0, B.createElement)(Dc, { ...e, key: `tsr-scripts-${e.tag}-${t}` }),
      ),
    })
  );
}
var Pc = class {
    constructor() {
      ((this.listeners = new Set()), (this.subscribe = this.subscribe.bind(this)));
    }
    subscribe(e) {
      return (
        this.listeners.add(e),
        this.onSubscribe(),
        () => {
          (this.listeners.delete(e), this.onUnsubscribe());
        }
      );
    }
    hasListeners() {
      return this.listeners.size > 0;
    }
    onSubscribe() {}
    onUnsubscribe() {}
  },
  Fc = new (class extends Pc {
    #e;
    #t;
    #n;
    constructor() {
      (super(),
        (this.#n = (e) => {
          if (typeof window < `u` && window.addEventListener) {
            let t = () => e();
            return (
              window.addEventListener(`visibilitychange`, t, !1),
              () => {
                window.removeEventListener(`visibilitychange`, t);
              }
            );
          }
        }));
    }
    onSubscribe() {
      this.#t || this.setEventListener(this.#n);
    }
    onUnsubscribe() {
      this.hasListeners() || (this.#t?.(), (this.#t = void 0));
    }
    setEventListener(e) {
      ((this.#n = e),
        this.#t?.(),
        (this.#t = e((e) => {
          typeof e == `boolean` ? this.setFocused(e) : this.onFocus();
        })));
    }
    setFocused(e) {
      this.#e !== e && ((this.#e = e), this.onFocus());
    }
    onFocus() {
      let e = this.isFocused();
      this.listeners.forEach((t) => {
        t(e);
      });
    }
    isFocused() {
      return typeof this.#e == `boolean`
        ? this.#e
        : globalThis.document?.visibilityState !== `hidden`;
    }
  })(),
  Ic = {
    setTimeout: (e, t) => setTimeout(e, t),
    clearTimeout: (e) => clearTimeout(e),
    setInterval: (e, t) => setInterval(e, t),
    clearInterval: (e) => clearInterval(e),
  },
  Lc = new (class {
    #e = Ic;
    setTimeoutProvider(e) {
      this.#e = e;
    }
    setTimeout(e, t) {
      return this.#e.setTimeout(e, t);
    }
    clearTimeout(e) {
      this.#e.clearTimeout(e);
    }
    setInterval(e, t) {
      return this.#e.setInterval(e, t);
    }
    clearInterval(e) {
      this.#e.clearInterval(e);
    }
  })();
function Rc(e) {
  setTimeout(e, 0);
}
var zc = typeof window > `u` || `Deno` in globalThis;
function U() {}
function Bc(e, t) {
  return typeof e == `function` ? e(t) : e;
}
function Vc(e) {
  return typeof e == `number` && e >= 0 && e !== 1 / 0;
}
function Hc(e, t) {
  return Math.max(e + (t || 0) - Date.now(), 0);
}
function Uc(e, t) {
  return typeof e == `function` ? e(t) : e;
}
function Wc(e, t) {
  return typeof e == `function` ? e(t) : e;
}
function Gc(e, t) {
  let { type: n = `all`, exact: r, fetchStatus: i, predicate: a, queryKey: o, stale: s } = e;
  if (o) {
    if (r) {
      if (t.queryHash !== qc(o, t.options)) return !1;
    } else if (!Yc(t.queryKey, o)) return !1;
  }
  if (n !== `all`) {
    let e = t.isActive();
    if ((n === `active` && !e) || (n === `inactive` && e)) return !1;
  }
  return !(
    (typeof s == `boolean` && t.isStale() !== s) ||
    (i && i !== t.state.fetchStatus) ||
    (a && !a(t))
  );
}
function Kc(e, t) {
  let { exact: n, status: r, predicate: i, mutationKey: a } = e;
  if (a) {
    if (!t.options.mutationKey) return !1;
    if (n) {
      if (Jc(t.options.mutationKey) !== Jc(a)) return !1;
    } else if (!Yc(t.options.mutationKey, a)) return !1;
  }
  return !((r && t.state.status !== r) || (i && !i(t)));
}
function qc(e, t) {
  return (t?.queryKeyHashFn || Jc)(e);
}
function Jc(e) {
  return JSON.stringify(e, (e, t) =>
    el(t)
      ? Object.keys(t)
          .sort()
          .reduce((e, n) => ((e[n] = t[n]), e), {})
      : t,
  );
}
function Yc(e, t) {
  return e === t
    ? !0
    : typeof e == typeof t && e && t && typeof e == `object` && typeof t == `object`
      ? Object.keys(t).every((n) => Yc(e[n], t[n]))
      : !1;
}
var Xc = Object.prototype.hasOwnProperty;
function Zc(e, t, n = 0) {
  if (e === t) return e;
  if (n > 500) return t;
  let r = $c(e) && $c(t);
  if (!r && !(el(e) && el(t))) return t;
  let i = (r ? e : Object.keys(e)).length,
    a = r ? t : Object.keys(t),
    o = a.length,
    s = r ? Array(o) : {},
    c = 0;
  for (let l = 0; l < o; l++) {
    let o = r ? l : a[l],
      u = e[o],
      d = t[o];
    if (u === d) {
      ((s[o] = u), (r ? l < i : Xc.call(e, o)) && c++);
      continue;
    }
    if (u === null || d === null || typeof u != `object` || typeof d != `object`) {
      s[o] = d;
      continue;
    }
    let f = Zc(u, d, n + 1);
    ((s[o] = f), f === u && c++);
  }
  return i === o && c === i ? e : s;
}
function Qc(e, t) {
  if (!t || Object.keys(e).length !== Object.keys(t).length) return !1;
  for (let n in e) if (e[n] !== t[n]) return !1;
  return !0;
}
function $c(e) {
  return Array.isArray(e) && e.length === Object.keys(e).length;
}
function el(e) {
  if (!tl(e)) return !1;
  let t = e.constructor;
  if (t === void 0) return !0;
  let n = t.prototype;
  return !(
    !tl(n) ||
    !n.hasOwnProperty(`isPrototypeOf`) ||
    Object.getPrototypeOf(e) !== Object.prototype
  );
}
function tl(e) {
  return Object.prototype.toString.call(e) === `[object Object]`;
}
function nl(e) {
  return new Promise((t) => {
    Lc.setTimeout(t, e);
  });
}
function rl(e, t, n) {
  return typeof n.structuralSharing == `function`
    ? n.structuralSharing(e, t)
    : n.structuralSharing === !1
      ? t
      : Zc(e, t);
}
function il(e, t, n = 0) {
  let r = [...e, t];
  return n && r.length > n ? r.slice(1) : r;
}
function al(e, t, n = 0) {
  let r = [t, ...e];
  return n && r.length > n ? r.slice(0, -1) : r;
}
var ol = Symbol();
function sl(e, t) {
  return !e.queryFn && t?.initialPromise
    ? () => t.initialPromise
    : !e.queryFn || e.queryFn === ol
      ? () => Promise.reject(Error(`Missing queryFn: '${e.queryHash}'`))
      : e.queryFn;
}
function cl(e, t) {
  return typeof e == `function` ? e(...t) : !!e;
}
function ll(e, t, n) {
  let r = !1,
    i;
  return (
    Object.defineProperty(e, `signal`, {
      enumerable: !0,
      get: () => (
        (i ??= t()),
        r ? i : ((r = !0), i.aborted ? n() : i.addEventListener(`abort`, n, { once: !0 }), i)
      ),
    }),
    e
  );
}
var W = (() => {
  let e = () => zc;
  return {
    isServer() {
      return e();
    },
    setIsServer(t) {
      e = t;
    },
  };
})();
function ul() {
  let e,
    t,
    n = new Promise((n, r) => {
      ((e = n), (t = r));
    });
  ((n.status = `pending`), n.catch(() => {}));
  function r(e) {
    (Object.assign(n, e), delete n.resolve, delete n.reject);
  }
  return (
    (n.resolve = (t) => {
      (r({ status: `fulfilled`, value: t }), e(t));
    }),
    (n.reject = (e) => {
      (r({ status: `rejected`, reason: e }), t(e));
    }),
    n
  );
}
var dl = Rc;
function fl() {
  let e = [],
    t = 0,
    n = (e) => {
      e();
    },
    r = (e) => {
      e();
    },
    i = dl,
    a = (r) => {
      t
        ? e.push(r)
        : i(() => {
            n(r);
          });
    },
    o = () => {
      let t = e;
      ((e = []),
        t.length &&
          i(() => {
            r(() => {
              t.forEach((e) => {
                n(e);
              });
            });
          }));
    };
  return {
    batch: (e) => {
      let n;
      t++;
      try {
        n = e();
      } finally {
        (t--, t || o());
      }
      return n;
    },
    batchCalls:
      (e) =>
      (...t) => {
        a(() => {
          e(...t);
        });
      },
    schedule: a,
    setNotifyFunction: (e) => {
      n = e;
    },
    setBatchNotifyFunction: (e) => {
      r = e;
    },
    setScheduler: (e) => {
      i = e;
    },
  };
}
var pl = fl(),
  ml = new (class extends Pc {
    #e = !0;
    #t;
    #n;
    constructor() {
      (super(),
        (this.#n = (e) => {
          if (typeof window < `u` && window.addEventListener) {
            let t = () => e(!0),
              n = () => e(!1);
            return (
              window.addEventListener(`online`, t, !1),
              window.addEventListener(`offline`, n, !1),
              () => {
                (window.removeEventListener(`online`, t), window.removeEventListener(`offline`, n));
              }
            );
          }
        }));
    }
    onSubscribe() {
      this.#t || this.setEventListener(this.#n);
    }
    onUnsubscribe() {
      this.hasListeners() || (this.#t?.(), (this.#t = void 0));
    }
    setEventListener(e) {
      ((this.#n = e), this.#t?.(), (this.#t = e(this.setOnline.bind(this))));
    }
    setOnline(e) {
      this.#e !== e &&
        ((this.#e = e),
        this.listeners.forEach((t) => {
          t(e);
        }));
    }
    isOnline() {
      return this.#e;
    }
  })();
function hl(e) {
  return Math.min(1e3 * 2 ** e, 3e4);
}
function gl(e) {
  return (e ?? `online`) === `online` ? ml.isOnline() : !0;
}
var _l = class extends Error {
  constructor(e) {
    (super(`CancelledError`), (this.revert = e?.revert), (this.silent = e?.silent));
  }
};
function vl(e) {
  let t = !1,
    n = 0,
    r,
    i = ul(),
    a = () => i.status !== `pending`,
    o = (t) => {
      if (!a()) {
        let n = new _l(t);
        (f(n), e.onCancel?.(n));
      }
    },
    s = () => {
      t = !0;
    },
    c = () => {
      t = !1;
    },
    l = () => Fc.isFocused() && (e.networkMode === `always` || ml.isOnline()) && e.canRun(),
    u = () => gl(e.networkMode) && e.canRun(),
    d = (e) => {
      a() || (r?.(), i.resolve(e));
    },
    f = (e) => {
      a() || (r?.(), i.reject(e));
    },
    p = () =>
      new Promise((t) => {
        ((r = (e) => {
          (a() || l()) && t(e);
        }),
          e.onPause?.());
      }).then(() => {
        ((r = void 0), a() || e.onContinue?.());
      }),
    m = () => {
      if (a()) return;
      let r,
        i = n === 0 ? e.initialPromise : void 0;
      try {
        r = i ?? e.fn();
      } catch (e) {
        r = Promise.reject(e);
      }
      Promise.resolve(r)
        .then(d)
        .catch((r) => {
          if (a()) return;
          let i = e.retry ?? (W.isServer() ? 0 : 3),
            o = e.retryDelay ?? hl,
            s = typeof o == `function` ? o(n, r) : o,
            c = i === !0 || (typeof i == `number` && n < i) || (typeof i == `function` && i(n, r));
          if (t || !c) {
            f(r);
            return;
          }
          (n++,
            e.onFail?.(n, r),
            nl(s)
              .then(() => (l() ? void 0 : p()))
              .then(() => {
                t ? f(r) : m();
              }));
        });
    };
  return {
    promise: i,
    status: () => i.status,
    cancel: o,
    continue: () => (r?.(), i),
    cancelRetry: s,
    continueRetry: c,
    canStart: u,
    start: () => (u() ? m() : p().then(m), i),
  };
}
var yl = class {
    #e;
    destroy() {
      this.clearGcTimeout();
    }
    scheduleGc() {
      (this.clearGcTimeout(),
        Vc(this.gcTime) &&
          (this.#e = Lc.setTimeout(() => {
            this.optionalRemove();
          }, this.gcTime)));
    }
    updateGcTime(e) {
      this.gcTime = Math.max(this.gcTime || 0, e ?? (W.isServer() ? 1 / 0 : 300 * 1e3));
    }
    clearGcTimeout() {
      this.#e !== void 0 && (Lc.clearTimeout(this.#e), (this.#e = void 0));
    }
  },
  bl = class extends yl {
    #e;
    #t;
    #n;
    #r;
    #i;
    #a;
    #o;
    constructor(e) {
      (super(),
        (this.#o = !1),
        (this.#a = e.defaultOptions),
        this.setOptions(e.options),
        (this.observers = []),
        (this.#r = e.client),
        (this.#n = this.#r.getQueryCache()),
        (this.queryKey = e.queryKey),
        (this.queryHash = e.queryHash),
        (this.#e = Cl(this.options)),
        (this.state = e.state ?? this.#e),
        this.scheduleGc());
    }
    get meta() {
      return this.options.meta;
    }
    get promise() {
      return this.#i?.promise;
    }
    setOptions(e) {
      if (
        ((this.options = { ...this.#a, ...e }),
        this.updateGcTime(this.options.gcTime),
        this.state && this.state.data === void 0)
      ) {
        let e = Cl(this.options);
        e.data !== void 0 && (this.setState(Sl(e.data, e.dataUpdatedAt)), (this.#e = e));
      }
    }
    optionalRemove() {
      !this.observers.length && this.state.fetchStatus === `idle` && this.#n.remove(this);
    }
    setData(e, t) {
      let n = rl(this.state.data, e, this.options);
      return (
        this.#c({ data: n, type: `success`, dataUpdatedAt: t?.updatedAt, manual: t?.manual }), n
      );
    }
    setState(e, t) {
      this.#c({ type: `setState`, state: e, setStateOptions: t });
    }
    cancel(e) {
      let t = this.#i?.promise;
      return (this.#i?.cancel(e), t ? t.then(U).catch(U) : Promise.resolve());
    }
    destroy() {
      (super.destroy(), this.cancel({ silent: !0 }));
    }
    get resetState() {
      return this.#e;
    }
    reset() {
      (this.destroy(), this.setState(this.resetState));
    }
    isActive() {
      return this.observers.some((e) => Wc(e.options.enabled, this) !== !1);
    }
    isDisabled() {
      return this.getObserversCount() > 0
        ? !this.isActive()
        : this.options.queryFn === ol || !this.isFetched();
    }
    isFetched() {
      return this.state.dataUpdateCount + this.state.errorUpdateCount > 0;
    }
    isStatic() {
      return this.getObserversCount() > 0
        ? this.observers.some((e) => Uc(e.options.staleTime, this) === `static`)
        : !1;
    }
    isStale() {
      return this.getObserversCount() > 0
        ? this.observers.some((e) => e.getCurrentResult().isStale)
        : this.state.data === void 0 || this.state.isInvalidated;
    }
    isStaleByTime(e = 0) {
      return this.state.data === void 0
        ? !0
        : e === `static`
          ? !1
          : this.state.isInvalidated
            ? !0
            : !Hc(this.state.dataUpdatedAt, e);
    }
    onFocus() {
      (this.observers.find((e) => e.shouldFetchOnWindowFocus())?.refetch({ cancelRefetch: !1 }),
        this.#i?.continue());
    }
    onOnline() {
      (this.observers.find((e) => e.shouldFetchOnReconnect())?.refetch({ cancelRefetch: !1 }),
        this.#i?.continue());
    }
    addObserver(e) {
      this.observers.includes(e) ||
        (this.observers.push(e),
        this.clearGcTimeout(),
        this.#n.notify({ type: `observerAdded`, query: this, observer: e }));
    }
    removeObserver(e) {
      this.observers.includes(e) &&
        ((this.observers = this.observers.filter((t) => t !== e)),
        this.observers.length ||
          (this.#i &&
            (this.#o || this.#s() ? this.#i.cancel({ revert: !0 }) : this.#i.cancelRetry()),
          this.scheduleGc()),
        this.#n.notify({ type: `observerRemoved`, query: this, observer: e }));
    }
    getObserversCount() {
      return this.observers.length;
    }
    #s() {
      return this.state.fetchStatus === `paused` && this.state.status === `pending`;
    }
    invalidate() {
      this.state.isInvalidated || this.#c({ type: `invalidate` });
    }
    async fetch(e, t) {
      if (this.state.fetchStatus !== `idle` && this.#i?.status() !== `rejected`) {
        if (this.state.data !== void 0 && t?.cancelRefetch) this.cancel({ silent: !0 });
        else if (this.#i) return (this.#i.continueRetry(), this.#i.promise);
      }
      if ((e && this.setOptions(e), !this.options.queryFn)) {
        let e = this.observers.find((e) => e.options.queryFn);
        e && this.setOptions(e.options);
      }
      let n = new AbortController(),
        r = (e) => {
          Object.defineProperty(e, `signal`, {
            enumerable: !0,
            get: () => ((this.#o = !0), n.signal),
          });
        },
        i = () => {
          let e = sl(this.options, t),
            n = (() => {
              let e = { client: this.#r, queryKey: this.queryKey, meta: this.meta };
              return (r(e), e);
            })();
          return (
            (this.#o = !1), this.options.persister ? this.options.persister(e, n, this) : e(n)
          );
        },
        a = (() => {
          let e = {
            fetchOptions: t,
            options: this.options,
            queryKey: this.queryKey,
            client: this.#r,
            state: this.state,
            fetchFn: i,
          };
          return (r(e), e);
        })();
      (this.options.behavior?.onFetch(a, this),
        (this.#t = this.state),
        (this.state.fetchStatus === `idle` || this.state.fetchMeta !== a.fetchOptions?.meta) &&
          this.#c({ type: `fetch`, meta: a.fetchOptions?.meta }),
        (this.#i = vl({
          initialPromise: t?.initialPromise,
          fn: a.fetchFn,
          onCancel: (e) => {
            (e instanceof _l && e.revert && this.setState({ ...this.#t, fetchStatus: `idle` }),
              n.abort());
          },
          onFail: (e, t) => {
            this.#c({ type: `failed`, failureCount: e, error: t });
          },
          onPause: () => {
            this.#c({ type: `pause` });
          },
          onContinue: () => {
            this.#c({ type: `continue` });
          },
          retry: a.options.retry,
          retryDelay: a.options.retryDelay,
          networkMode: a.options.networkMode,
          canRun: () => !0,
        })));
      try {
        let e = await this.#i.start();
        if (e === void 0) throw Error(`${this.queryHash} data is undefined`);
        return (
          this.setData(e),
          this.#n.config.onSuccess?.(e, this),
          this.#n.config.onSettled?.(e, this.state.error, this),
          e
        );
      } catch (e) {
        if (e instanceof _l) {
          if (e.silent) return this.#i.promise;
          if (e.revert) {
            if (this.state.data === void 0) throw e;
            return this.state.data;
          }
        }
        throw (
          this.#c({ type: `error`, error: e }),
          this.#n.config.onError?.(e, this),
          this.#n.config.onSettled?.(this.state.data, e, this),
          e
        );
      } finally {
        this.scheduleGc();
      }
    }
    #c(e) {
      let t = (t) => {
        switch (e.type) {
          case `failed`:
            return { ...t, fetchFailureCount: e.failureCount, fetchFailureReason: e.error };
          case `pause`:
            return { ...t, fetchStatus: `paused` };
          case `continue`:
            return { ...t, fetchStatus: `fetching` };
          case `fetch`:
            return { ...t, ...xl(t.data, this.options), fetchMeta: e.meta ?? null };
          case `success`:
            let n = {
              ...t,
              ...Sl(e.data, e.dataUpdatedAt),
              dataUpdateCount: t.dataUpdateCount + 1,
              ...(!e.manual && {
                fetchStatus: `idle`,
                fetchFailureCount: 0,
                fetchFailureReason: null,
              }),
            };
            return ((this.#t = e.manual ? n : void 0), n);
          case `error`:
            let r = e.error;
            return {
              ...t,
              error: r,
              errorUpdateCount: t.errorUpdateCount + 1,
              errorUpdatedAt: Date.now(),
              fetchFailureCount: t.fetchFailureCount + 1,
              fetchFailureReason: r,
              fetchStatus: `idle`,
              status: `error`,
              isInvalidated: !0,
            };
          case `invalidate`:
            return { ...t, isInvalidated: !0 };
          case `setState`:
            return { ...t, ...e.state };
        }
      };
      ((this.state = t(this.state)),
        pl.batch(() => {
          (this.observers.forEach((e) => {
            e.onQueryUpdate();
          }),
            this.#n.notify({ query: this, type: `updated`, action: e }));
        }));
    }
  };
function xl(e, t) {
  return {
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: gl(t.networkMode) ? `fetching` : `paused`,
    ...(e === void 0 && { error: null, status: `pending` }),
  };
}
function Sl(e, t) {
  return {
    data: e,
    dataUpdatedAt: t ?? Date.now(),
    error: null,
    isInvalidated: !1,
    status: `success`,
  };
}
function Cl(e) {
  let t = typeof e.initialData == `function` ? e.initialData() : e.initialData,
    n = t !== void 0,
    r = n
      ? typeof e.initialDataUpdatedAt == `function`
        ? e.initialDataUpdatedAt()
        : e.initialDataUpdatedAt
      : 0;
  return {
    data: t,
    dataUpdateCount: 0,
    dataUpdatedAt: n ? (r ?? Date.now()) : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: !1,
    status: n ? `success` : `pending`,
    fetchStatus: `idle`,
  };
}
function wl(e) {
  return {
    onFetch: (t, n) => {
      let r = t.options,
        i = t.fetchOptions?.meta?.fetchMore?.direction,
        a = t.state.data?.pages || [],
        o = t.state.data?.pageParams || [],
        s = { pages: [], pageParams: [] },
        c = 0,
        l = async () => {
          let n = !1,
            l = (e) => {
              ll(
                e,
                () => t.signal,
                () => (n = !0),
              );
            },
            u = sl(t.options, t.fetchOptions),
            d = async (e, r, i) => {
              if (n) return Promise.reject();
              if (r == null && e.pages.length) return Promise.resolve(e);
              let a = await u(
                  (() => {
                    let e = {
                      client: t.client,
                      queryKey: t.queryKey,
                      pageParam: r,
                      direction: i ? `backward` : `forward`,
                      meta: t.options.meta,
                    };
                    return (l(e), e);
                  })(),
                ),
                { maxPages: o } = t.options,
                s = i ? al : il;
              return { pages: s(e.pages, a, o), pageParams: s(e.pageParams, r, o) };
            };
          if (i && a.length) {
            let e = i === `backward`,
              t = e ? El : Tl,
              n = { pages: a, pageParams: o };
            s = await d(n, t(r, n), e);
          } else {
            let t = e ?? a.length;
            do {
              let e = c === 0 ? (o[0] ?? r.initialPageParam) : Tl(r, s);
              if (c > 0 && e == null) break;
              ((s = await d(s, e)), c++);
            } while (c < t);
          }
          return s;
        };
      t.options.persister
        ? (t.fetchFn = () =>
            t.options.persister?.(
              l,
              { client: t.client, queryKey: t.queryKey, meta: t.options.meta, signal: t.signal },
              n,
            ))
        : (t.fetchFn = l);
    },
  };
}
function Tl(e, { pages: t, pageParams: n }) {
  let r = t.length - 1;
  return t.length > 0 ? e.getNextPageParam(t[r], t, n[r], n) : void 0;
}
function El(e, { pages: t, pageParams: n }) {
  return t.length > 0 ? e.getPreviousPageParam?.(t[0], t, n[0], n) : void 0;
}
var Dl = class extends yl {
  #e;
  #t;
  #n;
  #r;
  constructor(e) {
    (super(),
      (this.#e = e.client),
      (this.mutationId = e.mutationId),
      (this.#n = e.mutationCache),
      (this.#t = []),
      (this.state = e.state || Ol()),
      this.setOptions(e.options),
      this.scheduleGc());
  }
  setOptions(e) {
    ((this.options = e), this.updateGcTime(this.options.gcTime));
  }
  get meta() {
    return this.options.meta;
  }
  addObserver(e) {
    this.#t.includes(e) ||
      (this.#t.push(e),
      this.clearGcTimeout(),
      this.#n.notify({ type: `observerAdded`, mutation: this, observer: e }));
  }
  removeObserver(e) {
    ((this.#t = this.#t.filter((t) => t !== e)),
      this.scheduleGc(),
      this.#n.notify({ type: `observerRemoved`, mutation: this, observer: e }));
  }
  optionalRemove() {
    this.#t.length || (this.state.status === `pending` ? this.scheduleGc() : this.#n.remove(this));
  }
  continue() {
    return this.#r?.continue() ?? this.execute(this.state.variables);
  }
  async execute(e) {
    let t = () => {
        this.#i({ type: `continue` });
      },
      n = { client: this.#e, meta: this.options.meta, mutationKey: this.options.mutationKey };
    this.#r = vl({
      fn: () =>
        this.options.mutationFn
          ? this.options.mutationFn(e, n)
          : Promise.reject(Error(`No mutationFn found`)),
      onFail: (e, t) => {
        this.#i({ type: `failed`, failureCount: e, error: t });
      },
      onPause: () => {
        this.#i({ type: `pause` });
      },
      onContinue: t,
      retry: this.options.retry ?? 0,
      retryDelay: this.options.retryDelay,
      networkMode: this.options.networkMode,
      canRun: () => this.#n.canRun(this),
    });
    let r = this.state.status === `pending`,
      i = !this.#r.canStart();
    try {
      if (r) t();
      else {
        (this.#i({ type: `pending`, variables: e, isPaused: i }),
          this.#n.config.onMutate && (await this.#n.config.onMutate(e, this, n)));
        let t = await this.options.onMutate?.(e, n);
        t !== this.state.context &&
          this.#i({ type: `pending`, context: t, variables: e, isPaused: i });
      }
      let a = await this.#r.start();
      return (
        await this.#n.config.onSuccess?.(a, e, this.state.context, this, n),
        await this.options.onSuccess?.(a, e, this.state.context, n),
        await this.#n.config.onSettled?.(
          a,
          null,
          this.state.variables,
          this.state.context,
          this,
          n,
        ),
        await this.options.onSettled?.(a, null, e, this.state.context, n),
        this.#i({ type: `success`, data: a }),
        a
      );
    } catch (t) {
      try {
        await this.#n.config.onError?.(t, e, this.state.context, this, n);
      } catch (e) {
        Promise.reject(e);
      }
      try {
        await this.options.onError?.(t, e, this.state.context, n);
      } catch (e) {
        Promise.reject(e);
      }
      try {
        await this.#n.config.onSettled?.(
          void 0,
          t,
          this.state.variables,
          this.state.context,
          this,
          n,
        );
      } catch (e) {
        Promise.reject(e);
      }
      try {
        await this.options.onSettled?.(void 0, t, e, this.state.context, n);
      } catch (e) {
        Promise.reject(e);
      }
      throw (this.#i({ type: `error`, error: t }), t);
    } finally {
      this.#n.runNext(this);
    }
  }
  #i(e) {
    let t = (t) => {
      switch (e.type) {
        case `failed`:
          return { ...t, failureCount: e.failureCount, failureReason: e.error };
        case `pause`:
          return { ...t, isPaused: !0 };
        case `continue`:
          return { ...t, isPaused: !1 };
        case `pending`:
          return {
            ...t,
            context: e.context,
            data: void 0,
            failureCount: 0,
            failureReason: null,
            error: null,
            isPaused: e.isPaused,
            status: `pending`,
            variables: e.variables,
            submittedAt: Date.now(),
          };
        case `success`:
          return {
            ...t,
            data: e.data,
            failureCount: 0,
            failureReason: null,
            error: null,
            status: `success`,
            isPaused: !1,
          };
        case `error`:
          return {
            ...t,
            data: void 0,
            error: e.error,
            failureCount: t.failureCount + 1,
            failureReason: e.error,
            isPaused: !1,
            status: `error`,
          };
      }
    };
    ((this.state = t(this.state)),
      pl.batch(() => {
        (this.#t.forEach((t) => {
          t.onMutationUpdate(e);
        }),
          this.#n.notify({ mutation: this, type: `updated`, action: e }));
      }));
  }
};
function Ol() {
  return {
    context: void 0,
    data: void 0,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: !1,
    status: `idle`,
    variables: void 0,
    submittedAt: 0,
  };
}
var kl = class extends Pc {
  constructor(e = {}) {
    (super(), (this.config = e), (this.#e = new Set()), (this.#t = new Map()), (this.#n = 0));
  }
  #e;
  #t;
  #n;
  build(e, t, n) {
    let r = new Dl({
      client: e,
      mutationCache: this,
      mutationId: ++this.#n,
      options: e.defaultMutationOptions(t),
      state: n,
    });
    return (this.add(r), r);
  }
  add(e) {
    this.#e.add(e);
    let t = Al(e);
    if (typeof t == `string`) {
      let n = this.#t.get(t);
      n ? n.push(e) : this.#t.set(t, [e]);
    }
    this.notify({ type: `added`, mutation: e });
  }
  remove(e) {
    if (this.#e.delete(e)) {
      let t = Al(e);
      if (typeof t == `string`) {
        let n = this.#t.get(t);
        if (n)
          if (n.length > 1) {
            let t = n.indexOf(e);
            t !== -1 && n.splice(t, 1);
          } else n[0] === e && this.#t.delete(t);
      }
    }
    this.notify({ type: `removed`, mutation: e });
  }
  canRun(e) {
    let t = Al(e);
    if (typeof t == `string`) {
      let n = this.#t.get(t)?.find((e) => e.state.status === `pending`);
      return !n || n === e;
    } else return !0;
  }
  runNext(e) {
    let t = Al(e);
    return typeof t == `string`
      ? (this.#t.get(t)?.find((t) => t !== e && t.state.isPaused)?.continue() ?? Promise.resolve())
      : Promise.resolve();
  }
  clear() {
    pl.batch(() => {
      (this.#e.forEach((e) => {
        this.notify({ type: `removed`, mutation: e });
      }),
        this.#e.clear(),
        this.#t.clear());
    });
  }
  getAll() {
    return Array.from(this.#e);
  }
  find(e) {
    let t = { exact: !0, ...e };
    return this.getAll().find((e) => Kc(t, e));
  }
  findAll(e = {}) {
    return this.getAll().filter((t) => Kc(e, t));
  }
  notify(e) {
    pl.batch(() => {
      this.listeners.forEach((t) => {
        t(e);
      });
    });
  }
  resumePausedMutations() {
    let e = this.getAll().filter((e) => e.state.isPaused);
    return pl.batch(() => Promise.all(e.map((e) => e.continue().catch(U))));
  }
};
function Al(e) {
  return e.options.scope?.id;
}
var jl = class extends Pc {
    constructor(e = {}) {
      (super(), (this.config = e), (this.#e = new Map()));
    }
    #e;
    build(e, t, n) {
      let r = t.queryKey,
        i = t.queryHash ?? qc(r, t),
        a = this.get(i);
      return (
        a ||
          ((a = new bl({
            client: e,
            queryKey: r,
            queryHash: i,
            options: e.defaultQueryOptions(t),
            state: n,
            defaultOptions: e.getQueryDefaults(r),
          })),
          this.add(a)),
        a
      );
    }
    add(e) {
      this.#e.has(e.queryHash) ||
        (this.#e.set(e.queryHash, e), this.notify({ type: `added`, query: e }));
    }
    remove(e) {
      let t = this.#e.get(e.queryHash);
      t &&
        (e.destroy(),
        t === e && this.#e.delete(e.queryHash),
        this.notify({ type: `removed`, query: e }));
    }
    clear() {
      pl.batch(() => {
        this.getAll().forEach((e) => {
          this.remove(e);
        });
      });
    }
    get(e) {
      return this.#e.get(e);
    }
    getAll() {
      return [...this.#e.values()];
    }
    find(e) {
      let t = { exact: !0, ...e };
      return this.getAll().find((e) => Gc(t, e));
    }
    findAll(e = {}) {
      let t = this.getAll();
      return Object.keys(e).length > 0 ? t.filter((t) => Gc(e, t)) : t;
    }
    notify(e) {
      pl.batch(() => {
        this.listeners.forEach((t) => {
          t(e);
        });
      });
    }
    onFocus() {
      pl.batch(() => {
        this.getAll().forEach((e) => {
          e.onFocus();
        });
      });
    }
    onOnline() {
      pl.batch(() => {
        this.getAll().forEach((e) => {
          e.onOnline();
        });
      });
    }
  },
  Ml = class {
    #e;
    #t;
    #n;
    #r;
    #i;
    #a;
    #o;
    #s;
    constructor(e = {}) {
      ((this.#e = e.queryCache || new jl()),
        (this.#t = e.mutationCache || new kl()),
        (this.#n = e.defaultOptions || {}),
        (this.#r = new Map()),
        (this.#i = new Map()),
        (this.#a = 0));
    }
    mount() {
      (this.#a++,
        this.#a === 1 &&
          ((this.#o = Fc.subscribe(async (e) => {
            e && (await this.resumePausedMutations(), this.#e.onFocus());
          })),
          (this.#s = ml.subscribe(async (e) => {
            e && (await this.resumePausedMutations(), this.#e.onOnline());
          }))));
    }
    unmount() {
      (this.#a--,
        this.#a === 0 && (this.#o?.(), (this.#o = void 0), this.#s?.(), (this.#s = void 0)));
    }
    isFetching(e) {
      return this.#e.findAll({ ...e, fetchStatus: `fetching` }).length;
    }
    isMutating(e) {
      return this.#t.findAll({ ...e, status: `pending` }).length;
    }
    getQueryData(e) {
      let t = this.defaultQueryOptions({ queryKey: e });
      return this.#e.get(t.queryHash)?.state.data;
    }
    ensureQueryData(e) {
      let t = this.defaultQueryOptions(e),
        n = this.#e.build(this, t),
        r = n.state.data;
      return r === void 0
        ? this.fetchQuery(e)
        : (e.revalidateIfStale && n.isStaleByTime(Uc(t.staleTime, n)) && this.prefetchQuery(t),
          Promise.resolve(r));
    }
    getQueriesData(e) {
      return this.#e.findAll(e).map(({ queryKey: e, state: t }) => [e, t.data]);
    }
    setQueryData(e, t, n) {
      let r = this.defaultQueryOptions({ queryKey: e }),
        i = this.#e.get(r.queryHash)?.state.data,
        a = Bc(t, i);
      if (a !== void 0) return this.#e.build(this, r).setData(a, { ...n, manual: !0 });
    }
    setQueriesData(e, t, n) {
      return pl.batch(() =>
        this.#e.findAll(e).map(({ queryKey: e }) => [e, this.setQueryData(e, t, n)]),
      );
    }
    getQueryState(e) {
      let t = this.defaultQueryOptions({ queryKey: e });
      return this.#e.get(t.queryHash)?.state;
    }
    removeQueries(e) {
      let t = this.#e;
      pl.batch(() => {
        t.findAll(e).forEach((e) => {
          t.remove(e);
        });
      });
    }
    resetQueries(e, t) {
      let n = this.#e;
      return pl.batch(
        () => (
          n.findAll(e).forEach((e) => {
            e.reset();
          }),
          this.refetchQueries({ type: `active`, ...e }, t)
        ),
      );
    }
    cancelQueries(e, t = {}) {
      let n = { revert: !0, ...t },
        r = pl.batch(() => this.#e.findAll(e).map((e) => e.cancel(n)));
      return Promise.all(r).then(U).catch(U);
    }
    invalidateQueries(e, t = {}) {
      return pl.batch(
        () => (
          this.#e.findAll(e).forEach((e) => {
            e.invalidate();
          }),
          e?.refetchType === `none`
            ? Promise.resolve()
            : this.refetchQueries({ ...e, type: e?.refetchType ?? e?.type ?? `active` }, t)
        ),
      );
    }
    refetchQueries(e, t = {}) {
      let n = { ...t, cancelRefetch: t.cancelRefetch ?? !0 },
        r = pl.batch(() =>
          this.#e
            .findAll(e)
            .filter((e) => !e.isDisabled() && !e.isStatic())
            .map((e) => {
              let t = e.fetch(void 0, n);
              return (
                n.throwOnError || (t = t.catch(U)),
                e.state.fetchStatus === `paused` ? Promise.resolve() : t
              );
            }),
        );
      return Promise.all(r).then(U);
    }
    fetchQuery(e) {
      let t = this.defaultQueryOptions(e);
      t.retry === void 0 && (t.retry = !1);
      let n = this.#e.build(this, t);
      return n.isStaleByTime(Uc(t.staleTime, n)) ? n.fetch(t) : Promise.resolve(n.state.data);
    }
    prefetchQuery(e) {
      return this.fetchQuery(e).then(U).catch(U);
    }
    fetchInfiniteQuery(e) {
      return ((e.behavior = wl(e.pages)), this.fetchQuery(e));
    }
    prefetchInfiniteQuery(e) {
      return this.fetchInfiniteQuery(e).then(U).catch(U);
    }
    ensureInfiniteQueryData(e) {
      return ((e.behavior = wl(e.pages)), this.ensureQueryData(e));
    }
    resumePausedMutations() {
      return ml.isOnline() ? this.#t.resumePausedMutations() : Promise.resolve();
    }
    getQueryCache() {
      return this.#e;
    }
    getMutationCache() {
      return this.#t;
    }
    getDefaultOptions() {
      return this.#n;
    }
    setDefaultOptions(e) {
      this.#n = e;
    }
    setQueryDefaults(e, t) {
      this.#r.set(Jc(e), { queryKey: e, defaultOptions: t });
    }
    getQueryDefaults(e) {
      let t = [...this.#r.values()],
        n = {};
      return (
        t.forEach((t) => {
          Yc(e, t.queryKey) && Object.assign(n, t.defaultOptions);
        }),
        n
      );
    }
    setMutationDefaults(e, t) {
      this.#i.set(Jc(e), { mutationKey: e, defaultOptions: t });
    }
    getMutationDefaults(e) {
      let t = [...this.#i.values()],
        n = {};
      return (
        t.forEach((t) => {
          Yc(e, t.mutationKey) && Object.assign(n, t.defaultOptions);
        }),
        n
      );
    }
    defaultQueryOptions(e) {
      if (e._defaulted) return e;
      let t = { ...this.#n.queries, ...this.getQueryDefaults(e.queryKey), ...e, _defaulted: !0 };
      return (
        (t.queryHash ||= qc(t.queryKey, t)),
        t.refetchOnReconnect === void 0 && (t.refetchOnReconnect = t.networkMode !== `always`),
        t.throwOnError === void 0 && (t.throwOnError = !!t.suspense),
        !t.networkMode && t.persister && (t.networkMode = `offlineFirst`),
        t.queryFn === ol && (t.enabled = !1),
        t
      );
    }
    defaultMutationOptions(e) {
      return e?._defaulted
        ? e
        : {
            ...this.#n.mutations,
            ...(e?.mutationKey && this.getMutationDefaults(e.mutationKey)),
            ...e,
            _defaulted: !0,
          };
    }
    clear() {
      (this.#e.clear(), this.#t.clear());
    }
  },
  Nl = B.createContext(void 0),
  Pl = (e) => {
    let t = B.useContext(Nl);
    if (e) return e;
    if (!t) throw Error(`No QueryClient set, use QueryClientProvider to set one`);
    return t;
  },
  Fl = ({ client: e, children: t }) => (
    B.useEffect(
      () => (
        e.mount(),
        () => {
          e.unmount();
        }
      ),
      [e],
    ),
    (0, V.jsx)(Nl.Provider, { value: e, children: t })
  ),
  Il = new Ml(),
  Ll = oc({
    head: () => ({
      meta: [
        { charSet: `utf-8` },
        { name: `viewport`, content: `width=device-width, initial-scale=1` },
        { title: `oRPC + TanStack Start on CF Workers` },
      ],
    }),
    component: () =>
      (0, V.jsx)(Fl, { client: Il, children: (0, V.jsx)(Rl, { children: (0, V.jsx)(vc, {}) }) }),
  });
function Rl({ children: e }) {
  return (0, V.jsxs)(`html`, {
    lang: `en`,
    children: [
      (0, V.jsxs)(`head`, {
        children: [
          (0, V.jsx)(jc, {}),
          (0, V.jsx)(`style`, {
            dangerouslySetInnerHTML: {
              __html: `
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; }
          nav { padding: 0.75rem 1.5rem; border-bottom: 1px solid #222; display: flex; gap: 1rem; align-items: center; }
          nav a { color: #60a5fa; text-decoration: none; font-size: 0.9rem; }
          nav a:hover { text-decoration: underline; }
          nav a[data-status="active"] { color: #f59e0b; font-weight: bold; }
          main { padding: 2rem; max-width: 700px; margin: 0 auto; }
          h1 { font-size: 1.4rem; margin-bottom: 1rem; }
          p { line-height: 1.6; color: #aaa; margin-bottom: 1rem; }
          code { color: #f59e0b; font-size: 0.85em; }
          button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
          button:hover { border-color: #555; }
          button:disabled { opacity: 0.5; cursor: default; }
          .btn-primary { background: #1e3a5f; border-color: #2563eb; color: #93c5fd; }
          .btn-danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
          pre { background: #111; border: 1px solid #222; border-radius: 8px; padding: 1rem; font-size: 0.8rem; overflow: auto; color: #4ade80; line-height: 1.6; }
          input[type="text"], input[type="number"] { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.85rem; outline: none; }
          input:focus { border-color: #60a5fa; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; background: #166534; color: #4ade80; }
          .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 0.75rem 1rem; }
          .card:hover { border-color: #444; }
        `,
            },
          }),
        ],
      }),
      (0, V.jsxs)(`body`, {
        children: [
          (0, V.jsxs)(`nav`, {
            children: [
              (0, V.jsx)(`strong`, {
                style: { color: `#fff`, fontSize: `0.95rem` },
                children: `Facet App`,
              }),
              (0, V.jsx)(tc, { to: `/`, children: `Home` }),
              (0, V.jsx)(tc, { to: `/things`, children: `Things` }),
              (0, V.jsx)(tc, { to: `/stream`, children: `Stream` }),
              (0, V.jsx)(tc, { to: `/terminal`, children: `Terminal` }),
              (0, V.jsx)(`a`, {
                href: `/api/docs`,
                target: `_blank`,
                style: { color: `#888` },
                children: `API Docs`,
              }),
              (0, V.jsx)(`span`, { className: `badge`, children: `DO Facet` }),
            ],
          }),
          e,
          (0, V.jsx)(Mc, {}),
        ],
      }),
    ],
  });
}
var zl = `modulepreload`,
  Bl = function (e) {
    return `/` + e;
  },
  G = {},
  K = function (e, t, n) {
    let r = Promise.resolve();
    if (t && t.length > 0) {
      let e = document.getElementsByTagName(`link`),
        i = document.querySelector(`meta[property=csp-nonce]`),
        a = i?.nonce || i?.getAttribute(`nonce`);
      function o(e) {
        return Promise.all(
          e.map((e) =>
            Promise.resolve(e).then(
              (e) => ({ status: `fulfilled`, value: e }),
              (e) => ({ status: `rejected`, reason: e }),
            ),
          ),
        );
      }
      r = o(
        t.map((t) => {
          if (((t = Bl(t, n)), t in G)) return;
          G[t] = !0;
          let r = t.endsWith(`.css`),
            i = r ? `[rel="stylesheet"]` : ``;
          if (n)
            for (let n = e.length - 1; n >= 0; n--) {
              let i = e[n];
              if (i.href === t && (!r || i.rel === `stylesheet`)) return;
            }
          else if (document.querySelector(`link[href="${t}"]${i}`)) return;
          let o = document.createElement(`link`);
          if (
            ((o.rel = r ? `stylesheet` : zl),
            r || (o.as = `script`),
            (o.crossOrigin = ``),
            (o.href = t),
            a && o.setAttribute(`nonce`, a),
            document.head.appendChild(o),
            r)
          )
            return new Promise((e, n) => {
              (o.addEventListener(`load`, e),
                o.addEventListener(`error`, () => n(Error(`Unable to preload CSS for ${t}`))));
            });
        }),
      );
    }
    function i(e) {
      let t = new Event(`vite:preloadError`, { cancelable: !0 });
      if (((t.payload = e), window.dispatchEvent(t), !t.defaultPrevented)) throw e;
    }
    return r.then((t) => {
      for (let e of t || []) e.status === `rejected` && i(e.reason);
      return e().catch(i);
    });
  },
  q = sc(`/things`)({
    component: lc(
      () => K(() => import(`./things-BkvK_53i.js`), __vite__mapDeps([0, 1, 2])),
      `component`,
    ),
  }),
  J = sc(`/terminal`)({
    component: lc(
      () => K(() => import(`./terminal-tpukXwcz.js`), __vite__mapDeps([3, 1])),
      `component`,
    ),
  }),
  Y = sc(`/stream`)({
    component: lc(
      () => K(() => import(`./stream-h1H4kUpO.js`), __vite__mapDeps([4, 1, 2])),
      `component`,
    ),
  });
function Vl(e) {
  return e !== `__proto__` && e !== `constructor` && e !== `prototype`;
}
function Hl(e, t) {
  let n = Object.create(null);
  if (e) for (let t of Object.keys(e)) Vl(t) && (n[t] = e[t]);
  if (t && typeof t == `object`) for (let e of Object.keys(t)) Vl(e) && (n[e] = t[e]);
  return n;
}
function Ul(e) {
  if (!e) return Object.create(null);
  let t = Object.create(null);
  for (let n of Object.keys(e)) Vl(n) && (t[n] = e[n]);
  return t;
}
var Wl = () => {
    throw Error(`createServerOnlyFn() functions can only be called on the server!`);
  },
  Gl = (e, t) => {
    let n = t || e || {};
    return (
      n.method === void 0 && (n.method = `GET`),
      Object.assign((e) => Gl(void 0, { ...n, ...e }), {
        options: n,
        middleware: (e) => {
          let t = [...(n.middleware || [])];
          e.map((e) => {
            f in e ? e.options.middleware && t.push(...e.options.middleware) : t.push(e);
          });
          let r = Gl(void 0, { ...n, middleware: t });
          return ((r[f] = !0), r);
        },
        inputValidator: (e) => Gl(void 0, { ...n, inputValidator: e }),
        handler: (...e) => {
          let [t, r] = e,
            i = { ...n, extractedFn: t, serverFn: r },
            a = [...(i.middleware || []), Jl(i)];
          return (
            (t.method = n.method),
            Object.assign(
              async (e) => {
                let n = await X(a, `client`, {
                    ...t,
                    ...i,
                    data: e?.data,
                    headers: e?.headers,
                    signal: e?.signal,
                    fetch: e?.fetch,
                    context: Ul(),
                  }),
                  r = yt(n.error);
                if (r) throw r;
                if (n.error) throw n.error;
                return n.result;
              },
              {
                ...t,
                method: n.method,
                __executeServer: async (e) => {
                  let n = Wl(),
                    r = n.contextAfterGlobalMiddlewares;
                  return await X(a, `server`, {
                    ...t,
                    ...e,
                    serverFnMeta: t.serverFnMeta,
                    context: Hl(e.context, r),
                    request: n.request,
                  }).then((e) => ({ result: e.result, error: e.error, context: e.sendContext }));
                },
              },
            )
          );
        },
      })
    );
  };
async function X(e, t, n) {
  let r = Kl([...(v()?.functionMiddleware || []), ...e]);
  if (t === `server`) {
    let e = Wl({ throwIfNotFound: !1 });
    e?.executedRequestMiddlewares && (r = r.filter((t) => !e.executedRequestMiddlewares.has(t)));
  }
  let i = async (e) => {
    let n = r.shift();
    if (!n) return e;
    try {
      `inputValidator` in n.options &&
        n.options.inputValidator &&
        t === `server` &&
        (e.data = await ql(n.options.inputValidator, e.data));
      let r;
      if (
        (t === `client`
          ? `client` in n.options && (r = n.options.client)
          : `server` in n.options && (r = n.options.server),
        r)
      ) {
        let t = async (t = {}) => {
            let n = await i({
              ...e,
              ...t,
              context: Hl(e.context, t.context),
              sendContext: Hl(e.sendContext, t.sendContext),
              headers: Uo(e.headers, t.headers),
              _callSiteFetch: e._callSiteFetch,
              fetch: e._callSiteFetch ?? t.fetch ?? e.fetch,
              result: t.result === void 0 ? (t instanceof Response ? t : e.result) : t.result,
              error: t.error ?? e.error,
            });
            if (n.error) throw n.error;
            return n;
          },
          n = await r({ ...e, next: t });
        if (vt(n)) return { ...e, error: n };
        if (n instanceof Response) return { ...e, result: n };
        if (!n)
          throw Error(
            `User middleware returned undefined. You must call next() or return a result in your middlewares.`,
          );
        return n;
      }
      return i(e);
    } catch (t) {
      return { ...e, error: t };
    }
  };
  return i({
    ...n,
    headers: n.headers || {},
    sendContext: n.sendContext || {},
    context: n.context || Ul(),
    _callSiteFetch: n.fetch,
  });
}
function Kl(e, t = 100) {
  let n = new Set(),
    r = [],
    i = (e, a) => {
      if (a > t)
        throw Error(
          `Middleware nesting depth exceeded maximum of ${t}. Check for circular references.`,
        );
      e.forEach((e) => {
        (e.options.middleware && i(e.options.middleware, a + 1), n.has(e) || (n.add(e), r.push(e)));
      });
    };
  return (i(e, 0), r);
}
async function ql(e, t) {
  if (e == null) return {};
  if (`~standard` in e) {
    let n = await e[`~standard`].validate(t);
    if (n.issues) throw Error(JSON.stringify(n.issues, void 0, 2));
    return n.value;
  }
  if (`parse` in e) return e.parse(t);
  if (typeof e == `function`) return e(t);
  throw Error(`Invalid validator type!`);
}
function Jl(e) {
  return {
    "~types": void 0,
    options: {
      inputValidator: e.inputValidator,
      client: async ({ next: t, sendContext: n, fetch: r, ...i }) => {
        let a = { ...i, context: n, fetch: r };
        return t(await e.extractedFn?.(a));
      },
      server: async ({ next: t, ...n }) => {
        let r = await e.serverFn?.(n);
        return t({ ...n, result: r });
      },
    },
  };
}
var Yl = () => K(() => import(`./routes-ESX7X8jG.js`), __vite__mapDeps([5, 1])),
  Xl = Gl({ method: `GET` }).handler(
    zo(`37e67d3ccf1225b287d37f9049d00eb6cc2b71abed75aa21d6cf45b6bbe99560`),
  ),
  Zl = sc(`/`)({ loader: () => Xl(), component: lc(Yl, `component`) }),
  Ql = q.update({ id: `/things`, path: `/things`, getParentRoute: () => Ll }),
  $l = J.update({ id: `/terminal`, path: `/terminal`, getParentRoute: () => Ll }),
  eu = Y.update({ id: `/stream`, path: `/stream`, getParentRoute: () => Ll }),
  tu = {
    IndexRoute: Zl.update({ id: `/`, path: `/`, getParentRoute: () => Ll }),
    StreamRoute: eu,
    TerminalRoute: $l,
    ThingsRoute: Ql,
  },
  nu = Ll._addFileChildren(tu);
function ru() {
  return Cc({ routeTree: nu, scrollRestoration: !0 });
}
var iu = ru;
async function au() {
  let e = await iu(),
    t = [];
  return (
    (window.__TSS_START_OPTIONS__ = { serializationAdapters: t }),
    t.push(Bo),
    e.options.serializationAdapters && t.push(...e.options.serializationAdapters),
    e.update({ basepath: ``, serializationAdapters: t }),
    e.stores.matchesId.get().length || (await Ko(e)),
    e
  );
}
async function ou() {
  let e = await au();
  return (window.$_TSR?.h(), e);
}
var su;
function cu() {
  return (
    (su ||= ou()), (0, V.jsx)($o, { promise: su, children: (e) => (0, V.jsx)(Ec, { router: e }) })
  );
}
var lu = l();
(0, B.startTransition)(() => {
  (0, lu.hydrateRoot)(document, (0, V.jsx)(B.StrictMode, { children: (0, V.jsx)(cu, {}) }));
});
export {
  ol as _,
  xl as a,
  Fc as b,
  W as c,
  U as d,
  rl as f,
  cl as g,
  Qc as h,
  Ol as i,
  Jc as l,
  Uc as m,
  K as n,
  pl as o,
  Wc as p,
  Pl as r,
  ul as s,
  Zl as t,
  Vc as u,
  Hc as v,
  Pc as x,
  Lc as y,
};
