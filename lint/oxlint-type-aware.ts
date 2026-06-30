import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  API,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Diagnostic,
  type Project,
  type Snapshot,
  type Type,
} from "@typescript/native-preview/unstable/sync";
import type { CallExpression, Expression, Node } from "estree";
import {
  SyntaxKind,
  type Expression as TsExpression,
  type Node as TsNode,
  type TypeNode,
} from "@typescript/native-preview/unstable/ast";

const IGNORED_DIRS = new Set([
  ".alchemy",
  ".cache",
  ".git",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

const servicesByCwd = new Map<string, TypeAwareLintService>();

export function getTypeAwareLintService(options: { cwd?: string } = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  let service = servicesByCwd.get(cwd);
  if (!service) {
    service = new TypeAwareLintService({ cwd });
    servicesByCwd.set(cwd, service);
  }
  return service;
}

export class TypeAwareLintService {
  cwd: string;
  api: API | undefined;
  snapshot: Snapshot | undefined;
  openFiles = new Set<string>();
  tsconfigFiles: string[] | undefined;
  projectByFile = new Map<string, Project | undefined>();
  projectDiagnosticsByConfig = new Map<string, readonly Diagnostic[]>();
  mtimesByFile = new Map<string, number>();
  textByFile = new Map<string, string>();
  textChangedFiles = new Set<string>();
  snapshotVersion = 0;

  constructor(input: { cwd: string }) {
    this.cwd = input.cwd;
  }

  getStats() {
    return {
      openFiles: this.openFiles.size,
      projects: this.snapshot?.getProjects().length || 0,
      tsconfigs: this.getTsconfigFiles().length,
    };
  }

  close() {
    this.snapshot?.dispose();
    this.snapshot = undefined;
    this.api?.close();
    this.api = undefined;
    this.openFiles.clear();
    this.projectByFile.clear();
    this.projectDiagnosticsByConfig.clear();
    this.mtimesByFile.clear();
    this.textByFile.clear();
    this.textChangedFiles.clear();
  }

  getProjectForFile(fileName: string) {
    const absoluteFileName = resolve(fileName);
    this.refreshSnapshotForChangedFiles([absoluteFileName]);
    const cached = this.projectByFile.get(absoluteFileName);
    if (cached) return cached;

    let project = this.getSnapshot().getDefaultProjectForFile(absoluteFileName);
    if (isInferredProject(project)) {
      this.openFile(absoluteFileName);
      project = this.getSnapshot().getDefaultProjectForFile(absoluteFileName);
    }

    this.projectByFile.set(absoluteFileName, project);
    this.trackProjectFiles(project);
    return project;
  }

  getFileService(fileName: string) {
    const project = this.getProjectForFile(fileName);
    if (!project) return undefined;
    return new TypeAwareLintFileService({
      fileName,
      project,
      service: this,
    });
  }

  getProjectDiagnosticsForFile(fileName: string) {
    const absoluteFileName = resolve(fileName);
    const fileService = this.getFileService(absoluteFileName);
    if (!fileService) return [];

    const cacheKey = getProjectDiagnosticsCacheKey(fileService.project);
    if (this.textByFile.size === 0 && cacheKey) {
      const cached = this.projectDiagnosticsByConfig.get(cacheKey);
      if (cached) return cached;
      const diagnostics = fileService.getProjectDiagnostics();
      this.projectDiagnosticsByConfig.set(cacheKey, diagnostics);
      return diagnostics;
    }

    return fileService.getProjectDiagnostics();
  }

  getDiagnosticsForFiles(fileNames: readonly string[]) {
    return fileNames.flatMap((fileName) => this.getFileService(fileName)?.getDiagnostics() || []);
  }

  getDiagnosticsForFileText(fileName: string, text: string) {
    const absoluteFileName = resolve(fileName);
    const hadPreviousText = this.textByFile.has(absoluteFileName);
    const previousText = this.textByFile.get(absoluteFileName);

    this.setFileText(absoluteFileName, text);
    const diagnostics = this.getFileService(absoluteFileName)?.getDiagnostics() || [];

    if (hadPreviousText) {
      this.setFileText(absoluteFileName, previousText || "");
    } else {
      this.deleteFileText(absoluteFileName);
    }

    return diagnostics;
  }

  withFileTextDiagnostics<T>(
    fileName: string,
    callback: (getDiagnostics: (text: string) => readonly Diagnostic[]) => T,
  ) {
    const absoluteFileName = resolve(fileName);
    const hadPreviousText = this.textByFile.has(absoluteFileName);
    const previousText = this.textByFile.get(absoluteFileName);

    try {
      return callback((text) => {
        this.setFileText(absoluteFileName, text);
        return this.getFileService(absoluteFileName)?.getDiagnostics() || [];
      });
    } finally {
      if (hadPreviousText) {
        this.setFileText(absoluteFileName, previousText || "");
      } else {
        this.deleteFileText(absoluteFileName);
      }
    }
  }

  getProjectDiagnosticsForFileText(fileName: string, text: string) {
    const absoluteFileName = resolve(fileName);
    const hadPreviousText = this.textByFile.has(absoluteFileName);
    const previousText = this.textByFile.get(absoluteFileName);

    this.setFileText(absoluteFileName, text);
    const diagnostics = this.getProjectDiagnosticsForFile(absoluteFileName);

    if (hadPreviousText) {
      this.setFileText(absoluteFileName, previousText || "");
    } else {
      this.deleteFileText(absoluteFileName);
    }

    return diagnostics;
  }

  withProjectDiagnosticsForFileText<T>(
    fileName: string,
    callback: (
      getDiagnostics: (
        text: string,
        diagnosticFileNames?: readonly string[],
      ) => readonly Diagnostic[],
    ) => T,
  ) {
    const absoluteFileName = resolve(fileName);
    const hadPreviousText = this.textByFile.has(absoluteFileName);
    const previousText = this.textByFile.get(absoluteFileName);

    try {
      return callback((text, diagnosticFileNames) => {
        this.setFileText(absoluteFileName, text);
        if (diagnosticFileNames) return this.getDiagnosticsForFiles(diagnosticFileNames);
        return this.getProjectDiagnosticsForFile(absoluteFileName);
      });
    } finally {
      if (hadPreviousText) {
        this.setFileText(absoluteFileName, previousText || "");
      } else {
        this.deleteFileText(absoluteFileName);
      }
    }
  }

  getSnapshot(): Snapshot {
    if (!this.api) {
      this.api = this.createApi();
    }
    if (!this.snapshot) {
      this.updateSnapshot({ openProjects: this.getTsconfigFiles() });
    }
    if (!this.snapshot) throw new Error("Failed to create TypeScript snapshot");
    return this.snapshot;
  }

  openFile(fileName: string) {
    if (this.openFiles.has(fileName)) return;
    this.openFiles.add(fileName);
    this.projectByFile.clear();
    this.projectDiagnosticsByConfig.clear();
    this.updateSnapshot({
      openFiles: [...this.openFiles],
      openProjects: this.getTsconfigFiles(),
    });
  }

  updateSnapshot(params: Parameters<API["updateSnapshot"]>[0]) {
    const previous = this.snapshot;
    this.snapshot = this.requireApi().updateSnapshot(params);
    this.snapshotVersion++;
    previous?.dispose();
    for (const project of this.snapshot.getProjects()) {
      this.trackProjectFiles(project);
    }
  }

  requireApi() {
    if (!this.api) {
      this.api = this.createApi();
    }
    return this.api;
  }

  createApi() {
    return new API({
      cwd: this.cwd,
      fs: {
        directoryExists: (directoryName) => {
          const absoluteDirectoryName = resolve(directoryName);
          if (this.hasVirtualFileInDirectoryTree(absoluteDirectoryName)) return true;
          return undefined;
        },
        fileExists: (fileName) => {
          if (this.textByFile.has(resolve(fileName))) return true;
          return undefined;
        },
        getAccessibleEntries: (directoryName) => this.getAccessibleEntries(directoryName),
        readFile: (fileName) => this.textByFile.get(resolve(fileName)),
      },
    });
  }

  hasVirtualFileInDirectoryTree(directoryName: string) {
    const directoryPrefix = directoryName.endsWith("/") ? directoryName : `${directoryName}/`;
    return [...this.textByFile.keys()].some((fileName) => fileName.startsWith(directoryPrefix));
  }

  getAccessibleEntries(directoryName: string) {
    const absoluteDirectoryName = resolve(directoryName);
    const virtualFiles = [...this.textByFile.keys()].filter(
      (fileName) => dirname(fileName) === absoluteDirectoryName,
    );
    if (virtualFiles.length === 0) return undefined;

    const files = new Set<string>();
    const directories = new Set<string>();
    try {
      for (const entry of readdirSync(absoluteDirectoryName, { withFileTypes: true })) {
        if (entry.isFile()) files.add(entry.name);
        if (entry.isDirectory()) directories.add(entry.name);
      }
    } catch {
      // A virtual file can live in a directory that the host FS cannot read.
    }

    for (const fileName of virtualFiles) {
      files.add(basename(fileName));
    }

    return {
      files: [...files].sort(),
      directories: [...directories].sort(),
    };
  }

  getTsconfigFiles() {
    if (!this.tsconfigFiles) {
      this.tsconfigFiles = findTsconfigFiles(this.cwd);
    }
    return this.tsconfigFiles;
  }

  refreshSnapshotForChangedFiles(fileNames: readonly string[]) {
    const changedFiles = [
      ...new Set([
        ...this.drainTextChangedFiles(fileNames),
        ...fileNames.filter((fileName) => this.hasFileChanged(fileName)),
      ]),
    ];
    if (changedFiles.length === 0) return;

    this.projectByFile.clear();
    this.updateSnapshot({
      fileChanges: { changed: changedFiles },
      openFiles: [...this.openFiles],
      openProjects: this.getTsconfigFiles(),
    });
  }

  trackProjectFiles(project: Project | undefined) {
    if (!project || isInferredProject(project)) return;
    for (const fileName of project.rootFiles) {
      this.rememberFileMtime(fileName);
    }
  }

  hasFileChanged(fileName: string) {
    const previous = this.mtimesByFile.get(fileName);
    const current = getFileMtime(fileName);
    if (previous === undefined) {
      if (current !== undefined) this.mtimesByFile.set(fileName, current);
      return false;
    }
    if (current === previous) return false;
    this.projectDiagnosticsByConfig.clear();
    if (current === undefined) {
      this.mtimesByFile.delete(fileName);
    } else {
      this.mtimesByFile.set(fileName, current);
    }
    return true;
  }

  rememberFileMtime(fileName: string) {
    const mtime = getFileMtime(fileName);
    if (mtime !== undefined) this.mtimesByFile.set(fileName, mtime);
  }

  setFileText(fileName: string, text: string) {
    const absoluteFileName = resolve(fileName);
    if (text === getFileText(absoluteFileName)) {
      if (this.textByFile.has(absoluteFileName)) {
        this.textByFile.delete(absoluteFileName);
        this.textChangedFiles.add(absoluteFileName);
      }
      this.mtimesByFile.set(absoluteFileName, getFileMtime(absoluteFileName) ?? -1);
      return;
    }
    if (this.textByFile.get(absoluteFileName) === text) return;
    this.textByFile.set(absoluteFileName, text);
    this.textChangedFiles.add(absoluteFileName);
    this.mtimesByFile.set(absoluteFileName, getFileMtime(absoluteFileName) ?? -1);
  }

  deleteFileText(fileName: string) {
    const absoluteFileName = resolve(fileName);
    if (!this.textByFile.has(absoluteFileName)) return;
    this.textByFile.delete(absoluteFileName);
    this.textChangedFiles.add(absoluteFileName);
    this.mtimesByFile.set(absoluteFileName, getFileMtime(absoluteFileName) ?? -1);
  }

  drainTextChangedFiles(fileNames: readonly string[]) {
    const candidates = fileNames.map((fileName) => resolve(fileName));
    const changedFiles = candidates.filter((fileName) => this.textChangedFiles.has(fileName));
    for (const fileName of changedFiles) {
      this.textChangedFiles.delete(fileName);
    }
    return changedFiles;
  }
}

export class TypeAwareLintFileService {
  fileName: string;
  _project: Project;
  service: TypeAwareLintService | undefined;
  snapshotVersion: number;
  externalReferenceByRange = new Map<string, boolean>();
  externalReferenceFilesByRange = new Map<string, readonly string[] | undefined>();

  constructor(input: { fileName: string; project: Project; service?: TypeAwareLintService }) {
    this.fileName = resolve(input.fileName);
    this._project = input.project;
    this.service = input.service;
    this.snapshotVersion = input.service?.snapshotVersion || 0;
  }

  get project() {
    return this.getProject();
  }

  getProject() {
    if (!this.service || this.snapshotVersion === this.service.snapshotVersion) {
      return this._project;
    }

    const project = this.service.getProjectForFile(this.fileName);
    if (project) {
      this._project = project;
      this.snapshotVersion = this.service.snapshotVersion;
    }
    return this._project;
  }

  getTypeAtPosition(position: number) {
    return this.getProject().checker.getTypeAtPosition(this.fileName, position);
  }

  getTypeFromTypeNodeAtRange(range: readonly [number, number]) {
    const node = this.findNativeNodeAtRange(range);
    if (!node || !isTypeNode(node)) return undefined;
    return this.getProject().checker.getTypeFromTypeNode(node as TypeNode);
  }

  getTypeFromSimpleTypeText(typeText: string, position: number) {
    const checker = this.getProject().checker;
    const trimmed = typeText.trim();

    if (trimmed === "any") return checker.getAnyType();
    if (trimmed === "unknown") return checker.getUnknownType();
    if (trimmed === "string") return checker.getStringType();
    if (trimmed === "number") return checker.getNumberType();
    if (trimmed === "boolean") return checker.getBooleanType();
    if (trimmed === "bigint") return checker.getBigIntType();
    if (trimmed === "symbol") return checker.getESSymbolType();
    if (trimmed === "void") return checker.getVoidType();
    if (trimmed === "undefined") return checker.getUndefinedType();
    if (trimmed === "null") return checker.getNullType();
    if (trimmed === "never") return checker.getNeverType();
    if (!trimmed.match(/^[A-Za-z_$][\w$]*$/)) return undefined;

    return this.resolveTypeByName(trimmed, position)?.type;
  }

  getDiagnostics(): readonly Diagnostic[] {
    const project = this.getProject();
    return [
      ...project.program.getSyntacticDiagnostics(this.fileName),
      ...project.program.getBindDiagnostics(this.fileName),
      ...project.program.getSemanticDiagnostics(this.fileName),
    ];
  }

  getProjectDiagnostics(): readonly Diagnostic[] {
    const project = this.getProject();
    return [
      ...project.program.getSyntacticDiagnostics(),
      ...project.program.getBindDiagnostics(),
      ...project.program.getSemanticDiagnostics(),
      ...project.program.getGlobalDiagnostics(),
      ...project.program.getProgramDiagnostics(),
    ];
  }

  getTypeAtNodeStart(node: Node) {
    const position = node.range?.[0];
    if (typeof position !== "number") return undefined;
    return this.getTypeAtPosition(position);
  }

  getTypeAtNodeLocation(node: Node) {
    if (!node.range) return undefined;
    const nativeNode = this.findNativeNodeAtRange(node.range);
    if (!nativeNode) return undefined;
    return this.getProject().checker.getTypeAtLocation(nativeNode);
  }

  getContextualTypeAtNodeLocation(node: Node) {
    if (!node.range) return undefined;
    const nativeNode = this.findNativeNodeAtRange(node.range);
    if (!nativeNode) return undefined;
    return this.getProject().checker.getContextualType(nativeNode as unknown as TsExpression);
  }

  getTypeAtNodeEnd(node: Node) {
    const position = node.range?.[1];
    if (typeof position !== "number") return undefined;
    return this.getTypeAtPosition(Math.max(position - 1, 0));
  }

  areTypesEquivalent(left: Type, right: Type) {
    if (isAnyOrUnknown(left) || isAnyOrUnknown(right)) {
      return left.flags === right.flags;
    }
    const checker = this.getProject().checker;
    return checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left);
  }

  isTypeAssignableTo(source: Type, target: Type) {
    return this.getProject().checker.isTypeAssignableTo(source, target);
  }

  isAnyType(type: Type) {
    return Boolean(type.flags & TypeFlags.Any);
  }

  findNativeNodeAtRange(range: readonly [number, number]) {
    const sourceFile = this.getProject().program.getSourceFile(this.fileName);
    if (!sourceFile) return undefined;
    return findSmallestContainingNode(sourceFile, range);
  }

  hasExternalReferencesAtRange(range: readonly [number, number]) {
    const cacheKey = rangeKey(range);
    const cached = this.externalReferenceByRange.get(cacheKey);
    if (cached !== undefined) return cached;

    const referenceFiles = this.getExternalReferenceFilesAtRange(range);
    const hasExternalReference = referenceFiles === undefined || referenceFiles.length > 0;
    this.externalReferenceByRange.set(cacheKey, hasExternalReference);
    return hasExternalReference;
  }

  getExternalReferenceFilesAtRange(range: readonly [number, number]) {
    const cacheKey = rangeKey(range);
    if (this.externalReferenceFilesByRange.has(cacheKey)) {
      return this.externalReferenceFilesByRange.get(cacheKey);
    }

    const node = this.findNativeNodeAtRange(range);
    if (!node) return undefined;

    const entries = this.getProject().checker.getReferencedSymbolsForNode(node, range[0]);
    if (entries.length === 0) return undefined;

    const referenceFiles = new Set<string>();
    for (const entry of entries) {
      const definitionFileName = resolve(entry.definition.path);
      if (definitionFileName !== this.fileName) continue;
      for (const reference of entry.references) {
        const referenceFileName = resolve(reference.path);
        if (referenceFileName !== this.fileName) referenceFiles.add(referenceFileName);
      }
    }

    const result = [...referenceFiles].sort();
    this.externalReferenceFilesByRange.set(cacheKey, result);
    return result;
  }

  getThenableInfo(node: Expression) {
    const type = this.getExpressionType(node);
    if (!type || !this.isThenableType(type)) return undefined;
    return {
      text: this.project.checker.typeToString(type),
      type,
    };
  }

  getExpressionType(node: Expression) {
    if (node.type === "CallExpression") {
      return this.getCallReturnType(node);
    }
    return this.getTypeAtNodeStart(node);
  }

  getCallReturnType(node: CallExpression) {
    const signature = this.getCallSignature(node);
    if (!signature) return undefined;
    return this.getProject().checker.getReturnTypeOfSignature(signature);
  }

  getCallParameterType(node: CallExpression, index: number) {
    const signature = this.getCallSignature(node);
    if (!signature) return undefined;
    return this.getProject().checker.getParameterType(signature, index);
  }

  getCallSignature(node: CallExpression) {
    const calleePosition = getCallablePosition(node.callee);
    if (calleePosition === undefined) return undefined;

    const calleeType = this.getTypeAtPosition(calleePosition);
    if (!calleeType) return undefined;

    const project = this.getProject();
    const signatures = project.checker.getSignaturesOfType(calleeType, SignatureKind.Call);
    return signatures[0];
  }

  resolveTypeByName(name: string, position: number) {
    const project = this.getProject();
    const symbol = project.checker.resolveName(
      name,
      SymbolFlags.Type,
      { document: this.fileName, position },
      true,
    );
    if (!symbol) return undefined;
    const type = project.checker.getDeclaredTypeOfSymbol(symbol);
    if (!type) return undefined;
    return { symbol, type };
  }

  isThenableType(type: Type) {
    const properties = this.getProject().checker.getPropertiesOfType(type);
    return properties.some((property) => property.name === "then");
  }
}

function getCallablePosition(callee: CallExpression["callee"]) {
  if (callee.type === "MemberExpression") return callee.property.range?.[0];
  return callee.range?.[0];
}

function rangeKey(range: readonly [number, number]) {
  return `${range[0]}:${range[1]}`;
}

function isAnyOrUnknown(type: Type) {
  return Boolean(type.flags & (TypeFlags.Any | TypeFlags.Unknown));
}

function findSmallestContainingNode(
  node: TsNode,
  range: readonly [number, number],
): TsNode | undefined {
  if (node.pos > range[0] || node.end < range[1]) return undefined;

  let match: TsNode | undefined;
  node.forEachChild((child) => {
    const childMatch = findSmallestContainingNode(child, range);
    if (childMatch) match = childMatch;
  });
  return match || node;
}

function isTypeNode(node: TsNode) {
  return (
    node.kind === SyntaxKind.AnyKeyword ||
    node.kind === SyntaxKind.UnknownKeyword ||
    node.kind === SyntaxKind.StringKeyword ||
    node.kind === SyntaxKind.NumberKeyword ||
    node.kind === SyntaxKind.BooleanKeyword ||
    node.kind === SyntaxKind.BigIntKeyword ||
    node.kind === SyntaxKind.SymbolKeyword ||
    node.kind === SyntaxKind.ObjectKeyword ||
    node.kind === SyntaxKind.VoidKeyword ||
    node.kind === SyntaxKind.UndefinedKeyword ||
    node.kind === SyntaxKind.NeverKeyword ||
    node.kind === SyntaxKind.TypeReference ||
    node.kind === SyntaxKind.UnionType ||
    node.kind === SyntaxKind.IntersectionType ||
    node.kind === SyntaxKind.TypeLiteral ||
    node.kind === SyntaxKind.ArrayType ||
    node.kind === SyntaxKind.TupleType ||
    node.kind === SyntaxKind.LiteralType ||
    node.kind === SyntaxKind.IndexedAccessType ||
    node.kind === SyntaxKind.TypeOperator ||
    node.kind === SyntaxKind.ParenthesizedType ||
    node.kind === SyntaxKind.FunctionType ||
    node.kind === SyntaxKind.ConstructorType ||
    node.kind === SyntaxKind.ConditionalType ||
    node.kind === SyntaxKind.MappedType ||
    node.kind === SyntaxKind.TemplateLiteralType
  );
}

function isInferredProject(project: Project | undefined) {
  return !project || project.configFileName === "/dev/null/inferred";
}

function getProjectDiagnosticsCacheKey(project: Project) {
  if (isInferredProject(project)) return undefined;
  return project.configFileName;
}

function findTsconfigFiles(root: string) {
  const results: string[] = [];

  function visit(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.match(/^tsconfig(?:\..*)?\.json$/)) continue;
      if (existsSync(path) && statSync(path).isFile()) results.push(path);
    }
  }

  visit(root);
  return results.sort();
}

function getFileMtime(fileName: string) {
  try {
    return statSync(fileName).mtimeMs;
  } catch {
    return undefined;
  }
}

function getFileText(fileName: string) {
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return undefined;
  }
}
