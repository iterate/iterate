#ifndef ITERATE_KIT_CLI_SCREEN_H
#define ITERATE_KIT_CLI_SCREEN_H

/*
 * cli_screen: the whole session, in one place, redrawn when it changes.
 *
 * ORIGINATING FAILURE. Everything this target knew about itself was a line on
 * stderr, and the lines were the only interface. A person holding the space
 * bar could not tell whether the transport was up, whether a call existed,
 * whether the key was even registering, or whether the silence they were
 * hearing meant the agent had not answered or that nothing had been sent. The
 * facts were all present and all scrolling past at a hundred lines a minute,
 * which is the same as absent.
 *
 * ONE STRUCT, DRAWN. The caller fills a `cli_screen_state` from whatever it
 * already has — server-side facts it learned over the stream, client-side
 * facts only it knows, like whether a key is down — and calls draw. There is
 * no incremental update path and no widget owning a corner of the terminal:
 * the frame is rebuilt from the state every time, and written only when the
 * bytes differ from what is already on screen. A screen that can only be
 * wrong in the same way the state is wrong needs no reconciliation.
 *
 * THE LOG IS INSIDE THE FRAME. Diagnostics cannot be left to scroll behind a
 * redrawing frame — they would tear it — so the tail of them is drawn as part
 * of it. `cli_screen_note` is what the process-wide logger calls once a screen
 * is active; the ring keeps the last few lines and forgets the rest, which is
 * all anybody reads while a session is running anyway. The full log is still
 * on stderr for every run that has no screen.
 *
 * OFF BY DEFAULT. Scripted runs, recordings and the fault harnesses are read
 * by other programs, and those parse the line log. The screen is enabled only
 * for an interactive push-to-talk session on a terminal.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /** Lines of log kept under the frame. Enough to see a state change land. */
  CLI_SCREEN_LOG_LINES = 8,
  CLI_SCREEN_LINE_BYTES = 160,
  /** The whole frame, built before any of it is written. */
  CLI_SCREEN_FRAME_BYTES = 4096,
};

/**
 * Everything the frame shows, gathered by the caller for one draw.
 *
 * TWO KINDS OF FACT, DELIBERATELY MIXED. Some of this is what the server last
 * told us and some is only true on this machine — whether the space bar is
 * down right now cannot be learned from a stream, and how long ago the
 * provider accepted a call cannot be learned from a keyboard. A person
 * debugging a dead press needs both on the same line of sight, which is the
 * reason this is one struct and not two.
 */
struct cli_screen_state {
  /** Which stream this session is talking to; drawn in the heading. */
  const char *stream_path;
  /** Since the process started. */
  uint64_t elapsed_ms;

  /*
   * THE TWO CONNECTIVITY TIMESTAMPS, and they are timestamps rather than
   * flags because "connected" and "connected four minutes ago and nothing
   * since" are different situations that a boolean draws identically.
   */
  /** Cap'n Web reached /api and the stream mounted. 0 means never. */
  uint64_t api_connected_at_ms;
  /** The server reported a provider call established. 0 means none now. */
  uint64_t call_established_at_ms;
  /** A call has been asked for and not yet confirmed. */
  bool call_pending;
  /** Transport state name, for the case where neither light is green. */
  const char *transport_state;

  /** The space bar, right now. Known only here. */
  bool space_held;
  /** A turn is open and capture is being sent. */
  bool talking;
  /** The key came up and the tail of the turn is still going out. */
  bool flushing;

  uint32_t mic_captured;
  /** Frames waiting for a link that cannot take them yet. */
  uint32_t mic_held;
  uint32_t mic_sent;
  /** Frames the capture ring discarded because nobody drained it. */
  uint32_t mic_lost;

  uint32_t spk_received;
  uint32_t spk_played;
  uint32_t spk_ring_ms;
  uint32_t spk_conceal;
  uint32_t spk_underruns;
  /*
   * Frames the room never got because the speaker ring was full.
   *
   * ON THE FRAME BECAUSE IT IS AUDIBLE. Everything else on this line is a
   * shortfall a listener hears as a gap; this one they hear as a cut, and it
   * was the only one of the five with nowhere to be seen while somebody was
   * reporting clipping.
   */
  uint32_t spk_dropped;
  /*
   * Output buffers the converter had nothing to fill — silence a listener
   * HEARD, as distinct from every other counter here.
   *
   * Missing from the first cut of this frame, and its absence cost a
   * diagnosis: somebody reported choppy audio, `drop` read 0, the recording of
   * what we wrote to playback was clean, and the one number that would have
   * said "the output ring ran dry" was not on screen.
   */
  uint32_t spk_starved;
  /*
   * Frames the playback clock SKIPPED to recover lateness.
   *
   * The third wrong instrument in a row, and the reason it is here: `drop`
   * counts frames the ring never accepted and `starve` counts holes the
   * listener heard, but a frame discarded BETWEEN them — accepted into the
   * ring, then thrown away by the catch-up rule instead of being played —
   * shows up in neither. It is a hole in the answer with a full ring behind
   * it, which is precisely the state that was measured: ring 1840ms, starve
   * 165, drop 0.
   */
  uint32_t spk_catchup;

  /*
   * The last completed turn, broken at the two seams a person can act on:
   * how long this machine took to commit after the key came up, and how long
   * everything past it took to answer. Zero means no turn has finished.
   */
  uint32_t turn_release_to_commit_ms;
  uint32_t turn_commit_to_audio_ms;

  uint32_t outbox_used;
  uint32_t outbox_slots;
  uint32_t loops;
};

/** Caller-owned; zero-initialised is a valid disabled screen. */
struct cli_screen {
  bool enabled;
  /** Ring of recent log lines, oldest first once it has wrapped. */
  char log[CLI_SCREEN_LOG_LINES][CLI_SCREEN_LINE_BYTES];
  size_t log_write;
  size_t log_used;
  /** The bytes currently on the terminal, so an unchanged frame costs nothing. */
  char drawn[CLI_SCREEN_FRAME_BYTES];
  size_t drawn_length;
};

/**
 * Turn the screen on for this process, or off.
 *
 * PROCESS-WIDE ON PURPOSE. The logger that feeds it is a free function with no
 * handle to anything, and threading one through every call site would be a
 * large change to prove a small one. Enabling twice is a caller error and the
 * second wins; there is exactly one terminal.
 */
void cli_screen_enable(struct cli_screen *screen, bool enabled);

/** The screen currently drawing, or NULL. Used by the logger. */
struct cli_screen *cli_screen_active(void);

/** Record one diagnostic line for the log tail. Truncates rather than wraps. */
void cli_screen_note(struct cli_screen *screen, const char *level, const char *text);

/** Rebuild the frame and write it if it differs from what is on screen. */
void cli_screen_draw(struct cli_screen *screen, const struct cli_screen_state *state);

/** Leave the terminal usable: show the cursor and move below the frame. */
void cli_screen_finish(struct cli_screen *screen);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_CLI_SCREEN_H */
