import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { Entry as HarEntry, Har } from "har-format";

const HAR_HEADER = `{"log":{"version":"1.2","creator":{"name":"@iterate-com/mock-http-proxy","version":"0.0.1"},"entries":[\n`;
const HAR_FOOTER = "\n]}}\n";

/**
 * Writes a valid HAR file incrementally, one entry at a time.
 *
 * On open, writes the JSON envelope prefix. Each `append()` writes a single
 * entry as a JSON line. On `close()`, writes the closing brackets so the file
 * is valid HAR JSON. Never holds more than one entry in memory.
 */
export class StreamingHarWriter {
  private fd: FileHandle | null = null;
  private first = true;
  private entryCount = 0;
  private filePath: string | null = null;

  async open(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    this.fd = await open(path, "w");
    await this.fd.write(HAR_HEADER);
    this.first = true;
    this.entryCount = 0;
    this.filePath = path;
  }

  async append(entry: HarEntry): Promise<void> {
    if (!this.fd) throw new Error("StreamingHarWriter is not open");
    const prefix = this.first ? "" : ",\n";
    this.first = false;
    await this.fd.write(prefix + JSON.stringify(entry));
    this.entryCount++;
  }

  async close(): Promise<void> {
    if (!this.fd) return;
    await this.fd.write(HAR_FOOTER);
    await this.fd.close();
    this.fd = null;
  }

  get count(): number {
    return this.entryCount;
  }

  get path(): string | null {
    return this.filePath;
  }

  /**
   * Read the completed HAR file back from disk. Only works after `close()`.
   * Returns an empty HAR if the file doesn't exist or wasn't written.
   */
  static async readBack(path: string): Promise<Har> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Har;
    } catch {
      return {
        log: {
          version: "1.2",
          creator: { name: "@iterate-com/mock-http-proxy", version: "0.0.1" },
          entries: [],
        },
      };
    }
  }
}
