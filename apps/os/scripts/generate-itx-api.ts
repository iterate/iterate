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
// members. Classes extending IterateRpcTarget<"Name"> become `interface Name`
// (the string-literal type argument IS the published name — no naming
// convention, no override table); classes extending IterateRpcRelay<"Name">
// instead publish the existing hand-authored contract of that name. Named type
// aliases and interfaces referenced in signatures are discovered wherever they
// live (their domain modules) and emitted once — checker-expanded when the
// alias is a bare type-reference (`z.infer<…>`, `ProcessorState<…>`, i.e. a
// derived type that would not be import-free copied literally), and copied
// verbatim otherwise (hand-authored literal shapes, which keeps their
// docstrings and generics intact).
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
const outPath = path.join(projectDir, "src/itx-api.generated.ts");

/** The opt-in roots in rpc-targets.ts (see their docstrings there). */
const ITERATE_ROOT = "IterateRpcTarget";
const RELAY_ROOT = "IterateRpcRelay";

/**
 * Public members that are host-side plumbing, never part of the RPC contract.
 * A member whose TYPE is a `DurableObjectStub` is excluded structurally (see
 * `emitClass`) so it can never leak regardless of name — these are the
 * remaining object-typed plumbing fields.
 */
const SKIPPED_MEMBER_NAMES = new Set(["props", "projectProps"]);

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
  "RequestInfo",
  "RequestInit",
  "ArrayBuffer",
  "Uint8Array",
  "Blob",
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
  if (!rpcTargetsFile) {
    throw new Error("could not load src/rpc-targets.ts into the program");
  }

  // ── Registries ─────────────────────────────────────────────────────────────

  /** Every class declared in rpc-targets.ts, by class name. */
  const allClasses = new Map<string, ts.ClassDeclaration>();
  for (const statement of rpcTargetsFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      allClasses.set(statement.name.text, statement);
    }
  }

  const extendsClauseOf = (decl: ts.ClassDeclaration): ts.ExpressionWithTypeArguments | undefined =>
    decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];

  /**
   * Walk the extends chain to the opt-in root. Returns which root terminates
   * the chain (relay classes go through IterateRpcRelay, which itself extends
   * IterateRpcTarget), or undefined for a class that never opted in.
   */
  const rootOf = (
    decl: ts.ClassDeclaration,
  ): typeof ITERATE_ROOT | typeof RELAY_ROOT | undefined => {
    const base = extendsClauseOf(decl)?.expression.getText();
    if (base === RELAY_ROOT) return RELAY_ROOT;
    if (base === ITERATE_ROOT) return ITERATE_ROOT;
    const parent = base ? allClasses.get(base) : undefined;
    return parent ? rootOf(parent) : undefined;
  };

  /**
   * The published name: the string-literal type argument in the class's own
   * extends clause (`extends IterateRpcTarget<"Stream">`, or
   * `extends ParentClass<"ProjectStreamCollection">` for a subclass). A class
   * hierarchy's PARENT names itself in its own type-parameter default
   * (`class X<Name extends string = "StreamCollection"> extends IterateRpcTarget<Name>`),
   * so every published name is spelled exactly once, at the class that defines it.
   */
  const publishedNameOf = (decl: ts.ClassDeclaration): string => {
    const clause = extendsClauseOf(decl);
    const arg = clause?.typeArguments?.[0];
    if (arg && ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
      return arg.literal.text;
    }
    if (arg && ts.isTypeReferenceNode(arg)) {
      const param = decl.typeParameters?.find((tp) => tp.name.text === arg.typeName.getText());
      const fallback = param?.default;
      if (fallback && ts.isLiteralTypeNode(fallback) && ts.isStringLiteral(fallback.literal)) {
        return fallback.literal.text;
      }
    }
    throw new Error(
      `class ${decl.name?.text} opted into the itx contract (extends ${ITERATE_ROOT}) but does ` +
        `not spell its published name as a string literal — write ` +
        `\`extends ${ITERATE_ROOT}<"Name">\` (or pass/default the literal through the parent's generic).`,
    );
  };

  /** class name -> published name (its emitted interface, or its relay contract). */
  const renameMap = new Map<string, string>();
  /** published interface name -> class, for classes that DO define a surface. */
  const classByPublicName = new Map<string, ts.ClassDeclaration>();
  /** published relay contract names (must resolve to hand-authored named types). */
  const relayContracts = new Set<string>();
  for (const [className, decl] of allClasses) {
    if (className === ITERATE_ROOT || className === RELAY_ROOT) continue;
    const root = rootOf(decl);
    if (!root) continue;
    const publicName = publishedNameOf(decl);
    renameMap.set(className, publicName);
    if (root === RELAY_ROOT) {
      relayContracts.add(publicName);
    } else {
      classByPublicName.set(publicName, decl);
    }
  }

  /**
   * Every exported named type (alias or interface) in the app, by name, keyed
   * to all its declarations. Discovered across the program because itx data
   * shapes live in their own domain modules now, not one central file. The
   * walker is demand-driven — only names actually reached from the entrypoint
   * are emitted — and a reached name with more than one declaration is a hard
   * error (see `resolveNamedDecl`), so cross-module name clashes can never
   * silently pick the wrong shape.
   */
  const namedDecls = new Map<string, (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[]>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName === rpcTargetsPath || sourceFile.fileName === outPath) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;
    for (const statement of sourceFile.statements) {
      if (
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const list = namedDecls.get(statement.name.text) ?? [];
        list.push(statement);
        namedDecls.set(statement.name.text, list);
      }
    }
  }

  // Every relay must forward to a contract that actually exists as a hand-authored
  // named type — otherwise a typo'd or renamed contract would emit a dangling name.
  for (const contract of relayContracts) {
    if (!namedDecls.has(contract)) {
      throw new Error(
        `a class extends ${RELAY_ROOT}<"${contract}">, but no module exports a type of that name`,
      );
    }
  }

  /** Resolve a reached named type to its single declaration, or throw if ambiguous. */
  const resolveNamedDecl = (
    name: string,
  ): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined => {
    const list = namedDecls.get(name);
    if (!list || list.length === 0) return undefined;
    if (list.length > 1) {
      const files = list.map((d) => path.relative(projectDir, d.getSourceFile().fileName));
      throw new Error(
        `itx api generation reached ambiguous type "${name}" — declared in ${files.length} ` +
          `modules (${files.join(", ")}). Give the itx-facing one a unique name.`,
      );
    }
    return list[0];
  };

  /**
   * A hand-authored literal shape is copied verbatim (docstrings + generics
   * preserved). A type alias whose right-hand side is a bare type reference
   * (`z.infer<…>`, `ProcessorState<…>`) is a DERIVED type — copying it verbatim
   * would drag in imports — so it is checker-expanded into structural form.
   * Interfaces are always literal and copied verbatim.
   */
  const isDerivedAlias = (
    decl: ts.TypeAliasDeclaration | ts.InterfaceDeclaration,
  ): decl is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(decl) && ts.isTypeReferenceNode(decl.type);

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
      if (classByPublicName.has(name) || namedDecls.has(name)) {
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

  /** True when an emitted member type is a Durable Object stub (host plumbing). */
  const isDurableObjectStub = (typeText: string): boolean => /\bDurableObjectStub\b/.test(typeText);

  /** The last JSDoc block in a declaration's leading trivia, verbatim. */
  const jsDocOf = (decl: ts.Node): string | undefined => {
    const fullText = decl.getSourceFile().getFullText();
    const trivia = fullText.slice(decl.getFullStart(), decl.getStart());
    const blocks = trivia.match(/\/\*\*[\s\S]*?\*\//g);
    return blocks?.at(-1);
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
    const lines: string[] = [];
    const classDoc = jsDocOf(cls);
    if (classDoc) lines.push(classDoc);
    // A class extending another published class is an interface extension:
    // emit only the subclass's own members and inherit the rest. (The opt-in
    // roots themselves are not in renameMap, so a direct extends is no clause.)
    const baseClassName = extendsClauseOf(cls)?.expression.getText();
    const basePublicName = baseClassName ? renameMap.get(baseClassName) : undefined;
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

      const doc = jsDocOf(member);

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
        // A member typed as a Durable Object stub is host plumbing, never the
        // public contract — exclude it structurally so it can't leak via a
        // forgotten `@internal` tag or an unlisted name.
        if (isDurableObjectStub(typeText)) continue;
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
        if (isDurableObjectStub(typeText)) continue;
        if (doc) lines.push(doc);
        lines.push(`  ${memberName}: ${typeText};`);
      }
    }

    lines.push("}");
    interfaceChunks.push(rewriteAndCollect(lines.join("\n"), `interface ${publicName}`));
  };

  const emitNamedDecl = (name: string, decl: ts.TypeAliasDeclaration | ts.InterfaceDeclaration) => {
    const doc = jsDocOf(decl);
    const from = path.relative(projectDir, decl.getSourceFile().fileName);
    if (isDerivedAlias(decl)) {
      // Derived alias (z.infer<…>, ProcessorState<…>): expand to structural form.
      const type = checker.getTypeAtLocation(decl.name);
      const expanded = checker.typeToString(type, decl, typeFlags | ts.TypeFormatFlags.InTypeAlias);
      aliasChunks.push(
        rewriteAndCollect(
          `${doc ? `${doc}\n` : ""}export type ${name} = ${expanded};`,
          `derived alias ${name} (${from})`,
        ),
      );
      return;
    }
    // Hand-authored literal shape: copy verbatim, docstrings and generics intact.
    const typeParams = new Set((decl.typeParameters ?? []).map((tp) => tp.name.text));
    const chunk = rewriteAndCollect(
      doc ? `${doc}\n${decl.getText()}` : decl.getText(),
      `${name} (${from})`,
      typeParams,
    );
    (ts.isInterfaceDeclaration(decl) ? interfaceChunks : aliasChunks).push(chunk);
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
    const decl = resolveNamedDecl(name);
    if (decl) {
      emitNamedDecl(name, decl);
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
