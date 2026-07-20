// Local full-loop proof: browser -> project app host (config-worker gate +
// proxy) -> vessel (vite dev 5175) -> local os /api (project-app-session).
import { SignJWT } from "jose";
import { chromium } from "playwright";

const secret = process.env.APP_CONFIG_PROJECT_APP_SESSION_SECRET.trim();
const host = "tasks--tasks-proof.localhost:5173";
const origin = `http://${host}`;
const token = await new SignJWT({
  audience: origin,
  projectId: "prj_a53dcf0c31c744b894f1743c5e430e14",
  type: "project-app-session",
  userId: "usr_local_proof",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
  .sign(new TextEncoder().encode(secret));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([
  { name: "iterate-project-auth", value: token, domain: host.split(":")[0], path: "/" },
]);
const page = await context.newPage();
for (let attempt = 1; attempt <= 6; attempt++) {
  await page.goto(`${origin}/`, { waitUntil: "networkidle" }).catch(() => {});
  const body = (await page.textContent("body").catch(() => "")) ?? "";
  if (body.includes("todo") || body.includes("connecting")) break;
  console.log(`attempt ${attempt}: ${body.slice(0, 120).replaceAll("\n", " ")}`);
  await page.waitForTimeout(5000);
}
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/local-proxy-proof.png" });
console.log("body:", (await page.textContent("body"))?.slice(0, 300));
await browser.close();
