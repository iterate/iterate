// Telling a truthful denial apart from a bad instruction.
//
// The capability proof asserts that the brief `setupVoiceAgent` installs never
// presents a method the device lacks as something to call. The first version of
// that assertion was a substring search, and it failed the deployed brief for
// the sentence that exists to PREVENT the mistake:
//
//   "There is NO interrupt or interruptPlayback method here: to cut an answer
//    short, call pushToTalk.start(), which cancels whatever is playing and opens
//    the microphone."
//
// Given a device that plays audio and has no interrupt, a model will guess
// `interrupt`. Naming it in order to refuse it, with the real alternative
// alongside, is the only thing that heads that off — so the warning stays and
// the assertion has to be precise instead.
import { describe, expect, it } from "vitest";

import { baselineJpegProblems, DEVICE_IMAGE_LIMITS } from "./slow-image-fixture.ts";
import {
  absentMethodCalls,
  agentDriveProblems,
  boundaryEvidenceProblems,
  briefContentProblems,
  correlateTaggedTurn,
  awaitSettlements,
  busyShapeProblems,
  transitionProblems,
} from "./prove.ts";

/** The three names the firmware has no dispatch entry for. */
const ABSENT = ["interruptPlayback", "interrupt", "conversation.interrupt"] as const;

/** Verbatim from the deployed brief, at the offset the proof read it from. */
const DEPLOYED_DENIAL =
  "conversation.start(), conversation.hangUp() — both safe to repeat; they record intent, so " +
  "starting a live call or hanging up a dead one changes nothing. There is NO interrupt or " +
  "interruptPlayback method here: to cut an answer short, call pushToTalk.start(), which cancels " +
  "whatever is playing and opens the microphone.";

describe("absentMethodCalls", () => {
  it("passes the deployed denial, which names them only to refuse them", () => {
    /*
     * THE FALSE POSITIVE THAT MATTERED. This exact text failed the proof once,
     * and acting on that failure would have deleted the warning that stops a
     * model inventing a method.
     *
     * `interruptPlayback` appears here as prose inside the denial, not as
     * something to call, and that is the distinction the rule has to draw.
     */
    expect(absentMethodCalls(DEPLOYED_DENIAL, ABSENT)).toEqual([]);
  });

  it("catches a brief that tells the model to call one", () => {
    expect(absentMethodCalls("To cut an answer short, call interrupt(0).", ABSENT)).toContain(
      "interrupt",
    );
    expect(absentMethodCalls("Use conversation.interrupt() to stop playback.", ABSENT)).toEqual(
      expect.arrayContaining(["interrupt", "conversation.interrupt"]),
    );
    expect(absentMethodCalls("Call interruptPlayback() first.", ABSENT)).toContain(
      "interruptPlayback",
    );
  });

  it("catches a member reference even without an argument list", () => {
    /* `conversation.interrupt` in a capability list is a claim that it exists,
     * whether or not the brief shows the parentheses. */
    expect(
      absentMethodCalls("Methods: conversation.start, conversation.interrupt", ABSENT),
    ).toEqual(expect.arrayContaining(["interrupt", "conversation.interrupt"]));
  });

  it("does not trip on ordinary English about interrupting", () => {
    /*
     * The other false-positive family. A brief SHOULD talk about interruption —
     * it is the behaviour the device is built around — and prose about it is not
     * a claim about a method.
     */
    for (const prose of [
      "The user can interrupt at any time by holding the upper button.",
      "An interruption mid-answer is normal and expected.",
      "Playback is interrupted when the microphone opens.",
      "This device is interruptible.",
    ]) {
      expect(absentMethodCalls(prose, ABSENT)).toEqual([]);
    }
  });

  it("does not care about a method the device really has", () => {
    /* pushToTalk.start is present, advertised, and the denial's whole point. */
    expect(absentMethodCalls("Call pushToTalk.start() to cut an answer short.", ABSENT)).toEqual(
      [],
    );
  });

  it("reports nothing for an empty absent list, whatever the text says", () => {
    expect(absentMethodCalls("call interrupt() twice", [])).toEqual([]);
  });
});

describe("awaitSettlements", () => {
  /** A run as askAgent builds it from `script-run-requested`. */
  const pending = (executionId: string, requestedAtOffset: number) => ({
    code: `device.health()`,
    executionId,
    requestedAtOffset,
    settledAtOffset: null,
    settlement: null,
  });

  it("picks up a settlement that lands after the agent's answer", async () => {
    /*
     * THE MEASURED RACE. On deployed preview_3 `script-run-settled` is appended
     * 155-283ms after `agents/web-message-sent`, and `ask()` resolves on the
     * message — so the read that follows it lands in the gap. Four consecutive
     * cases were reported as "no capability script settled as succeeded" while
     * the device had done exactly what was asked.
     */
    const stream = {
      waitForEvent: (args: { predicate?: (event: { payload?: unknown }) => boolean }) => {
        const event = {
          offset: 291_170,
          payload: { executionId: "agent-output:291136", settlement: { status: "succeeded" } },
        };
        expect(args.predicate?.(event)).toBe(true);
        return Promise.resolve(event);
      },
    };
    const runs = [pending("agent-output:291136", 291_139)];
    const result = await awaitSettlements(stream, runs, 20_000);
    expect(result.stillPending).toEqual([]);
    expect(runs[0]!.settlement).toEqual({ status: "succeeded" });
    expect(runs[0]!.settledAtOffset).toBe(291_170);
  });

  it("leaves a run that never settles pending, so its case fails", async () => {
    /* The wait must not invent a settlement. A run the platform never settles is
     * a real failure and has to stay visible as one. */
    const stream = {
      waitForEvent: () => Promise.reject(new Error("stream-wait-timeout: after 20000ms")),
    };
    const runs = [pending("agent-output:1", 10)];
    const result = await awaitSettlements(stream, runs, 100);
    expect(result.stillPending).toEqual(["agent-output:1"]);
    expect(runs[0]!.settlement).toBeNull();
  });

  it("does not wait for runs that already settled", async () => {
    /* The common case after a slow turn: nothing to wait for, no time spent. */
    let calls = 0;
    const stream = {
      waitForEvent: () => {
        calls++;
        return Promise.reject(new Error("should not be called"));
      },
    };
    const settled = { ...pending("agent-output:2", 20), settlement: { status: "succeeded" } };
    const result = await awaitSettlements(stream, [settled], 20_000);
    expect(calls).toBe(0);
    expect(result.stillPending).toEqual([]);
  });

  it("matches only the run it is waiting for", async () => {
    /* Another turn's settlement must not satisfy this run — the executionId is
     * the correlation, exactly as with the warm-up token. */
    const stream = {
      waitForEvent: (args: { predicate?: (event: { payload?: unknown }) => boolean }) => {
        expect(args.predicate?.({ payload: { executionId: "agent-output:999" } })).toBe(false);
        return Promise.resolve({
          offset: 5,
          payload: { executionId: "agent-output:3", settlement: { status: "failed" } },
        });
      },
    };
    const runs = [pending("agent-output:3", 4)];
    await awaitSettlements(stream, runs, 20_000);
    /* Settled, but as a failure — recorded truthfully rather than as success. */
    expect(runs[0]!.settlement).toEqual({ status: "failed" });
  });
});

describe("transitionProblems", () => {
  const good = {
    agentReported: { ok: true, value: 42 },
    baseline: "20",
    baselineDiffersFromTarget: true,
    baselineVerified: true,
    endedAtTarget: true,
    target: "42",
  };

  it("passes a verified move from a contrasting baseline", () => {
    expect(transitionProblems(good)).toEqual([]);
  });

  it("rejects a case that started already at the target", () => {
    /*
     * THE PRECONDITION THAT LEAKED. Proof run 2 was stopped with the panel left
     * red, so run 3's set-background began at its own target and reported
     * "moved rgb(123,0,0) -> rgb(123,0,0)". Nothing was wrong with the device;
     * the case had nothing to prove, and would equally have "passed" a device
     * that ignored the call outright.
     */
    const problems = transitionProblems({
      ...good,
      baseline: "#7f0000",
      baselineDiffersFromTarget: false,
      target: "#7f0000",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not differ from the target");
  });

  it("rejects a baseline the device never actually showed", () => {
    /* Establishing a baseline is only worth anything if it took. */
    const problems = transitionProblems({ ...good, baselineVerified: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("did not show the contrasting baseline");
  });

  it("rejects a device that never reached the target", () => {
    expect(transitionProblems({ ...good, endedAtTarget: false })[0]).toContain(
      "does not show the target",
    );
  });

  it("refuses to accept a side effect as proof the agent made the call", () => {
    /*
     * The device can be in the right state because something else put it there.
     * A case whose agent returned nothing has only the device as a witness, and
     * that is exactly what must not count.
     */
    const problems = transitionProblems({ ...good, agentReported: null });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("side effect is not proof");
  });

  it("reports every independent problem at once", () => {
    /* So one rerun shows the whole picture instead of one reason at a time. */
    expect(
      transitionProblems({
        agentReported: null,
        baseline: "#7f0000",
        baselineDiffersFromTarget: false,
        baselineVerified: false,
        endedAtTarget: false,
        target: "#7f0000",
      }),
    ).toHaveLength(4);
  });
});

describe("busyShapeProblems", () => {
  /** Verbatim from the stream: what the agent actually ran, at offset 297333. */
  const AGENT_WROTE =
    "async (itx) => {\n" +
    '  const a = itx.kit.waveshare.showImage("https://placehold.co/200x200.jpg", 5);\n' +
    '  const b = itx.kit.waveshare.showImage("https://placehold.co/210x210.jpg", 5);\n' +
    "  return await Promise.allSettled([a, b]);\n" +
    "}";

  it("accepts the concurrent script the agent actually wrote", () => {
    /*
     * THE FALSE-POSITIVE GUARD, and the reason this rule is worth having: this
     * script is correct — both promises created before either is awaited — and
     * the case still failed. The overlap was real; the refusal text was lost
     * because Promise.allSettled's rejected entry carries an Error and
     * JSON.stringify(new Error("x")) is {}. A rule that blamed the shape here
     * would have sent the next person looking in the wrong place.
     */
    expect(busyShapeProblems(AGENT_WROTE)).toEqual([]);
  });

  it("rejects a serialized script, which proves nothing about concurrency", () => {
    /* The device would accept these one after another, exactly as it should, and
     * a results-only check would call that a passing overlap. */
    const serialized =
      "async (itx) => {\n" +
      '  const a = await itx.kit.waveshare.showImage("https://placehold.co/200x200.jpg", 5);\n' +
      '  const b = await itx.kit.waveshare.showImage("https://placehold.co/210x210.jpg", 5);\n' +
      "  return [a, b];\n" +
      "}";
    const problems = busyShapeProblems(serialized);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("awaits a showImage call directly");
  });

  it("rejects a script that awaits the first and only then starts the second", () => {
    /* The subtler serialization: allSettled is present, but one call was already
     * awaited, so there was never a moment with both in flight. */
    const halfSerialized =
      "async (itx) => {\n" +
      '  const a = await itx.kit.waveshare.showImage("u1", 5);\n' +
      '  const b = itx.kit.waveshare.showImage("u2", 5);\n' +
      "  return await Promise.allSettled([Promise.resolve(a), b]);\n" +
      "}";
    expect(busyShapeProblems(halfSerialized).join(" ")).toContain(
      "awaits a showImage call directly",
    );
  });

  it("rejects a single call", () => {
    expect(
      busyShapeProblems('async (itx) => itx.kit.waveshare.showImage("u1", 5)').join(" "),
    ).toContain("an overlap needs two");
  });

  it("rejects two calls that are never awaited together", () => {
    const noJoin =
      "async (itx) => {\n" +
      '  const a = itx.kit.waveshare.showImage("u1", 5);\n' +
      '  const b = itx.kit.waveshare.showImage("u2", 5);\n' +
      "  return { a: typeof a, b: typeof b };\n" +
      "}";
    expect(busyShapeProblems(noJoin).join(" ")).toContain("does not await both requests together");
  });

  it("accepts the mapped form the prompt now asks for", () => {
    /* The fix: same concurrency, but the refusal comes back as a string so it
     * survives serialisation and the agent can report it. */
    const mapped =
      "async (itx) => {\n" +
      '  const a = itx.kit.waveshare.showImage("u1", 5);\n' +
      '  const b = itx.kit.waveshare.showImage("u2", 5);\n' +
      "  const outcomes = await Promise.allSettled([a, b]);\n" +
      '  return outcomes.map((o) => o.status === "fulfilled"\n' +
      '    ? { status: "fulfilled", value: o.value }\n' +
      '    : { status: "rejected", reason: String(o.reason?.message ?? o.reason) });\n' +
      "}";
    expect(busyShapeProblems(mapped)).toEqual([]);
  });
});

describe("baselineJpegProblems", () => {
  /** Minimal bytes that satisfy each check, so each test changes one thing. */
  const soi = [0xff, 0xd8];
  const sof0 = [0xff, 0xc0, 0x00, 0x11];
  const sof2 = [0xff, 0xc2, 0x00, 0x11];

  it("accepts a small baseline JPEG", () => {
    expect(baselineJpegProblems(new Uint8Array([...soi, ...sof0, 0x00, 0x01]))).toEqual([]);
  });

  it("rejects bytes at or past the device's cap, which would answer too-large", () => {
    /*
     * THE REGRESSION. `httpbin.org/drip?duration=60&numbytes=400000` was refused
     * in 849ms as "too-large" because 400,000 is past MAX_BODY_BYTES — so the
     * timeout case was exercising the size gate and reporting a device fault.
     */
    const oversized = new Uint8Array(DEVICE_IMAGE_LIMITS.maxBodyBytes + 1);
    oversized.set(soi);
    oversized.set(sof0, 2);
    const problems = baselineJpegProblems(oversized);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("too-large");
  });

  it("rejects a progressive JPEG, which would answer unsupported-format", () => {
    const problems = baselineJpegProblems(new Uint8Array([...soi, ...sof2]));
    expect(problems.join(" ")).toContain("unsupported-format");
  });

  it("rejects bytes with no frame header at all", () => {
    expect(baselineJpegProblems(new Uint8Array([...soi, 0x01, 0x02])).join(" ")).toContain(
      "not a baseline JPEG",
    );
  });

  it("rejects something that is not a JPEG", () => {
    expect(baselineJpegProblems(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).join(" ")).toContain(
      "SOI marker",
    );
  });

  it("rejects an empty body", () => {
    expect(baselineJpegProblems(new Uint8Array())).toEqual(["the fixture image is empty"]);
  });
});

describe("agentDriveProblems", () => {
  const run = (code: string) => ({
    code,
    executionId: "agent-output:1",
    requestedAtOffset: 100,
    settledAtOffset: 106,
    settlement: { status: "failed", error: "expected 0-48 dB" },
  });
  const good = {
    error: null,
    scriptRuns: [run("async (itx) => itx.kit.waveshare.setMicGain(49)")],
    unsettled: [],
  };

  it("accepts a turn that ran the method under test", () => {
    expect(agentDriveProblems(good, ["setMicGain"])).toEqual([]);
  });

  it("names an ask that errored, instead of leaving the verdict silent", () => {
    /*
     * THE REGRESSION. `set-mic-gain-over` failed with only "agent evidence
     * contains it: false" while the stream showed its script settling with
     * exactly `expected 0-48 dB`. Reconstructing that took a hand walk over
     * stream offsets, because the verdict said nothing about the ask.
     */
    const problems = agentDriveProblems({ ...good, error: "ask timed out after 150000ms" }, [
      "setMicGain",
    ]);
    expect(problems[0]).toContain("the ask itself failed");
    expect(problems[0]).toContain("timed out");
  });

  it("rejects a turn where the agent ran nothing", () => {
    expect(agentDriveProblems({ ...good, scriptRuns: [] }, ["setMicGain"])).toEqual([
      "the agent ran no capability script at all",
    ]);
  });

  it("rejects a turn whose scripts never call the method", () => {
    /*
     * The refusal wording appears in earlier cases of the same conversation, so
     * a model answering from memory could satisfy a text-only check. Requiring
     * the call closes that.
     */
    const problems = agentDriveProblems(
      { ...good, scriptRuns: [run("async (itx) => itx.chat.sendMessage('expected 0-48 dB')")] },
      ["setMicGain"],
    );
    expect(problems[0]).toContain("none of the 1 script(s)");
  });

  it("matches a dotted method by the name that appears in code", () => {
    /* `recording.size` is written `size(` inside a script. */
    expect(
      agentDriveProblems(
        { ...good, scriptRuns: [run("async (itx) => itx.kit.waveshare.recording.size('x')")] },
        ["recording.size"],
      ),
    ).toEqual([]);
  });

  it("reports runs that never settled", () => {
    const problems = agentDriveProblems({ ...good, unsettled: ["agent-output:9"] }, ["setMicGain"]);
    expect(problems[0]).toContain("never settled: agent-output:9");
  });

  it("accepts any one of several methods a case covers", () => {
    expect(agentDriveProblems(good, ["setVolume", "setMicGain"])).toEqual([]);
  });
});

describe("boundaryEvidenceProblems", () => {
  const caught = {
    code: "async (itx) => { try { return await itx.kit.waveshare.setMicGain(49); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } }",
    executionId: "agent-output:1",
    requestedAtOffset: 100,
    settledAtOffset: 106,
    settlement: { status: "succeeded", result: { ok: false, error: "expected 0-48 dB" } },
  };
  const complete = {
    error: null,
    finalMessage: "The device refused: expected 0-48 dB",
    scriptRuns: [caught],
    unsettled: [],
  };

  it("accepts a caught rejection returned as a value and reported", () => {
    expect(boundaryEvidenceProblems(complete, "expected 0-48 dB", ["setMicGain"])).toEqual([]);
  });

  it("rejects an uncaught rejection, even though the settlement carries the text", () => {
    /*
     * THE REGRESSION, from the seventh proof run. The script at offset 319998
     * settled `{"status":"failed","error":"expected 0-48 dB"}` — the wording was
     * right there, but the script had crashed rather than handled the refusal.
     */
    const uncaught = {
      ...complete,
      scriptRuns: [
        {
          ...caught,
          code: "async (itx) => await itx.kit.waveshare.setMicGain(49)",
          settlement: { status: "failed", error: "expected 0-48 dB" },
        },
      ],
    };
    const problems = boundaryEvidenceProblems(uncaught, "expected 0-48 dB", ["setMicGain"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("let the rejection throw out of its script");
  });

  it("rejects a turn that ended without a final message", () => {
    /*
     * The other half of the same failure: that turn produced no
     * `agents/web-message-sent` at all. A device that refuses and an agent that
     * goes quiet is not a working pair.
     */
    const silent = { ...complete, finalMessage: null };
    const problems = boundaryEvidenceProblems(silent, "expected 0-48 dB", ["setMicGain"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ended without a final message");
  });

  it("rejects a final message that does not name the refusal", () => {
    const vague = { ...complete, finalMessage: "That did not work, sorry." };
    expect(boundaryEvidenceProblems(vague, "expected 0-48 dB", ["setMicGain"])[0]).toContain(
      "final message does not name",
    );
  });

  it("rejects a succeeded run whose result does not carry the message", () => {
    /* `{ok:false}` without the wording tells the next reader nothing. */
    const bare = {
      ...complete,
      scriptRuns: [{ ...caught, settlement: { status: "succeeded", result: { ok: false } } }],
    };
    expect(boundaryEvidenceProblems(bare, "expected 0-48 dB", ["setMicGain"])[0]).toContain(
      'no script the agent ran returned "expected 0-48 dB"',
    );
  });

  it("reports both halves when the turn ran nothing at all", () => {
    const nothing = { error: null, finalMessage: null, scriptRuns: [], unsettled: [] };
    const problems = boundaryEvidenceProblems(nothing, "expected 0-48 dB", ["setMicGain"]);
    expect(problems).toEqual([
      "the agent ran no capability script at all",
      'no script the agent ran returned "expected 0-48 dB" as a value it caught',
      "the agent's turn ended without a final message, so it never reported anything",
    ]);
  });

  it("still surfaces an ask that errored", () => {
    const broken = { ...complete, error: "ask timed out after 150000ms" };
    expect(boundaryEvidenceProblems(broken, "expected 0-48 dB", ["setMicGain"])[0]).toContain(
      "the ask itself failed",
    );
  });
});

describe("briefContentProblems", () => {
  /**
   * The load-bearing lines of the brief `setupVoiceAgent` installs, verbatim from
   * the deployed stream (key voice-agent/brief:0l2uva5:setup:1f5adae1-…).
   *
   * Method names alone were never the acceptance point: a model told `setMicGain`
   * exists but not that it takes 0-48 dB will guess, and a model not told that
   * push-to-talk is how you cut an answer short will reach for `interrupt`.
   */
  const DEPLOYED = [
    "METRICS: health() takes no arguments and returns ~70 live read-only numbers as one JSON object.",
    "conversation.start(), conversation.hangUp() — both safe to repeat; they record intent.",
    "There is NO interrupt or interruptPlayback method here: to cut an answer short, call",
    "pushToTalk.start(), which cancels whatever is playing and opens the microphone.",
    "pushToTalk.start(), pushToTalk.stop() — take one spoken turn; stop() commits what was said.",
    "showImage(url, seconds) — BASELINE JPEG only, full-screen for 1-30s, then the display is restored.",
    "takeScreenshot() then readScreenshotChunk(i) — reads the panel back in chunks.",
    "recording.status(), recording.size(name), recording.read(name, byteOffset) — the current call.",
    "setBackground(colour) — hex (#1e293b) or a name (navy, teal, iterate).",
    "setVolume(0-100), setMicGain(0-48 dB).",
    "restart() — reboots. Disruptive: drops any call, ~20s to come back.",
  ].join("\n");

  it("accepts the brief the deployed setup installs", () => {
    expect(briefContentProblems(DEPLOYED)).toEqual([]);
  });

  it("fails a brief that stops naming call control", () => {
    expect(
      briefContentProblems(DEPLOYED.replace("conversation.hangUp()", "hang up somehow")).join(" "),
    ).toContain("call initiate and hang-up");
  });

  it("fails a brief that drops the image display bounds", () => {
    /* "showImage exists" is not enough: 1-30s and the restore are the semantics. */
    expect(briefContentProblems(DEPLOYED.replace("1-30s", "a while")).join(" ")).toContain(
      "timed image URL display",
    );
  });

  it("fails a brief that stops pointing at health() for metrics", () => {
    expect(briefContentProblems(DEPLOYED.replace("METRICS", "Numbers")).join(" ")).toContain(
      "metrics access",
    );
  });

  it("fails a brief that loses the setter ranges", () => {
    /* Exactly the guess that produces "expected 0-48 dB" in production. */
    const vague = DEPLOYED.replace("setMicGain(0-48 dB)", "setMicGain(db)");
    expect(briefContentProblems(vague).join(" ")).toContain("device controls with their ranges");
  });

  it("fails a brief that no longer ties barge-in to push-to-talk", () => {
    const noBargeIn = DEPLOYED.replace("cut an answer short", "stop the audio");
    expect(briefContentProblems(noBargeIn).join(" ")).toContain(
      "push-to-talk as the barge-in mechanism",
    );
  });

  it("fails a brief that drops the explicit denial of interrupt", () => {
    /* The denial is required POSITIVELY: silence about a method a model would
     * otherwise invent is weaker than saying it does not exist. */
    const noDenial = DEPLOYED.replace("There is NO interrupt or interruptPlayback method here", "");
    expect(briefContentProblems(noDenial).join(" ")).toContain("explicit denial");
  });

  it("fails a brief that drops recording or screenshot entirely", () => {
    expect(briefContentProblems(DEPLOYED.replace("recording.status(), ", "")).join(" ")).toContain(
      "recording",
    );
    expect(briefContentProblems(DEPLOYED.replace("takeScreenshot()", "")).join(" ")).toContain(
      "screenshot",
    );
  });

  it("reports every missing topic at once", () => {
    expect(briefContentProblems("You are a helpful assistant.")).toHaveLength(8);
  });
});

describe("correlateTaggedTurn", () => {
  const prompt = (offset: number, tag: string) => ({
    offset,
    payload: { content: `[${tag}] Call setMicGain(49) and report the error.`, role: "user" },
    type: "events.iterate.com/agents/context-added",
  });
  const reply = (offset: number, message: string) => ({
    offset,
    payload: { message },
    type: "events.iterate.com/agents/web-message-sent",
  });

  it("finds the prompt and its single tagged reply", () => {
    const turn = correlateTaggedTurn(
      [prompt(100, "qaaaaaaaa"), reply(120, "[qaaaaaaaa] The error was: expected 0-48 dB")],
      "qaaaaaaaa",
    );
    expect(turn.problems).toEqual([]);
    expect(turn.promptOffset).toBe(100);
    expect(turn.replyOffset).toBe(120);
    expect(turn.reply).toContain("expected 0-48 dB");
  });

  it("refuses a previous question's reply that lands after this prompt", () => {
    /*
     * THE ONE-BEHIND DEFECT, verbatim from the stream at 03:59:27.996: the agent
     * sent "For the preceding setMicGain(49) test..." after the next case's
     * prompt had gone out. Accepting it made the harness judge every case using
     * its neighbour's evidence, forever one behind.
     */
    const turn = correlateTaggedTurn(
      [
        prompt(200, "qbbbbbbbb"),
        reply(210, "[qaaaaaaaa] For the preceding setMicGain(49) test, the error was 0-48 dB"),
      ],
      "qbbbbbbbb",
    );
    expect(turn.reply).toBeNull();
    expect(turn.lateOtherTags).toEqual(["qaaaaaaaa"]);
    expect(turn.problems[0]).toContain("never answered");
  });

  it("refuses a reply carrying the wrong tag even when the wording looks right", () => {
    const turn = correlateTaggedTurn(
      [prompt(300, "qcccccccc"), reply(310, "[q4444dddd] expected 0-48 dB")],
      "qcccccccc",
    );
    expect(turn.reply).toBeNull();
    expect(turn.problems).toHaveLength(1);
  });

  it("refuses an untagged reply", () => {
    /* A reply with no tag cannot be attributed to anything. */
    const turn = correlateTaggedTurn(
      [prompt(400, "qeeeeeeee"), reply(410, "expected 0-48 dB")],
      "qeeeeeeee",
    );
    expect(turn.reply).toBeNull();
    expect(turn.lateOtherTags).toEqual([]);
    expect(turn.problems[0]).toContain("no completed reply carried");
  });

  it("refuses a duplicated or replayed reply", () => {
    const turn = correlateTaggedTurn(
      [
        prompt(500, "qffffffff"),
        reply(510, "[qffffffff] expected 0-48 dB"),
        reply(520, "[qffffffff] expected 0-48 dB"),
      ],
      "qffffffff",
    );
    expect(turn.reply).toBeNull();
    expect(turn.problems[0]).toContain("2 replies carried");
    expect(turn.problems[0]).toContain("duplicated or replayed");
  });

  it("ignores a reply that arrived before this question was asked", () => {
    /* Out of order: the same tag cannot have been answered before it was sent, so
     * an earlier message carrying it is not this turn's answer. */
    const turn = correlateTaggedTurn(
      [
        reply(600, "[qgggggggg] a reply from before the prompt"),
        prompt(610, "qgggggggg"),
        reply(620, "[qgggggggg] expected 0-48 dB"),
      ],
      "qgggggggg",
    );
    /* The prompt anchors at the FIRST event carrying the tag, so an out-of-order
     * duplicate is visible as a duplicate rather than silently chosen. */
    expect(turn.problems.length).toBeGreaterThan(0);
  });

  it("fails boundedly when the prompt never reached the stream", () => {
    expect(correlateTaggedTurn([], "qhhhhhhhh").problems[0]).toContain("never reached the stream");
  });

  it("picks its own reply out of a conversation full of other traffic", () => {
    /* Tags are hex, as `crypto.randomUUID().slice(0, 8)` produces them. */
    const turn = correlateTaggedTurn(
      [
        reply(700, "[q1111aaaa] an older answer"),
        prompt(710, "q2222bbbb"),
        reply(715, "[q1111aaaa] a late older answer"),
        {
          offset: 716,
          payload: { activity: "working" },
          type: "events.iterate.com/agent/summary-updated",
        },
        reply(720, "[q2222bbbb] expected 0-48 dB"),
        reply(730, "[q3333cccc] a newer question's answer"),
      ],
      "q2222bbbb",
    );
    expect(turn.problems).toEqual([]);
    expect(turn.replyOffset).toBe(720);
    expect(turn.lateOtherTags.sort()).toEqual(["q1111aaaa", "q3333cccc"]);
  });
});

describe("agentDriveProblems: the absence case", () => {
  /*
   * The negative control asks the agent to call a method the device does NOT
   * have, so the call it must be seen making is not one of the fifteen it
   * reports coverage for. Passing the human label "(none — asserts absence)" as
   * the thing to look for searched the scripts for `absence)(` and failed the
   * case on a harness artefact while the device answered correctly.
   */
  const attempt = {
    code: "async (itx) => { try { return await itx.kit.waveshare.interruptPlayback(); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } }",
    executionId: "agent-output:1",
    requestedAtOffset: 10,
    settledAtOffset: 16,
    settlement: { status: "succeeded", result: { ok: false, error: "unknown device capability" } },
  };

  it("accepts a script that attempts the absent method", () => {
    expect(
      agentDriveProblems({ error: null, scriptRuns: [attempt], unsettled: [] }, [
        "interruptPlayback",
      ]),
    ).toEqual([]);
  });

  it("never matches when handed a human label instead of a call", () => {
    /* The regression: a label can never appear in code as `label(`. */
    expect(
      agentDriveProblems({ error: null, scriptRuns: [attempt], unsettled: [] }, [
        "(none — asserts absence)",
      ]),
    ).toHaveLength(1);
  });

  it("rejects a substituted call, which is what the prompt forbids", () => {
    /* The prompt says "do not substitute another method and do not call
     * pushToTalk" — an agent that reaches for the working alternative has not
     * shown that the absent one is absent. */
    const substituted = {
      ...attempt,
      code: "async (itx) => itx.kit.waveshare.pushToTalk.start()",
    };
    expect(
      agentDriveProblems({ error: null, scriptRuns: [substituted], unsettled: [] }, [
        "interruptPlayback",
      ])[0],
    ).toContain("none of the 1 script(s)");
  });
});
