import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcTarget } from "capnweb";
import type { IterateConnection } from "../node.ts";

/** What `iterate provide` reads from a file: its default export, called on every connection with
 *  that connection's project, answers the object whose functions are lent; `description`, when
 *  exported, is the one line a model reads for the name. */
export type ProvidedFile = {
  provide: (input: { itx: unknown }) => unknown;
  description?: string;
};

/** A capability's name: `itx.<name>`, dotted segments allowed (`whatsapp.jonas`). */
const NAME = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/;

/** THE FILE, IMPORTED BY NODE ITSELF: `.ts`, `.mts`, `.mjs` and `.js` alike (Node strips a `.ts`
 *  file's types, 22.18 and later). Its bare imports resolve from its own folder's `node_modules`, so
 *  its dependencies are that folder's to install, never this CLI's: a missing one names the folder
 *  to install in. Importing it runs its top level once, for the whole process. */
export async function importProvidedFile(file: string): Promise<ProvidedFile> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`No file ${path}.`);
  let imported: { default?: unknown; description?: unknown };
  try {
    imported = await import(pathToFileURL(path).href);
  } catch (error) {
    // Node's module errors are Errors with a `code`; anything else reads as neither and is rethrown
    const { code, message } = error as { code?: string; message?: string };
    if (code === "ERR_MODULE_NOT_FOUND" && message?.startsWith("Cannot find package")) {
      const packageDirectory = nearestPackageDirectory(path);
      throw new Error(
        packageDirectory
          ? `${message}. Install ${basename(path)}'s dependencies first: npm install (or pnpm install) in ${packageDirectory}.`
          : `${message}. ${basename(path)} has no package.json above it: make one in ${dirname(path)} that lists its dependencies, then npm install there.`,
      );
    }
    if (code === "ERR_UNKNOWN_FILE_EXTENSION")
      throw new Error(
        `${message}. Node ${process.version} cannot load ${extname(path)} files: Node 22.18 or later strips a TypeScript file's types itself.`,
      );
    throw error;
  }
  if (typeof imported.default !== "function")
    throw new Error(
      `${basename(path)} has no default export to provide: export default function ({ itx }) { return { someFunction() {} } }`,
    );
  return {
    // a function, checked above; what it answers is checked when it is called (rpcTargetOf)
    provide: imported.default as ProvidedFile["provide"],
    description: typeof imported.description === "string" ? imported.description : undefined,
  };
}

/** `whatsapp.ts` → `whatsapp`: the default name, when the file's name is one. */
export function nameOfFile(file: string): string {
  const name = basename(file, extname(file));
  if (!NAME.test(name))
    throw new Error(
      `${basename(file)} is not a capability name: pass --name, letters and digits starting with a letter (e.g. --name whatsapp).`,
    );
  return name;
}

/** THE LENT STUB: the functions of `provided` as the methods of one RpcTarget of THIS process's
 *  capnweb. capnweb lends only instances of its own `RpcTarget`, and in Node that is a class of each
 *  installed copy: an RpcTarget from the file's own copy of capnweb would not be one here, so the
 *  file answers plain functions and this wraps them. Which functions is capnweb's own rule: a plain
 *  object's own properties, a class instance's methods (never its fields). Arguments and answers
 *  cross as they are (plain data, bytes, stubs); anything else fails the call. */
export function rpcTargetOf(provided: unknown): RpcTarget {
  if (typeof provided !== "object" || !provided)
    throw new Error(
      `The default export answered ${String(provided)}: it must answer an object of functions.`,
    );
  // an object, checked above: its properties are read by name, each checked to be a function
  const object = provided as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  const layers: object[] = [];
  if (prototype === Object.prototype || prototype === null) layers.push(object);
  else
    for (
      let layer = prototype;
      layer && layer !== Object.prototype;
      layer = Object.getPrototypeOf(layer)
    )
      layers.push(layer);
  const names = new Set<string>();
  for (const layer of layers)
    for (const name of Object.getOwnPropertyNames(layer))
      if (name !== "constructor" && typeof object[name] === "function") names.add(name);
  if (names.size === 0)
    throw new Error("The default export answered an object with no functions: nothing to lend.");
  class Provided extends RpcTarget {}
  for (const name of names)
    Object.defineProperty(Provided.prototype, name, {
      // `name` was collected only where `object[name]` is a function
      value: (...args: unknown[]) => (object[name] as (...args: unknown[]) => unknown)(...args),
    });
  return new Provided();
}

/** How long `provide` waits before each attempt to reconnect after its connection closed, about
 *  five minutes in all, as `iterate tunnel` does: long enough for Wi-Fi to come back or a laptop to
 *  wake, short enough that a lend whose network is gone for good says so and exits. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, ...Array(9).fill(30_000)];

/** `iterate provide <file>`: lend the file's functions to the project as `itx.<name>` until Ctrl-C.
 *  On every connection — the first, and each one `reconnect` opens after one closes or the lend
 *  ends under it — the file's default export is called with that connection's project as `itx`,
 *  and what it answers is lent again at the same name: the file keeps its long-lived state (a
 *  socket, a session) in its own module scope and reaches the project through the newest `itx`.
 *  `itx.<name>` is printed on stdout once live. Only when every attempt to reconnect fails does it
 *  end, with an error. */
export async function runProvide(input: {
  connection: IterateConnection;
  reconnect: () => Promise<IterateConnection>;
  project: string;
  file: ProvidedFile;
  name: string;
  /** the reconnect schedule — a test's, `RECONNECT_DELAYS_MS` otherwise */
  reconnectDelaysMs?: readonly number[];
}): Promise<void> {
  if (!NAME.test(input.name))
    throw new Error(
      `${JSON.stringify(input.name)} is not a capability name: letters and digits starting with a letter, dotted segments allowed (whatsapp, whatsapp.jonas).`,
    );
  const match = `itx.${input.name}`;
  let stop = () => {};
  const stopped = new Promise<"stopped">((resolve) => (stop = () => resolve("stopped")));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  /** Lend over one connection until Ctrl-C, or until the connection closes or the lend ends — why,
   *  as a line. */
  const serve = async (
    connection: IterateConnection,
    first: boolean,
  ): Promise<"stopped" | string> => {
    using project = await connection.session.projects.get(input.project);
    const target = rpcTargetOf(await input.file.provide({ itx: project }));
    using lend = await project.provide(
      match,
      target,
      input.file.description ? { description: input.file.description } : undefined,
    );
    if (first) {
      console.log(match);
      console.error(`${match} is live for project ${input.project}. Press Ctrl-C to stop.`);
    } else console.error(`Reconnected: ${match} is live again.`);
    const lendEnded = lend.lendEnded().then(
      (reason) => `its lend ended: the stub ${reason}`,
      (error: unknown) => `its lend ended: ${messageOf(error)}`,
    );
    const connectionClosed = connection.closed.then(
      ({ code, reason }) => `${code}: ${reason || "connection closed"}`,
    );
    return await Promise.race([stopped, connectionClosed, lendEnded]);
  };
  const delaysMs = input.reconnectDelaysMs || RECONNECT_DELAYS_MS;
  let connection: IterateConnection | null = input.connection;
  let lastFailure = "";
  try {
    for (let first = true, failures = 0; ; first = false) {
      if (connection) {
        try {
          const outcome = await serve(connection, first);
          if (outcome === "stopped") return;
          lastFailure = outcome;
          console.error(`${match} disconnected (${lastFailure}). Reconnecting...`);
          failures = 0; // it was lent: a fresh round of attempts
        } catch (error) {
          if (first) throw error; // the first connection's refusal is the answer
          lastFailure = messageOf(error);
          console.error(`Could not lend ${match} again: ${lastFailure}`);
        } finally {
          connection[Symbol.dispose]();
        }
      }
      const delayMs = delaysMs[failures++];
      if (delayMs === undefined)
        throw new Error(
          `${match} disconnected and could not reconnect (${lastFailure}). Run iterate provide again.`,
        );
      let wait: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        stopped,
        new Promise<"waited">((resolve) => (wait = setTimeout(() => resolve("waited"), delayMs))),
      ]);
      clearTimeout(wait);
      if (waited === "stopped") return;
      connection = await input.reconnect().catch((error: unknown) => {
        lastFailure = messageOf(error);
        console.error(`Could not reconnect: ${lastFailure}`);
        return null;
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/** The folder of the nearest package.json at or above the file's own folder. */
function nearestPackageDirectory(path: string): string | null {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
