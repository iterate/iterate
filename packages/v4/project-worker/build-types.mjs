// Emit the real public ITX declaration graph for the isolated checker. No parallel
// handwritten ITX interface, package downloads or host filesystem access at check time.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";

const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const publicRoots = [resolve("src/iterate-context.ts"), resolve("src/session.ts")];
const program = ts.createProgram(publicRoots, {
  ...options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  removeComments: true,
  declarationMap: false,
});
const declarations = new Map();
const emitted = program.emit(undefined, (_path, text, _bom, _error, sources) => {
  for (const source of sources ?? []) declarations.set(source.fileName, text);
});
if (emitted.emitSkipped || emitted.diagnostics.length)
  throw new Error(
    ts.formatDiagnostics(emitted.diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );

const libDirectory = dirname(ts.getDefaultLibFilePath(options));
// Only ship the declaration closure reachable from the public root. `getSourceFiles()` also
// contains every ambient dependency TypeScript happened to load (including its implementation
// ecosystem), which is neither part of ITX's public surface nor useful to the isolated checker.
const reachable = new Set();
const visitDependencies = (source) => {
  if (reachable.has(source.fileName)) return;
  reachable.add(source.fileName);
  const declaration = source.isDeclarationFile ? source.text : declarations.get(source.fileName);
  if (declaration === undefined) throw new Error(`No declarations emitted for ${source.fileName}`);
  const declarationSource = ts.createSourceFile(
    source.fileName,
    declaration,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    if (ts.isExternalModuleReference(node)) specifier = node.expression;
    if (specifier && ts.isStringLiteral(specifier)) {
      const resolved = ts.resolveModuleName(
        specifier.text,
        source.fileName,
        options,
        ts.sys,
      ).resolvedModule;
      const target = resolved && program.getSourceFile(resolved.resolvedFileName);
      if (target) visitDependencies(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(declarationSource);
  for (const reference of declarationSource.typeReferenceDirectives) {
    const resolved = ts.resolveTypeReferenceDirective(
      reference.fileName,
      source.fileName,
      options,
      ts.sys,
    ).resolvedTypeReferenceDirective;
    const target = resolved && program.getSourceFile(resolved.resolvedFileName);
    if (target) visitDependencies(target);
  }
};
for (const root of publicRoots) visitDependencies(program.getSourceFile(root));
// User code may import the configured Workers ambient module directly; it is part of the public
// checker contract even when the ITX declaration text does not itself name it.
for (const typeName of options.types ?? []) {
  const resolved = ts.resolveTypeReferenceDirective(
    typeName,
    resolve("src/iterate-context.ts"),
    options,
    ts.sys,
  ).resolvedTypeReferenceDirective;
  const target = resolved && program.getSourceFile(resolved.resolvedFileName);
  if (target) visitDependencies(target);
}
// Lib files use /// references rather than imports; include the complete default-lib chain.
const visitLib = (file) => {
  if (reachable.has(file)) return;
  const source = program.getSourceFile(file);
  if (!source) return;
  reachable.add(file);
  for (const reference of source.libReferenceDirectives)
    visitLib(resolve(libDirectory, `lib.${reference.fileName}.d.ts`));
};
visitLib(ts.getDefaultLibFilePath(options));
const selected = program
  .getSourceFiles()
  .filter((source) => reachable.has(source.fileName) || dirname(source.fileName) === libDirectory);
const names = new Map(
  selected.map((source) => {
    const normalized = source.fileName.replaceAll("\\", "/");
    const dependencyStart = normalized.indexOf("/node_modules/");
    const identity =
      dependencyStart < 0
        ? `itx/${relative(process.cwd(), source.fileName)}`
        : normalized.slice(dependencyStart);
    const name =
      dirname(source.fileName) === libDirectory
        ? `/types/lib/${basename(source.fileName)}`
        : `/types/${createHash("sha256").update(identity).digest("hex").slice(0, 20)}.d.ts`;
    return [source.fileName, name];
  }),
);
const files = {};
for (const original of selected) {
  const body = original.isDeclarationFile ? original.text : declarations.get(original.fileName);
  if (body === undefined) throw new Error(`No declarations emitted for ${original.fileName}`);
  const source = ts.createSourceFile(original.fileName, body, ts.ScriptTarget.Latest, true);
  const edits = [];
  // Bind import names to the exact dependency bytes selected by this build. The
  // virtual checker then needs neither node_modules symlinks nor package resolution.
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    if (ts.isExternalModuleReference(node)) specifier = node.expression;
    if (specifier && ts.isStringLiteral(specifier)) {
      const resolved = ts.resolveModuleName(
        specifier.text,
        original.fileName,
        options,
        ts.sys,
      ).resolvedModule;
      const target = resolved && names.get(resolved.resolvedFileName);
      if (target)
        edits.push({
          start: specifier.getStart(source),
          end: specifier.end,
          text: JSON.stringify(target.replace(/\.d\.ts$/, "")),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let text = body;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  files[names.get(original.fileName)] = text;
}
const itx = names.get(resolve("src/iterate-context.ts"));
const session = names.get(resolve("src/session.ts"));
if (!itx || !session) throw new Error("Public ITX/session declaration was not emitted");
files["/node_modules/itx/index.d.ts"] =
  `import type { IterateContext } from ${JSON.stringify(itx.replace(/\.d\.ts$/, ""))};\nexport type { IterateContext as Itx };\nexport interface ItxEnv { ITX: { get(): Promise<IterateContext> } }\n`;
files["/index.d.ts"] =
  `export type { IterateContext as Itx } from ${JSON.stringify(itx.replace(/\.d\.ts$/, ""))};\nexport { Session, UnauthenticatedSession } from ${JSON.stringify(session.replace(/\.d\.ts$/, ""))};\n`;
// Browser-facing type imports cannot resolve the checker's virtual absolute paths. Emit exactly
// the same declaration bytes as a relative on-disk graph; no public API is handwritten here.
const physicalRoot = resolve("src/generated/itx-types");
for (const [virtualPath, original] of Object.entries(files)) {
  const destination = resolve(physicalRoot, `.${virtualPath}`);
  let physical = original;
  for (const target of Object.keys(files)) {
    const virtualSpecifier = target.replace(/\.d\.ts$/, "");
    const targetPath = resolve(physicalRoot, `.${target}`);
    let specifier = relative(dirname(destination), targetPath)
      .replaceAll("\\", "/")
      .replace(/\.d\.ts$/, "");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    physical = physical.replaceAll(JSON.stringify(virtualSpecifier), JSON.stringify(specifier));
  }
  mkdirSync(dirname(destination), { recursive: true });
  let previousPhysical;
  try {
    previousPhysical = readFileSync(destination, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previousPhysical !== physical) writeFileSync(destination, physical);
}
const roots = Object.keys(files);
const defaultLib = `/types/lib/${basename(ts.getDefaultLibFilePath(options))}`;
const output = `// Generated by build-types.mjs: declaration text only.\nexport const TYPE_FILES: Record<string, string> = ${JSON.stringify(files)};\nexport const TYPE_ROOTS: string[] = ${JSON.stringify(roots)};\nexport const TYPE_DEFAULT_LIB_FILE = ${JSON.stringify(defaultLib)};\n`;
const path = "src/generated/type-files.ts";
let previous;
try {
  previous = readFileSync(path, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (previous !== output) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output);
}
console.log(`itx types: ${roots.length} declarations, ${(output.length / 1024).toFixed(1)} KiB`);
