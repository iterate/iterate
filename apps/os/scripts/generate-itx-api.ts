// Generates src/itx-api.generated.ts — the single, standalone, annotated
// public itx type surface — from the RpcTarget classes in src/rpc-targets.ts.
//
// The RpcTargets (plus the zod schemas their signatures use) are the ONE
// source of truth: docstrings live on the classes, data shapes on the schemas.
// This script projects that source of truth into one import-free .ts file that
// (a) itx scripts can typecheck against, (b) humans can read top-to-bottom,
// (c) runtime consumers (itx.docs, __describe, the REPL editor) reach
// per-declaration through the Itx Type Graph (itx-api-graph.generated.ts),
// emitted by the same run. A copy of the flat file is written into
// packages/iterate, where the published `iterate/sdk` export re-exports it
// (freshness enforced by the same test).
//
// How it works: open the apps/os project with the native TypeScript compiler
// (@typescript/native-preview — the same API the type-aware lint plugin uses),
// start at UnauthenticatedOsRpcTarget, and walk every type reachable from its
// public members. Classes extending IterateRpcTarget<"Name"> become
// `interface Name` (the string-literal type argument IS the published name —
// no naming convention, no override table); classes extending
// IterateRpcRelay<"Name"> instead publish the existing hand-authored contract
// of that name. Named type aliases and interfaces referenced in signatures are
// discovered wherever they live (their domain modules) and emitted once —
// checker-expanded when the alias is a bare type-reference (`z.infer<…>`,
// `ProcessorState<…>`, i.e. a derived type that would not be import-free
// copied literally), and copied verbatim otherwise (hand-authored literal
// shapes, which keeps their docstrings and generics intact).
//
// Regenerate: pnpm generate:itx-api
// Freshness is enforced by src/itx-api.generated.test.ts, which also runs
// `verifyRpcTargetsSatisfyContract` — every contract-defining class must
// typecheck with `implements <its generated interface>` injected, proving the
// projection is sound (the classes really do satisfy what we publish).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { API, ModifierFlags, SignatureKind } from "@typescript/native-preview/unstable/sync";
import {
  SyntaxKind,
  isClassDeclaration,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
} from "@typescript/native-preview/unstable/ast";
import type { Checker, Type } from "@typescript/native-preview/unstable/sync";
import type {
  ClassDeclaration,
  ExpressionWithTypeArguments,
  InterfaceDeclaration,
  Node,
  ParameterDeclaration,
  SourceFile,
  TypeAliasDeclaration,
} from "@typescript/native-preview/unstable/ast";
import { stripComments } from "../src/domains/itx/itx-api-graph.ts";
import type { ItxApiDeclaration } from "../src/domains/itx/itx-api-graph.ts";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const tsconfigPath = path.join(projectDir, "tsconfig.json");
const rpcTargetsPath = path.join(projectDir, "src/rpc-targets.ts");
const outPath = path.join(projectDir, "src/itx-api.generated.ts");
/** The copy published as `iterate/sdk` (packages/iterate re-exports it from its hand-written sdk.ts). Same content as outPath. */
const packageCopyPath = path.resolve(projectDir, "../../packages/iterate/src/itx-api.generated.ts");
/** The Itx Type Graph: the flat file's declarations as per-declaration records (see src/domains/itx/itx-api-graph.ts). */
const graphOutPath = path.join(projectDir, "src/itx-api-graph.generated.ts");

/** The opt-in roots in rpc-targets.ts (see their docstrings there). */
const ITERATE_ROOT = "IterateRpcTarget";
const RELAY_ROOT = "IterateRpcRelay";

/** The native API's typeToString flags (numeric TypeFormatFlags, same values as tsc). */
const NO_TRUNCATION = 1;
const USE_ALIAS_DEFINED_OUTSIDE_CURRENT_SCOPE = 1 << 14;
const IN_TYPE_ALIAS = 1 << 23;

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

/** One opened compiler session over the apps/os project. Dispose to stop the server. */
function openProject(fsOverlay?: Map<string, string>) {
  const api = new API({
    cwd: projectDir,
    ...(fsOverlay ? { fs: { readFile: (fileName) => fsOverlay.get(path.resolve(fileName)) } } : {}),
  });
  const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
  const project = snapshot.getProject(tsconfigPath);
  if (!project) {
    api.close();
    throw new Error(`could not open the TypeScript project at ${tsconfigPath}`);
  }
  return {
    project,
    [Symbol.dispose]() {
      snapshot.dispose();
      api.close();
    },
  };
}

const extendsClauseOf = (decl: ClassDeclaration): ExpressionWithTypeArguments | undefined =>
  [...(decl.heritageClauses ?? [])].find((h) => h.token === SyntaxKind.ExtendsKeyword)?.types[0];

type ClassRegistry = {
  /** class name -> published name (its emitted interface, or its relay contract). */
  renameMap: Map<string, string>;
  /** published interface name -> class, for classes that DO define a surface. */
  classByPublicName: Map<string, ClassDeclaration>;
  /** published relay contract names (must resolve to hand-authored named types). */
  relayContracts: Set<string>;
  /** every class declaration in rpc-targets.ts, by class name. */
  allClasses: Map<string, ClassDeclaration>;
};

/**
 * Discover the opt-in classes: everything whose extends chain reaches
 * IterateRpcTarget, with the published name read from the string-literal type
 * argument in the class's own extends clause (`extends IterateRpcTarget<"Stream">`,
 * or `extends ParentClass<"ProjectStreamCollection">` for a subclass). A class
 * hierarchy's PARENT names itself in its own type-parameter default
 * (`class X<Name extends string = "StreamCollection"> extends IterateRpcTarget<Name>`),
 * so every published name is spelled exactly once, at the class that defines it.
 */
function collectClasses(rpcTargetsFile: { statements: Iterable<Node> }): ClassRegistry {
  const allClasses = new Map<string, ClassDeclaration>();
  for (const statement of rpcTargetsFile.statements) {
    if (isClassDeclaration(statement) && statement.name) {
      allClasses.set(statement.name.text, statement);
    }
  }

  const rootOf = (decl: ClassDeclaration): typeof ITERATE_ROOT | typeof RELAY_ROOT | undefined => {
    const base = extendsClauseOf(decl)?.expression.getText();
    if (base === RELAY_ROOT) return RELAY_ROOT;
    if (base === ITERATE_ROOT) return ITERATE_ROOT;
    const parent = base ? allClasses.get(base) : undefined;
    return parent ? rootOf(parent) : undefined;
  };

  const publishedNameOf = (decl: ClassDeclaration): string => {
    const clause = extendsClauseOf(decl);
    const arg = [...(clause?.typeArguments ?? [])][0];
    if (arg && isLiteralTypeNode(arg) && isStringLiteral(arg.literal)) {
      return arg.literal.text;
    }
    if (arg && isTypeReferenceNode(arg)) {
      const param = [...(decl.typeParameters ?? [])].find(
        (tp) => tp.name.text === arg.typeName.getText(),
      );
      const fallback = param?.defaultType;
      if (fallback && isLiteralTypeNode(fallback) && isStringLiteral(fallback.literal)) {
        return fallback.literal.text;
      }
    }
    throw new Error(
      `class ${decl.name?.text} opted into the itx contract (extends ${ITERATE_ROOT}) but does ` +
        `not spell its published name as a string literal — write ` +
        `\`extends ${ITERATE_ROOT}<"Name">\` (or pass/default the literal through the parent's generic).`,
    );
  };

  const renameMap = new Map<string, string>();
  const classByPublicName = new Map<string, ClassDeclaration>();
  const relayContracts = new Set<string>();
  for (const [className, decl] of allClasses) {
    if (className === ITERATE_ROOT || className === RELAY_ROOT) continue;
    const root = rootOf(decl);
    if (!root) continue;
    const publicName = publishedNameOf(decl);
    renameMap.set(className, publicName);
    if (root === RELAY_ROOT) {
      // Several relays may front the SAME contract (ProcessorRelayRpcTarget and
      // StreamProcessorRpcTarget both publish StreamProcessorRpc) — but a relay
      // sharing a name with a class-defined interface would be two different
      // shapes under one published name.
      if (classByPublicName.has(publicName)) {
        throw new Error(
          `published name "${publicName}" is claimed by both ` +
            `${classByPublicName.get(publicName)?.name?.text} (interface) and ${className} (relay)`,
        );
      }
      relayContracts.add(publicName);
    } else {
      // Two classes publishing one interface name would silently overwrite each
      // other here — generation and the implements check would only ever see
      // the last one, letting the first drift undetected.
      const existing = classByPublicName.get(publicName);
      if (existing || relayContracts.has(publicName)) {
        throw new Error(
          `published name "${publicName}" is claimed by both ` +
            `${existing?.name?.text ?? "a relay"} and ${className} — every ` +
            `${ITERATE_ROOT}<"Name"> literal must be unique to its surface`,
        );
      }
      classByPublicName.set(publicName, decl);
    }
  }
  return { allClasses, classByPublicName, relayContracts, renameMap };
}

export function generateItxApi(): string {
  using session = openProject();
  const { project } = session;
  const checker = project.checker;
  const rpcTargetsFile = project.program.getSourceFile(rpcTargetsPath);
  if (!rpcTargetsFile) {
    throw new Error("could not load src/rpc-targets.ts into the program");
  }

  // ── Registries ─────────────────────────────────────────────────────────────

  const { classByPublicName, relayContracts, renameMap } = collectClasses(rpcTargetsFile);

  /**
   * Every exported named type (alias or interface) in the app, by name, keyed
   * to all its declarations. Discovered across the project's files because itx
   * data shapes live in their own domain modules now, not one central file.
   * The walker is demand-driven — only names actually reached from the
   * entrypoint are emitted — and a reached name with more than one declaration
   * is a hard error (see `resolveNamedDecl`), so cross-module name clashes can
   * never silently pick the wrong shape.
   */
  const namedDecls = new Map<string, (TypeAliasDeclaration | InterfaceDeclaration)[]>();
  const collectNamedDecls = (sourceFile: SourceFile) => {
    for (const statement of sourceFile.statements) {
      if (
        (isTypeAliasDeclaration(statement) || isInterfaceDeclaration(statement)) &&
        statement.modifierFlags & ModifierFlags.Export
      ) {
        const list = namedDecls.get(statement.name.text) ?? [];
        list.push(statement);
        namedDecls.set(statement.name.text, list);
      }
    }
  };
  for (const fileName of project.rootFiles) {
    if (fileName.endsWith(".d.ts")) continue;
    const resolved = path.resolve(fileName);
    if (resolved === rpcTargetsPath || resolved === outPath) continue;
    if (fileName.includes("node_modules")) continue;
    const sourceFile = project.program.getSourceFile(fileName);
    if (!sourceFile) continue;
    collectNamedDecls(sourceFile);
  }
  // Contract wire types that live in the published package rather than the
  // apps/os root file set (the live-state protocol moved into `iterate/client`
  // so the browser store and the server engine share one definition). They are
  // reached through package imports, which the root-file walk above skips —
  // chase them explicitly, and fail loudly if the program does not carry them
  // under their real path (a resolution change would otherwise silently drop
  // types from the contract).
  for (const fileName of [
    path.resolve(projectDir, "../../packages/iterate/src/itx/live-state/protocol.ts"),
  ]) {
    const sourceFile = project.program.getSourceFile(fileName);
    if (!sourceFile) {
      throw new Error(
        `itx api generation: expected package contract source in the program: ${fileName}`,
      );
    }
    collectNamedDecls(sourceFile);
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
  ): TypeAliasDeclaration | InterfaceDeclaration | undefined => {
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
    decl: TypeAliasDeclaration | InterfaceDeclaration,
  ): decl is TypeAliasDeclaration => isTypeAliasDeclaration(decl) && isTypeReferenceNode(decl.type);

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
    // Inline type imports are already self-resolving package references in a
    // standalone declaration (`import("octokit").Octokit`). Do not mistake
    // the qualified export name for a leaked local declaration.
    const codeOnly = stripComments(out).replaceAll(
      /import\(["'][^"']+["']\)\.[A-Z][A-Za-z0-9_]*/g,
      "",
    );
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

  const typeFlags = NO_TRUNCATION | USE_ALIAS_DEFINED_OUTSIDE_CURRENT_SCOPE;

  const printType = (type: Type, location: Node): string =>
    checker.typeToString(type, location, typeFlags);

  /** The type of an unannotated member, as the checker sees it. */
  const printMemberType = (member: Node & { name?: Node }): string =>
    printType(requireType(checker, member.name ?? member), member);

  /** The return type of an unannotated method, via its one call signature. */
  const printReturnType = (member: Node & { name?: Node }): string => {
    const methodType = requireType(checker, member.name ?? member);
    const signature = checker.getSignaturesOfType(methodType, SignatureKind.Call)[0];
    if (!signature) throw new Error(`no call signature for ${member.name?.getText()}`);
    const returnType = checker.getReturnTypeOfSignature(signature);
    if (!returnType) throw new Error(`no return type for ${member.name?.getText()}`);
    return printType(returnType, member);
  };

  /** True when an emitted member type is a Durable Object stub (host plumbing). */
  const isDurableObjectStub = (typeText: string): boolean => /\bDurableObjectStub\b/.test(typeText);

  const paramText = (param: ParameterDeclaration): string => {
    if (param.name.getText() === "this") return "";
    const rest = param.dotDotDotToken ? "..." : "";
    const optional = param.questionToken ? "?" : "";
    const explicit = param.type?.getText();
    const typeText =
      explicit && !explicit.includes("Parameters<")
        ? explicit
        : printType(requireType(checker, param), param);
    return `${rest}${param.name.getText()}${optional}: ${typeText}`;
  };

  const emitClass = (publicName: string, cls: ClassDeclaration) => {
    const lines: string[] = [];
    const classDoc = jsDocOf(cls);
    if (classDoc) lines.push(classDoc);
    // Overloaded methods: TypeScript's rule is that only the body-less
    // declarations are the published signatures — the implementation
    // signature underneath them is never directly callable, so emitting it
    // would add a phantom overload to the contract.
    const overloadedMethodNames = new Set<string>();
    for (const member of cls.members) {
      if (isMethodDeclaration(member) && !member.body && member.name) {
        overloadedMethodNames.add(member.name.getText());
      }
    }
    // A class extending another published class is an interface extension:
    // emit only the subclass's own members and inherit the rest. (The opt-in
    // roots themselves are not in renameMap, so a direct extends is no clause.)
    const baseClassName = extendsClauseOf(cls)?.expression.getText();
    const basePublicName = baseClassName ? renameMap.get(baseClassName) : undefined;
    lines.push(
      `export interface ${publicName}${basePublicName ? ` extends ${basePublicName}` : ""} {`,
    );

    for (const member of cls.members) {
      if (isConstructorDeclaration(member)) continue;
      const modifierFlags: number =
        "modifierFlags" in member ? (member.modifierFlags as number) : 0;
      if (
        modifierFlags &
        (ModifierFlags.Static | ModifierFlags.Private | ModifierFlags.Protected)
      ) {
        continue;
      }
      const nameNode = "name" in member ? (member.name as Node | undefined) : undefined;
      if (nameNode && isPrivateIdentifier(nameNode)) continue;
      const doc = jsDocOf(member);
      if (doc && /@internal\b/.test(doc)) continue;

      const memberName = nameNode?.getText() ?? "";
      if (SKIPPED_MEMBER_NAMES.has(memberName)) continue;

      if (isMethodDeclaration(member)) {
        if (member.body && overloadedMethodNames.has(memberName)) continue;
        if (memberName === "[Symbol.dispose]") {
          if (doc) lines.push(doc);
          lines.push(`  [Symbol.dispose](): void;`);
          continue;
        }
        const typeParams = member.typeParameters
          ? `<${[...member.typeParameters].map((tp) => tp.getText()).join(", ")}>`
          : "";
        const params = [...member.parameters].map(paramText).filter(Boolean).join(", ");
        const returnText = member.type?.getText() ?? printReturnType(member);
        if (doc) lines.push(doc);
        lines.push(`  ${memberName}${typeParams}(${params}): ${returnText};`);
        continue;
      }

      if (isGetAccessorDeclaration(member)) {
        const typeText = member.type?.getText() ?? printMemberType(member);
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

      if (isPropertyDeclaration(member)) {
        const typeText = member.type?.getText() ?? printMemberType(member);
        if (isDurableObjectStub(typeText)) continue;
        if (doc) lines.push(doc);
        lines.push(`  ${memberName}: ${typeText};`);
      }
    }

    lines.push("}");
    interfaceChunks.push(rewriteAndCollect(lines.join("\n"), `interface ${publicName}`));
  };

  const emitNamedDecl = (name: string, decl: TypeAliasDeclaration | InterfaceDeclaration) => {
    const doc = jsDocOf(decl);
    const from = path.relative(projectDir, decl.getSourceFile().fileName);
    if (isDerivedAlias(decl)) {
      // Derived alias (z.infer<…>, ProcessorState<…>): expand to structural form.
      const symbol = checker.getSymbolAtLocation(decl.name);
      const type = symbol && checker.getDeclaredTypeOfSymbol(symbol);
      if (!type) throw new Error(`could not resolve the declared type of ${name} (${from})`);
      const expanded = checker.typeToString(type, decl, typeFlags | IN_TYPE_ALIAS);
      aliasChunks.push(
        rewriteAndCollect(
          `${doc ? `${doc}\n` : ""}export type ${name} = ${expanded};`,
          `derived alias ${name} (${from})`,
        ),
      );
      return;
    }
    // Hand-authored literal shape: copy verbatim, docstrings and generics intact.
    const typeParams = new Set([...(decl.typeParameters ?? [])].map((tp) => tp.name.text));
    const chunk = rewriteAndCollect(
      doc ? `${doc}\n${decl.getText()}` : decl.getText(),
      `${name} (${from})`,
      typeParams,
    );
    (isInterfaceDeclaration(decl) ? interfaceChunks : aliasChunks).push(chunk);
  };

  enqueue("UnauthenticatedOs");
  // The worker-side contract: `env.ITX` on dynamic workers. Not reachable from
  // the /api walk (nothing on the capability tree mentions it), but worker code
  // imports it through `iterate/sdk`, so it is a second seed.
  enqueue("ItxBinding");
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
    const firstStatementStart = [...rpcTargetsFile.statements][0]?.getStart() ?? 0;
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

/**
 * The Itx Type Graph: parse the FORMATTED flat file back into one record per
 * exported declaration (see ItxApiDeclaration). Deriving the graph from the
 * emitted text — rather than collecting records during emission — guarantees
 * each record's `sourceText` is exactly the declaration's text in
 * itx-api.generated.ts (oxfmt formatting included), so "the flat file is the
 * join of the graph" holds by construction.
 */
export function buildItxApiGraph(flatFileSource: string): ItxApiDeclaration[] {
  using session = openProject(new Map([[outPath, flatFileSource]]));
  const sourceFile = session.project.program.getSourceFile(outPath);
  if (!sourceFile) throw new Error("could not load the generated itx api into the program");
  const fullText = sourceFile.getFullText();

  /** The declaration's own JSDoc: the last block in its leading trivia, but
   * only when nothing except whitespace separates it from the declaration —
   * otherwise a docless declaration would inherit the file preamble or a
   * section separator's neighbor. */
  const ownJsDoc = (statement: Node): string => {
    const trivia = fullText.slice(statement.getFullStart(), statement.getStart());
    const lastBlock = [...trivia.matchAll(/\/\*\*[\s\S]*?\*\//g)].at(-1);
    if (!lastBlock) return "";
    const gap = trivia.slice(lastBlock.index + lastBlock[0].length);
    return gap.trim() === "" ? lastBlock[0] : "";
  };

  /** TSDoc summary, first sentence: strip comment syntax, cut at the first
   * block tag, take up to the first sentence-ending period. */
  const summaryOf = (jsDoc: string): string => {
    const text = jsDoc
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "")
      .replaceAll(/^\s*\* ?/gm, "")
      .split(/\n\s*@/)[0]!
      .replaceAll(/\s+/g, " ")
      .trim();
    return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  };

  const declarations: Array<{
    statement: InterfaceDeclaration | TypeAliasDeclaration;
    record: ItxApiDeclaration;
  }> = [];
  for (const statement of sourceFile.statements) {
    if (!isInterfaceDeclaration(statement) && !isTypeAliasDeclaration(statement)) continue;
    const jsDoc = ownJsDoc(statement);
    const memberSummaries: Record<string, string> = {};
    if (isInterfaceDeclaration(statement)) {
      for (const member of statement.members) {
        const memberName = "name" in member ? (member.name as Node | undefined)?.getText() : "";
        if (!memberName) continue;
        const memberDoc = ownJsDoc(member);
        if (memberDoc) memberSummaries[memberName] = summaryOf(memberDoc);
      }
    }
    declarations.push({
      statement,
      record: {
        name: statement.name.text,
        kind: isInterfaceDeclaration(statement) ? "interface" : "typeAlias",
        sourceText: [jsDoc, statement.getText()].filter(Boolean).join("\n"),
        summary: summaryOf(jsDoc),
        memberSummaries,
        referencedTypeNames: [],
      },
    });
  }

  // Reference edges: identifiers in the declaration's CODE (comments
  // stripped) that name another declaration in this graph.
  const allNames = new Set(declarations.map(({ record }) => record.name));
  for (const { statement, record } of declarations) {
    const codeOnly = stripComments(statement.getText());
    const referenced = new Set<string>();
    for (const match of codeOnly.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
      if (match[0] !== record.name && allNames.has(match[0])) referenced.add(match[0]);
    }
    record.referencedTypeNames = [...referenced];
  }

  const records = declarations.map(({ record }) => record);
  const duplicates = records.filter(
    (record, index) => records.findIndex((other) => other.name === record.name) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `itx api graph has duplicate declaration names: ${duplicates.map((d) => d.name).join(", ")}`,
    );
  }
  return records;
}

/** The generated module carrying the Itx Type Graph, formatted for the repo. */
export function generateItxApiGraphSource(flatFileSource: string): string {
  const records = buildItxApiGraph(flatFileSource);
  const raw = [
    "// GENERATED by scripts/generate-itx-api.ts — do not edit.",
    "// Regenerate with: pnpm generate:itx-api",
    "// Freshness is enforced by itx-api.generated.test.ts.",
    "//",
    "// The Itx Type Graph: every exported declaration of itx-api.generated.ts as",
    "// one record, in file order — same generator run, same content, kept",
    "// per-declaration so runtime consumers (itx.docs, __describe) can assemble",
    "// bounded slices instead of shipping the whole flat file.",
    'import type { ItxApiDeclaration } from "./domains/itx/itx-api-graph.ts";',
    "",
    `export const ITX_API_DECLARATIONS: readonly ItxApiDeclaration[] = ${JSON.stringify(records, null, 2)};`,
    "",
  ].join("\n");
  return execFileSync(
    path.join(projectDir, "../../node_modules/.bin/oxfmt"),
    [`--stdin-filepath=${graphOutPath}`],
    { encoding: "utf8", input: raw },
  );
}

/**
 * The soundness check on the projection: every contract-defining class must
 * satisfy the interface generated FROM it. Mechanically inject
 * `implements __itxApi.<Name>` into each class declaration (and a type-only
 * namespace import of the generated file), then typecheck the modified
 * rpc-targets.ts inside the real project — via the compiler API's fs overlay,
 * nothing is written to disk. A diagnostic here means the generator emitted a
 * contract the implementation does not actually satisfy.
 *
 * Relays are exempt: they front hand-authored (often generic) contracts and
 * stay honest via their own `implements` clause or typed construction sites.
 */
export function verifyRpcTargetsSatisfyContract(generatedSource: string): void {
  const originalSource = readFileSync(rpcTargetsPath, "utf8");

  // Analysis pass over the real file: which classes to inject, and where.
  const edits: Array<{ insert: string; position: number }> = [];
  {
    using session = openProject();
    const rpcTargetsFile = session.project.program.getSourceFile(rpcTargetsPath);
    if (!rpcTargetsFile) throw new Error("could not load src/rpc-targets.ts into the program");
    const { classByPublicName } = collectClasses(rpcTargetsFile);
    for (const [publicName, cls] of classByPublicName) {
      const implementsClause = [...(cls.heritageClauses ?? [])].find(
        (h) => h.token === SyntaxKind.ImplementsKeyword,
      );
      if (implementsClause) {
        edits.push({ insert: `, __itxApi.${publicName}`, position: implementsClause.end });
        continue;
      }
      const extendsClause = extendsClauseOf(cls);
      if (!extendsClause) throw new Error(`class ${cls.name?.text} has no extends clause`);
      edits.push({ insert: ` implements __itxApi.${publicName}`, position: extendsClause.end });
    }
  }

  let transformed = originalSource;
  for (const edit of edits.sort((a, b) => b.position - a.position)) {
    transformed =
      transformed.slice(0, edit.position) + edit.insert + transformed.slice(edit.position);
  }
  transformed += `\nimport type * as __itxApi from "./itx-api.generated.ts";\n`;

  // Check pass: same project, with rpc-targets.ts and the generated file
  // served from the overlay.
  using session = openProject(
    new Map([
      [rpcTargetsPath, transformed],
      [outPath, generatedSource],
    ]),
  );
  const diagnostics = session.project.program.getSemanticDiagnostics(rpcTargetsPath);
  if (diagnostics.length > 0) {
    const details = diagnostics.map((d) => {
      const position = d.pos ?? 0;
      const prefix = transformed.slice(0, position);
      const line = prefix.split("\n").length;
      const column = position - prefix.lastIndexOf("\n");
      const sourceLine = transformed.split("\n")[line - 1]?.trim();
      return (
        `  ${d.fileName ?? "?"}:${line}:${column}: ${d.text}` +
        (sourceLine === undefined ? "" : `\n    ${sourceLine}`)
      );
    });
    throw new Error(
      `rpc-targets.ts does not satisfy the generated itx contract — ` +
        `${diagnostics.length} diagnostic(s) with \`implements\` injected:\n${details.join("\n")}`,
    );
  }
}

function requireType(checker: Checker, node: Node): Type {
  const type = checker.getTypeAtLocation(node);
  if (!type) throw new Error(`could not resolve a type at ${node.getText()}`);
  return type;
}

/** The last JSDoc block in a declaration's leading trivia, verbatim. */
function jsDocOf(decl: Node): string | undefined {
  const fullText = decl.getSourceFile().getFullText();
  const trivia = fullText.slice(decl.getFullStart(), decl.getStart());
  const blocks = trivia.match(/\/\*\*[\s\S]*?\*\//g);
  return blocks?.at(-1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const source = generateItxApi();
  verifyRpcTargetsSatisfyContract(source);
  writeFileSync(outPath, source);
  console.log(`wrote ${outPath}`);
  writeFileSync(packageCopyPath, source);
  console.log(`wrote ${packageCopyPath}`);
  writeFileSync(graphOutPath, generateItxApiGraphSource(source));
  console.log(`wrote ${graphOutPath}`);
}
