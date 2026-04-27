// Shared LibSQL Studio helpers — used by Project DO, WorkspaceDO, and dynamic app workers.

export function studioHTML(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${name} — SQL Studio</title>
<style>*{margin:0;padding:0}body,html{height:100%;overflow:hidden}iframe{width:100%;height:100%;border:none}</style>
</head><body>
<iframe id="studio" src="https://libsqlstudio.com/embed/sqlite?name=${encodeURIComponent(name)}"></iframe>
<script>
window.addEventListener("message", async function(e) {
  if (e.source !== document.getElementById("studio").contentWindow) return;
  var msg = e.data;
  if (!msg || (msg.type !== "query" && msg.type !== "transaction")) return;
  try {
    var resp = await fetch("_sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg)
    });
    var result = await resp.json();
    e.source.postMessage(result, "*");
  } catch (err) {
    e.source.postMessage({ type: msg.type, id: msg.id, error: err.message }, "*");
  }
});
</script></body></html>`;
}

interface StudioQueryResult {
  rows: Record<string, unknown>[];
  headers: { name: string; displayName: string; originalType: null; type: number }[];
  stat: { rowsAffected: number; rowsRead: number; rowsWritten: number; queryDurationMs: number };
  lastInsertRowid: number;
}

function runStudioQuery(sql: SqlStorage, statement: string): StudioQueryResult {
  const cursor = sql.exec(statement);
  const cols = cursor.columnNames;
  const rows = cursor.toArray();
  const headers = cols.map((n) => ({
    name: n,
    displayName: n,
    originalType: null as null,
    type: 1,
  }));
  return {
    rows,
    headers,
    stat: {
      rowsAffected: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      queryDurationMs: 0,
    },
    lastInsertRowid: 0,
  };
}

export async function execSQL(sql: SqlStorage, req: Request): Promise<Response> {
  const msg = (await req.json()) as {
    type: string;
    id: number;
    statement?: string;
    statements?: string[];
  };
  try {
    if (msg.type === "query") {
      const result = runStudioQuery(sql, msg.statement!);
      return Response.json({ type: "query", id: msg.id, data: result });
    }
    if (msg.type === "transaction") {
      const results = (msg.statements ?? []).map((s) => runStudioQuery(sql, s));
      return Response.json({ type: "transaction", id: msg.id, data: results });
    }
    return Response.json({ error: "unknown type" }, { status: 400 });
  } catch (err: any) {
    return Response.json({ type: msg.type, id: msg.id, error: err.message });
  }
}
