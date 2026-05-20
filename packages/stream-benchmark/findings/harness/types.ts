export type AppendBenchmarkResult = {
  mode: string;
  path: string;
  messages: number;
  sent: number;
  received: number;
  errors: number;
  elapsedMs: number;
  appendsPerSecond: number;
  firstEventMs?: number;
  batchSize?: number;
  committed?: number;
};
