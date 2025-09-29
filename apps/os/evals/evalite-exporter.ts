import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";
import { createDatabase, getMostRecentRun, getEvals, getResults } from "evalite/db";
import { createServer } from "evalite/server";
import { DB_LOCATION } from "evalite/backend-only-constants";

const exportEvaliteUI = async (
  db: ReturnType<typeof createDatabase>,
  options: { port: number; outDir: string },
) => {
  const pathsToStore = ["/api/server-state", "/api/menu-items"];

  const run = getMostRecentRun(db, "full")!;
  const evals = getEvals(db, [run.id], ["fail", "success", "running"]);

  for (const e of evals) {
    const query = { name: e.name };
    pathsToStore.push(`/api/eval?${new URLSearchParams(query)}`);

    const results = getResults(db, [e.id]);
    results.forEach((_r, i) => {
      const query = {
        name: e.name,
        index: i.toString(),
      };
      pathsToStore.push(`/api/eval/result?${new URLSearchParams(query)}`);
    });
  }

  const require = createRequire(import.meta.url);
  const evalitePath = require.resolve("evalite");
  const evaliteUIPath = path.join(evalitePath, "../..", "dist/ui");

  const storedApiResponses = {} as Record<string, any>;
  for (const path of pathsToStore) {
    const res = await fetch(`http://localhost:${options.port}` + path);
    const text = await res.text();
    storedApiResponses[path] = text;
  }

  const uiFiles = fs.globSync(path.join(evaliteUIPath, "**/*"), { withFileTypes: true });
  for (const file of uiFiles) {
    if (!file.isFile()) continue;
    const filepath = path.join(file.parentPath, file.name);
    const target = path.join(process.cwd(), filepath.replace(evaliteUIPath, options.outDir));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (filepath.endsWith(".js")) {
      let content = fs.readFileSync(filepath, "utf8");
      content = content.replace(
        /const (\w+)=await fetch/,
        `
          const __name = f => f;

          // shimmed fetch to return stored api responses

          /** API responses stored during test run */
          const storedApiResponses = ${JSON.stringify(storedApiResponses)};

          /** Shimmed fetch function to return stored API responses from test run */
          ${async function fakeFetch(urlString: string, _whatever: {}) {
            const url = new URL(urlString);

            const match = Object.keys(storedApiResponses).find((p) => {
              const storedUrl = new URL(url.origin + p);
              if (storedUrl.pathname !== url.pathname) return false;

              for (const [key, value] of url.searchParams.entries()) {
                const storedValue = storedUrl.searchParams.get(key) || "";
                if (storedValue !== value) return false;
              }
              return true;
            });

            if (match) {
              return {
                ok: true,
                status: 200,
                headers: {},
                text: async () => storedApiResponses[match],
                json: async () => JSON.parse(storedApiResponses[match]),
              };
            } else {
              console.error("not found", url.href, Error().stack);
              console.error("available paths:", Object.keys(storedApiResponses));

              return {
                ok: false,
                status: 404,
                headers: {},
                text: async () => JSON.stringify({ error: "Not found" }),
                json: async () => ({ error: "Not found" }),
              };
            }
          }.toString()}

          const $1 = await fakeFetch
        `.trim(),
      );

      content = content.replace(
        /const (\w+)=new WebSocket/,
        `
          return;
          const $1 = new WebSocket
        `.trimEnd(),
      );
      fs.writeFileSync(target, content);
    } else {
      fs.copyFileSync(filepath, target);
    }
  }
};

const main = async () => {
  const port = 7100;
  const outDir = "ignoreme/evalite-ui";

  const db = createDatabase(DB_LOCATION);
  const server = createServer({ db });
  server.start(port);

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** i));
    const success = await fetch(`http://localhost:${port}/api/server-state`).then(
      (res) => res.ok,
      () => false,
    );
    if (success) break;
    if (i === 9) throw new Error("server not ready");
    console.log("waiting for server to be ready", i);
  }

  await exportEvaliteUI(db, { port, outDir });
  console.log(`exported evalite ui to ${outDir}`);
  process.exit(0);
};

main();
