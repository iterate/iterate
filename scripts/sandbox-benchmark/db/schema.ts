/**
 * SQLite schema for benchmark results
 */

import Database from "better-sqlite3";

export type MeasurementType = "cold_boot" | "restart" | "request_latency";

export interface Run {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  machinesPerConfig: number;
  requestsPerMachine: number;
  batchSize: number;
  restartCycles: number;
  notes: string | null;
  configJson: string | null; // Full BenchmarkConfig as JSON
}

export interface Sandbox {
  id: string;
  runId: string;
  configName: string;
  provider: string;
  providerSandboxId: string;
  cpu: number | null;
  memoryMb: number | null;
  region: string | null;
  dockerfile: string;
  sandboxIndex: number;
  tunnelUrl: string | null;
  terminalUrl: string | null;
  createdAt: string;
}

export interface Measurement {
  id: number;
  sandboxId: string;
  measurementType: MeasurementType;
  sequenceIndex: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  statusCode: number | null;
  error: string | null;
  sandboxProcessStartMs: number | null;
  sandboxReadyMs: number | null;
  metadata: string | null; // JSON
}

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  machines_per_config INTEGER NOT NULL,
  requests_per_machine INTEGER NOT NULL,
  batch_size INTEGER NOT NULL,
  restart_cycles INTEGER NOT NULL,
  notes TEXT,
  config_json TEXT
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  config_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_sandbox_id TEXT NOT NULL,
  cpu INTEGER,
  memory_mb INTEGER,
  region TEXT,
  dockerfile TEXT NOT NULL,
  sandbox_index INTEGER NOT NULL,
  tunnel_url TEXT,
  terminal_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  measurement_type TEXT NOT NULL,
  sequence_index INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms REAL,
  status_code INTEGER,
  error TEXT,
  sandbox_process_start_ms REAL,
  sandbox_ready_ms REAL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sandboxes_run_id ON sandboxes(run_id);
CREATE INDEX IF NOT EXISTS idx_measurements_sandbox_id ON measurements(sandbox_id);
CREATE INDEX IF NOT EXISTS idx_measurements_type ON measurements(measurement_type);
`;

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLES_SQL);
  return db;
}
