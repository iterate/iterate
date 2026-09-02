// e2e/support/targets.ts — the live rpc-stub fixtures: RpcTargets a test PROVIDES under a match
// (`itx.provide("itx.x", new Tools("x"))` — lent under the key `itx.x`, rule at the same spelling)
// and then calls through the rules from another session.

import { RpcTarget } from "capnweb";

/** The plainest live rpc stub: one method, tagged so a call proves WHICH provider answered. */
export class Tools extends RpcTarget {
  #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  hello() {
    return `hello-from-${this.#tag}`;
  }
}

/** A provider whose `hang()` never answers — the mid-invoke rig (the test kills or races it). */
export class HangTools extends RpcTarget {
  hangStarted = false;
  hello() {
    return "hang-tools";
  }
  hang() {
    this.hangStarted = true;
    return new Promise(() => {
      /* never resolves */
    });
  }
}

/** The Slack-bridge shape: an RpcTarget whose GETTERS return plain objects of functions (slack →
 *  chat → postMessage), recording every call so a test proves the exact dotted call arrived. Swap in
 *  `new WebClient(token)` behind the getters for real. */
export class SlackReplayTarget extends RpcTarget {
  calls: [string, Record<string, unknown>][] = [];
  get chat() {
    return {
      postMessage: (opts: Record<string, unknown>) => {
        this.calls.push(["chat.postMessage", opts]);
        return { ok: true, ts: "1755.000100", channel: opts.channel };
      },
    };
  }
  get conversations() {
    return {
      list: (opts?: { limit?: number }) => {
        this.calls.push(["conversations.list", opts ?? {}]);
        return {
          ok: true,
          channels: [
            { id: "C1", name: "general" },
            { id: "C2", name: "random" },
          ].slice(0, opts?.limit ?? 99),
        };
      },
    };
  }
}
