// Artifact editor UI — CodeMirror 6 + build support
// Served at <project>.iterate-dev-jonas.app

export function editorHTML(
  slug: string,
  doId: string,
  files: string[],
  configStr: string | null,
): string {
  const config = configStr ? JSON.parse(configStr) : { apps: [] };

  const appNames: string[] = config.apps || [];
  const buildableApps = new Set<string>();
  const builtApps = new Set<string>();
  for (const f of files) {
    const m = f.match(/^apps\/([^/]+)\/package\.json$/);
    if (m) buildableApps.add(m[1]);
    const d = f.match(/^apps\/([^/]+)\/dist\/manifest\.json$/);
    if (d) builtApps.add(d[1]);
  }

  const fileList = files
    .map(
      (f) =>
        `<li data-path="${f}" onclick="openFile('${f}')" style="cursor:pointer;padding:4px 8px;border-radius:4px">${f}</li>`,
    )
    .join("");

  const appCards = appNames
    .map((app: string) => {
      const isBuildable = buildableApps.has(app);
      const isBuilt = builtApps.has(app);
      const stateClass = isBuilt ? "built" : "plain";
      const stateLabel = isBuilt ? "ready" : isBuildable ? "idle" : "plain js";
      const buildBtn = isBuildable
        ? `<button onclick="buildApp('${app}')" class="build-btn" data-app="${app}">Build</button>`
        : "";
      return `<div class="app-card" data-app="${app}">
      <div class="app-card-header">
        <a href="https://${app}.${slug}.iterate-dev-jonas.app" target="_blank" class="app-name">${app}</a>
        <span class="build-badge ${stateClass}" data-badge="${app}">${stateLabel}</span>
      </div>
      ${buildBtn}
    </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${slug} — Artifact Editor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; height: 100vh; }
  #sidebar { width: 260px; background: #111; border-right: 1px solid #333; padding: 1rem; overflow-y: auto; flex-shrink: 0; }
  #sidebar h2 { font-size: .9rem; color: #888; margin-bottom: .5rem; }
  #sidebar ul { list-style: none; font-size: .85rem; font-family: monospace; }
  #sidebar li:hover { background: #222; }
  #sidebar li.active { background: #1e3a5f; color: #93c5fd; }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #header { padding: .8rem 1rem; background: #111; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 1rem; }
  #header h1 { font-size: 1.1rem; color: #fff; }
  #header code { font-size: .75rem; color: #666; }
  #toolbar { padding: .5rem 1rem; background: #0d0d0d; border-bottom: 1px solid #222; display: flex; align-items: center; gap: .5rem; font-size: .85rem; }
  #toolbar .path { color: #f59e0b; font-family: monospace; }
  #toolbar button { background: #3b82f6; color: #fff; border: none; padding: .3rem .8rem; border-radius: 4px; cursor: pointer; font-size: .85rem; }
  #toolbar button:hover { background: #2563eb; }
  #toolbar .status { color: #666; margin-left: auto; }
  #content-area { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #editor-area { flex: 1; position: relative; min-height: 0; overflow: hidden; }
  #empty { padding: 2rem; color: #555; text-align: center; }
  /* CodeMirror container */
  #cm-wrapper { width: 100%; height: 100%; display: none; }
  #cm-wrapper .cm-editor { height: 100%; }
  #cm-wrapper .cm-scroller { overflow: auto; }
  .apps { font-size: .8rem; color: #888; margin-top: .5rem; }
  a { color: #60a5fa; }
  .app-card { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: .5rem .6rem; margin: .4rem 0; }
  .app-card-header { display: flex; align-items: center; justify-content: space-between; gap: .4rem; }
  .app-name { font-size: .85rem; font-weight: 600; color: #60a5fa; text-decoration: none; }
  .app-name:hover { text-decoration: underline; }
  .build-badge { font-size: .7rem; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .build-badge.plain { background: #333; color: #888; }
  .build-badge.idle { background: #333; color: #888; }
  .build-badge.built, .build-badge.ready { background: #14532d; color: #4ade80; }
  .build-badge.building { background: #422006; color: #fbbf24; }
  .build-badge.error { background: #450a0a; color: #f87171; }
  .build-btn { background: #7c3aed; color: #fff; border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: .75rem; margin-top: .3rem; }
  .build-btn:hover { background: #6d28d9; }
  .build-btn:disabled { background: #555; cursor: not-allowed; }
  #log-panel { height: 160px; background: #0d0d0d; border-top: 1px solid #333; font-family: monospace; font-size: .75rem; overflow-y: auto; padding: .5rem; flex-shrink: 0; }
  #log-panel .log-entry { color: #6ee7b7; margin: 1px 0; }
  #log-panel .log-entry .ts { color: #555; margin-right: .5rem; }
  #log-header { padding: .3rem .5rem; background: #111; border-top: 1px solid #333; font-size: .75rem; color: #888; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
  #log-header .ws-status { font-size: .7rem; }
  #log-header .ws-status.connected { color: #4ade80; }
  #log-header .ws-status.disconnected { color: #f87171; }
</style>
</head><body>

<div id="sidebar">
  <h2>Project: ${slug}</h2>
  <div class="apps" style="margin-bottom:.8rem"><code>DO: ${doId.slice(0, 12)}…</code></div>
  <h2>Apps</h2>
  ${appCards || '<div class="apps">none</div>'}
  <h2 style="margin-top:.8rem">Files</h2>
  <ul id="file-list">${fileList}</ul>
  <div style="margin-top:1rem">
    <input id="new-file" placeholder="new/file/path.js" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:4px 6px;border-radius:4px;font-family:monospace;font-size:.8rem">
    <button onclick="createFile()" style="margin-top:4px;width:100%;background:#14532d;color:#6ee7b7;border:1px solid #166534;padding:4px;border-radius:4px;cursor:pointer;font-size:.8rem">+ new file</button>
  </div>
</div>

<div id="main">
  <div id="header">
    <h1>${slug}</h1>
    <code>Artifact Editor</code>
    <button onclick="rebase(false)" style="margin-left:auto;background:#7c3aed;font-size:.8rem">Rebase (merge)</button>
    <button onclick="rebase(true)" style="background:#dc2626;font-size:.8rem">Rebase (force reset)</button>
    <a href="/" style="font-size:.8rem;margin-left:.5rem">&larr; admin</a>
  </div>
  <div id="toolbar" style="display:none">
    <span>Editing:</span>
    <span class="path" id="current-path"></span>
    <button onclick="saveFile()">Save (Ctrl+S)</button>
    <span class="status" id="status"></span>
  </div>
  <div id="content-area">
    <div id="editor-area">
      <div id="empty">Select a file from the sidebar to edit it</div>
      <div id="cm-wrapper"></div>
    </div>
    <div id="log-header">
      <span>Build Logs</span>
      <span class="ws-status disconnected" id="ws-status">disconnected</span>
    </div>
    <div id="log-panel"></div>
  </div>
</div>

<script type="importmap">
{
  "imports": {
    "@codemirror/state": "https://esm.sh/@codemirror/state@6.5.2",
    "@codemirror/view": "https://esm.sh/@codemirror/view@6.36.8?external=@codemirror/state",
    "@codemirror/language": "https://esm.sh/@codemirror/language@6.11.0?external=@codemirror/state,@codemirror/view",
    "@lezer/common": "https://esm.sh/@lezer/common@1.2.3",
    "@lezer/highlight": "https://esm.sh/@lezer/highlight@1.2.1?external=@lezer/common",
    "@lezer/lr": "https://esm.sh/@lezer/lr@1.4.2?external=@lezer/common,@lezer/highlight",
    "style-mod": "https://esm.sh/style-mod@4.1.2",
    "crelt": "https://esm.sh/crelt@1.0.6"
  }
}
</script>
<script type="module">
  // ── CodeMirror 6 — shared deps via importmap to avoid duplicate @codemirror/state ──
  const ext = "?external=@codemirror/state,@codemirror/view,@codemirror/language,@lezer/common,@lezer/highlight,@lezer/lr,style-mod,crelt";
  const {EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, rectangularSelection} = await import("@codemirror/view");
  const {EditorState} = await import("@codemirror/state");
  const {defaultKeymap, history, historyKeymap, indentWithTab} = await import("https://esm.sh/@codemirror/commands@6.8.1" + ext);
  const {syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap} = await import("@codemirror/language");
  const {javascript} = await import("https://esm.sh/@codemirror/lang-javascript@6.2.3" + ext);
  const {json} = await import("https://esm.sh/@codemirror/lang-json@6.0.1" + ext);
  const {html} = await import("https://esm.sh/@codemirror/lang-html@6.4.10" + ext);
  const {css} = await import("https://esm.sh/@codemirror/lang-css@6.3.1" + ext);
  const {oneDark} = await import("https://esm.sh/@codemirror/theme-one-dark@6.1.2" + ext);
  const {closeBrackets, closeBracketsKeymap} = await import("https://esm.sh/@codemirror/autocomplete@6.18.6" + ext);
  const {searchKeymap, highlightSelectionMatches} = await import("https://esm.sh/@codemirror/search@6.5.10" + ext);

  let currentPath = null;
  let cmView = null;
  const cmWrapper = document.getElementById('cm-wrapper');
  const toolbar = document.getElementById('toolbar');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const pathEl = document.getElementById('current-path');
  const logPanel = document.getElementById('log-panel');
  const wsStatus = document.getElementById('ws-status');

  function getLang(path) {
    if (path.endsWith('.json') || path.endsWith('.jsonc')) return json();
    if (path.endsWith('.html') || path.endsWith('.htm')) return html();
    if (path.endsWith('.css')) return css();
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return javascript({ typescript: true, jsx: path.endsWith('.tsx') });
    if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs')) return javascript({ jsx: path.endsWith('.jsx') });
    return javascript();
  }

  function createEditor(content, path) {
    if (cmView) cmView.destroy();
    cmWrapper.innerHTML = '';

    const saveKeymap = keymap.of([{
      key: "Mod-s",
      run: () => { saveFile(); return true; }
    }]);

    cmView = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          rectangularSelection(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          getLang(path),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          saveKeymap,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto" },
          }),
        ],
      }),
      parent: cmWrapper,
    });
  }

  // ── WebSocket log connection ──
  let ws;
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/api/logs');
    ws.onopen = function() { wsStatus.textContent = 'connected'; wsStatus.className = 'ws-status connected'; };
    ws.onclose = function() { wsStatus.textContent = 'disconnected'; wsStatus.className = 'ws-status disconnected'; setTimeout(connectWS, 2000); };
    ws.onerror = function() { ws.close(); };
    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'history') {
          msg.logs.forEach(function(l) { addLogEntry(l); });
        } else if (msg.type === 'log') {
          addLogEntry(msg);
        }
      } catch (err) {}
    };
  }
  connectWS();

  function addLogEntry(entry) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const time = new Date(entry.ts).toLocaleTimeString();
    div.innerHTML = '<span class="ts">' + time + '</span>' + escapeHtml(entry.message);
    logPanel.appendChild(div);
    logPanel.scrollTop = logPanel.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Build ──
  window.buildApp = async function(appName) {
    const btn = document.querySelector('.build-btn[data-app="' + appName + '"]');
    const badge = document.querySelector('[data-badge="' + appName + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Building...'; }
    if (badge) { badge.textContent = 'building'; badge.className = 'build-badge building'; }

    try {
      const resp = await fetch('/api/build/' + appName, { method: 'POST' });
      const data = await resp.json();
      if (data.ok) {
        if (badge) { badge.textContent = 'ready'; badge.className = 'build-badge ready'; }
        if (btn) { btn.textContent = 'Build'; btn.disabled = false; }
        refreshFileList();
      } else {
        if (badge) { badge.textContent = 'error'; badge.className = 'build-badge error'; }
        if (btn) { btn.textContent = 'Build'; btn.disabled = false; }
        addLogEntry({ ts: Date.now(), message: 'ERROR: ' + (data.error || 'unknown') });
      }
    } catch (err) {
      if (badge) { badge.textContent = 'error'; badge.className = 'build-badge error'; }
      if (btn) { btn.textContent = 'Build'; btn.disabled = false; }
      addLogEntry({ ts: Date.now(), message: 'ERROR: ' + err.message });
    }
  };

  async function refreshFileList() {
    const resp = await fetch('/api/files');
    const data = await resp.json();
    const ul = document.getElementById('file-list');
    ul.innerHTML = data.files.map(function(f) {
      return '<li data-path="' + f + '" onclick="openFile(\\'' + f + '\\')" style="cursor:pointer;padding:4px 8px;border-radius:4px">' + f + '</li>';
    }).join('');
    if (currentPath) {
      document.querySelectorAll('#file-list li').forEach(function(li) {
        li.classList.toggle('active', li.dataset.path === currentPath);
      });
    }
  }

  // ── File operations ──
  window.openFile = async function(path) {
    status.textContent = 'Loading...';
    const resp = await fetch('/api/files/' + encodeURIComponent(path));
    const data = await resp.json();
    if (data.error) { status.textContent = data.error; return; }
    currentPath = path;
    createEditor(data.content, path);
    cmWrapper.style.display = 'block';
    empty.style.display = 'none';
    toolbar.style.display = 'flex';
    pathEl.textContent = path;
    status.textContent = '';
    document.querySelectorAll('#file-list li').forEach(function(li) {
      li.classList.toggle('active', li.dataset.path === path);
    });
  };

  window.saveFile = async function() {
    if (!currentPath || !cmView) return;
    status.textContent = 'Saving...';
    const content = cmView.state.doc.toString();
    const resp = await fetch('/api/files/' + encodeURIComponent(currentPath), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await resp.json();
    status.textContent = data.oid ? 'Saved + pushed: ' + data.oid.slice(0, 8) : 'Saved (no push)';
  };

  window.createFile = async function() {
    const path = document.getElementById('new-file').value.trim();
    if (!path) return;
    status.textContent = 'Creating...';
    await fetch('/api/files/' + encodeURIComponent(path), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    location.reload();
  };

  window.rebase = async function(force) {
    if (force && !confirm('This will discard all local changes and reset to base-template. Continue?')) return;
    status.textContent = 'Rebasing from base-template...';
    const resp = await fetch('/api/rebase' + (force ? '?force=1' : ''), { method: 'POST' });
    const data = await resp.json();
    status.textContent = JSON.stringify(data, null, 2);
    if (data.ok) setTimeout(function() { location.reload(); }, 1000);
  };
</script>
</body></html>`;
}
