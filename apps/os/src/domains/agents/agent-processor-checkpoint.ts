import type { StreamProcessorSnapshot } from "../streams/stream-processor.ts";
import { AgentProcessorContract, type AgentProcessorState } from "./agent-processor-contract.ts";

const HISTORY_TAIL_TARGET_BYTES = 128 * 1024;
const MAX_SQL_BLOB_BYTES = 512 * 1024;
const CHECKPOINT_TABLE = "agent_processor_checkpoint_v1";
const HISTORY_CHUNKS_TABLE = "agent_processor_history_chunks_v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type AgentCheckpoint = StreamProcessorSnapshot<AgentProcessorState>;
type AgentHistory = AgentProcessorState["history"];
type AgentHistoryItem = AgentHistory[number];
type CheckpointStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

type CheckpointRow = {
  contractVersion: string;
  generation: number;
  historyLength: number;
  offset: number;
  sealedChunkCount: number;
  stateJson: string;
  tailBytes: ArrayBuffer;
};

type ChunkRow = {
  chunkBytes: ArrayBuffer;
  chunkIndex: number;
  partIndex: number;
};

type EncodedHistoryChunk = {
  bytes: Uint8Array;
  items: AgentHistoryItem[];
};

class InvalidAgentCheckpointError extends Error {}

/**
 * Agent-only checkpoint storage that keeps the frequently changing tail
 * bounded while older model-visible history becomes immutable SQL rows.
 */
export class AgentProcessorCheckpointStore {
  readonly #storage: CheckpointStorage;
  readonly #contractVersion: string;
  #schemaReady = false;
  #generation = 0;
  #sealedChunkCount = 0;
  #tailItems: AgentHistoryItem[] = [];
  #lastHistory: AgentHistory | undefined;

  constructor(storage: CheckpointStorage, contractVersion: string) {
    this.#storage = storage;
    this.#contractVersion = contractVersion;
  }

  readonly read = (): AgentCheckpoint | undefined => {
    const row = this.#readCheckpointRow();
    if (row === undefined) return undefined;
    this.#generation = row.generation;
    if (row.contractVersion !== this.#contractVersion) return undefined;

    try {
      const sealedChunks = this.#readSealedChunks(row);
      const tailItems = decodeHistoryChunk([row.tailBytes]);
      const history = [...sealedChunks.flat(), ...tailItems];
      if (history.length !== row.historyLength) {
        throw new InvalidAgentCheckpointError(
          `Agent checkpoint history length mismatch: expected ${row.historyLength}, read ${history.length}`,
        );
      }

      const stateWithoutHistory = decodeStateWithoutHistory(row.stateJson);
      const state: AgentProcessorState = { ...stateWithoutHistory, history };
      this.#sealedChunkCount = row.sealedChunkCount;
      this.#tailItems = tailItems;
      this.#lastHistory = history;
      return { offset: row.offset, state };
    } catch (error) {
      if (!(error instanceof InvalidAgentCheckpointError) && !(error instanceof SyntaxError)) {
        throw error;
      }
      this.#sealedChunkCount = 0;
      this.#tailItems = [];
      this.#lastHistory = undefined;
      return undefined;
    }
  };

  readonly write = (snapshot: AgentCheckpoint): void => {
    this.#ensureSchema();
    const history = snapshot.state.history;
    const previousHistory = this.#lastHistory;
    const isAppend = previousHistory !== undefined && hasIdentityPrefix(history, previousHistory);
    const reset = !isAppend;
    const appendedItems = isAppend ? history.slice(previousHistory.length) : history;
    const generation = reset ? this.#generation + 1 : this.#generation;
    const startingChunkCount = reset ? 0 : this.#sealedChunkCount;
    const packed = packAppendedHistory(reset ? [] : this.#tailItems, appendedItems);
    const { history: _history, ...stateWithoutHistory } = snapshot.state;

    this.#storage.transactionSync(() => {
      if (reset) {
        this.#storage.sql.exec(`delete from ${HISTORY_CHUNKS_TABLE}`);
      }
      for (let index = 0; index < packed.sealed.length; index += 1) {
        this.#insertSealedChunk(generation, startingChunkCount + index, packed.sealed[index]!);
      }
      this.#storage.sql.exec(
        `insert into ${CHECKPOINT_TABLE} (
           singleton,
           contract_version,
           checkpoint_offset,
           generation,
           history_length,
           sealed_chunk_count,
           state_json,
           tail_bytes
         ) values (1, ?, ?, ?, ?, ?, ?, ?)
         on conflict (singleton) do update set
           contract_version = excluded.contract_version,
           checkpoint_offset = excluded.checkpoint_offset,
           generation = excluded.generation,
           history_length = excluded.history_length,
           sealed_chunk_count = excluded.sealed_chunk_count,
           state_json = excluded.state_json,
           tail_bytes = excluded.tail_bytes`,
        this.#contractVersion,
        snapshot.offset,
        generation,
        history.length,
        startingChunkCount + packed.sealed.length,
        JSON.stringify(stateWithoutHistory),
        exactArrayBuffer(packed.tail.bytes),
      );
    });

    this.#generation = generation;
    this.#sealedChunkCount = startingChunkCount + packed.sealed.length;
    this.#tailItems = packed.tail.items;
    this.#lastHistory = history;
  };

  #readCheckpointRow(): CheckpointRow | undefined {
    try {
      const row = this.#storage.sql
        .exec<CheckpointRow>(`
          select contract_version as contractVersion,
                 checkpoint_offset as offset,
                 generation,
                 history_length as historyLength,
                 sealed_chunk_count as sealedChunkCount,
                 state_json as stateJson,
                 tail_bytes as tailBytes
          from ${CHECKPOINT_TABLE}
          where singleton = 1
        `)
        .toArray()[0];
      this.#schemaReady = true;
      return row;
    } catch (error) {
      if (!String(error).includes(`no such table: ${CHECKPOINT_TABLE}`)) throw error;
      this.#ensureSchema();
      return undefined;
    }
  }

  #ensureSchema(): void {
    if (this.#schemaReady) return;
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(`
        create table if not exists ${CHECKPOINT_TABLE} (
          singleton integer primary key check (singleton = 1),
          contract_version text not null,
          checkpoint_offset integer not null,
          generation integer not null,
          history_length integer not null,
          sealed_chunk_count integer not null,
          state_json text not null,
          tail_bytes blob not null
        )
      `);
      this.#storage.sql.exec(`
        create table if not exists ${HISTORY_CHUNKS_TABLE} (
          generation integer not null,
          chunk_index integer not null,
          part_index integer not null,
          chunk_bytes blob not null,
          primary key (generation, chunk_index, part_index)
        ) without rowid
      `);
    });
    this.#schemaReady = true;
  }

  #readSealedChunks(row: CheckpointRow): AgentHistoryItem[][] {
    if (row.sealedChunkCount === 0) return [];
    const chunks: AgentHistoryItem[][] = [];
    let currentIndex = -1;
    let expectedPartIndex = 0;
    let parts: ArrayBuffer[] = [];

    const finishChunk = () => {
      if (currentIndex < 0) return;
      chunks.push(decodeHistoryChunk(parts));
    };

    for (const part of this.#storage.sql.exec<ChunkRow>(
      `select chunk_index as chunkIndex,
              part_index as partIndex,
              chunk_bytes as chunkBytes
       from ${HISTORY_CHUNKS_TABLE}
       where generation = ?
       order by chunk_index asc, part_index asc`,
      row.generation,
    )) {
      if (part.chunkIndex !== currentIndex) {
        finishChunk();
        currentIndex += 1;
        if (part.chunkIndex !== currentIndex) {
          throw new InvalidAgentCheckpointError(
            `Agent checkpoint missing sealed history chunk ${currentIndex}`,
          );
        }
        parts = [];
        expectedPartIndex = 0;
      }
      if (part.partIndex !== expectedPartIndex) {
        throw new InvalidAgentCheckpointError(
          `Agent checkpoint missing part ${expectedPartIndex} of history chunk ${currentIndex}`,
        );
      }
      parts.push(part.chunkBytes);
      expectedPartIndex += 1;
    }
    finishChunk();
    if (chunks.length !== row.sealedChunkCount) {
      throw new InvalidAgentCheckpointError(
        `Agent checkpoint sealed chunk mismatch: expected ${row.sealedChunkCount}, read ${chunks.length}`,
      );
    }
    return chunks;
  }

  #insertSealedChunk(generation: number, chunkIndex: number, chunk: EncodedHistoryChunk): void {
    let partIndex = 0;
    for (let start = 0; start < chunk.bytes.byteLength; start += MAX_SQL_BLOB_BYTES) {
      const end = Math.min(start + MAX_SQL_BLOB_BYTES, chunk.bytes.byteLength);
      this.#storage.sql.exec(
        `insert into ${HISTORY_CHUNKS_TABLE} (
           generation, chunk_index, part_index, chunk_bytes
         ) values (?, ?, ?, ?)`,
        generation,
        chunkIndex,
        partIndex,
        exactArrayBuffer(chunk.bytes.subarray(start, end)),
      );
      partIndex += 1;
    }
  }
}

function hasIdentityPrefix(history: AgentHistory, prefix: AgentHistory): boolean {
  if (history.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (history[index] !== prefix[index]) return false;
  }
  return true;
}

function packAppendedHistory(
  initialTail: readonly AgentHistoryItem[],
  appendedItems: readonly AgentHistoryItem[],
): { sealed: EncodedHistoryChunk[]; tail: EncodedHistoryChunk } {
  const sealed: EncodedHistoryChunk[] = [];
  let tail = encodeHistoryChunk(initialTail);
  for (const item of appendedItems) {
    const candidate = encodeHistoryChunk([...tail.items, item]);
    if (candidate.bytes.byteLength <= HISTORY_TAIL_TARGET_BYTES) {
      tail = candidate;
      continue;
    }
    if (tail.items.length > 0) sealed.push(tail);
    const itemChunk = encodeHistoryChunk([item]);
    if (itemChunk.bytes.byteLength > HISTORY_TAIL_TARGET_BYTES) {
      sealed.push(itemChunk);
      tail = encodeHistoryChunk([]);
    } else {
      tail = itemChunk;
    }
  }
  return { sealed, tail };
}

function encodeHistoryChunk(items: readonly AgentHistoryItem[]): EncodedHistoryChunk {
  const copiedItems = [...items];
  return { bytes: textEncoder.encode(JSON.stringify(copiedItems)), items: copiedItems };
}

function decodeHistoryChunk(parts: readonly ArrayBuffer[]): AgentHistoryItem[] {
  const decoded: unknown = JSON.parse(textDecoder.decode(combineArrayBuffers(parts)));
  if (!Array.isArray(decoded) || !decoded.every(isAgentHistoryItem)) {
    throw new InvalidAgentCheckpointError("Agent checkpoint history chunk is malformed");
  }
  return decoded;
}

function decodeStateWithoutHistory(json: string): Omit<AgentProcessorState, "history"> {
  const decoded: unknown = JSON.parse(json);
  if (!isRecord(decoded)) {
    throw new InvalidAgentCheckpointError("Agent checkpoint state is malformed");
  }
  const parsed = AgentProcessorContract.stateSchema.safeParse({ ...decoded, history: [] });
  if (!parsed.success) {
    throw new InvalidAgentCheckpointError("Agent checkpoint state is malformed");
  }
  const { history: _history, ...stateWithoutHistory } = parsed.data;
  return stateWithoutHistory;
}

function isAgentHistoryItem(value: unknown): value is AgentHistoryItem {
  if (!isRecord(value)) return false;
  if (value.role !== "user" && value.role !== "assistant") return false;
  if (typeof value.content !== "string") return false;
  if (value.files === undefined) return true;
  return Array.isArray(value.files) && value.files.every(isAgentFileAttachment);
}

function isAgentFileAttachment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.contentType === "string" &&
    typeof value.filename === "string" &&
    typeof value.path === "string" &&
    Number.isInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.url === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function combineArrayBuffers(parts: readonly ArrayBuffer[]): Uint8Array {
  if (parts.length === 1) return new Uint8Array(parts[0]!);
  const combined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return combined;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
