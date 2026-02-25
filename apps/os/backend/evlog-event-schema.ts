export type EvlogExceptionEvent = {
  request: {
    id: string;
    method: string;
    path: string;
    status: number;
    duration: number;
    waitUntil: boolean;
    parentRequestId?: string;
    trpcProcedure?: string;
    url?: string;
  };
  user: {
    id: string;
    email: string;
  };
};
