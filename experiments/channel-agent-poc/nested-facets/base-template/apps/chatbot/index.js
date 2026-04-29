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
      "CREATE TABLE IF NOT EXISTS messages (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "role TEXT NOT NULL," +
        "content TEXT NOT NULL," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
        ")",
    );
  }

  async fetch(req) {
    this.ensureTable();
    var url = new URL(req.url);
    var doId = this.ctx.id.toString();
    console.log("[Chatbot] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    // ── SQL Studio ──
    if (url.pathname === "/_studio")
      return new Response(sqlStudioHTML("App: chatbot"), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    if (req.method === "POST" && url.pathname === "/_sql")
      return handleSqlExec(this.ctx.storage.sql, req);

    // ── POST /api/chat — send message, get OpenAI response ──
    if (req.method === "POST" && url.pathname === "/api/chat") {
      var body = await req.json();
      var userMessage = body.message;
      if (!userMessage) return Response.json({ error: "message required" }, { status: 400 });

      // Store user message
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (role, content) VALUES (?, ?)",
        "user",
        userMessage,
      );

      // Build message history for OpenAI
      var history = this.ctx.storage.sql
        .exec("SELECT role, content FROM messages ORDER BY id")
        .toArray();

      var messages = [{ role: "system", content: "You are a helpful assistant." }];
      for (var i = 0; i < history.length; i++) {
        messages.push({ role: history[i].role, content: history[i].content });
      }

      // Call OpenAI — the sentinel string gets replaced by the egress gateway
      var resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: 'Bearer getIterateSecret({secretKey:"openai-api-key"})',
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
        return Response.json(
          { error: "OpenAI API error", status: resp.status, detail: errText },
          { status: 502 },
        );
      }

      var data = await resp.json();
      var assistantMessage = data.choices[0].message.content;

      // Store assistant response
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (role, content) VALUES (?, ?)",
        "assistant",
        assistantMessage,
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
      "<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}",
      "#header{padding:1rem;border-bottom:1px solid #333;display:flex;align-items:center;gap:1rem}",
      "#header h1{font-size:1.2rem;color:#fff}#header code{font-size:.7rem;color:#666}",
      "#header button{background:#333;color:#aaa;border:none;padding:.3rem .6rem;border-radius:4px;cursor:pointer;font-size:.8rem}",
      "#messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.8rem}",
      ".msg{max-width:80%;padding:.8rem 1rem;border-radius:12px;font-size:.9rem;line-height:1.4;white-space:pre-wrap}",
      ".msg.user{align-self:flex-end;background:#1e3a5f;color:#93c5fd;border-bottom-right-radius:4px}",
      ".msg.assistant{align-self:flex-start;background:#1a1a1a;border:1px solid #333;border-bottom-left-radius:4px}",
      ".msg.error{align-self:center;background:#450a0a;color:#f87171;border:1px solid #7f1d1d}",
      "#input-area{padding:1rem;border-top:1px solid #333;display:flex;gap:.5rem}",
      "#input-area input{flex:1;background:#1a1a1a;border:1px solid #444;color:#fff;padding:.6rem .8rem;border-radius:8px;font-size:.9rem;outline:none}",
      "#input-area input:focus{border-color:#3b82f6}",
      "#input-area button{background:#3b82f6;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:8px;cursor:pointer;font-weight:600}",
      "#input-area button:disabled{background:#555;cursor:not-allowed}",
      "</style></head><body>",
      '<div id="header"><h1>Chatbot</h1><code>DO: ' + doId + "</code>",
      '<button onclick="clearChat()">Clear</button></div>',
      '<div id="messages"></div>',
      '<div id="input-area">',
      '<input id="chat-input" placeholder="Type a message..." autofocus>',
      '<button id="send-btn" onclick="sendMessage()">Send</button>',
      "</div>",
      "<script>",
      'var messagesEl = document.getElementById("messages");',
      'var inputEl = document.getElementById("chat-input");',
      'var sendBtn = document.getElementById("send-btn");',
      "",
      "function addMessage(role, content) {",
      '  var div = document.createElement("div");',
      '  div.className = "msg " + role;',
      "  div.textContent = content;",
      "  messagesEl.appendChild(div);",
      "  messagesEl.scrollTop = messagesEl.scrollHeight;",
      "}",
      "",
      "async function loadHistory() {",
      '  var resp = await fetch("/api/messages");',
      "  var data = await resp.json();",
      "  (data.messages || []).forEach(function(m) { addMessage(m.role, m.content); });",
      "}",
      "loadHistory();",
      "",
      "async function sendMessage() {",
      "  var text = inputEl.value.trim();",
      "  if (!text) return;",
      '  inputEl.value = "";',
      "  sendBtn.disabled = true;",
      '  addMessage("user", text);',
      "  try {",
      '    var resp = await fetch("/api/chat", {',
      '      method: "POST",',
      '      headers: { "content-type": "application/json" },',
      "      body: JSON.stringify({ message: text }),",
      "    });",
      "    var data = await resp.json();",
      '    if (data.ok) { addMessage("assistant", data.message); }',
      '    else { addMessage("error", "Error: " + (data.error || "unknown") + (data.detail ? "\\n" + data.detail : "")); }',
      '  } catch (err) { addMessage("error", "Error: " + err.message); }',
      "  sendBtn.disabled = false;",
      "  inputEl.focus();",
      "}",
      "",
      "async function clearChat() {",
      '  if (!confirm("Clear conversation?")) return;',
      '  await fetch("/api/clear", { method: "POST" });',
      '  messagesEl.innerHTML = "";',
      "}",
      "",
      'inputEl.addEventListener("keydown", function(e) {',
      '  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }',
      "});",
      "</script></body></html>",
    ].join("\n");
  }
}
