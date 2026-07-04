// Generates src/itx-api.generated.ts — the single, standalone, annotated
// public itx type surface — from the RpcTarget classes in src/rpc-targets.ts.
//
// The RpcTargets (plus the zod schemas their signatures use) are the ONE
// source of truth: docstrings live on the classes, data shapes on the schemas.
// This script projects that source of truth into one import-free .ts file that
// (a) itx scripts can typecheck against, (b) humans can read top-to-bottom,
// (c) agents receive verbatim via the ITX_TYPES_SOURCE embed.
//
// How it works: build a TS program over rpc-targets.ts, start at
// UnauthenticatedOsRpcTarget, and walk every type reachable from its public
// members. RpcTarget classes become interfaces (class name minus "RpcTarget",
// plus a few naming overrides); named type aliases referenced in signatures
// are emitted once — verbatim when they are already import-free (types.ts),
// checker-expanded when they are zod-inferred (schema files).
//
// Regenerate: pnpm generate:itx-api
// Freshness is enforced by src/itx-api.generated.test.ts.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const rpcTargetsPath = path.join(projectDir, "src/rpc-targets.ts");
const typesPath = path.join(projectDir, "src/types.ts");
const outPath = path.join(projectDir, "src/itx-api.generated.ts");

/**
 * Classes whose public interface name is not simply the class name minus the
 * "RpcTarget" suffix. `null` means "never emit an interface for this class" —
 * signatures mentioning it are rewritten to the mapped contract name instead.
 */
const CLASS_NAME_OVERRIDES: Record<string, string> = {
  ProjectRpcTarget: "Itx",
  SlackRpcTarget: "SlackCapability",
  GmailRpcTarget: "GmailCapability",
  IntegrationsRpcTarget: "ProjectIntegrations",
  ItxExampleCatalogRpcTarget: "ItxExampleCatalog",
  StreamSubscriptionRpcTarget: "StreamSubscriptionHandle",
  ProcessorStateSubscriptionRpcTarget: "ProcessorStateSubscriptionHandle",
  ProjectEgressInterceptRpcTarget: "ProjectEgressIntercept",
};

/**
 * Classes that relay an existing named contract rather than defining a surface
 * of their own. Mentions are renamed; the contract is emitted from the
 * registry (types.ts / schemas), not from the class members.
 */
const CLASS_TO_CONTRACT: Record<string, string> = {
  ProcessorRelayRpcTarget: "StreamProcessorRpc",
  StreamProcessorRpcTarget: "StreamProcessorRpc",
  McpClientRpcTarget: "McpClientRpc",
  OpenApiRpcTarget: "OpenApiRpc",
  DynamicWorkerRpcTarget: "DynamicWorkerCapability",
};

/** Public members that are host-side plumbing, never part of the RPC contract. */
const SKIPPED_MEMBER_NAMES = new Set(["props", "projectProps", "durableObjectStub"]);

/** Ambient names that need no emission (runtime globals the REPL/editor shims). */
const AMBIENT_NAMES = new Set([
  "Promise",
  "Record",
  "Array",
  "Pick",
  "Omit",
  "Partial",
  "Parameters",
  "NonNullable",
  "Disposable",
  "Request",
  "Response",
  "Headers",
  "ReadableStream",
  "URL",
  "Error",
  "Symbol",
]);

export function generateItxApi(): string {
  const configFile = ts.readConfigFile(path.join(projectDir, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectDir);
  const program = ts.createProgram({
    rootNames: [rpcTargetsPath],
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const rpcTargetsFile = program.getSourceFile(rpcTargetsPath);
  const typesFile = program.getSourceFile(typesPath);
  if (!rpcTargetsFile || !typesFile) {
    throw new Error("could not load src/rpc-targets.ts / src/types.ts into the program");
  }

  // ── Registries ─────────────────────────────────────────────────────────────

  /** Every RpcTarget class in rpc-targets.ts, by class name. */
  const classesByName = new Map<string, ts.ClassDeclaration>();
  for (const statement of rpcTargetsFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text.endsWith("RpcTarget")) {
      classesByName.set(statement.name.text, statement);
    }
  }

  /** class name -> emitted interface name (or relay contract name). */
  const renameMap = new Map<string, string>();
  /** emitted interface name -> class, for classes that DO define a surface. */
  const classByPublicName = new Map<string, ts.ClassDeclaration>();
  for (const [className, decl] of classesByName) {
    const contract = CLASS_TO_CONTRACT[className];
    if (contract) {
      renameMap.set(className, contract);
      continue;
    }
    const publicName = CLASS_NAME_OVERRIDES[className] ?? className.replace(/RpcTarget$/, "");
    renameMap.set(className, publicName);
    classByPublicName.set(publicName, decl);
  }

  /** Named types declared in types.ts (import-free — copyable verbatim). */
  const typesTsDecls = new Map<string, ts.TypeAliasDeclaration | ts.InterfaceDeclaration>();
  for (const statement of typesFile.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      statement.name
    ) {
      typesTsDecls.set(statement.name.text, statement);
    }
  }

  /**
   * Named type aliases exported from schema modules (zod-inferred, so they
   * must be checker-expanded into structural form to stay import-free).
   * Discovered lazily: any exported TypeAliasDeclaration outside types.ts and
   * rpc-targets.ts that a signature mentions.
   */
  const schemaAliasDecls = new Map<string, ts.TypeAliasDeclaration>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName === typesPath || sourceFile.fileName === rpcTargetsPath) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;
    for (const statement of sourceFile.statements) {
      if (
        ts.isTypeAliasDeclaration(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        !schemaAliasDecls.has(statement.name.text)
      ) {
        schemaAliasDecls.set(statement.name.text, statement);
      }
    }
  }

  // ── Emission ───────────────────────────────────────────────────────────────

  const emitted = new Set<string>();
  const interfaceChunks: string[] = [];
  const aliasChunks: string[] = [];
  const queue: string[] = [];
  /** PascalCase names mentioned in output that no registry can supply. */
  const unresolved = new Map<string, string>();

  const enqueue = (name: string) => {
    if (!emitted.has(name) && !AMBIENT_NAMES.has(name)) queue.push(name);
  };

  /** Rewrite class names to public names, then enqueue every named type the text mentions. */
  const rewriteAndCollect = (text: string, context: string, exclude?: Set<string>): string => {
    let out = text;
    for (const [className, publicName] of renameMap) {
      out = out.replaceAll(new RegExp(`\\b${className}\\b`, "g"), publicName);
    }
    // zod's JSON helper prints its internal alias; the public name is JsonValue.
    out = out.replaceAll(/\bz\.core\.util\.JSONType\b/g, "JsonValue");
    // Scan code only — docstring prose is full of capitalized words.
    const codeOnly = out.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
    for (const match of codeOnly.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
      const name = match[0];
      if (exclude?.has(name)) continue;
      if (classByPublicName.has(name) || typesTsDecls.has(name) || schemaAliasDecls.has(name)) {
        enqueue(name);
      } else if (!AMBIENT_NAMES.has(name) && !/^[A-Z][a-z]?$/.test(name)) {
        // Single letters (T, K…) are type params; everything else unknown is a
        // leak — an inferred type dragged in host-side plumbing. Collect for
        // the final error so the emitted file is guaranteed standalone.
        if (!unresolved.has(name)) unresolved.set(name, context);
      }
    }
    return out;
  };

  const typeFlags =
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

  const printType = (type: ts.Type, location: ts.Node): string =>
    checker.typeToString(type, location, typeFlags);

  /** The last JSDoc block in a declaration's leading trivia, verbatim. */
  const jsDocOf = (decl: ts.Node): string | undefined => {
    const fullText = decl.getSourceFile().getFullText();
    const trivia = fullText.slice(decl.getFullStart(), decl.getStart());
    const blocks = trivia.match(/\/\*\*[\s\S]*?\*\//g);
    return blocks?.at(-1);
  };

  /** Members of the interfaces a class `implements`, for docstring fallback. */
  const interfaceMemberDocs = (cls: ts.ClassDeclaration): Map<string, string> => {
    const docs = new Map<string, string>();
    for (const heritage of cls.heritageClauses ?? []) {
      if (heritage.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const typeNode of heritage.types) {
        const name = typeNode.expression.getText();
        const iface = typesTsDecls.get(name);
        if (!iface || !ts.isInterfaceDeclaration(iface)) continue;
        for (const member of iface.members) {
          const memberName = member.name?.getText();
          const doc = memberName ? jsDocOf(member) : undefined;
          if (memberName && doc && !docs.has(memberName)) docs.set(memberName, doc);
        }
      }
    }
    return docs;
  };

  const classDocFallback = (cls: ts.ClassDeclaration): string | undefined => {
    for (const heritage of cls.heritageClauses ?? []) {
      if (heritage.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const typeNode of heritage.types) {
        const iface = typesTsDecls.get(typeNode.expression.getText());
        if (iface) return jsDocOf(iface);
      }
    }
    return undefined;
  };

  const paramText = (param: ts.ParameterDeclaration): string => {
    if (param.name.getText() === "this") return "";
    const rest = param.dotDotDotToken ? "..." : "";
    const optional = param.questionToken ? "?" : "";
    const explicit = param.type?.getText();
    const typeText =
      explicit && !explicit.includes("Parameters<")
        ? explicit
        : printType(checker.getTypeAtLocation(param), param);
    return `${rest}${param.name.getText()}${optional}: ${typeText}`;
  };

  const emitClass = (publicName: string, cls: ts.ClassDeclaration) => {
    const memberDocs = interfaceMemberDocs(cls);
    const lines: string[] = [];
    const classDoc = jsDocOf(cls) ?? classDocFallback(cls);
    if (classDoc) lines.push(classDoc);
    // A class extending another RpcTarget is an interface extension: emit only
    // the subclass's own members and inherit the rest.
    const baseClassName = cls.heritageClauses
      ?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
      ?.types[0]?.expression.getText();
    const basePublicName =
      baseClassName && baseClassName !== "RpcTarget" ? renameMap.get(baseClassName) : undefined;
    lines.push(
      `export interface ${publicName}${basePublicName ? ` extends ${basePublicName}` : ""} {`,
    );

    for (const member of cls.members) {
      if (ts.isConstructorDeclaration(member)) continue;
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
      if (
        modifiers?.some(
          (m) =>
            m.kind === ts.SyntaxKind.StaticKeyword ||
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword,
        )
      ) {
        continue;
      }
      if (member.name && ts.isPrivateIdentifier(member.name)) continue;
      if (ts.getJSDocTags(member).some((tag) => tag.tagName.text === "internal")) continue;

      const memberName = member.name?.getText() ?? "";
      if (SKIPPED_MEMBER_NAMES.has(memberName)) continue;

      const doc = jsDocOf(member) ?? memberDocs.get(memberName);

      if (ts.isMethodDeclaration(member)) {
        if (memberName === "[Symbol.dispose]") {
          if (doc) lines.push(doc);
          lines.push(`  [Symbol.dispose](): void;`);
          continue;
        }
        const signature = checker.getSignatureFromDeclaration(member);
        if (!signature) continue;
        const typeParams = member.typeParameters
          ? `<${member.typeParameters.map((tp) => tp.getText()).join(", ")}>`
          : "";
        const params = member.parameters.map(paramText).filter(Boolean).join(", ");
        const returnText = member.type?.getText() ?? printType(signature.getReturnType(), member);
        if (doc) lines.push(doc);
        lines.push(`  ${memberName}${typeParams}(${params}): ${returnText};`);
        continue;
      }

      if (ts.isGetAccessorDeclaration(member)) {
        const typeText =
          member.type?.getText() ?? printType(checker.getTypeAtLocation(member), member);
        if (doc) lines.push(doc);
        // `X | undefined` getters are optional members of the contract.
        const optionalMatch = typeText.match(/^(.*?)\s*\|\s*undefined$/);
        if (optionalMatch) {
          lines.push(`  ${memberName}?: ${optionalMatch[1]};`);
        } else {
          lines.push(`  ${memberName}: ${typeText};`);
        }
        continue;
      }

      if (ts.isPropertyDeclaration(member)) {
        const typeText =
          member.type?.getText() ?? printType(checker.getTypeAtLocation(member), member);
        if (doc) lines.push(doc);
        lines.push(`  ${memberName}: ${typeText};`);
      }
    }

    lines.push("}");
    interfaceChunks.push(rewriteAndCollect(lines.join("\n"), `interface ${publicName}`));
  };

  const emitTypesTsDecl = (
    name: string,
    decl: ts.TypeAliasDeclaration | ts.InterfaceDeclaration,
  ) => {
    const doc = jsDocOf(decl);
    const body = decl.getText();
    const typeParams = new Set((decl.typeParameters ?? []).map((tp) => tp.name.text));
    const chunk = rewriteAndCollect(doc ? `${doc}\n${body}` : body, `types.ts ${name}`, typeParams);
    (ts.isInterfaceDeclaration(decl) ? interfaceChunks : aliasChunks).push(chunk);
  };

  const emitSchemaAlias = (name: string, decl: ts.TypeAliasDeclaration) => {
    const doc = jsDocOf(decl);
    const type = checker.getTypeAtLocation(decl.name);
    const expanded = checker.typeToString(type, decl, typeFlags | ts.TypeFormatFlags.InTypeAlias);
    const chunk = rewriteAndCollect(
      `${doc ? `${doc}\n` : ""}export type ${name} = ${expanded};`,
      `schema alias ${name}`,
    );
    aliasChunks.push(chunk);
  };

  enqueue("UnauthenticatedOs");
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (emitted.has(name)) continue;
    emitted.add(name);
    const cls = classByPublicName.get(name);
    if (cls) {
      emitClass(name, cls);
      continue;
    }
    const typesTsDecl = typesTsDecls.get(name);
    if (typesTsDecl) {
      emitTypesTsDecl(name, typesTsDecl);
      continue;
    }
    const schemaAlias = schemaAliasDecls.get(name);
    if (schemaAlias) {
      emitSchemaAlias(name, schemaAlias);
      continue;
    }
    throw new Error(`itx api generation reached unknown type "${name}"`);
  }

  if (unresolved.size > 0) {
    const details = [...unresolved].map(([name, context]) => `  ${name} (via ${context})`);
    throw new Error(
      `itx api generation leaked ${unresolved.size} unresolvable type name(s) — add an explicit\n` +
        `signature on the RpcTarget member (or extend AMBIENT_NAMES if it is a runtime global):\n` +
        details.join("\n"),
    );
  }

  const preamble = (() => {
    const fullText = rpcTargetsFile.getFullText();
    const firstStatementStart = rpcTargetsFile.statements[0]?.getStart() ?? 0;
    const trivia = fullText.slice(0, firstStatementStart);
    return trivia.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
  })();

  const raw = [
    "// GENERATED by scripts/generate-itx-api.ts — do not edit.",
    "// Regenerate with: pnpm generate:itx-api",
    "//",
    "// The source of truth is src/rpc-targets.ts (docstrings + signatures) and the",
    "// zod schemas its signatures use. This file is the projection: one standalone,",
    "// import-free module describing everything reachable from the /api entrypoint.",
    "",
    preamble,
    "",
    interfaceChunks.join("\n\n"),
    "",
    "// ─── Data shapes ─────────────────────────────────────────────────────────────",
    "",
    aliasChunks.join("\n\n"),
    "",
  ].join("\n");

  // Format through the repo's formatter so the emitted file is byte-stable
  // (the freshness test compares exact text).
  return execFileSync(
    path.join(projectDir, "../../node_modules/.bin/oxfmt"),
    [`--stdin-filepath=${outPath}`],
    { encoding: "utf8", input: raw },
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  writeFileSync(outPath, generateItxApi());
  console.log(`wrote ${outPath}`);
}
