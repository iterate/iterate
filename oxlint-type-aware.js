import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { API, SignatureKind, SymbolFlags } from "@typescript/native-preview/unstable/sync";

const IGNORED_DIRS = new Set([
  ".alchemy",
  ".cache",
  ".git",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

/** @type {Map<string, TypeAwareLintService>} */
const servicesByCwd = new Map();

/**
 * @param {{ cwd?: string }} options
 */
export function getTypeAwareLintService(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  let service = servicesByCwd.get(cwd);
  if (!service) {
    service = new TypeAwareLintService({ cwd });
    servicesByCwd.set(cwd, service);
  }
  return service;
}

export class TypeAwareLintService {
  /** @type {string} */
  cwd;
  /** @type {API | undefined} */
  api;
  /** @type {import("@typescript/native-preview/unstable/sync").Snapshot | undefined} */
  snapshot;
  /** @type {Set<string>} */
  openFiles = new Set();
  /** @type {string[] | undefined} */
  tsconfigFiles;
  /** @type {Map<string, import("@typescript/native-preview/unstable/sync").Project | undefined>} */
  projectByFile = new Map();
  /** @type {Map<string, number>} */
  mtimesByFile = new Map();
  /** @type {Map<string, string>} */
  textByFile = new Map();
  /** @type {Set<string>} */
  textChangedFiles = new Set();

  /**
   * @param {{ cwd: string }} input
   */
  constructor(input) {
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

  /**
   * @param {string} fileName
   */
  getProjectForFile(fileName) {
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

  /**
   * @param {string} fileName
   * @param {number} position
   */
  getTypeAtPosition(fileName, position) {
    const project = this.getProjectForFile(fileName);
    if (!project) return undefined;
    const type = project.checker.getTypeAtPosition(resolve(fileName), position);
    if (!type) return undefined;
    return { project, type };
  }

  /**
   * @param {string} fileName
   * @param {{ range?: [number, number] }} node
   */
  getTypeAtNodeStart(fileName, node) {
    const position = node.range?.[0];
    if (typeof position !== "number") return undefined;
    return this.getTypeAtPosition(fileName, position);
  }

  /**
   * @param {string} fileName
   * @param {{ range?: [number, number], type?: string }} node
   */
  getThenableInfo(fileName, node) {
    const typed = this.getExpressionTypeInfo(fileName, node);
    if (!typed) return undefined;
    if (!this.isThenableType(typed.project, typed.type)) return undefined;
    return {
      text: typed.project.checker.typeToString(typed.type),
      type: typed.type,
      project: typed.project,
    };
  }

  /**
   * @param {string} fileName
   * @param {{ range?: [number, number], type?: string, callee?: { range?: [number, number], type?: string, property?: { range?: [number, number] } } }} node
   */
  getExpressionTypeInfo(fileName, node) {
    if (node.type === "CallExpression") {
      return this.getCallReturnTypeInfo(fileName, node);
    }
    return this.getTypeAtNodeStart(fileName, node);
  }

  /**
   * @param {string} fileName
   * @param {{ callee?: { range?: [number, number], type?: string, property?: { range?: [number, number] } } }} node
   */
  getCallReturnTypeInfo(fileName, node) {
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

  /**
   * @param {string} fileName
   * @param {string} name
   * @param {number} position
   */
  resolveTypeByName(fileName, name, position) {
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

  /**
   * @param {string} fileName
   * @param {string} name
   * @param {number} position
   */
  getCallablePropertiesOfNamedType(fileName, name, position) {
    const typed = this.resolveTypeByName(fileName, name, position);
    if (!typed) return undefined;

    return getCallablePropertiesOfType(typed.project, typed.type);
  }

  /**
   * @param {import("@typescript/native-preview/unstable/sync").Project} project
   * @param {import("@typescript/native-preview/unstable/sync").Type} type
   */
  isThenableType(project, type) {
    const properties = project.checker.getPropertiesOfType(type);
    return properties.some((property) => property.name === "then");
  }

  getSnapshot() {
    if (!this.api) {
      this.api = new API({
        cwd: this.cwd,
        fs: { readFile: (fileName) => this.textByFile.get(resolve(fileName)) },
      });
    }
    if (!this.snapshot) {
      this.updateSnapshot({ openProjects: this.getTsconfigFiles() });
    }
    return this.snapshot;
  }

  /**
   * @param {string} fileName
   */
  openFile(fileName) {
    if (this.openFiles.has(fileName)) return;
    this.openFiles.add(fileName);
    this.projectByFile.clear();
    this.updateSnapshot({ openFiles: [fileName] });
  }

  /**
   * @param {Parameters<API["updateSnapshot"]>[0]} params
   */
  updateSnapshot(params) {
    const previous = this.snapshot;
    this.snapshot = this.requireApi().updateSnapshot(params);
    previous?.dispose();
    for (const project of this.snapshot.getProjects()) {
      this.trackProjectFiles(project);
    }
  }

  requireApi() {
    if (!this.api) {
      this.api = new API({
        cwd: this.cwd,
        fs: {
          readFile: (fileName) => this.textByFile.get(resolve(fileName)),
        },
      });
    }
    return this.api;
  }

  getTsconfigFiles() {
    if (!this.tsconfigFiles) {
      this.tsconfigFiles = findTsconfigFiles(this.cwd);
    }
    return this.tsconfigFiles;
  }

  /**
   * @param {readonly string[]} fileNames
   */
  refreshSnapshotForChangedFiles(fileNames) {
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

  /**
   * @param {import("@typescript/native-preview/unstable/sync").Project | undefined} project
   */
  trackProjectFiles(project) {
    if (isInferredProject(project)) return;
    for (const fileName of project.rootFiles) {
      this.rememberFileMtime(fileName);
    }
  }

  /**
   * @param {string} fileName
   */
  hasFileChanged(fileName) {
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

  /**
   * @param {string} fileName
   */
  rememberFileMtime(fileName) {
    const mtime = getFileMtime(fileName);
    if (mtime !== undefined) this.mtimesByFile.set(fileName, mtime);
  }

  /**
   * @param {string} fileName
   * @param {string} text
   */
  setFileText(fileName, text) {
    const absoluteFileName = resolve(fileName);
    if (this.textByFile.get(absoluteFileName) === text) return;
    this.textByFile.set(absoluteFileName, text);
    this.textChangedFiles.add(absoluteFileName);
    this.mtimesByFile.set(absoluteFileName, getFileMtime(absoluteFileName) ?? -1);
  }

  /**
   * @param {readonly string[]} fileNames
   */
  drainTextChangedFiles(fileNames) {
    const candidates = fileNames.map((fileName) => resolve(fileName));
    const changedFiles = candidates.filter((fileName) => this.textChangedFiles.has(fileName));
    for (const fileName of changedFiles) {
      this.textChangedFiles.delete(fileName);
    }
    return changedFiles;
  }
}

/**
 * @param {import("@typescript/native-preview/unstable/sync").Project} project
 * @param {import("@typescript/native-preview/unstable/sync").Type} type
 */
function getCallablePropertiesOfType(project, type) {
  return project.checker
    .getPropertiesOfType(type)
    .map((property) => {
      const propertyType = project.checker.getTypeOfSymbol(property);
      const signature = project.checker.getSignaturesOfType(propertyType, SignatureKind.Call)[0];
      if (!signature) return undefined;
      return {
        name: property.name,
        parameters: signature.getParameters().map((parameter) => parameter.name),
        hasRestParameter: signature.hasRestParameter,
      };
    })
    .filter(Boolean);
}

/**
 * @param {{ range?: [number, number], type?: string, property?: { range?: [number, number] }} | undefined} callee
 */
function getCallablePosition(callee) {
  if (!callee) return undefined;
  if (callee.type === "MemberExpression") return callee.property?.range?.[0];
  return callee.range?.[0];
}

/**
 * @param {import("@typescript/native-preview/unstable/sync").Project | undefined} project
 */
function isInferredProject(project) {
  return !project || project.configFileName === "/dev/null/inferred";
}

/**
 * @param {string} root
 */
function findTsconfigFiles(root) {
  /** @type {string[]} */
  const results = [];

  /**
   * @param {string} dir
   */
  function visit(dir) {
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

/** @param {string} fileName */
function getFileMtime(fileName) {
  try {
    return statSync(fileName).mtimeMs;
  } catch {
    return undefined;
  }
}
