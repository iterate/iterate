// https://nodejs.org/docs/latest-v24.x/api/module.html#customization-hooks

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    const url = new URL("./shimmed-workers.mjs", import.meta.url).href;
    return { url, shortCircuit: true, format: "module" };
  }
  if (specifier === "cloudflare:email") {
    const url = new URL("./shimmed-email.mjs", import.meta.url).href;
    return { url, shortCircuit: true, format: "module" };
  }
  if (specifier.startsWith("cloudflare:")) {
    throw new Error(`Cloudflare specifier ${specifier} not supported in CLI`);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  // Inject import.meta.env into the source code
  if (result.format === "module" && result.source) {
    let source = result.source.toString();
    if (source.includes("import.meta.env")) {
      const envShim = `
        const __importMetaEnv = ${JSON.stringify(process.env)};
        if (!import.meta.env) {
          Object.defineProperty(import.meta, 'env', {
            value: __importMetaEnv,
            writable: false,
            enumerable: true,
            configurable: false
          });
        }
      `;
      source = envShim + source;
      return { ...result, source };
    }
  }

  return result;
}
