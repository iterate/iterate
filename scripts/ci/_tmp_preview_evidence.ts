// scratch: exercise a nobody lookup and a project deletion on a PR preview, as the operator
import { randomBytes } from "node:crypto";
import { connectIterate } from "iterate/node";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";
import { dopplerSecret } from "../lib/env-context.ts";
const baseUrl = process.argv[2]!;
const config = parseAppConfig({
  APP_CONFIG: dopplerSecret("os", "preview", "APP_CONFIG"),
  APP_CONFIG_SECRETS__KEY: dopplerSecret("os", "preview", "APP_CONFIG_SECRETS__KEY"),
});
using connection = await connectIterate({
  baseUrl,
  auth: { type: "admin-secret", secret: config.secrets.adminBearer.exposeSecret() },
});
const session = connection.session;
const nobody = randomBytes(32).toString("hex");
console.log("identify", JSON.stringify(await session.contexts.identify([nobody])));
const slug = `evidence-${Date.now().toString(36)}`;
using project = await session.projects.create({ project: slug });
const who = (await project.whoami()) as { projectId: string };
await project.cd("/x").append({ type: "events.iterate.com/test/marker", payload: {} } as never);
await project.cd("/y").readEvents(0, 1);
console.log("created", slug, who.projectId, new Date().toISOString());
await new Promise((r) => setTimeout(r, 3000));
await session.projects.delete(slug);
console.log("deleted", new Date().toISOString());
