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
import type { Node as TsNode } from "@typescript/native-preview/unstable/ast";

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

  getDiagnosticsForFiles(fileNames: readonly string[], options: { allProjects?: boolean } = {}) {
    if (!options.allProjects) {
      return fileNames.flatMap((fileName) => this.getFileService(fileName)?.getDiagnostics() || []);
    }

    // A file can be part of several programs with different compiler options and ambient types
    // (e.g. apps/streams-example-app compiles apps/os sources via `~/*` path aliases), and can
    // type-check in one but not another. Ask every project; non-members throw and are skipped.
    const absoluteFileNames = fileNames.map((fileName) => resolve(fileName));
    this.refreshSnapshotForChangedFiles(absoluteFileNames);
    const projects = this.getSnapshot()
      .getProjects()
      .filter((project) => !isInferredProject(project));
    return absoluteFileNames.flatMap((fileName) => {
      let memberProjects = 0;
      const diagnostics = projects.flatMap((project) => {
        try {
          const projectDiagnostics = [
            ...project.program.getSyntacticDiagnostics(fileName),
            ...project.program.getBindDiagnostics(fileName),
            ...project.program.getSemanticDiagnostics(fileName),
          ];
          memberProjects++;
          return projectDiagnostics;
        } catch {
          return []; // file is not part of this project
        }
      });
      if (memberProjects > 0) return diagnostics;
      // not in any tsconfig project: fall back to the default (possibly inferred) project so
      // callers never mistake "no project checked this" for "no errors"
      return this.getFileService(fileName)?.getDiagnostics() || [];
    });
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
    // Flush ALL pending text overlays, not just the requested files': a stale overlay on file A
    // would otherwise keep affecting types observed through any other file until A is next
    // queried directly. Batching every pending change into one snapshot update also means
    // set-text/restore-text pairs from overlay-based rules cost a single update.
    const changedFiles = [
      ...new Set([
        ...this.textChangedFiles,
        ...fileNames.filter((fileName) => this.hasFileChanged(fileName)),
      ]),
    ];
    if (changedFiles.length === 0) return;
    this.textChangedFiles.clear();

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
}

export class TypeAwareLintFileService {
  fileName: string;
  _project: Project;
  service: TypeAwareLintService | undefined;
  snapshotVersion: number;
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

  getDiagnostics(): readonly Diagnostic[] {
    const project = this.getProject();
    return [
      ...project.program.getSyntacticDiagnostics(this.fileName),
      ...project.program.getBindDiagnostics(this.fileName),
      ...project.program.getSemanticDiagnostics(this.fileName),
    ];
  }

  getTypeAtNodeStart(node: Node) {
    const position = node.range?.[0];
    if (typeof position !== "number") return undefined;
    return this.getTypeAtPosition(position);
  }

  findNativeNodeAtRange(range: readonly [number, number]) {
    const sourceFile = this.getProject().program.getSourceFile(this.fileName);
    if (!sourceFile) return undefined;
    return findSmallestContainingNode(sourceFile, range);
  }

  // True when the node at the range is `any`, or a type with `any` somewhere inside it
  // (`any[]`, `Promise<any>`, `Record<string, any>`), judged by its printed form.
  isAnyLikeTypeAtRange(range: readonly [number, number]) {
    const node = this.findNativeNodeAtRange(range);
    if (!node) return false;
    const checker = this.getProject().checker;
    const type = checker.getTypeAtLocation(node);
    if (!type) return false;
    if (type.flags & TypeFlags.Any) return true;
    return /\bany\b/.test(checker.typeToString(type));
  }

  getExternalReferenceFilesAtRange(range: readonly [number, number]) {
    const cacheKey = rangeKey(range);
    if (this.externalReferenceFilesByRange.has(cacheKey)) {
      return this.externalReferenceFilesByRange.get(cacheKey);
    }

    // find-references panics tsgo for files in inferred projects (files no tsconfig includes);
    // undefined tells callers the references are unknowable
    if (isInferredProject(this.getProject())) {
      this.externalReferenceFilesByRange.set(cacheKey, undefined);
      return undefined;
    }

    const node = this.findNativeNodeAtRange(range);
    if (!node) return undefined;

    const entries = this.getProject().checker.getReferencedSymbolsForNode(node, range[0]);
    if (entries.length === 0) return undefined;

    // An import of the symbol shows up as its own entry whose definition is the import
    // specifier in the referencing file, so every definition and reference path counts.
    // tsgo reports canonicalized (possibly lowercased) paths, so compare case-insensitively.
    const selfKey = resolve(this.fileName).toLowerCase();
    const referenceFiles = new Map<string, string>();
    for (const entry of entries) {
      for (const path of [entry.definition.path, ...entry.references.map((ref) => ref.path)]) {
        const referenceFileName = resolve(path);
        const key = referenceFileName.toLowerCase();
        if (key !== selfKey) referenceFiles.set(key, referenceFileName);
      }
    }

    const result = [...referenceFiles.values()].sort();
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

function isInferredProject(project: Project | undefined) {
  return !project || project.configFileName === "/dev/null/inferred";
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
