const DYNAMIC_WORKER_COMPATIBILITY_DATE = "2026-02-05";

export async function executeCodeInDynamicWorker(options: {
  code: string;
  loader: WorkerLoader;
}): Promise<string> {
  const worker = options.loader.get(crypto.randomUUID(), () => ({
    compatibilityDate: DYNAMIC_WORKER_COMPATIBILITY_DATE,
    mainModule: "index.js",
    modules: {
      "index.js": {
        js: buildWorkerSource(options.code),
      },
    },
    globalOutbound: null,
  }));

  try {
    const response = await worker.getEntrypoint().fetch("https://codemode.execute/");
    const payload = (await response.json()) as { result?: unknown };
    return typeof payload.result === "string" ? payload.result : stringifyUnknown(payload.result);
  } catch (error) {
    return formatError(error);
  }
}

function buildWorkerSource(code: string) {
  return `
function stringifyUnknown(value) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack ?? \`\${error.name}: \${error.message}\`;
  }

  return String(error);
}

export default {
  async fetch() {
    try {
      const result = await (async () => {
${indentCode(code, 8)}
      })();

      return Response.json({ result: stringifyUnknown(result) });
    } catch (error) {
      return Response.json({ result: formatError(error) }, { status: 500 });
    }
  },
};
`.trim();
}

function indentCode(code: string, spaces: number) {
  const prefix = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
}
