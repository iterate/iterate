// Minimal in-memory filesystem compatible with isomorphic-git's FS interface.
// isomorphic-git needs: readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat, symlink, readlink

type FsCallback<T> = (err: Error | null, result?: T) => void;

interface Stat {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function makeStat(type: "file" | "dir", size: number): Stat {
  const now = Date.now();
  return {
    type,
    mode: type === "file" ? 0o100644 : 0o40755,
    size,
    ino: 0,
    mtimeMs: now,
    ctimeMs: now,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => false,
  };
}

export class MemoryFS {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>(["/"]); // root always exists

  private normalize(p: string): string {
    if (!p.startsWith("/")) p = "/" + p;
    return p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }

  private parentDir(p: string): string {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }

  // Promisified API (what isomorphic-git actually uses)
  promises = {
    readFile: async (path: string, opts?: { encoding?: string }): Promise<Uint8Array | string> => {
      const p = this.normalize(path);
      const data = this.files.get(p);
      if (!data) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      if (opts?.encoding === "utf8") return new TextDecoder().decode(data);
      return data;
    },

    writeFile: async (
      path: string,
      data: Uint8Array | string,
      opts?: { mode?: number },
    ): Promise<void> => {
      const p = this.normalize(path);
      // auto-create parent dirs
      const parent = this.parentDir(p);
      if (parent !== p && !this.dirs.has(parent)) {
        await this.promises.mkdir(parent, { recursive: true });
      }
      const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
      this.files.set(p, buf);
    },

    unlink: async (path: string): Promise<void> => {
      const p = this.normalize(path);
      if (!this.files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      this.files.delete(p);
    },

    readdir: async (path: string): Promise<string[]> => {
      const p = this.normalize(path);
      if (!this.dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      const entries = new Set<string>();
      const prefix = p === "/" ? "/" : p + "/";
      for (const f of this.files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) entries.add(name);
        }
      }
      for (const d of this.dirs) {
        if (d.startsWith(prefix) && d !== p) {
          const rest = d.slice(prefix.length);
          const name = rest.split("/")[0];
          if (name) entries.add(name);
        }
      }
      return [...entries];
    },

    mkdir: async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
      const p = this.normalize(path);
      if (this.dirs.has(p)) return;
      if (opts?.recursive) {
        const parts = p.split("/").filter(Boolean);
        let cur = "";
        for (const part of parts) {
          cur += "/" + part;
          this.dirs.add(cur);
        }
      } else {
        const parent = this.parentDir(p);
        if (!this.dirs.has(parent))
          throw Object.assign(new Error(`ENOENT: ${parent}`), { code: "ENOENT" });
        this.dirs.add(p);
      }
    },

    rmdir: async (path: string): Promise<void> => {
      const p = this.normalize(path);
      this.dirs.delete(p);
    },

    stat: async (path: string): Promise<Stat> => {
      const p = this.normalize(path);
      if (this.dirs.has(p)) return makeStat("dir", 0);
      const data = this.files.get(p);
      if (data) return makeStat("file", data.length);
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },

    lstat: async (path: string): Promise<Stat> => {
      return this.promises.stat(path);
    },

    symlink: async (_target: string, _path: string): Promise<void> => {
      // noop — isomorphic-git doesn't actually need symlinks
    },

    readlink: async (path: string): Promise<string> => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },

    chmod: async (_path: string, _mode: number): Promise<void> => {
      // noop
    },
  };
}
