import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  API,
  SignatureKind,
  SymbolFlags,
  type Project,
  type Snapshot,
  type Symbol,
  type Type,
} from "@typescript/native-preview/unstable/sync";

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

  getTypeAtPosition(fileName: string, position: number) {
    const project = this.getProjectForFile(fileName);
    if (!project) return undefined;
    const type = project.checker.getTypeAtPosition(resolve(fileName), position);
    if (!type) return undefined;
    return { project, type };
  }

  getTypeAtNodeStart(fileName: string, node: RangedNode) {
    const position = node.range?.[0];
    if (typeof position !== "number") return undefined;
    return this.getTypeAtPosition(fileName, position);
  }

  getThenableInfo(fileName: string, node: ExpressionNode) {
    const typed = this.getExpressionTypeInfo(fileName, node);
    if (!typed) return undefined;
    if (!this.isThenableType(typed.project, typed.type)) return undefined;
    return {
      text: typed.project.checker.typeToString(typed.type),
      type: typed.type,
      project: typed.project,
    };
  }

  getExpressionTypeInfo(fileName: string, node: ExpressionNode) {
    if (node.type === "CallExpression") {
      return this.getCallReturnTypeInfo(fileName, node);
    }
    return this.getTypeAtNodeStart(fileName, node);
  }

  getCallReturnTypeInfo(fileName: string, node: CallExpressionNode) {
    const calleePosition = getCallablePosition(node.callee);
    if (calleePosition === undefined) return undefined;

    const calleeType = this.getTypeAtPosition(fileName, calleePosition);
    if (!calleeType) return undefined;

    const signatures = calleeType.project.checker.getSignaturesOfType(
      calleeType.type,
      SignatureKind.Call,
    );
    const signature = signatures[0];
    if (!signature) return undefined;

    const type = calleeType.project.checker.getReturnTypeOfSignature(signature);
    if (!type) return undefined;
    return { project: calleeType.project, type };
  }

  resolveTypeByName(fileName: string, name: string, position: number) {
    const project = this.getProjectForFile(fileName);
    if (!project) return undefined;
    const symbol = project.checker.resolveName(
      name,
      SymbolFlags.Type,
      { document: resolve(fileName), position },
      true,
    );
    if (!symbol) return undefined;
    const type = project.checker.getDeclaredTypeOfSymbol(symbol);
    if (!type) return undefined;
    return { project, symbol, type };
  }

  isThenableType(project: Project, type: Type) {
    const properties = project.checker.getPropertiesOfType(type);
    return properties.some((property: Symbol) => property.name === "then");
  }

  getSnapshot() {
    if (!this.api) {
      this.api = this.createApi();
    }
    if (!this.snapshot) {
      this.updateSnapshot({ openProjects: this.getTsconfigFiles() });
    }
    return this.snapshot;
  }

  openFile(fileName: string) {
    if (this.openFiles.has(fileName)) return;
    this.openFiles.add(fileName);
    this.projectByFile.clear();
    this.updateSnapshot({ openFiles: [fileName] });
  }

  updateSnapshot(params: Parameters<API["updateSnapshot"]>[0]) {
    const previous = this.snapshot;
    this.snapshot = this.requireApi().updateSnapshot(params);
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
        readFile: (fileName) => this.textByFile.get(resolve(fileName)),
      },
    });
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
    if (isInferredProject(project)) return;
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
    if (this.textByFile.get(absoluteFileName) === text) return;
    this.textByFile.set(absoluteFileName, text);
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

type RangedNode = {
  range?: [number, number];
  type?: string;
};

type CallableNode = RangedNode & {
  property?: RangedNode;
};

type CallExpressionNode = RangedNode & {
  type: "CallExpression";
  callee?: CallableNode;
};

type ExpressionNode = RangedNode | CallExpressionNode;

function getCallablePosition(callee: CallableNode | undefined) {
  if (!callee) return undefined;
  if (callee.type === "MemberExpression") return callee.property?.range?.[0];
  return callee.range?.[0];
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
