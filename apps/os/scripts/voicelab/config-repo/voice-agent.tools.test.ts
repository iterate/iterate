// The direct tools: what a board is offered, and what happens when it is used.
//
// The whole design of DIRECT_TOOLS is that nothing here names a board. What a
// call is offered is DERIVED from the mount `instructions` the device itself
// publishes — the string each `*_device.c` hands to `provideCapability`, which
// is also the string the prompt quotes. So the tests below feed the real
// strings from the four boards in this repo and assert the outcome, because
// "a board with no servos is never offered a nod" is a claim that is true right
// up until somebody edits the table.
import { describe, expect, it } from "vitest";

import {
  advertisesMethod,
  capabilityBrief,
  directToolDefinitions,
  directToolsFor,
  DIRECT_TOOLS,
  hangUpIsDue,
  HEAD_GESTURES,
  playoutRemainingMs,
  type DirectToolCall,
  type ProvidedCapabilities,
} from "./voice-agent.ts";

/*
 * VERBATIM from apps/kit/firmware/devices/<board>/<board>_device.c, the
 * `static const char instructions[]` that each board assigns to
 * `options.instructions` — NOT `peer_description`, which the capability host
 * never reads (see the note at that assignment in waveshare_device.c).
 */
const BOARD_INSTRUCTIONS = {
  havpe:
    "Home Assistant Voice Preview Edition voice endpoint. Hold the physical " +
    "center button for push-to-talk; a short tap starts and ends the call; " +
    "audio and lifecycle events share this stream connection.",
  m5sticks3:
    "M5StickS3 voice endpoint. Hold the physical front button for " +
    "push-to-talk; the side button starts and ends the call; audio and " +
    "lifecycle events share this stream connection.",
  stackchan:
    "StackChan voice robot. Touching its screen starts and ends the call; " +
    "the microphone stays open during a call (it cancels its own speaker). " +
    "servos.move({yawDegrees,pitchDegrees,speed}) turns its head; audio and " +
    "lifecycle events share this stream connection.",
  waveshare:
    "Waveshare voice endpoint. Use the physical upper button for " +
    "push-to-talk; audio and lifecycle events share this stream connection.",
} as const;

/** One board mounted, the way the capability inventory reports it. */
function mounted(board: keyof typeof BOARD_INSTRUCTIONS): ProvidedCapabilities {
  return { live: [{ path: ["kit", board], instructions: BOARD_INSTRUCTIONS[board] }] };
}

/** The tools a set of mounts earns, by name. */
function toolNames(provided: ProvidedCapabilities): string[] {
  return directToolsFor(provided).map(({ tool }) => tool.name);
}

/** A DirectToolCall that records instead of doing. */
function recorder(args: Record<string, unknown> = {}) {
  const calls: { method: string; argument?: unknown }[] = [];
  const gestures: (readonly { yawDegrees: number; pitchDegrees: number; speed: number }[])[] = [];
  const hangUps: string[] = [];
  const call: DirectToolCall = {
    args,
    device: (method, argument) => calls.push({ method, argument }),
    gesture: (steps) => gestures.push(steps),
    hangUp: (reason) => hangUps.push(reason),
  };
  return { call, calls, gestures, hangUps };
}

describe("advertisesMethod", () => {
  it("reads a method out of the device's own mount instructions", () => {
    expect(advertisesMethod(BOARD_INSTRUCTIONS.stackchan, "servos.move")).toBe(true);
    expect(advertisesMethod(BOARD_INSTRUCTIONS.waveshare, "servos.move")).toBe(false);
  });

  it("requires the open bracket, so prose about a thing is not the thing", () => {
    /* Every method is written as a call — `health()`, `servos.move({…})` — and
     * a board that merely mentions servos in a sentence has not said it has one. */
    expect(advertisesMethod("this robot has servos.move somewhere", "servos.move")).toBe(false);
    expect(
      advertisesMethod("servos.move({yawDegrees,pitchDegrees,speed}) turns", "servos.move"),
    ).toBe(true);
    expect(advertisesMethod("servos.move ({a})", "servos.move")).toBe(true);
  });

  it("will not let a longer name satisfy a shorter one", () => {
    /* `speaker.volume(` must not answer a need for `volume(`, and
     * `face.setBrightness(` must not answer a need for `face.set`. */
    expect(advertisesMethod("speaker.volume() returns it", "volume")).toBe(false);
    expect(advertisesMethod("face.setBrightness({level})", "face.set")).toBe(false);
    expect(advertisesMethod("face.set({expression})", "face.set")).toBe(true);
  });

  it("matches at the very start of the string", () => {
    expect(advertisesMethod("health() and nothing else", "health")).toBe(true);
  });
});

describe("directToolsFor", () => {
  it("gives StackChan the head gestures, because StackChan advertises servos", () => {
    expect(toolNames(mounted("stackchan"))).toEqual(["hang_up", "nod", "shake_head"]);
  });

  it("gives the three screenless-or-servoless boards hang_up and nothing else", () => {
    /* The whole point of deriving: none of these advertises a servo, so none of
     * them is handed a nod tool it would call into a TypeError. */
    for (const board of ["havpe", "m5sticks3", "waveshare"] as const) {
      expect(toolNames(mounted(board))).toEqual(["hang_up"]);
    }
  });

  it("offers set_face to nobody, because no board advertises face.set yet", () => {
    /* Firmware has the whole mechanism — face_stage_apply_held_expression takes
     * eleven expressions and only the doze animation has ever used one — but no
     * dispatch entry and no mention in any `instructions[]`. The day both exist
     * this passes for that board and this test changes; until then, offering the
     * tool would be offering a call that answers "unknown device capability". */
    const everyBoard: ProvidedCapabilities = {
      live: Object.entries(BOARD_INSTRUCTIONS).map(([board, instructions]) => ({
        path: ["kit", board],
        instructions,
      })),
    };
    expect(toolNames(everyBoard)).not.toContain("set_face");
  });

  it("lights set_face up the moment a board says it has one, with no edit here", () => {
    const withAFace: ProvidedCapabilities = {
      live: [
        {
          path: ["kit", "stackchan"],
          instructions: `${BOARD_INSTRUCTIONS.stackchan} face.set({expression}) changes its face.`,
        },
      ],
    };
    const derived = directToolsFor(withAFace);
    expect(derived.map(({ tool }) => tool.name)).toEqual([
      "hang_up",
      "nod",
      "shake_head",
      "set_face",
    ]);
    /* …and bound to the mount that earned it, not to a guess. */
    expect(derived.find(({ tool }) => tool.name === "set_face")?.mountPath).toEqual([
      "kit",
      "stackchan",
    ]);
  });

  it("keeps hang_up when nothing is mounted at all", () => {
    /* Ending a call is a property of the CALL. A bridge with no device — a
     * script, a `mode=bridge` host — can still be hung up. */
    const nothing = directToolsFor({ live: [] });
    expect(nothing.map(({ tool }) => tool.name)).toEqual(["hang_up"]);
    expect(nothing[0]?.mountPath).toBeNull();
  });

  it("keeps hang_up when the capability read failed outright", () => {
    expect(toolNames({ live: [], error: "itx unavailable" })).toEqual(["hang_up"]);
  });

  it("binds a device tool to the mount that advertised it", () => {
    const derived = directToolsFor(mounted("stackchan"));
    expect(derived.find(({ tool }) => tool.name === "nod")?.mountPath).toEqual([
      "kit",
      "stackchan",
    ]);
    expect(derived.find(({ tool }) => tool.name === "hang_up")?.mountPath).toBeNull();
  });

  it("binds to the FIRST advertising mount when two boards are mounted", () => {
    /* A call runs on one stream with one device on it and a capability
     * inventory does not say which, so two robots on one project get one nod
     * tool aimed at the first — never two tools with the same name. */
    const twoRobots: ProvidedCapabilities = {
      live: [
        { path: ["kit", "stackchanA"], instructions: BOARD_INSTRUCTIONS.stackchan },
        { path: ["kit", "stackchanB"], instructions: BOARD_INSTRUCTIONS.stackchan },
      ],
    };
    const nods = directToolsFor(twoRobots).filter(({ tool }) => tool.name === "nod");
    expect(nods).toHaveLength(1);
    expect(nods[0]?.mountPath).toEqual(["kit", "stackchanA"]);
  });

  it("ignores a mount whose instructions are empty", () => {
    expect(toolNames({ live: [{ path: ["kit", "mute"], instructions: "" }] })).toEqual(["hang_up"]);
  });
});

describe("the table itself", () => {
  it("gives every tool a unique name, since the model picks by name", () => {
    const names = DIRECT_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool, because the description is the only explanation", () => {
    for (const tool of DIRECT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.parameters.type).toBe("object");
    }
  });

  it("carries the derived tools straight into the provider's tools array", () => {
    const definitions = directToolDefinitions(directToolsFor(mounted("stackchan")));
    expect(definitions.map((entry) => entry.name)).toEqual(["hang_up", "nod", "shake_head"]);
    expect(definitions.every((entry) => entry.type === "function")).toBe(true);
    /* The mount is the bridge's business, not the model's. */
    expect(JSON.stringify(definitions)).not.toContain("kit");
  });
});

describe("running a direct tool", () => {
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const tool = DIRECT_TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`no tool named ${name}`);
    const recorded = recorder(args);
    return { ...recorded, told: tool.run(recorded.call) };
  };

  it("hang_up asks to hang up and touches no device", () => {
    const { calls, gestures, hangUps, told } = run("hang_up");
    expect(hangUps).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(gestures).toEqual([]);
    /* What comes back is read by the model, so it has to say what happens next:
     * the call ends when it stops talking, not when it called this. */
    expect(told).toContain("stop talking");
  });

  it("nod and shake_head issue the gesture and nothing else", () => {
    const nod = run("nod");
    expect(nod.gestures).toEqual([HEAD_GESTURES.nod]);
    expect(nod.calls).toEqual([]);
    expect(nod.hangUps).toEqual([]);

    const shake = run("shake_head");
    expect(shake.gestures).toEqual([HEAD_GESTURES.shake]);
  });

  it("set_face passes a known expression through to the device", () => {
    const { calls, told } = run("set_face", { expression: "thoughtful" });
    expect(calls).toEqual([{ method: "face.set", argument: { expression: "thoughtful" } }]);
    expect(told).toContain("thoughtful");
  });

  it("set_face refuses an expression the firmware does not have", () => {
    /* The model invents enum values. Passing one through would reach the device
     * as a call it cannot answer, and the model would never learn why. */
    const { calls, told } = run("set_face", { expression: "smug" });
    expect(calls).toEqual([]);
    expect(told).toContain("no expression called");
    expect(told).toContain("thoughtful");
  });

  it("set_face survives being called with no arguments at all", () => {
    const { calls, told } = run("set_face");
    expect(calls).toEqual([]);
    expect(told).toContain("no expression called");
  });
});

describe("HEAD_GESTURES", () => {
  it("stays inside the servo envelope the firmware enforces", () => {
    /* stackchan_body.c rejects the whole move outside these, so one bad step
     * would be a gesture that silently does nothing from that step on. */
    for (const steps of Object.values(HEAD_GESTURES)) {
      for (const step of steps) {
        expect(step.yawDegrees).toBeGreaterThanOrEqual(-128);
        expect(step.yawDegrees).toBeLessThanOrEqual(128);
        expect(step.pitchDegrees).toBeGreaterThanOrEqual(0);
        expect(step.pitchDegrees).toBeLessThanOrEqual(90);
        expect(step.speed).toBeGreaterThan(0);
        expect(step.speed).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("ends every gesture back at home", () => {
    /* Nothing else in the firmware ever moves the head — this capability is the
     * only caller of move_head — so a gesture that stops short leaves the robot
     * looking at the wall until somebody nods again. */
    for (const steps of Object.values(HEAD_GESTURES)) {
      expect(steps.at(-1)).toMatchObject({ yawDegrees: 0, pitchDegrees: 0 });
    }
  });

  it("moves the axis the gesture is named after, and only that one", () => {
    expect(HEAD_GESTURES.nod.some((step) => step.pitchDegrees !== 0)).toBe(true);
    expect(HEAD_GESTURES.nod.every((step) => step.yawDegrees === 0)).toBe(true);
    expect(HEAD_GESTURES.shake.some((step) => step.yawDegrees !== 0)).toBe(true);
    expect(HEAD_GESTURES.shake.every((step) => step.pitchDegrees === 0)).toBe(true);
  });

  it("goes both ways, or it is a lean rather than a shake", () => {
    expect(HEAD_GESTURES.shake.some((step) => step.yawDegrees < 0)).toBe(true);
    expect(HEAD_GESTURES.shake.some((step) => step.yawDegrees > 0)).toBe(true);
  });
});

describe("playoutRemainingMs", () => {
  /*
   * THE MEASUREMENT THAT STOPS A GOODBYE BEING CUT IN HALF. `conversation-ended`
   * reaching a device runs abandon_speaker_audio(), and frames leave this bridge
   * far faster than the device plays them, so at the moment an answer finishes
   * generating the device may still be holding nearly all of it.
   */
  it("counts what has been sent but not yet played", () => {
    /* 100 frames is 2s of speech; 500ms in, 1.5s is still to come. */
    expect(playoutRemainingMs({ frames: 100, firstFrameAtMs: 1_000 }, 1_500)).toBe(1_500);
  });

  it("is zero once the audio has had time to play", () => {
    expect(playoutRemainingMs({ frames: 100, firstFrameAtMs: 1_000 }, 9_000)).toBe(0);
  });

  it("is zero for an answer that never made a sound", () => {
    /* The model called hang_up without speaking: nothing is owed to the ring. */
    expect(playoutRemainingMs({ frames: 0, firstFrameAtMs: 0 }, 5_000)).toBe(0);
    expect(playoutRemainingMs({ frames: 12, firstFrameAtMs: 0 }, 5_000)).toBe(0);
  });

  it("never waits longer than the device's ring can hold", () => {
    /* A 90s answer is 4500 frames. The device rings 30s, so anything it is
     * still holding is inside that — a longer wait would be arithmetic that has
     * gone wrong, not a very long goodbye. */
    expect(playoutRemainingMs({ frames: 4_500, firstFrameAtMs: 1_000 }, 1_000)).toBe(30_000);
  });
});

describe("hangUpIsDue", () => {
  /*
   * THE BUG THIS ENCODES. The settle was edge-triggered from `response.done`
   * alone, while four separate places free the floor — and `response.done`
   * called `takeTheFloorIfFree()` first, which takes it back. Measured on the
   * StackChan: hang_up fired, the model said "Goodbye!", callActive stayed
   * true. So the deadline is not belt-and-braces; it is the guarantee.
   */
  const asked = { askedAtMs: 10_000 };

  it("is not due when nothing asked for it", () => {
    expect(hangUpIsDue(null, false, 10_000)).toBe(false);
    expect(hangUpIsDue(null, true, 999_999)).toBe(false);
  });

  it("is due as soon as the floor is free", () => {
    expect(hangUpIsDue(asked, false, 10_050)).toBe(true);
  });

  it("waits while an answer is still being generated", () => {
    expect(hangUpIsDue(asked, true, 10_050)).toBe(false);
  });

  it("happens anyway once the deadline passes, floor or no floor", () => {
    expect(hangUpIsDue(asked, true, 10_000 + 14_999)).toBe(false);
    expect(hangUpIsDue(asked, true, 10_000 + 15_000)).toBe(true);
  });
});

describe("capabilityBrief", () => {
  it("quotes the device rather than restating it", () => {
    const brief = capabilityBrief(mounted("stackchan"));
    expect(brief).toContain("itx.kit.stackchan");
    expect(brief).toContain(BOARD_INSTRUCTIONS.stackchan);
  });

  it("tells the thinking half what the voice half can already do without it", () => {
    /* Derived from the same table, so the two halves cannot come to disagree
     * about whether the voice needs help hanging up. */
    const brief = capabilityBrief(mounted("stackchan"));
    expect(brief).toContain("hang_up");
    expect(brief).toContain("nod");
    expect(brief).toContain("shake_head");

    const plain = capabilityBrief(mounted("waveshare"));
    expect(plain).toContain("hang_up");
    expect(plain).not.toContain("shake_head");
  });

  it("says no device is connected rather than claiming one is", () => {
    const brief = capabilityBrief({ live: [] });
    expect(brief).toContain("No device is mounted");
    /* Still true, and still worth saying: the call can be ended. */
    expect(brief).toContain("hang_up");
  });

  it("reports a failed read as a gap, never as an absence of hardware", () => {
    const brief = capabilityBrief({ live: [], error: "itx unavailable" });
    expect(brief).toContain("could not be read");
    expect(brief).toContain("itx unavailable");
    expect(brief).not.toContain("No device is mounted");
  });
});
