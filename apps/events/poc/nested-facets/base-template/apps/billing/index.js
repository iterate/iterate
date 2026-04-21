import { DurableObject } from "cloudflare:workers";

// ── SQL Studio helpers ──────────────────────────────────────────────────────

function sqlStudioHTML(name) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    "<title>" +
    name +
    " — SQL Studio</title>" +
    "<style>*{margin:0;padding:0}body,html{height:100%;overflow:hidden}iframe{width:100%;height:100%;border:none}</style>" +
    "</head><body>" +
    '<iframe id="studio" src="https://libsqlstudio.com/embed/sqlite?name=' +
    encodeURIComponent(name) +
    '"></iframe>' +
    "<script>" +
    'window.addEventListener("message", async function(e) {' +
    '  if (e.source !== document.getElementById("studio").contentWindow) return;' +
    "  var msg = e.data;" +
    '  if (!msg || (msg.type !== "query" && msg.type !== "transaction")) return;' +
    "  try {" +
    '    var resp = await fetch("_sql", {' +
    '      method: "POST",' +
    '      headers: { "content-type": "application/json" },' +
    "      body: JSON.stringify(msg)" +
    "    });" +
    "    var result = await resp.json();" +
    '    e.source.postMessage(result, "*");' +
    "  } catch (err) {" +
    '    e.source.postMessage({ type: msg.type, id: msg.id, error: err.message }, "*");' +
    "  }" +
    "});" +
    "</script></body></html>"
  );
}

function runQuery(sql, statement) {
  var cursor = sql.exec(statement);
  var cols = cursor.columnNames;
  var rows = cursor.toArray();
  var headers = cols.map(function (n) {
    return { name: n, displayName: n, originalType: null, type: 1 };
  });
  return {
    rows: rows,
    headers: headers,
    stat: {
      rowsAffected: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      queryDurationMs: 0,
    },
    lastInsertRowid: 0,
  };
}

function handleSqlExec(sql, req) {
  return req.json().then(function (msg) {
    try {
      if (msg.type === "query") {
        var result = runQuery(sql, msg.statement);
        return Response.json({ type: "query", id: msg.id, data: result });
      }
      if (msg.type === "transaction") {
        var results = [];
        for (var i = 0; i < msg.statements.length; i++) {
          results.push(runQuery(sql, msg.statements[i]));
        }
        return Response.json({ type: "transaction", id: msg.id, data: results });
      }
      return Response.json({ error: "unknown type" }, { status: 400 });
    } catch (err) {
      return Response.json({ type: msg.type, id: msg.id, error: err.message });
    }
  });
}

export class App extends DurableObject {
  ensureTable() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invoices (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "customer TEXT NOT NULL," +
        "amount REAL NOT NULL," +
        "status TEXT NOT NULL DEFAULT 'draft'," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
        ")",
    );
  }

  async fetch(req) {
    this.ensureTable();
    var url = new URL(req.url);
    var doId = this.ctx.id.toString();
    console.log("[BillingApp] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    // ── SQL Studio ──
    if (url.pathname === "/_studio")
      return new Response(sqlStudioHTML("App: billing"), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    if (req.method === "POST" && url.pathname === "/_sql")
      return handleSqlExec(this.ctx.storage.sql, req);

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
        body.status || "draft",
      );
      var row = this.ctx.storage.sql
        .exec("SELECT * FROM invoices ORDER BY id DESC LIMIT 1")
        .toArray()[0];
      return Response.json({ ok: true, invoice: row, doId: doId });
    }

    var patchMatch = url.pathname.match(/^\/invoices\/(\d+)$/);
    if (req.method === "PATCH" && patchMatch) {
      var id = parseInt(patchMatch[1]);
      var body = await req.json();
      console.log("[BillingApp] updating invoice " + id + ": " + JSON.stringify(body));
      this.ctx.storage.sql.exec("UPDATE invoices SET status = ? WHERE id = ?", body.status, id);
      var row = this.ctx.storage.sql.exec("SELECT * FROM invoices WHERE id = ?", id).toArray()[0];
      return Response.json({ ok: true, invoice: row, doId: doId });
    }

    var delMatch = url.pathname.match(/^\/invoices\/(\d+)$/);
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
    var rows = invoices
      .map(function (inv) {
        return (
          "<tr>" +
          "<td>" +
          inv.id +
          "</td>" +
          "<td>" +
          inv.customer +
          "</td>" +
          "<td>$" +
          Number(inv.amount).toFixed(2) +
          "</td>" +
          '<td><select onchange="updateStatus(' +
          inv.id +
          ', this.value)">' +
          ["draft", "sent", "paid", "void"]
            .map(function (s) {
              return "<option" + (s === inv.status ? " selected" : "") + ">" + s + "</option>";
            })
            .join("") +
          "</select></td>" +
          "<td>" +
          inv.created_at +
          "</td>" +
          '<td><button onclick="deleteInvoice(' +
          inv.id +
          ')" style="color:#f87171">x</button></td>' +
          "</tr>"
        );
      })
      .join("");

    return [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Billing App</title>',
      "<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:800px;margin:0 auto}",
      "h1{font-size:1.4rem;margin-bottom:.5rem;color:#fff}.card{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:1.2rem;margin:1rem 0}",
      "table{width:100%;border-collapse:collapse}th{text-align:left;padding:.5rem;border-bottom:1px solid #444;color:#aaa;font-size:.8rem}",
      "td{padding:.5rem;border-bottom:1px solid #222}input,select{background:#222;border:1px solid #444;color:#fff;padding:.4rem .6rem;border-radius:4px;font-family:monospace}",
      "button{background:#3b82f6;color:#fff;border:none;padding:.4rem .8rem;border-radius:4px;cursor:pointer}button:hover{background:#2563eb}",
      "form{display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap}code{font-size:.75rem;color:#888}</style></head><body>",
      "<h1>Billing App</h1><p><code>DO ID: " + doId + "</code></p>",
      '<div class="card"><b>Create invoice</b><form id="f">',
      '<input name="customer" placeholder="Customer" required>',
      '<input name="amount" type="number" step="0.01" placeholder="Amount" required>',
      '<button type="submit">Create</button></form></div>',
      "<table><thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr></thead>",
      "<tbody>" + rows + "</tbody></table>",
      "<script>",
      'document.getElementById("f").addEventListener("submit",async function(e){e.preventDefault();var fd=new FormData(e.target);',
      'await fetch("/invoices",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({customer:fd.get("customer"),amount:parseFloat(fd.get("amount"))})});location.reload()});',
      'async function updateStatus(id,s){await fetch("/invoices/"+id,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:s})})}',
      'async function deleteInvoice(id){if(!confirm("Delete?"))return;await fetch("/invoices/"+id,{method:"DELETE"});location.reload()}',
      "</script></body></html>",
    ].join("\n");
  }
}
