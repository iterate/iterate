import process from "node:process";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "../src/auth.ts";
import { connectItx } from "../src/client.ts";

const rawBaseUrl = (process.env.ITX_BASE || process.env.APP_CONFIG_BASE_URL || "").trim();

if (!rawBaseUrl) {
  console.error("Set ITX_BASE or APP_CONFIG_BASE_URL to the deployed minimal-itx-v4 worker URL.");
  process.exit(1);
}

if (
  process.env.ALLOW_LOCAL_ITX !== "1" &&
  /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rawBaseUrl)
) {
  console.error(`Refusing to create a deployed project against local URL: ${rawBaseUrl}`);
  console.error("Set ALLOW_LOCAL_ITX=1 if you are intentionally testing against local dev.");
  process.exit(1);
}

const baseUrl = rawBaseUrl.replace(/\/+$/, "");
const slug = process.argv[2] ?? `agent-browser-${Date.now().toString(36)}`;

using itx = connectItx({
  auth: {
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  },
  baseUrl,
});

using project = itx.projects.create({ slug });
const description = await project.describe();
const projectUrl = new URL(`/${description.projectId}`, `${baseUrl}/`).toString();

console.log(
  JSON.stringify(
    {
      baseUrl,
      projectUrl,
      slug,
      ...description,
    },
    null,
    2,
  ),
);
