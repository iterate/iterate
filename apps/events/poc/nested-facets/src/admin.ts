// Admin UI — served at the bare domain (iterate-dev-jonas.app)

interface ProjectRow {
  slug: string;
  canonical_hostname: string | null;
  config_json: string;
  artifacts_repo: string | null;
  artifacts_remote: string | null;
  created_at: string;
}

export function adminHTML(projects: ProjectRow[]): string {
  const rows = projects
    .map((p) => {
      const config = JSON.parse(p.config_json);
      const domain = p.canonical_hostname ?? `${p.slug}.iterate-dev-jonas.app`;
      return `<tr>
    <td><a href="https://${domain}" style="color:#60a5fa">${p.slug}</a></td>
    <td>${p.canonical_hostname ? `<code>${p.canonical_hostname}</code>` : "<em>—</em>"}</td>
    <td><code>${(config.apps || []).join(", ")}</code></td>
    <td>${p.artifacts_repo ? `<code style="font-size:.7rem">${p.artifacts_repo}</code>` : "<em>—</em>"}</td>
    <td style="font-size:.8rem">${p.created_at}</td>
    <td><button onclick="deleteProject('${p.slug}')" style="color:#f87171;background:transparent;border:1px solid #f87171">delete</button></td>
  </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Platform Admin — iterate-dev-jonas.app</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: .3rem; color: #fff; }
  h2 { font-size: .9rem; color: #666; font-weight: normal; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th { text-align: left; padding: .5rem; border-bottom: 1px solid #444; color: #aaa; font-size: .8rem; }
  td { padding: .5rem; border-bottom: 1px solid #222; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1.2rem; margin: 1rem 0; }
  input { background: #222; border: 1px solid #444; color: #fff; padding: .4rem .6rem; border-radius: 4px; font-family: monospace; }
  button { background: #3b82f6; color: #fff; border: none; padding: .4rem .8rem; border-radius: 4px; cursor: pointer; font-size: .85rem; }
  button:hover { opacity: .9; }
  form { display: flex; gap: .5rem; align-items: end; flex-wrap: wrap; margin-top: .5rem; }
  label { font-size: .8rem; color: #888; display: flex; flex-direction: column; gap: .2rem; }
  #log { margin-top: 1rem; font-family: monospace; font-size: .8rem; white-space: pre-wrap; color: #6ee7b7; max-height: 200px; overflow-y: auto; }
  code { font-size: .85rem; } em { color: #555; font-style: normal; }
  a { color: #60a5fa; }
</style>
</head><body>
<h1>Platform Admin</h1>
<h2>iterate-dev-jonas.app — manage projects, apps, and artifacts</h2>

<div class="card">
  <b>Create project</b>
  <form id="create-form">
    <label>Slug <input name="slug" placeholder="my-project" required pattern="[a-z0-9-]+"></label>
    <label>Custom hostname <input name="canonical_hostname" placeholder="optional"></label>
    <label>Apps <input name="apps" value="agents" placeholder="comma-separated"></label>
    <button type="submit">Create</button>
  </form>
</div>

<table>
  <thead><tr><th>Project</th><th>Custom hostname</th><th>Apps</th><th>Artifacts</th><th>Created</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<div style="margin-top:1rem">
  <a href="/base" style="color:#a78bfa;font-weight:600">Edit base template &rarr;</a>
  <span style="color:#555;font-size:.8rem;margin-left:.5rem">Edit the base-template artifact that new projects fork from</span>
</div>

<div class="card">
  <b>Secrets</b>
  <div style="margin-top:.5rem">
    <label>Project
      <select id="secrets-project" onchange="loadSecrets()" style="background:#222;border:1px solid #444;color:#fff;padding:.4rem .6rem;border-radius:4px;font-family:monospace">
        <option value="">— select —</option>
        ${projects.map((p) => `<option value="${p.slug}">${p.slug}</option>`).join("")}
      </select>
    </label>
  </div>
  <table id="secrets-table" style="display:none">
    <thead><tr><th>Name</th><th>Created</th><th></th></tr></thead>
    <tbody id="secrets-body"></tbody>
  </table>
  <form id="secret-form" style="display:none">
    <label>Name <input name="name" placeholder="openai-api-key" required></label>
    <label>Value <input name="value" type="password" placeholder="sk-..." required></label>
    <button type="submit">Add secret</button>
  </form>
</div>

<div id="log"></div>

<script>
  const log = document.getElementById('log');
  function addLog(msg) { log.textContent = new Date().toLocaleTimeString() + ' ' + msg + '\\n' + log.textContent; }

  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      slug: fd.get('slug'),
      canonical_hostname: fd.get('canonical_hostname') || null,
      apps: fd.get('apps')?.split(',').map(s => s.trim()).filter(Boolean) ?? ['agents'],
    };
    addLog('Creating project ' + body.slug + '...');
    const resp = await fetch('/admin/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    addLog(JSON.stringify(data, null, 2));
    if (resp.ok) setTimeout(() => location.reload(), 500);
  });

  async function deleteProject(slug) {
    if (!confirm('Delete project ' + slug + '?')) return;
    addLog('Deleting ' + slug + '...');
    const resp = await fetch('/admin/api/projects/' + slug, { method: 'DELETE' });
    addLog(await resp.text());
    if (resp.ok) setTimeout(() => location.reload(), 500);
  }

  // ── Secrets ──
  async function loadSecrets() {
    const project = document.getElementById('secrets-project').value;
    const table = document.getElementById('secrets-table');
    const form = document.getElementById('secret-form');
    if (!project) { table.style.display = 'none'; form.style.display = 'none'; return; }
    table.style.display = ''; form.style.display = 'flex';
    const resp = await fetch('/admin/api/secrets?project=' + encodeURIComponent(project));
    const data = await resp.json();
    const tbody = document.getElementById('secrets-body');
    tbody.innerHTML = (data.secrets || []).map(function(s) {
      return '<tr><td><code>' + s.name + '</code></td><td style="font-size:.8rem">' + s.created_at + '</td>' +
        '<td><button onclick="deleteSecret(\\'' + project + '\\', \\'' + s.name + '\\')" style="color:#f87171;background:transparent;border:1px solid #f87171">delete</button></td></tr>';
    }).join('');
  }

  document.getElementById('secret-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const project = document.getElementById('secrets-project').value;
    if (!project) return;
    const fd = new FormData(e.target);
    const resp = await fetch('/admin/api/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_slug: project, name: fd.get('name'), value: fd.get('value') }),
    });
    const data = await resp.json();
    addLog('Secret: ' + JSON.stringify(data));
    if (resp.ok) { e.target.reset(); loadSecrets(); }
  });

  async function deleteSecret(project, name) {
    if (!confirm('Delete secret ' + name + ' from ' + project + '?')) return;
    await fetch('/admin/api/secrets/' + encodeURIComponent(project) + '/' + encodeURIComponent(name), { method: 'DELETE' });
    loadSecrets();
  }
</script>
</body></html>`;
}
