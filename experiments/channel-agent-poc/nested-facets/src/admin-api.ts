// Admin API — project CRUD, secrets management.

import { provisionProject, deprovisionProject } from "./provisioning.ts";

interface ProjectRow {
  slug: string;
  canonical_hostname: string | null;
  config_json: string;
  artifacts_repo: string | null;
  artifacts_remote: string | null;
  created_at: string;
}

interface AdminEnv {
  DB: D1Database;
  PROJECT: DurableObjectNamespace;
  REPO: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  CF_WORKER_NAME: string;
}

export async function handleAdminAPI(req: Request, url: URL, env: AdminEnv): Promise<Response> {
  const path = url.pathname.replace("/admin/api/", "");

  if (req.method === "POST" && path === "projects") {
    const body = (await req.json()) as {
      slug: string;
      canonical_hostname?: string | null;
      apps?: string[];
    };
    const slug = body.slug?.trim();
    if (!slug || !/^[a-z0-9-]+$/.test(slug))
      return Response.json({ error: "Invalid slug" }, { status: 400 });
    const config = { apps: body.apps ?? ["agents"] };
    console.log(`[Admin] creating project ${slug}`);

    // Fork base-template artifact via RepoDO
    const repoId = env.REPO.idFromName(slug);
    const repoStub = env.REPO.get(repoId) as unknown as {
      forkFromBase(slug: string): Promise<{ name: string; remote: string }>;
    };
    let artifactsRepo: string | null = null;
    let artifactsRemote: string | null = null;
    try {
      const forked = await repoStub.forkFromBase(slug);
      artifactsRepo = forked.name;
      artifactsRemote = forked.remote;
      console.log(`[Admin] forked base-template → ${artifactsRepo}`);
    } catch (e: any) {
      console.error("[Admin] fork failed:", e.message);
    }

    const provision = await provisionProject(env, slug);
    await env.DB.prepare(
      "INSERT INTO projects (slug, canonical_hostname, config_json, artifacts_repo, artifacts_remote) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        slug,
        body.canonical_hostname ?? null,
        JSON.stringify(config),
        artifactsRepo,
        artifactsRemote,
      )
      .run();

    // Store slug in the Project DO
    if (artifactsRepo && artifactsRemote) {
      const id = env.PROJECT.idFromName(slug);
      const stub = env.PROJECT.get(id) as unknown as {
        setup(slug: string, remote: string, repo: string, hostname?: string | null): Promise<void>;
      };
      await stub.setup(slug, artifactsRemote, artifactsRepo, body.canonical_hostname);
    }

    return Response.json(
      { ok: true, slug, config, artifactsRepo, artifactsRemote, provision },
      { status: 201 },
    );
  }

  const deleteMatch = path.match(/^projects\/([a-z0-9-]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const slug = deleteMatch[1];
    // Delete artifact repo via RepoDO
    const repoId = env.REPO.idFromName(slug);
    const repoStub = env.REPO.get(repoId) as unknown as { deleteRepo(): Promise<void> };
    await repoStub.deleteRepo();
    await deprovisionProject(env, slug);
    await env.DB.prepare("DELETE FROM projects WHERE slug = ?").bind(slug).run();
    return new Response("deleted");
  }

  // ── Secrets API ──

  if (req.method === "GET" && path === "secrets") {
    const project = url.searchParams.get("project");
    if (!project) return Response.json({ error: "project query param required" }, { status: 400 });
    const rows = await env.DB.prepare(
      "SELECT name, created_at FROM secrets WHERE project_slug = ? ORDER BY name",
    )
      .bind(project)
      .all<{ name: string; created_at: string }>();
    return Response.json({ secrets: rows.results });
  }

  if (req.method === "POST" && path === "secrets") {
    const body = (await req.json()) as { project_slug: string; name: string; value: string };
    if (!body.project_slug || !body.name || !body.value) {
      return Response.json({ error: "project_slug, name, and value required" }, { status: 400 });
    }
    const key = `${body.project_slug}:${body.name}`;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO secrets (key, project_slug, name, value) VALUES (?, ?, ?, ?)",
    )
      .bind(key, body.project_slug, body.name, body.value)
      .run();
    return Response.json({ ok: true, key }, { status: 201 });
  }

  const secretDeleteMatch = path.match(/^secrets\/([a-z0-9-]+)\/(.+)$/);
  if (req.method === "DELETE" && secretDeleteMatch) {
    const [, project, name] = secretDeleteMatch;
    const key = `${project}:${name}`;
    await env.DB.prepare("DELETE FROM secrets WHERE key = ?").bind(key).run();
    return Response.json({ ok: true, deleted: key });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
