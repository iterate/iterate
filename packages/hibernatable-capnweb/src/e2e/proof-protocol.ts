import type { RpcTarget } from "capnweb";

export type PeerRecordArgs = {
  message: string;
  callerInstanceId: string;
};

export type PeerRecordResult = {
  runtime: string;
  message: string;
  callerInstanceId: string;
  receivedCount: number;
};

export interface ProofPeerApi extends RpcTarget {
  record(args: PeerRecordArgs): PeerRecordResult | Promise<PeerRecordResult>;
}

export interface ProofHostApi extends RpcTarget {
  echo(args: { message: string }):
    | { message: string; instanceId: string }
    | Promise<{
        message: string;
        instanceId: string;
      }>;
  callPeerFromSession(args: { message: string }): PeerRecordResult | Promise<PeerRecordResult>;
}

export type ProofStatus = {
  instanceId: string;
  constructorCount: number;
  fetchCount: number;
  webSocketMessageCount: number;
  webSocketCloseCount: number;
  connections: Array<{
    id: string;
    meta: unknown;
    live: boolean;
    autoResponseTimestamp: string | null;
  }>;
};

export type CallPeerProof = {
  before: ProofStatus;
  result: PeerRecordResult;
  after: ProofStatus;
};
