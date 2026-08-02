// READ ONLY: lists projects, then reconnects by slug to prove resolution.
import process from "node:process";
import { connectItxReady } from "iterate/node";
import { connectProject } from "./connect.ts";

const baseUrl = process.env.APP_CONFIG_BASE_URL!.trim();
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET!.trim();
const session = await connectItxReady({ auth: { secret, type: "admin-secret" }, baseUrl });
const list = (await session.projects.list({ scope: "deployment" })) as {
  id: string;
  slug: string;
}[];
const target = list.find((p) => p.id === "prj_698c23da57f84d92a9ba5dc959efebec");
console.log("SLUG_OF_LAB:", target?.slug, "of", list.length, "projects");
if (target?.slug) {
  const itx = await connectProject({ project: target.slug });
  const d = await (
    itx as unknown as { __describe(): Promise<Record<string, unknown>> }
  ).__describe();
  console.log("CONNECTED_BY_SLUG ->", d.projectId);
}
