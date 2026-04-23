import { i as e, n as t, t as n } from "./jsx-runtime-ByY1xr43.js";
import { n as r } from "./index-BNby28Aj.js";
var i = e(t()),
  a = n();
function o() {
  let e = (0, i.useRef)(null),
    [t, n] = (0, i.useState)(`connecting`);
  (0, i.useEffect)(() => {
    if (!e.current) return;
    let t, i, a;
    return (
      (async () => {
        let { Terminal: o } = await r(async () => {
            let { Terminal: e } = await import(`./xterm-BakbraXI.js`);
            return { Terminal: e };
          }, []),
          { FitAddon: s } = await r(async () => {
            let { FitAddon: e } = await import(`./addon-fit-BuQzzy-m.js`);
            return { FitAddon: e };
          }, []);
        ((i = new o({
          cursorBlink: !0,
          fontSize: 14,
          fontFamily: `'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace`,
          theme: {
            background: `#1e1e1e`,
            foreground: `#d4d4d4`,
            cursor: `#f59e0b`,
            selectionBackground: `#264f78`,
          },
        })),
          (a = new s()),
          i.loadAddon(a),
          i.open(e.current),
          a.fit(),
          i.writeln(`\x1B[1;34m┌─────────────────────────────────────────┐\x1B[0m`),
          i.writeln(
            `\x1B[1;34m│\x1B[0m  \x1B[1;33mTerminal\x1B[0m — Durable Object Facet       \x1B[1;34m│\x1B[0m`,
          ),
          i.writeln(`\x1B[1;34m└─────────────────────────────────────────┘\x1B[0m`),
          i.writeln(``),
          i.writeln(`\x1B[90mConnecting to /api/pty via WebSocket...\x1B[0m`),
          i.writeln(``));
        let c = new URL(`/api/pty`, window.location.origin);
        ((c.protocol = c.protocol === `https:` ? `wss:` : `ws:`),
          (t = new WebSocket(c.toString())),
          (t.onopen = () => {
            (n(`connected`), i.writeln(`\x1B[32m✓ Connected\x1B[0m`), i.writeln(``));
          }),
          (t.onmessage = (e) => {
            i.write(e.data);
          }),
          (t.onclose = (e) => {
            (n(`closed`),
              i.writeln(``),
              i.writeln(
                `\x1b[90mConnection closed (code: ${e.code}${e.reason ? `, reason: ${e.reason}` : ``})\x1b[0m`,
              ));
          }),
          (t.onerror = () => {
            i.writeln(`\x1B[31m✗ WebSocket error\x1B[0m`);
          }),
          i.onData((e) => {
            t?.readyState === WebSocket.OPEN && t.send(e);
          }));
        let l = new ResizeObserver(() => {
          (a?.fit(),
            t?.readyState === WebSocket.OPEN &&
              i &&
              t.send(`\x00resize\x00${JSON.stringify({ cols: i.cols, rows: i.rows })}`));
        });
        return (l.observe(e.current), () => l.disconnect());
      })(),
      () => {
        (t?.close(), i?.dispose());
      }
    );
  }, []);
  let o = t === `connected` ? `#4ade80` : t === `connecting` ? `#fbbf24` : `#888`;
  return (0, a.jsxs)(`div`, {
    style: {
      display: `flex`,
      flexDirection: `column`,
      height: `calc(100vh - 49px)`,
      background: `#1e1e1e`,
    },
    children: [
      (0, a.jsxs)(`div`, {
        style: {
          padding: `0.5rem 1rem`,
          borderBottom: `1px solid #333`,
          display: `flex`,
          alignItems: `center`,
          gap: `0.75rem`,
          background: `#1a1a1a`,
        },
        children: [
          (0, a.jsx)(`span`, {
            style: { fontSize: `0.85rem`, fontWeight: 500, color: `#e0e0e0` },
            children: `Terminal`,
          }),
          (0, a.jsx)(`span`, {
            style: {
              fontSize: `0.7rem`,
              padding: `1px 6px`,
              borderRadius: 4,
              border: `1px solid ${o}33`,
              color: o,
            },
            children: t,
          }),
          (0, a.jsx)(`span`, {
            style: { fontSize: `0.75rem`, color: `#555` },
            children: `WebSocket → /api/pty`,
          }),
        ],
      }),
      (0, a.jsx)(`div`, { ref: e, style: { flex: 1, padding: `4px` } }),
      (0, a.jsx)(`link`, {
        rel: `stylesheet`,
        href: `https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css`,
      }),
    ],
  });
}
export { o as component };
