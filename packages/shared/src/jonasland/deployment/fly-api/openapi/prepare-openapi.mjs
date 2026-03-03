import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const jsonSpecPath = resolve(root, "openapi3.json");
const yamlSpecPath = resolve(root, "openapi3.yaml");

const spec = JSON.parse(readFileSync(jsonSpecPath, "utf-8"));
const paths = spec.paths;
if (!paths || typeof paths !== "object") {
  throw new Error("invalid OpenAPI document: missing paths object");
}

const httpMethods = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];
const patchedPaths = [];

for (const [path, pathItem] of Object.entries(paths)) {
  if (!pathItem || typeof pathItem !== "object") continue;

  const pathVars = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter(Boolean);
  if (pathVars.length === 0) continue;

  let patched = false;
  for (const method of httpMethods) {
    const operation = pathItem[method];
    if (!operation || typeof operation !== "object") continue;

    const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    const operationPathParamNames = operationParameters
      .filter((param) => param && typeof param === "object" && param.in === "path")
      .map((param) => param.name)
      .filter((value) => typeof value === "string");

    const missingParams = pathVars.filter(
      (paramName) => !operationPathParamNames.includes(paramName),
    );
    if (missingParams.length === 0) continue;

    operation.parameters = operationParameters;
    for (const paramName of missingParams) {
      operation.parameters.push({
        name: paramName,
        in: "path",
        required: true,
        description: "Local patch: inferred from URI template",
        schema: { type: "string" },
      });
      patched = true;
    }
  }

  if (patched) patchedPaths.push(path);
}

let output = JSON.stringify(spec, null, 2);
for (const path of patchedPaths) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  output = output.replace(
    new RegExp(`(\\n\\s*)\\"${escaped}\\": \\{`),
    "$1# LOCAL PATCH: Added missing path parameters inferred from URI template$1" + `"${path}": {`,
  );
}

const header = [
  "# LOCAL PATCHED SPEC",
  "# Source: https://docs.machines.dev/spec/openapi3.json",
  "# This file is generated from openapi3.json by prepare-openapi.mjs.",
  "# We patch missing path parameters inferred from URI templates so @hey-api/openapi-ts",
  "# generates complete typed operations. See inline `LOCAL PATCH` comments below.",
  "",
].join("\n");

writeFileSync(yamlSpecPath, `${header}${output}\n`, "utf-8");
process.stdout.write(`wrote ${yamlSpecPath} (patched paths: ${patchedPaths.length})\n`);
