// An in-memory, instrumented capnweb transport pair. Lets us run two capnweb
// RpcSessions in ONE process connected by a fake "wire", and COUNT + LOG every
// frame that crosses it — so we can measure round trips precisely.
//
// capnweb's RpcTransport is just { send(msg), receive(), abort?() }. We build a
// linked pair (left/right): left.send → right.receive, right.send → left.receive.
// Optional per-hop latency simulates the network so a single round trip ≈ 2·hop.

function makeChan() {
  const q = [];
  const waiters = [];
  let closed = null;
  return {
    push(m) {
      if (closed) return;
      const w = waiters.shift();
      if (w) w.resolve(m);
      else q.push(m);
    },
    pull() {
      if (q.length) return Promise.resolve(q.shift());
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close(err) {
      closed = err || new Error("transport closed");
      for (const w of waiters) w.reject(closed);
      waiters.length = 0;
    },
  };
}

const preview = (m) => {
  const s = typeof m === "string" ? m : JSON.stringify(m);
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
};

/**
 * Create a linked transport pair.
 *   opts.name    – label for logs (e.g. "B<->hub")
 *   opts.hopMs   – one-way delivery latency in ms (default 0)
 *   opts.log     – if true, print every frame
 * Returns { left, right, stats, reset }. `stats` counts sends per side and keeps
 * the raw frames so tests can classify them (push / pull / resolve / release / …).
 */
export function makeLinkedPair({ name = "wire", hopMs = 0, log = false } = {}) {
  const toRight = makeChan(); // messages traveling left→right (right.receive reads)
  const toLeft = makeChan(); // messages traveling right→left (left.receive reads)
  const stats = {
    left: { sends: 0, frames: [] },
    right: { sends: 0, frames: [] },
  };

  const deliver = (chan, msg) => {
    if (hopMs > 0) setTimeout(() => chan.push(msg), hopMs);
    else chan.push(msg);
  };

  const endpoint = (side, out, inbox) => ({
    async send(message) {
      stats[side].sends++;
      stats[side].frames.push(message);
      if (log)
        console.log(`  [${name}] ${side.padEnd(5)} send#${stats[side].sends}: ${preview(message)}`);
      deliver(out, message);
    },
    receive() {
      return inbox.pull();
    },
    abort(reason) {
      toRight.close(reason);
      toLeft.close(reason);
    },
  });

  return {
    stats,
    left: endpoint("left", toRight, toLeft),
    right: endpoint("right", toLeft, toRight),
    reset() {
      stats.left.sends = 0;
      stats.left.frames = [];
      stats.right.sends = 0;
      stats.right.frames = [];
    },
  };
}

// Classify a raw capnweb frame by its message type (frames are JSON arrays whose
// first element is the op, e.g. "push","pull","resolve","reject","release","abort").
export function frameType(frame) {
  try {
    const arr = typeof frame === "string" ? JSON.parse(frame) : frame;
    return Array.isArray(arr) ? String(arr[0]) : "?";
  } catch {
    return "?";
  }
}

export function summarize(stats) {
  const side = (s) => {
    const types = {};
    for (const f of s.frames) types[frameType(f)] = (types[frameType(f)] || 0) + 1;
    return { sends: s.sends, types };
  };
  return { left: side(stats.left), right: side(stats.right) };
}
