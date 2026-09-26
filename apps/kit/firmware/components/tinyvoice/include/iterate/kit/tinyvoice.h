#ifndef ITERATE_KIT_TINYVOICE_H
#define ITERATE_KIT_TINYVOICE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * A small formant speech synthesizer: the board's own voice, for the few
 * things it says before (or without) the conversation.
 *
 * A glottal buzz at the voice's pitch and a noise source pass through five
 * resonators whose frequencies move from phoneme to phoneme — the cascade /
 * parallel design of Klatt, "Software for a cascade/parallel formant
 * synthesizer" (JASA 67, 1980), cut down to one parallel branch and no nasal
 * zero. It reads a hand-written phoneme script, not English: every phrase a
 * board says is written out in advance (iterate/kit/announcer.h).
 *
 * Script syntax: space-separated ARPAbet phonemes (`iy ih eh ae aa ao ah ax uh
 * uw er ey ay ow aw oy w y r l m n ng f v th dh s z sh zh hh p b t d k g ch
 * jh`); a trailing 1 or 2 on a vowel marks main or secondary stress; `,` is a
 * short pause and `.` ends a sentence (the pitch falls). "Connecting to
 * Wi-Fi." is `k ax n eh1 k t ih ng t uw w ay1 f ay2 .`.
 *
 * It can also sing: with a tune, each vowel takes the tune's next note, the
 * note's length sets the syllable's timing, pauses are dropped so the tune
 * keeps time, and the pitch gets a slight vibrato.
 *
 * Output is 16 kHz mono PCM16. Rendering is deterministic: the same script and
 * tune give the same samples on every call.
 */

enum {
  ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ = 16000,
  /** Phonemes and pauses in one script. The longest announcement uses 44. */
  ITERATE_KIT_TINYVOICE_MAX_TOKENS = 96,
  ITERATE_KIT_TINYVOICE_MAX_TARGETS = 4 * ITERATE_KIT_TINYVOICE_MAX_TOKENS,
  ITERATE_KIT_TINYVOICE_PARAMETER_COUNT = 12,
};

/** How a script is voiced. The tunes are traditional and public domain. */
enum iterate_kit_tinyvoice_tune {
  ITERATE_KIT_TINYVOICE_SPOKEN = 0,
  ITERATE_KIT_TINYVOICE_GREENSLEEVES,
  ITERATE_KIT_TINYVOICE_DAISY_BELL,
  ITERATE_KIT_TINYVOICE_AULD_LANG_SYNE,
  ITERATE_KIT_TINYVOICE_LASS_OF_AUGHRIM,
};

struct iterate_kit_tinyvoice_phoneme;

/** One parsed script token: a phoneme, or a pause when `phoneme` is NULL. */
struct iterate_kit_tinyvoice_token {
  const struct iterate_kit_tinyvoice_phoneme *phoneme;
  uint16_t pause_ms;
  uint8_t stress;
  bool sentence_final;
};

/** Synthesis parameters held from `start_frame` until the next target. */
struct iterate_kit_tinyvoice_target {
  float parameters[ITERATE_KIT_TINYVOICE_PARAMETER_COUNT];
  uint32_t start_frame;
};

/**
 * The whole synthesizer between prepare and render, about 22 KB. Caller-owned
 * so a board can keep it out of internal RAM; no hidden state anywhere else.
 */
struct iterate_kit_tinyvoice {
  enum iterate_kit_tinyvoice_tune tune;
  size_t token_count;
  size_t target_count;
  uint32_t frame_count;
  struct iterate_kit_tinyvoice_token tokens[ITERATE_KIT_TINYVOICE_MAX_TOKENS];
  struct iterate_kit_tinyvoice_target targets[ITERATE_KIT_TINYVOICE_MAX_TARGETS];
};

/**
 * Parse `script` and lay out its timeline for `tune`.
 *
 * Returns the number of samples `iterate_kit_tinyvoice_render` will write, or
 * 0 when the script names an unknown phoneme, has more than
 * ITERATE_KIT_TINYVOICE_MAX_TOKENS tokens, or the tune is unknown.
 */
size_t iterate_kit_tinyvoice_prepare(
    struct iterate_kit_tinyvoice *voice,
    const char *script,
    enum iterate_kit_tinyvoice_tune tune);

/** Write exactly the prepared number of samples to `out`. */
void iterate_kit_tinyvoice_render(
    const struct iterate_kit_tinyvoice *voice, int16_t *out);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_TINYVOICE_H */
