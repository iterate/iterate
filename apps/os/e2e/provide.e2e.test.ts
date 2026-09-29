// provide.e2e.test.ts — `iterate provide <file>` against the deployment, the CLI run as a person runs
// it (the package's bin, operator credentials) on a TypeScript file in a folder of its own, with a
// dependency the CLI does not have. Pins:
//   • the file's functions are live as itx.<name>: a script in the project calls one and its answer
//     comes back; the file reaches the project through the itx it was handed (its event lands)
//   • the file's `description` is the lend's
//   • a provide killed outright: the name answers NO_ITX_EXPRESSION_MATCH, as before it was lent
//   • Ctrl-C exits 0 and recalls the lend the same way
// Loading (.ts, .mjs, CommonJS .js), a missing dependency and reconnecting are packages/cli
// src/provide.test.ts; the lend's own machinery, e2e/rpc-stubs-*.e2e.test.ts.

import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { errorCode } from "iterate/lib";
import { expect, test } from "vitest";
import {
  adminCredentials,
  freshCtx,
  openItx,
  readAll,
  rejection,
  until,
  workerUrl,
} from "./support/client.ts";

const bin = fileURLToPath(new URL("../../../packages/cli/bin/iterate.js", import.meta.url).href);

test(
  "iterate provide: a .ts file's functions are itx.<name> for the project's scripts, its itx reaches the project, its description is the lend's; killed or Ctrl-C, the name is unmatched again",
  { timeout: 60_000 },
  async () => {
    const ctx = freshCtx("provide");
    const itx = openItx(ctx);
    using folder = providedFolder();
    await using cli = await cliConfig();

    const provided = cli.provide([join(folder.path, "greeter.ts"), "--project", ctx]);
    expect(await provided.live).toBe("itx.greeter");
    // a script in the project calls it, as an agent's would
    expect(await itx.run(`async (itx) => await itx.greeter.greet("Jonas")`)).toBe("Hello, Jonas");
    expect(
      (await readAll(itx)).filter((event) => event.type === "test/greeted").map((e) => e.payload),
    ).toEqual([{ name: "Jonas" }]);
    expect(
      ((await itx.rewriteRules.list()) as { match: string; description?: string }[]).find(
        (rule) => rule.match === "itx.greeter",
      ),
    ).toMatchObject({ description: "Greets people, from a folder of its own" });

    // killed outright: the lend goes with its session, and the name with it
    await provided.stop("SIGKILL");
    await until("the killed provide's name is unmatched", async () =>
      errorCode(await rejection(itx.invoke(["itx", "greeter", ["greet", "again"]]))) ===
      "NO_ITX_EXPRESSION_MATCH"
        ? true
        : undefined,
    );

    // again, then Ctrl-C: exit 0, and the name is unmatched once more
    const again = cli.provide([join(folder.path, "greeter.ts"), "--project", ctx]);
    await again.live;
    expect(await itx.invoke(["itx", "greeter", ["greet", "Misha"]])).toBe("Hello, Misha");
    expect(await again.stop("SIGINT")).toBe(0);
    await until("the stopped provide's name is unmatched", async () =>
      errorCode(await rejection(itx.invoke(["itx", "greeter", ["greet", "again"]]))) ===
      "NO_ITX_EXPRESSION_MATCH"
        ? true
        : undefined,
    );
  },
);

/** A folder that is a package of its own: `greeter.ts` imports `greeting` from its own
 *  node_modules, which the CLI does not have. */
function providedFolder() {
  const folder = temporaryDirectory();
  writeFileSync(join(folder.path, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(folder.path, "node_modules/greeting"), { recursive: true });
  writeFileSync(
    join(folder.path, "node_modules/greeting/package.json"),
    JSON.stringify({ name: "greeting", type: "module", exports: "./index.js" }),
  );
  writeFileSync(
    join(folder.path, "node_modules/greeting/index.js"),
    `export const hello = "Hello";`,
  );
  writeFileSync(
    join(folder.path, "greeter.ts"),
    `import { hello } from "greeting";
    type Itx = { append(event: { type: string; payload: unknown }): Promise<unknown> };
    export const description = "Greets people, from a folder of its own";
    export default function provide({ itx }: { itx: Itx }) {
      return {
        async greet(name: string): Promise<string> {
          await itx.append({ type: "test/greeted", payload: { name } });
          return \`\${hello}, \${name}\`;
        },
      };
    }`,
  );
  return folder;
}

async function cliConfig() {
  const directory = temporaryDirectory();
  mkdirSync(join(directory.path, "iterate"));
  writeFileSync(
    join(directory.path, "iterate/config.json"),
    JSON.stringify({ default: "e2e", configs: { e2e: { osBaseUrl: workerUrl("/") } } }),
  );
  const children: ChildProcess[] = [];
  return {
    provide(args: string[]) {
      const child = execFile(process.execPath, [bin, "provide", ...args], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: directory.path,
          APP_CONFIG_SECRETS__ADMIN_BEARER: adminCredentials().secret,
          ITERATE_BEARER_TOKEN: "",
        },
      });
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const live = new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once("line", resolve);
        void exited.then((code) =>
          reject(new Error(`iterate provide exited ${code} before it was live: ${stderr}`)),
        );
      });
      live.catch(() => {}); // read through `exited` when it never goes live
      return {
        live,
        stop: (signal: "SIGINT" | "SIGKILL") => {
          child.kill(signal);
          return exited;
        },
      };
    },
    [Symbol.asyncDispose]: async () => {
      for (const child of children) child.kill("SIGKILL");
      directory[Symbol.dispose]();
    },
  };
}
