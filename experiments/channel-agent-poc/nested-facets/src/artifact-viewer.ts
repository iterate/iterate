// Artifact viewer — served at <project>.iterate-dev-jonas.app (no app prefix)
// Shows files stored in the project's config (from D1) with inline editing.

interface ProjectRow {
  slug: string;
  canonical_hostname: string | null;
  config_json: string;
  artifacts_repo: string | null;
  artifacts_remote: string | null;
  created_at: string;
}

export function artifactViewerHTML(project: ProjectRow): string {
  const config = JSON.parse(project.config_json);
  const domain = project.canonical_hostname ?? `${project.slug}.iterate-dev-jonas.app`;
  const configPretty = JSON.stringify(config, null, 2);

  const appLinks = (config.apps || [])
    .map(
      (app: string) =>
        `<a href="https://${app}.${domain}" style="color:#60a5fa">${app}.${domain}</a>`,
    )
    .join(" &middot; ");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${project.slug} — Artifact Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: .3rem; color: #fff; }
  h2 { font-size: .9rem; color: #666; font-weight: normal; margin-bottom: 1rem; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1.2rem; margin: 1rem 0; }
  .card h3 { font-size: 1rem; color: #ccc; margin-bottom: .5rem; }
  textarea { background: #111; border: 1px solid #444; color: #e0e0e0; padding: .8rem; border-radius: 6px; width: 100%; font-family: monospace; font-size: .85rem; resize: vertical; min-height: 120px; }
  button { background: #3b82f6; color: #fff; border: none; padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-size: .85rem; margin-top: .5rem; }
  button:hover { background: #2563eb; }
  code { font-size: .8rem; background: #222; padding: 2px 6px; border-radius: 3px; }
  a { color: #60a5fa; }
  .meta { font-size: .8rem; color: #666; margin-bottom: .5rem; }
  .tag { display: inline-block; font-size: .7rem; font-weight: 600; padding: 2px 6px; border-radius: 4px; margin-right: .3rem; }
  .tag-file { background: #1e3a5f; color: #93c5fd; }
  .tag-repo { background: #14332a; color: #6ee7b7; }
  #log { margin-top: .5rem; font-family: monospace; font-size: .8rem; white-space: pre-wrap; color: #6ee7b7; }
</style>
</head><body>
<h1>Project: ${project.slug}</h1>
<h2>Artifact viewer &middot; <a href="/">← admin</a></h2>

<div class="meta">
  Created: ${project.created_at} &middot;
  Custom hostname: ${project.canonical_hostname ? `<code>${project.canonical_hostname}</code>` : "none"} &middot;
  ${project.artifacts_repo ? `<span class="tag tag-repo">repo</span> <code>${project.artifacts_repo}</code>` : "no artifacts repo"}
  ${project.artifacts_remote ? `<br>Remote: <code style="font-size:.7rem">${project.artifacts_remote}</code>` : ""}
</div>

<div class="card">
  <b>Active apps:</b> ${appLinks || "<em>none</em>"}
</div>

<div class="card">
  <h3><span class="tag tag-file">file</span> config.json</h3>
  <textarea id="config">${configPretty}</textarea>
  <button onclick="saveConfig()">Save config.json</button>
  <div id="log"></div>
</div>

<script>
  const log = document.getElementById('log');

  async function saveConfig() {
    const text = document.getElementById('config').value;
    try {
      JSON.parse(text); // validate
    } catch (e) {
      log.textContent = 'Invalid JSON: ' + e.message;
      return;
    }
    log.textContent = 'Saving...';
    const resp = await fetch('/config.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
    const data = await resp.json();
    log.textContent = JSON.stringify(data, null, 2);
    if (resp.ok) setTimeout(() => location.reload(), 500);
  }
</script>
</body></html>`;
}
