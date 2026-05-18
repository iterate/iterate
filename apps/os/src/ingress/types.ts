import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";

export type ExactHostIngressRule = {
  id: string;
  host: string;
  projectId: string | null;
  priority: number;
  notes: string | null;
  callable: FetchCallable;
  createdAt: string;
  updatedAt: string;
};

export type IngressMatch = {
  requestHost: string;
  rule: ExactHostIngressRule;
};
