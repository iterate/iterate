import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";
import { evalite } from "evalite";
import { createDatabase } from "evalite/db";
import { createServer } from "evalite/server";
import { afterAll, beforeAll } from "vitest";
import { createTestHelper, getAuthedTrpcClient, multiTurnScorer } from "./helpers.ts";

let trpcClient!: Awaited<ReturnType<typeof getAuthedTrpcClient>>;
let startedAt!: Date;
let db!: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  trpcClient = await getAuthedTrpcClient();
  const startedAt = new Date();
  db = createDatabase(`node_modules/.evalite/cache.sqlite`);
});

beforeAll(async () => {
  // const server = createServer({
  //   db: createDatabase(`node_modules/.evalite/cache.sqlite`),
  // });
  // server.start(7100);
  // await new Promise((resolve) => setTimeout(resolve, 1000));
  // await fetch("http://localhost:7100/api/server-state").then(async (res) =>
  //   console.log({ json: await res.json() }),
  // );
  // await fetch("http://localhost:7100/api/all-evals").then(async (res) =>
  //   console.log({ json: await res.json() }),
  // );
});

afterAll(async () => {
  const pathsToStore = ["/api/server-state", "/api/menu-items"];
  {
    type DBEval = { name: string; id: number };
    type DBResult = { eval_id: number; id: number };
    const evalsQuery = `select * from evals where run_id in (select id from runs where runType = 'full' and created_at >= ?)`;
    const evals = db.prepare<[string], DBEval>(evalsQuery).all(startedAt.toISOString());

    for (const e of evals) {
      pathsToStore.push(`/api/eval?name=${encodeURIComponent(e.name)}`);

      const resultsQuery = `select * from results where eval_id = ? order by col_order asc`;
      const results = db.prepare<[number], DBResult>(resultsQuery).all(e.id);

      results.forEach((_r, i) => {
        pathsToStore.push(`/api/eval/result?name=${encodeURIComponent(e.name)}&index=${i}`);
      });
    }
  }
  // const json: {
  //   runs: { id: number; runType: "full" | "partial"; created_at: string };
  //   evals: Array<{
  //     created_at: string;
  //     id: number;
  //     name: string;
  //     status: "fail" | "success" | "running";
  //     filepath: string;
  //     duration: number;
  //     run_id: number;
  //     results: Array<{
  //       duration: number;
  //       status: string; //Evalite.ResultStatus;
  //       id: number;
  //       eval_id: number;
  //       created_at: string;
  //       col_order: number;
  //       input: unknown;
  //       expected: unknown;
  //       output: unknown;
  //       rendered_columns: unknown;
  //     }>;
  //   }>;
  // } = await res.json();
  type DBRun = { id: number; runType: string; created_at: string };
  type DBEval = {
    run_id: number;
    created_at: string;
    name: string;
    status: string;
    filepath: string;
    duration: number;
    id: number;
  };
  const runsQuery = `select * from runs where runType = 'full' and created_at >= ?`;
  const runs = db.prepare<[string], DBRun>(runsQuery).all(startedAt.toISOString());
  const evalsQuery = `select * from evals where run_id in (${runsQuery.replace("*", "id")})`;
  const evals = db.prepare<[string], DBEval>(evalsQuery).all(startedAt.toISOString());
  type DBResult = {
    eval_id: number;
    created_at: string;
    col_order: number;
    input: unknown;
    expected: unknown;
    output: unknown;
    rendered_columns: unknown;
    id: number;
  };
  const results = db
    .prepare<[string], DBResult & { eval_name: string }>(
      `
      select results.*, evals.name as eval_name
      from results
      join evals on results.eval_id = evals.id
      where eval_id in (${evalsQuery.replace("*", "id")})
    `,
    )
    .all(startedAt.toISOString());

  const require = createRequire(import.meta.url);
  const evalitePath = require.resolve("evalite");
  const evaliteUIPath = path.join(evalitePath, "../..", "dist/ui");
  console.log({ evaliteUIPath });

  // console.log({ json });
  // for (const e of json.evals) {
  //   const query = { name: e.name };
  //   pathsToStore.push(`/api/eval?${new URLSearchParams(query)}`);

  //   e.results.forEach((r, i) => {
  //     const query = {
  //       name: e.name,
  //       index: i.toString(),
  //     };
  //     pathsToStore.push(`/api/eval/result?${new URLSearchParams(query)}`);
  //   });
  // }
  for (const e of evals) {
    const query = { name: e.name };
    pathsToStore.push(`/api/eval?${new URLSearchParams(query)}`);
  }
  for (const r of results) {
    const query = { name: r.eval_name, index: r.col_order.toString() };
    pathsToStore.push(`/api/eval/result?${new URLSearchParams(query)}`);
  }

  const storedApiResponses = {} as Record<string, any>;
  for (const path of pathsToStore) {
    const res = await fetch("http://localhost:7100" + path);
    const text = await res.text();
    storedApiResponses[path] = text;
  }

  const uiFiles = fs.globSync(path.join(evaliteUIPath, "**/*"), { withFileTypes: true });
  console.log({ uiFiles });
  for (const file of uiFiles) {
    if (!file.isFile()) continue;
    const filepath = path.join(file.parentPath, file.name);
    const target = path.join(process.cwd(), filepath.replace(evaliteUIPath, "ignoreme/evalite-ui"));
    console.log({ target });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let content = fs.readFileSync(filepath, "utf8");
    if (filepath.endsWith(".js")) {
      content = content.replace(
        /const (\w+)=await fetch/,
        `
          // shimmed fetch to return stored api responses
          const storedApiResponses = ${JSON.stringify(storedApiResponses)};
          ${async function fakeFetch(urlString: string, _whatever: {}) {
            const url = new URL(urlString);

            const match = Object.keys(storedApiResponses).find((p) => {
              const storedUrl = new URL(url.origin + p);
              if (storedUrl.pathname !== url.pathname) return false;
              for (const [key, value] of url.searchParams.entries()) {
                if ((storedUrl.searchParams.get(key) || "") !== (value || "")) return false;
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
              console.error("not found", url, Error().stack);
              console.error("available paths:", Object.keys(storedApiResponses));

              return {
                ok: false,
                status: 404,
                headers: {},
                text: async () => JSON.stringify({ error: "Not found" }),
                json: async () => ({ error: "Not found" }),
              };
            }

            // let pathname = new URL(url).pathname;

            // pathname = url.slice("https://".length).split("/").slice(1).join("/");

            // if (!(pathname in storedApiResponses)) {
            //   if (window.location.pathname.startsWith("/eval/")) {
            //     const [evalName, _resultDivider, resultIndex] = window.location.pathname
            //       .replace("/eval/", "")
            //       .split("/");
            //     if (pathname === "/api/eval") {
            //       pathname = `/api/eval?name=${evalName}`;
            //     }
            //     if (pathname === "/api/eval/result") {
            //       pathname = `/api/eval/result?name=${evalName}&index=${resultIndex}`;
            //     }
            //   }
            // }
            // if (!(pathname in storedApiResponses) && pathname === "/api/eval") {
            //   pathname = `/api/eval?name=${window.location.pathname.split("/").at(-1)!}`;
            // }
            // if (!(pathname in storedApiResponses)) {
            //   pathname = pathname.replaceAll("%20", "+");
            // }
            // if (pathname in storedApiResponses) {
            //   return {
            //     ok: true,
            //     status: 200,
            //     headers: {},
            //     text: async () => storedApiResponses[pathname],
            //     json: async () => JSON.parse(storedApiResponses[pathname]),
            //   };
            // } else {
            //   console.error("not found", pathname, Error().stack);
            //   console.error("available paths:", Object.keys(storedApiResponses));

            //   return {
            //     ok: false,
            //     status: 404,
            //     headers: {},
            //     text: async () => JSON.stringify({ error: "Not found" }),
            //     json: async () => ({ error: "Not found" }),
            //   };
            // }
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
    }
    fs.writeFileSync(target, content);
  }

  console.log({ evaliteUIPath });
  // console.log({ json: await res.json() });
});

evalite("agent knows when to end their turn", {
  data: async () => {
    return [
      {
        input: {
          slug: "multi-turn conversation",
          messages: [
            // broken tool call
            { message: "name a green fruit", expected: "a green fruit" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            { message: "name another", expected: "a green fruit, not the same as the 1st or 2nd" },
          ].map((m, i) => {
            m.expected += `. penalize emojis by ${10 + i * 5}%`;
            return m;
          }),
        },
      },
    ];
  },
  task: async (input) => {
    const h = await createTestHelper(trpcClient, input.slug);
    const scorer = multiTurnScorer();

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      scorer.scoreTurn([`user: ${message.message}`, `assistant: ${reply}`], message.expected);
    }
    return { scores: await scorer.getScores() };
  },
  scorers: [
    multiTurnScorer.mean, //
    multiTurnScorer.median,
    multiTurnScorer.min,
  ],
  columns: multiTurnScorer.renderColumns,
});
