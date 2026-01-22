/**
 * Database query helpers for benchmark results
 */

import type Database from "better-sqlite3";
import type { MeasurementType, Run, Sandbox, Measurement } from "./schema.ts";

// Insert a new run
export function insertRun(db: Database.Database, run: Omit<Run, "finishedAt">): void {
  const stmt = db.prepare(`
    INSERT INTO runs (id, started_at, machines_per_config, requests_per_machine, batch_size, restart_cycles, notes, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    run.id,
    run.startedAt,
    run.machinesPerConfig,
    run.requestsPerMachine,
    run.batchSize,
    run.restartCycles,
    run.notes,
    run.configJson,
  );
}

// Update run finished time
export function finishRun(db: Database.Database, runId: string): void {
  const stmt = db.prepare(`UPDATE runs SET finished_at = ? WHERE id = ?`);
  stmt.run(new Date().toISOString(), runId);
}

// Insert a sandbox
export function insertSandbox(db: Database.Database, sandbox: Sandbox): void {
  const stmt = db.prepare(`
    INSERT INTO sandboxes (
      id, run_id, config_name, provider, provider_sandbox_id,
      cpu, memory_mb, region, dockerfile, sandbox_index,
      tunnel_url, terminal_url, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    sandbox.id,
    sandbox.runId,
    sandbox.configName,
    sandbox.provider,
    sandbox.providerSandboxId,
    sandbox.cpu,
    sandbox.memoryMb,
    sandbox.region,
    sandbox.dockerfile,
    sandbox.sandboxIndex,
    sandbox.tunnelUrl,
    sandbox.terminalUrl,
    sandbox.createdAt,
  );
}

// Update sandbox URLs
export function updateSandboxUrls(
  db: Database.Database,
  sandboxId: string,
  tunnelUrl: string,
  terminalUrl: string,
): void {
  const stmt = db.prepare(`
    UPDATE sandboxes SET tunnel_url = ?, terminal_url = ? WHERE id = ?
  `);
  stmt.run(tunnelUrl, terminalUrl, sandboxId);
}

// Insert a measurement
export function insertMeasurement(
  db: Database.Database,
  measurement: Omit<Measurement, "id">,
): number {
  const stmt = db.prepare(`
    INSERT INTO measurements (
      sandbox_id, measurement_type, sequence_index,
      started_at, completed_at, duration_ms,
      status_code, error,
      sandbox_process_start_ms, sandbox_ready_ms, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    measurement.sandboxId,
    measurement.measurementType,
    measurement.sequenceIndex,
    measurement.startedAt,
    measurement.completedAt,
    measurement.durationMs,
    measurement.statusCode,
    measurement.error,
    measurement.sandboxProcessStartMs,
    measurement.sandboxReadyMs,
    measurement.metadata,
  );
  return Number(result.lastInsertRowid);
}

// Get all runs
export function getRuns(db: Database.Database): Run[] {
  const stmt = db.prepare(`
    SELECT id, started_at as startedAt, finished_at as finishedAt,
           machines_per_config as machinesPerConfig,
           requests_per_machine as requestsPerMachine,
           batch_size as batchSize, restart_cycles as restartCycles, notes,
           config_json as configJson
    FROM runs ORDER BY started_at DESC
  `);
  return stmt.all() as Run[];
}

// Get sandboxes for a run
export function getSandboxesForRun(db: Database.Database, runId: string): Sandbox[] {
  const stmt = db.prepare(`
    SELECT id, run_id as runId, config_name as configName, provider,
           provider_sandbox_id as providerSandboxId,
           cpu, memory_mb as memoryMb, region, dockerfile,
           sandbox_index as sandboxIndex,
           tunnel_url as tunnelUrl, terminal_url as terminalUrl,
           created_at as createdAt
    FROM sandboxes WHERE run_id = ?
  `);
  return stmt.all(runId) as Sandbox[];
}

// Get measurements for a sandbox
export function getMeasurementsForSandbox(db: Database.Database, sandboxId: string): Measurement[] {
  const stmt = db.prepare(`
    SELECT id, sandbox_id as sandboxId, measurement_type as measurementType,
           sequence_index as sequenceIndex,
           started_at as startedAt, completed_at as completedAt,
           duration_ms as durationMs,
           status_code as statusCode, error,
           sandbox_process_start_ms as sandboxProcessStartMs,
           sandbox_ready_ms as sandboxReadyMs, metadata
    FROM measurements WHERE sandbox_id = ? ORDER BY id
  `);
  return stmt.all(sandboxId) as Measurement[];
}

// Get all measurements of a type for a run
export function getMeasurementsByType(
  db: Database.Database,
  runId: string,
  measurementType: MeasurementType,
): Measurement[] {
  const stmt = db.prepare(`
    SELECT m.id, m.sandbox_id as sandboxId, m.measurement_type as measurementType,
           m.sequence_index as sequenceIndex,
           m.started_at as startedAt, m.completed_at as completedAt,
           m.duration_ms as durationMs,
           m.status_code as statusCode, m.error,
           m.sandbox_process_start_ms as sandboxProcessStartMs,
           m.sandbox_ready_ms as sandboxReadyMs, m.metadata
    FROM measurements m
    JOIN sandboxes s ON m.sandbox_id = s.id
    WHERE s.run_id = ? AND m.measurement_type = ?
    ORDER BY m.id
  `);
  return stmt.all(runId, measurementType) as Measurement[];
}

// Get summary statistics for a run
export function getRunSummary(
  db: Database.Database,
  runId: string,
): {
  totalSandboxes: number;
  totalMeasurements: number;
  measurementsByType: Record<MeasurementType, number>;
} {
  const sandboxCount = db
    .prepare(`SELECT COUNT(*) as count FROM sandboxes WHERE run_id = ?`)
    .get(runId) as { count: number };

  const measurementCount = db
    .prepare(
      `
      SELECT COUNT(*) as count FROM measurements m
      JOIN sandboxes s ON m.sandbox_id = s.id
      WHERE s.run_id = ?
    `,
    )
    .get(runId) as { count: number };

  const byType = db
    .prepare(
      `
      SELECT m.measurement_type as type, COUNT(*) as count
      FROM measurements m
      JOIN sandboxes s ON m.sandbox_id = s.id
      WHERE s.run_id = ?
      GROUP BY m.measurement_type
    `,
    )
    .all(runId) as { type: MeasurementType; count: number }[];

  const measurementsByType: Record<MeasurementType, number> = {
    cold_boot: 0,
    restart: 0,
    request_latency: 0,
  };
  for (const row of byType) {
    measurementsByType[row.type] = row.count;
  }

  return {
    totalSandboxes: sandboxCount.count,
    totalMeasurements: measurementCount.count,
    measurementsByType,
  };
}
