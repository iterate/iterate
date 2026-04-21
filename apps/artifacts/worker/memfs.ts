// Minimal in-memory filesystem compatible with isomorphic-git's promises API.
// https://isomorphic-git.org/docs/en/fs

export class MemoryFS {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>(["/"]);

  private normalize(p: string) {
    if (!p.startsWith("/")) p = "/" + p;
    return p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }

  private parentDir(p: string) {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }

  private enoent(p: string): never {
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  }

  promises = {
    readFile: async (path: string, opts?: { encoding?: string }) => {
      const p = this.normalize(path);
      const data = this.files.get(p);
      if (!data) this.enoent(p);
      if (opts?.encoding === "utf8") return new TextDecoder().decode(data);
      return data;
    },

    writeFile: async (path: string, data: Uint8Array | string) => {
      const p = this.normalize(path);
      const parent = this.parentDir(p);
      if (parent !== p && !this.dirs.has(parent))
        await this.promises.mkdir(parent, { recursive: true });
      this.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
    },

    unlink: async (path: string) => {
      const p = this.normalize(path);
      if (!this.files.has(p)) this.enoent(p);
      this.files.delete(p);
    },

    readdir: async (path: string) => {
      const p = this.normalize(path);
      if (!this.dirs.has(p)) this.enoent(p);
      const entries = new Set<string>();
      const prefix = p === "/" ? "/" : p + "/";
      for (const f of this.files.keys()) {
        if (f.startsWith(prefix)) {
          const name = f.slice(prefix.length).split("/")[0];
          if (name) entries.add(name);
        }
      }
      for (const d of this.dirs) {
        if (d.startsWith(prefix) && d !== p) {
          const name = d.slice(prefix.length).split("/")[0];
          if (name) entries.add(name);
        }
      }
      return [...entries];
    },

    mkdir: async (path: string, opts?: { recursive?: boolean }) => {
      const p = this.normalize(path);
      if (this.dirs.has(p)) return;
      if (opts?.recursive) {
        let cur = "";
        for (const part of p.split("/").filter(Boolean)) {
          cur += "/" + part;
          this.dirs.add(cur);
        }
      } else {
        if (!this.dirs.has(this.parentDir(p))) this.enoent(this.parentDir(p));
        this.dirs.add(p);
      }
    },

    rmdir: async (path: string) => {
      this.dirs.delete(this.normalize(path));
    },

    stat: async (path: string) => {
      const p = this.normalize(path);
      if (this.dirs.has(p)) return makeStat("dir", 0);
      const data = this.files.get(p);
      if (data) return makeStat("file", data.length);
      this.enoent(p);
    },

    lstat: async (path: string) => this.promises.stat(path),

    // Stubs required by isomorphic-git FS interface but unused for non-symlink repos
    symlink: async () => {},
    readlink: async (path: string): Promise<string> => this.enoent(path),
    chmod: async () => {},
  };
}

function makeStat(type: "file" | "dir", size: number) {
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
