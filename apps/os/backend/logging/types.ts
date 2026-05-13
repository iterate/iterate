export type WideLog = {
  meta: {
    id: string;
    start: string;
    end?: string;
    durationMs?: number;
  };
  messages?: string[];
  errors?: unknown[];
  parent?: WideLog;
  [key: string]: unknown;
};
