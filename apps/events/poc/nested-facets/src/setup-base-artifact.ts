// Run once to create the base-template artifact repo with initial app source code.
// Usage: CLOUDFLARE_ACCOUNT_ID=cc7f6f461fbe823c199da2b27f9e0ff3 npx tsx src/setup-base-artifact.ts

import fs from "node:fs";
import { execSync } from "node:child_process";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const TOKEN_FILE = `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`;
const tokenLine = fs
  .readFileSync(TOKEN_FILE, "utf8")
  .split("\n")
  .find((l: string) => l.startsWith("oauth_token"));
const API_TOKEN = tokenLine!.split('"')[1];
const NAMESPACE = "default";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces/${NAMESPACE}`;

async function api(method: string, path: string, body?: object) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return resp.json() as any;
}

// ── App source code ──────────────────────────────────────────────────────────

const CF_ACCOUNT_ID = "cc7f6f461fbe823c199da2b27f9e0ff3";
const CF_WORKER_NAME = "nested-facets-poc";

const AGENTS_APP_SOURCE = `import { DurableObject } from "cloudflare:workers";

export class StreamProcessor extends DurableObject {
  async fetch(req) {
    var evt = await req.json();
    var doId = this.ctx.id.toString();
    console.log("[StreamProcessor] doId=" + doId + " streamPath=" + evt.streamPath);
    var n = (this.ctx.storage.kv.get("count") || 0) + 1;
    this.ctx.storage.kv.put("count", n);
    if (evt.emailSubject) {
      this.ctx.storage.kv.put("emailSubject", evt.emailSubject);
      this.ctx.storage.kv.put("emailFrom", evt.emailFrom);
      this.ctx.storage.kv.put("emailStream", evt.emailStream);
    }
    console.log("[StreamProcessor] count=" + n);
    return Response.json({ layer: 3, doId: doId, streamPath: evt.streamPath, count: n });
  }
}

export class App extends DurableObject {
  ensureTable() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS emails (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'stream_name TEXT NOT NULL,' +
      'message_id TEXT,' +
      'in_reply_to TEXT,' +
      'references_header TEXT,' +
      'from_addr TEXT NOT NULL,' +
      'to_addr TEXT NOT NULL,' +
      'subject TEXT,' +
      'text_body TEXT,' +
      'html_body TEXT,' +
      'date_str TEXT,' +
      'replied_at TEXT,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ')'
    );
  }

  async fetch(req) {
    this.ensureTable();
    var url = new URL(req.url);
    var doId = this.ctx.id.toString();
    console.log("[App] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    // ── POST /emails — inbound email from worker email handler ──
    if (req.method === "POST" && url.pathname === "/emails") {
      var email = await req.json();
      console.log("[App] storing email from=" + email.from + " subject=" + email.subject);
      this.ctx.storage.sql.exec(
        "INSERT INTO emails (stream_name, message_id, in_reply_to, references_header, from_addr, to_addr, subject, text_body, html_body, date_str) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        email.streamName || "default",
        email.messageId || null,
        email.inReplyTo || null,
        email.references || null,
        email.from,
        email.to,
        email.subject || "(no subject)",
        email.text || "",
        email.html || "",
        email.date || null
      );
      var row = this.ctx.storage.sql.exec("SELECT last_insert_rowid() as id").toArray()[0];
      var emailId = row.id;

      // Create a StreamProcessor facet for this email
      var proc = this.ctx.facets.get("email:" + emailId, async function() {
        return { class: this.ctx.exports.StreamProcessor };
      }.bind(this));
      await proc.fetch(new Request("http://localhost/event", {
        method: "POST",
        body: JSON.stringify({ streamPath: "email:" + emailId, emailSubject: email.subject, emailFrom: email.from, emailStream: email.streamName }),
      }));

      return Response.json({ ok: true, emailId: emailId });
    }

    // ── POST /emails/:id/reply — reply to an email ──
    var replyMatch = url.pathname.match(/^\\/emails\\/(\\d+)\\/reply$/);
    if (req.method === "POST" && replyMatch) {
      var id = parseInt(replyMatch[1]);
      var rows = this.ctx.storage.sql.exec("SELECT * FROM emails WHERE id = ?", id).toArray();
      if (rows.length === 0) return Response.json({ error: "not found" }, { status: 404 });
      var em = rows[0];
      this.ctx.storage.sql.exec("UPDATE emails SET replied_at = datetime('now') WHERE id = ?", id);
      // Build References chain: original references + this email's message_id
      var refs = em.references_header ? em.references_header + " " + em.message_id : em.message_id;
      return Response.json({
        ok: true,
        needsSend: true,
        sendPayload: {
          from: em.to_addr,
          to: em.from_addr,
          subject: "Re: " + (em.subject || ""),
          inReplyTo: em.message_id,
          references: refs,
          text: "OK - received and acknowledged."
        }
      });
    }

    // ── GET / — inbox UI + event sender ──
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      var emails = this.ctx.storage.sql.exec("SELECT * FROM emails ORDER BY id DESC").toArray();
      var exportsKeys = Object.keys(this.ctx.exports || {});
      var exportsList = exportsKeys.map(function(k) { return '<li><code>' + k + '</code></li>'; }).join('');
      var cfLogsURL = 'https://dash.cloudflare.com/${CF_ACCOUNT_ID}/workers/services/view/${CF_WORKER_NAME}/production/observability/logs?search=' + doId;
      var cfDOURL = 'https://dash.cloudflare.com/${CF_ACCOUNT_ID}/workers/services/view/${CF_WORKER_NAME}/production/storage/durable-objects';

      var emailCards = emails.map(function(em) {
        var preview = (em.text_body || "").substring(0, 200);
        var repliedBadge = em.replied_at ? '<span style="background:#166534;color:#4ade80;padding:2px 8px;border-radius:4px;font-size:.75rem;margin-left:.5rem">replied</span>' : '';
        var replyBtn = em.replied_at ? '' : '<button onclick="replyEmail(' + em.id + ', this)" style="background:#10b981;margin-top:.5rem">Respond OK</button>';
        return '<div class="card">' +
          '<div style="display:flex;justify-content:space-between;align-items:start">' +
          '<div style="min-width:0;flex:1">' +
          '<div style="font-weight:600;color:#fff">' + (em.subject || '(no subject)') + repliedBadge + '</div>' +
          '<div style="font-size:.85rem;color:#888;margin-top:.25rem">From: ' + em.from_addr + ' &middot; Stream: ' + em.stream_name + '</div>' +
          '<div style="font-size:.8rem;color:#666;margin-top:.25rem">' + (em.date_str || em.created_at) + '</div>' +
          '<div style="font-size:.85rem;margin-top:.5rem;color:#ccc">' + preview + (preview.length >= 200 ? '...' : '') + '</div>' +
          replyBtn +
          '</div></div></div>';
      }).join('');

      var inboxSection = emails.length > 0
        ? '<h2 style="margin-top:1.5rem">Inbox (' + emails.length + ')</h2>' + emailCards
        : '<div class="card" style="text-align:center;color:#666"><p>No emails yet</p><p style="font-size:.85rem;margin-top:.5rem">Send an email to <code>&lt;stream&gt;@&lt;project&gt;.iterate-dev-jonas.app</code></p></div>';

      var html = [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agents App</title>',
        '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:720px;margin:0 auto}',
        'h1{font-size:1.4rem;margin-bottom:.5rem;color:#fff}h2{font-size:1rem;margin:1rem 0 .5rem;color:#aaa}',
        '.card{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1.2rem;margin:1rem 0}',
        'code{font-size:.85rem;background:#222;padding:2px 6px;border-radius:3px}',
        '.big-id{font-size:1.1rem;color:#f59e0b;font-family:monospace;word-break:break-all;margin:.5rem 0}',
        'form{display:flex;gap:.5rem;margin-top:1rem}input{background:#222;border:1px solid #444;color:#fff;padding:.5rem .75rem;border-radius:6px;flex:1;font-family:monospace}',
        'button{background:#3b82f6;color:#fff;border:none;padding:.5rem 1.2rem;border-radius:6px;cursor:pointer;font-weight:600}button:hover{background:#2563eb}',
        'a{color:#60a5fa}ul{list-style:none;padding:0}li{padding:2px 0}',
        '#result{margin-top:1rem;white-space:pre-wrap;font-family:monospace;font-size:.8rem}</style></head><body>',
        '<h1>Agents App</h1>',
        '<div class="big-id">DO: ' + doId + '</div>',
        inboxSection,
        '<div class="card">',
        '<h2>Context Info</h2>',
        '<p><code>this.ctx.id: ' + doId + '</code></p>',
        '<h2>Available Exports</h2>',
        '<ul>' + (exportsList || '<li><em style="color:#666">none</em></li>') + '</ul>',
        '</div>',
        '<div class="card">',
        '<h2>Deep Links</h2>',
        '<ul>',
        '<li><a href="' + cfLogsURL + '" target="_blank">CF Dashboard Logs (filtered to this DO)</a></li>',
        '<li><a href="' + cfDOURL + '" target="_blank">CF Dashboard DO Storage</a></li>',
        '</ul>',
        '</div>',
        '<div class="card">',
        '<b>Send an event</b> — each stream path gets its own StreamProcessor facet with isolated SQLite',
        '<form id="f"><input name="streamPath" value="orders/2026-04" placeholder="streamPath"><button type="submit">POST /events</button></form>',
        '<div id="result"></div>',
        '</div>',
        '<script>',
        'async function replyEmail(id, btn) {',
        '  btn.disabled = true; btn.textContent = "Sending...";',
        '  try {',
        '    var resp = await fetch("/emails/" + id + "/reply", { method: "POST" });',
        '    var d = await resp.json();',
        '    if (d.ok) { btn.textContent = "Replied!"; btn.style.background = "#166534"; setTimeout(function(){ location.reload(); }, 1000); }',
        '    else { btn.textContent = "Error: " + (d.error || "unknown"); btn.style.background = "#7f1d1d"; }',
        '  } catch(err) { btn.textContent = "Error: " + err.message; btn.style.background = "#7f1d1d"; }',
        '}',
        'document.getElementById("f").addEventListener("submit",async function(e){',
        'e.preventDefault();var r=document.getElementById("result");r.textContent="sending...";',
        'try{var resp=await fetch("/events",{method:"POST",headers:{"content-type":"application/json"},',
        'body:JSON.stringify({streamPath:e.target.streamPath.value})});',
        'var d=await resp.json();var i=d.inner||{};',
        'r.innerHTML="<p>App DO: <code>"+d.doId+"</code></p>"+',
        '"<p>StreamProcessor DO: <code>"+i.doId+"</code> stream: <code>"+i.streamPath+"</code></p>"+',
        '"<p style=color:#f59e0b;font-size:1.5rem>count = "+i.count+"</p>"+',
        '"<details><summary style=cursor:pointer;color:#666>Raw JSON</summary><pre>"+JSON.stringify(d,null,2)+"</pre></details>";',
        '}catch(err){r.textContent="Error: "+err.message}});',
        '</script></body></html>',
      ].join("\\n");
      return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (url.pathname === "/probe") {
      var exportsInfo = {};
      for (var key of Object.keys(this.ctx.exports || {})) {
        var val = this.ctx.exports[key];
        exportsInfo[key] = { type: typeof val, constructorName: val && val.constructor ? val.constructor.name : "unknown" };
      }
      return Response.json({ doId: doId, ctxOwnKeys: Object.getOwnPropertyNames(this.ctx), exportsInfo: exportsInfo });
    }

    if (req.method === "POST" && url.pathname === "/events") {
      var evt = await req.clone().json();
      var streamPath = evt.streamPath || "default";
      console.log("[App] received event, streamPath=" + streamPath);

      var proc = this.ctx.facets.get("stream:" + streamPath, async function() {
        return { class: this.ctx.exports.StreamProcessor };
      }.bind(this));

      console.log("[App] forwarding to StreamProcessor facet");
      var inner = await proc.fetch(new Request("http://localhost/event", {
        method: "POST",
        body: JSON.stringify(evt),
      }));
      var innerJson = await inner.json();
      console.log("[App] response from StreamProcessor: " + JSON.stringify(innerJson));
      return Response.json({ layer: 2, doId: doId, from: "App", inner: innerJson });
    }

    return new Response("Agents App: try GET / or POST /events or POST /emails", { status: 404 });
  }
}
`;

const BILLING_APP_SOURCE = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  ensureTable() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS invoices (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'customer TEXT NOT NULL,' +
      'amount REAL NOT NULL,' +
      "status TEXT NOT NULL DEFAULT 'draft'," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ')'
    );
  }

  async fetch(req) {
    this.ensureTable();
    var url = new URL(req.url);
    var doId = this.ctx.id.toString();
    console.log("[BillingApp] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      var rows = this.ctx.storage.sql.exec("SELECT * FROM invoices ORDER BY id DESC").toArray();
      console.log("[BillingApp] listing " + rows.length + " invoices");
      return new Response(this.renderHTML(rows, doId), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }

    if (req.method === "POST" && url.pathname === "/invoices") {
      var body = await req.json();
      console.log("[BillingApp] creating invoice: " + JSON.stringify(body));
      this.ctx.storage.sql.exec(
        "INSERT INTO invoices (customer, amount, status) VALUES (?, ?, ?)",
        body.customer || "Unknown",
        body.amount || 0,
        body.status || "draft"
      );
      var row = this.ctx.storage.sql.exec("SELECT * FROM invoices ORDER BY id DESC LIMIT 1").toArray()[0];
      return Response.json({ ok: true, invoice: row, doId: doId });
    }

    var patchMatch = url.pathname.match(/^\\/invoices\\/(\\d+)$/);
    if (req.method === "PATCH" && patchMatch) {
      var id = parseInt(patchMatch[1]);
      var body = await req.json();
      console.log("[BillingApp] updating invoice " + id + ": " + JSON.stringify(body));
      this.ctx.storage.sql.exec("UPDATE invoices SET status = ? WHERE id = ?", body.status, id);
      var row = this.ctx.storage.sql.exec("SELECT * FROM invoices WHERE id = ?", id).toArray()[0];
      return Response.json({ ok: true, invoice: row, doId: doId });
    }

    var delMatch = url.pathname.match(/^\\/invoices\\/(\\d+)$/);
    if (req.method === "DELETE" && delMatch) {
      var id = parseInt(delMatch[1]);
      console.log("[BillingApp] deleting invoice " + id);
      this.ctx.storage.sql.exec("DELETE FROM invoices WHERE id = ?", id);
      return Response.json({ ok: true, deleted: id, doId: doId });
    }

    if (req.method === "GET" && url.pathname === "/api/invoices") {
      var rows = this.ctx.storage.sql.exec("SELECT * FROM invoices ORDER BY id DESC").toArray();
      return Response.json({ invoices: rows, doId: doId });
    }

    return new Response("BillingApp: try GET / or POST /invoices", { status: 404 });
  }

  renderHTML(invoices, doId) {
    var rows = invoices.map(function(inv) {
      return '<tr>' +
        '<td>' + inv.id + '</td>' +
        '<td>' + inv.customer + '</td>' +
        '<td>$' + Number(inv.amount).toFixed(2) + '</td>' +
        '<td><select onchange="updateStatus(' + inv.id + ', this.value)">' +
          ['draft','sent','paid','void'].map(function(s) {
            return '<option' + (s === inv.status ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select></td>' +
        '<td>' + inv.created_at + '</td>' +
        '<td><button onclick="deleteInvoice(' + inv.id + ')" style="color:#f87171">x</button></td>' +
        '</tr>';
    }).join('');

    return [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Billing App</title>',
      '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:800px;margin:0 auto}',
      'h1{font-size:1.4rem;margin-bottom:.5rem;color:#fff}.card{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1.2rem;margin:1rem 0}',
      'table{width:100%;border-collapse:collapse}th{text-align:left;padding:.5rem;border-bottom:1px solid #444;color:#aaa;font-size:.8rem}',
      'td{padding:.5rem;border-bottom:1px solid #222}input,select{background:#222;border:1px solid #444;color:#fff;padding:.4rem .6rem;border-radius:4px;font-family:monospace}',
      'button{background:#3b82f6;color:#fff;border:none;padding:.4rem .8rem;border-radius:4px;cursor:pointer}button:hover{background:#2563eb}',
      'form{display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap}code{font-size:.75rem;color:#888}</style></head><body>',
      '<h1>Billing App</h1><p><code>DO ID: ' + doId + '</code></p>',
      '<div class="card"><b>Create invoice</b><form id="f">',
      '<input name="customer" placeholder="Customer" required>',
      '<input name="amount" type="number" step="0.01" placeholder="Amount" required>',
      '<button type="submit">Create</button></form></div>',
      '<table><thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr></thead>',
      '<tbody>' + rows + '</tbody></table>',
      '<script>',
      'document.getElementById("f").addEventListener("submit",async function(e){e.preventDefault();var fd=new FormData(e.target);',
      'await fetch("/invoices",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({customer:fd.get("customer"),amount:parseFloat(fd.get("amount"))})});location.reload()});',
      'async function updateStatus(id,s){await fetch("/invoices/"+id,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:s})})}',
      'async function deleteInvoice(id){if(!confirm("Delete?"))return;await fetch("/invoices/"+id,{method:"DELETE"});location.reload()}',
      '</script></body></html>',
    ].join('\\n');
  }
}
`;

// Counter app — multi-file TS+React project (requires Build step)
const COUNTER_PACKAGE_JSON = JSON.stringify(
  {
    name: "counter",
    dependencies: {
      react: "^19",
      "react-dom": "^19",
    },
  },
  null,
  2,
);

const COUNTER_WORKER_TS = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const doId = this.ctx.id.toString();
    console.log("[CounterApp] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    // WebSocket upgrade on /api/ws
    if (req.headers.get("Upgrade") === "websocket" && url.pathname === "/api/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const count = this.ctx.storage.kv.get("count") || 0;
      pair[1].send(JSON.stringify({ type: "sync", count }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // API endpoints
    if (req.method === "POST" && url.pathname === "/api/increment") {
      const count = ((this.ctx.storage.kv.get("count") as number) || 0) + 1;
      this.ctx.storage.kv.put("count", count);
      this.broadcast(count);
      return Response.json({ count, doId });
    }

    if (req.method === "POST" && url.pathname === "/api/decrement") {
      const count = ((this.ctx.storage.kv.get("count") as number) || 0) - 1;
      this.ctx.storage.kv.put("count", count);
      this.broadcast(count);
      return Response.json({ count, doId });
    }

    if (req.method === "GET" && url.pathname === "/api/count") {
      const count = this.ctx.storage.kv.get("count") || 0;
      return Response.json({ count, doId });
    }

    // For all other GET requests, return null — the asset handler in the Project DO will serve the SPA
    return new Response("Not found", { status: 404 });
  }

  broadcast(count: number) {
    const msg = JSON.stringify({ type: "sync", count });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch (e: any) { console.log("[CounterApp] ws send error: " + e.message); }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message as string);
      let count = (this.ctx.storage.kv.get("count") as number) || 0;
      if (data.action === "increment") count++;
      else if (data.action === "decrement") count--;
      this.ctx.storage.kv.put("count", count);
      this.broadcast(count);
    } catch (e: any) {
      console.log("[CounterApp] ws message error: " + e.message);
    }
  }

  async webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
`;

const COUNTER_CLIENT_TSX = `import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState<number>(0);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(proto + "//" + location.host + "/api/ws");
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.count !== undefined) setCount(d.count);
        } catch {}
      };
    }
    connect();
    return () => { wsRef.current?.close(); };
  }, []);

  function send(action: string) {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ action }));
    }
  }

  return (
    <div style={{
      fontFamily: "system-ui, sans-serif",
      background: "#0a0a0a",
      color: "#e0e0e0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
    }}>
      <img src="/logo.svg" alt="Counter" style={{ width: 64, height: 64, marginBottom: "0.5rem" }} />
      <h1 style={{ fontSize: "1.4rem", marginBottom: ".5rem", color: "#fff" }}>
        Counter App
      </h1>
      <div style={{
        fontSize: "6rem",
        fontWeight: 700,
        color: "#f59e0b",
        margin: "2rem 0",
        fontFamily: "monospace",
        minWidth: 200,
        textAlign: "center",
      }}>
        {count}
      </div>
      <div style={{ display: "flex", gap: "1rem" }}>
        <button
          onClick={() => send("decrement")}
          style={{
            fontSize: "2rem", width: 80, height: 80, borderRadius: "50%",
            border: "2px solid #7f1d1d", background: "#1a1a1a", color: "#f87171",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          -
        </button>
        <button
          onClick={() => send("increment")}
          style={{
            fontSize: "2rem", width: 80, height: 80, borderRadius: "50%",
            border: "2px solid #166534", background: "#1a1a1a", color: "#4ade80",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          +
        </button>
      </div>
      <div style={{
        fontSize: ".8rem", marginTop: "1rem", padding: "4px 12px",
        borderRadius: 12, background: "#1a1a1a",
        border: connected ? "1px solid #166534" : "1px solid #7f1d1d",
        color: connected ? "#4ade80" : "#f87171",
      }}>
        {connected ? "connected" : "disconnected"}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Counter />);
`;

// SVG logo served from public/ via workspace.readFileBytes()
const COUNTER_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <circle cx="60" cy="60" r="56" stroke="#f59e0b" stroke-width="4" fill="#1a1a1a"/>
  <text x="60" y="72" text-anchor="middle" font-family="system-ui" font-size="48" font-weight="700" fill="#f59e0b">#</text>
</svg>`;

// Tiny 1x1 orange PNG (68 bytes) — proves binary image serving works
const COUNTER_TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8H8BQDwAFegHS8+X7mgAAAABJRU5ErkJggg==";

const COUNTER_INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Counter App</title>
  <style>* { margin: 0; padding: 0; box-sizing: border-box; }</style>
</head>
<body>
  <div id="root"></div>
</body>
</html>
`;

// Chatbot app — plain JS, uses OpenAI API via egress proxy secret substitution
const CHATBOT_APP_SOURCE = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  ensureTable() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS messages (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'role TEXT NOT NULL,' +
      'content TEXT NOT NULL,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ')'
    );
  }

  async fetch(req) {
    this.ensureTable();
    var url = new URL(req.url);
    var doId = this.ctx.id.toString();
    console.log("[Chatbot] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    // ── POST /api/chat — send message, get OpenAI response ──
    if (req.method === "POST" && url.pathname === "/api/chat") {
      var body = await req.json();
      var userMessage = body.message;
      if (!userMessage) return Response.json({ error: "message required" }, { status: 400 });

      // Store user message
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (role, content) VALUES (?, ?)",
        "user", userMessage
      );

      // Build message history for OpenAI
      var history = this.ctx.storage.sql.exec(
        "SELECT role, content FROM messages ORDER BY id"
      ).toArray();

      var messages = [
        { role: "system", content: "You are a helpful assistant." },
      ];
      for (var i = 0; i < history.length; i++) {
        messages.push({ role: history[i].role, content: history[i].content });
      }

      // Call OpenAI — the sentinel string gets replaced by the egress gateway
      var resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer getIterateSecret({secretKey:\\"openai-api-key\\"})",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: messages,
          stream: false,
        }),
      });

      if (!resp.ok) {
        var errText = await resp.text();
        console.error("[Chatbot] OpenAI error: " + resp.status + " " + errText);
        return Response.json({ error: "OpenAI API error", status: resp.status, detail: errText }, { status: 502 });
      }

      var data = await resp.json();
      var assistantMessage = data.choices[0].message.content;

      // Store assistant response
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (role, content) VALUES (?, ?)",
        "assistant", assistantMessage
      );

      return Response.json({ ok: true, message: assistantMessage });
    }

    // ── GET /api/messages — list conversation history ──
    if (req.method === "GET" && url.pathname === "/api/messages") {
      var rows = this.ctx.storage.sql.exec("SELECT * FROM messages ORDER BY id").toArray();
      return Response.json({ messages: rows });
    }

    // ── POST /api/clear — clear conversation ──
    if (req.method === "POST" && url.pathname === "/api/clear") {
      this.ctx.storage.sql.exec("DELETE FROM messages");
      return Response.json({ ok: true });
    }

    // ── GET / — chat UI ──
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(this.renderHTML(doId), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }

    return new Response("Chatbot: try GET / or POST /api/chat", { status: 404 });
  }

  renderHTML(doId) {
    return [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Chatbot</title>',
      '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}',
      '#header{padding:1rem;border-bottom:1px solid #333;display:flex;align-items:center;gap:1rem}',
      '#header h1{font-size:1.2rem;color:#fff}#header code{font-size:.7rem;color:#666}',
      '#header button{background:#333;color:#aaa;border:none;padding:.3rem .6rem;border-radius:4px;cursor:pointer;font-size:.8rem}',
      '#messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.8rem}',
      '.msg{max-width:80%;padding:.8rem 1rem;border-radius:12px;font-size:.9rem;line-height:1.4;white-space:pre-wrap}',
      '.msg.user{align-self:flex-end;background:#1e3a5f;color:#93c5fd;border-bottom-right-radius:4px}',
      '.msg.assistant{align-self:flex-start;background:#1a1a1a;border:1px solid #333;border-bottom-left-radius:4px}',
      '.msg.error{align-self:center;background:#450a0a;color:#f87171;border:1px solid #7f1d1d}',
      '#input-area{padding:1rem;border-top:1px solid #333;display:flex;gap:.5rem}',
      '#input-area input{flex:1;background:#1a1a1a;border:1px solid #444;color:#fff;padding:.6rem .8rem;border-radius:8px;font-size:.9rem;outline:none}',
      '#input-area input:focus{border-color:#3b82f6}',
      '#input-area button{background:#3b82f6;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:8px;cursor:pointer;font-weight:600}',
      '#input-area button:disabled{background:#555;cursor:not-allowed}',
      '</style></head><body>',
      '<div id="header"><h1>Chatbot</h1><code>DO: ' + doId + '</code>',
      '<button onclick="clearChat()">Clear</button></div>',
      '<div id="messages"></div>',
      '<div id="input-area">',
      '<input id="chat-input" placeholder="Type a message..." autofocus>',
      '<button id="send-btn" onclick="sendMessage()">Send</button>',
      '</div>',
      '<script>',
      'var messagesEl = document.getElementById("messages");',
      'var inputEl = document.getElementById("chat-input");',
      'var sendBtn = document.getElementById("send-btn");',
      '',
      'function addMessage(role, content) {',
      '  var div = document.createElement("div");',
      '  div.className = "msg " + role;',
      '  div.textContent = content;',
      '  messagesEl.appendChild(div);',
      '  messagesEl.scrollTop = messagesEl.scrollHeight;',
      '}',
      '',
      'async function loadHistory() {',
      '  var resp = await fetch("/api/messages");',
      '  var data = await resp.json();',
      '  (data.messages || []).forEach(function(m) { addMessage(m.role, m.content); });',
      '}',
      'loadHistory();',
      '',
      'async function sendMessage() {',
      '  var text = inputEl.value.trim();',
      '  if (!text) return;',
      '  inputEl.value = "";',
      '  sendBtn.disabled = true;',
      '  addMessage("user", text);',
      '  try {',
      '    var resp = await fetch("/api/chat", {',
      '      method: "POST",',
      '      headers: { "content-type": "application/json" },',
      '      body: JSON.stringify({ message: text }),',
      '    });',
      '    var data = await resp.json();',
      '    if (data.ok) { addMessage("assistant", data.message); }',
      '    else { addMessage("error", "Error: " + (data.error || "unknown") + (data.detail ? "\\n" + data.detail : "")); }',
      '  } catch (err) { addMessage("error", "Error: " + err.message); }',
      '  sendBtn.disabled = false;',
      '  inputEl.focus();',
      '}',
      '',
      'async function clearChat() {',
      '  if (!confirm("Clear conversation?")) return;',
      '  await fetch("/api/clear", { method: "POST" });',
      '  messagesEl.innerHTML = "";',
      '}',
      '',
      'inputEl.addEventListener("keydown", function(e) {',
      '  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }',
      '});',
      '</script></body></html>',
    ].join("\\n");
  }
}
`;

// ── Main setup ───────────────────────────────────────────────────────────────

async function main() {
  // 1. Create base-template repo
  console.log("Creating base-template repo...");
  let result = await api("POST", "/repos", { name: "base-template" });
  if (!result.success) {
    console.log("Repo might already exist:", result.errors?.[0]?.message);
    result = await api("GET", "/repos/base-template");
    if (!result.success) throw new Error("Failed to get base-template repo");
    result = result.result;
  }
  const remote = result.remote ?? result.result?.remote;
  let token = result.token ?? result.result?.token;
  if (!token) {
    // Existing repo — create a write token
    const tokenResult = await api("POST", "/tokens", {
      repo: "base-template",
      scope: "write",
      ttl: 3600,
    });
    token = tokenResult.result?.plaintext;
  }
  console.log("Remote:", remote);

  // 2. Clone, add files, commit, push using git CLI
  const tmpDir = `/tmp/base-template-${Date.now()}`;
  execSync(`mkdir -p ${tmpDir}`);
  execSync(`git init -b main ${tmpDir}`, { stdio: "pipe" });

  // Write config.json — include chatbot in default apps
  fs.writeFileSync(
    `${tmpDir}/config.json`,
    JSON.stringify({ apps: ["agents", "billing", "counter", "chatbot"] }, null, 2),
  );

  // Write app source files
  fs.mkdirSync(`${tmpDir}/apps/agents`, { recursive: true });
  fs.mkdirSync(`${tmpDir}/apps/billing`, { recursive: true });
  fs.mkdirSync(`${tmpDir}/apps/counter`, { recursive: true });
  fs.mkdirSync(`${tmpDir}/apps/chatbot`, { recursive: true });

  fs.writeFileSync(`${tmpDir}/apps/agents/index.js`, AGENTS_APP_SOURCE);
  fs.writeFileSync(`${tmpDir}/apps/billing/index.js`, BILLING_APP_SOURCE);
  fs.writeFileSync(`${tmpDir}/apps/chatbot/index.js`, CHATBOT_APP_SOURCE);

  // Counter: multi-file TS+React project (requires Build step)
  fs.writeFileSync(`${tmpDir}/apps/counter/package.json`, COUNTER_PACKAGE_JSON);
  fs.writeFileSync(`${tmpDir}/apps/counter/worker.ts`, COUNTER_WORKER_TS);
  fs.writeFileSync(`${tmpDir}/apps/counter/client.tsx`, COUNTER_CLIENT_TSX);
  fs.writeFileSync(`${tmpDir}/apps/counter/index.html`, COUNTER_INDEX_HTML);

  // Counter: public assets (images served via workspace.readFileBytes)
  fs.mkdirSync(`${tmpDir}/apps/counter/public`, { recursive: true });
  fs.writeFileSync(`${tmpDir}/apps/counter/public/logo.svg`, COUNTER_LOGO_SVG);
  fs.writeFileSync(
    `${tmpDir}/apps/counter/public/pixel.png`,
    Buffer.from(COUNTER_TINY_PNG_BASE64, "base64"),
  );

  // Commit and push
  execSync(
    `cd ${tmpDir} && git add -A && git commit -m "Template: agents+billing+chatbot (plain JS), counter (TS+React, needs Build)"`,
    { stdio: "pipe" },
  );
  execSync(`cd ${tmpDir} && git remote add origin "${remote}"`, { stdio: "pipe" });

  // Parse token for auth
  const tokenSecret = token.split("?expires=")[0];
  const authRemote = remote.replace("https://", `https://x:${tokenSecret}@`);
  execSync(
    `cd ${tmpDir} && git remote set-url origin "${authRemote}" && git push -u origin main --force`,
    { stdio: "inherit" },
  );

  console.log("\nBase template created and pushed!");
  console.log(
    `Apps: agents (plain JS), billing (plain JS), chatbot (plain JS, uses egress secrets), counter (TS+React — click Build in editor)`,
  );
  console.log(`Config: config.json`);

  // Cleanup
  execSync(`rm -rf ${tmpDir}`);
}
main();
