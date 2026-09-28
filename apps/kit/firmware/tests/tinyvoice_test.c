/*
 * The board's synthesizer speaks a phoneme script, sings it on the tune's
 * notes, and refuses a script it cannot say rather than saying half of it.
 */

#include "iterate/kit/tinyvoice.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) test_assert((expression), #expression, __FILE__, __LINE__)

static struct iterate_kit_tinyvoice voice;
static int16_t pcm[ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ * 8];

static size_t render(const char *script, enum iterate_kit_tinyvoice_tune tune) {
  const size_t samples = iterate_kit_tinyvoice_prepare(&voice, script, tune);
  assert(samples <= sizeof(pcm) / sizeof(pcm[0]));
  if (samples != 0U) iterate_kit_tinyvoice_render(&voice, pcm);
  return samples;
}

static int peak(const int16_t *samples, size_t count) {
  int loudest = 0;
  for (size_t i = 0; i < count; i++) loudest = abs(samples[i]) > loudest ? abs(samples[i]) : loudest;
  return loudest;
}

/*
 * The pitch in 60-400 Hz by YIN (de Cheveigné and Kawahara, JASA 111, 2002):
 * the first lag whose normalised difference dips below 0.15. Plain
 * autocorrelation picks the octave above on a low buzzy vowel.
 */
static float pitch_hz(const int16_t *samples, size_t count) {
  enum { MIN_LAG = ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ / 400, MAX_LAG = ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ / 60 };
  double running = 0;
  for (size_t lag = 1; lag <= MAX_LAG; lag++) {
    double difference = 0;
    for (size_t i = 0; i + lag < count; i++) {
      const double delta = (double)samples[i] - samples[i + lag];
      difference += delta * delta;
    }
    running += difference;
    if (lag >= MIN_LAG && difference * (double)lag / running < 0.15) {
      return (float)ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ / (float)lag;
    }
  }
  return 0.0f;
}

static void speaks_a_script_the_same_way_every_time(void) {
  const size_t samples = render("r eh1 d iy .", ITERATE_KIT_TINYVOICE_SPOKEN);
  /* "Ready." is a bit under a second, and audible. */
  assert(samples > ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ * 7 / 10);
  assert(samples < ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ);
  assert(peak(pcm, samples) > 4000);
  static int16_t first[sizeof(pcm) / sizeof(pcm[0])];
  memcpy(first, pcm, samples * sizeof(pcm[0]));
  assert(render("r eh1 d iy .", ITERATE_KIT_TINYVOICE_SPOKEN) == samples);
  assert(memcmp(first, pcm, samples * sizeof(pcm[0])) == 0);
}

static void sings_each_vowel_on_the_next_note(void) {
  /* One long vowel is one note: Greensleeves opens on A, sung down in C minor as C3. */
  const size_t samples = render("aa1 .", ITERATE_KIT_TINYVOICE_GREENSLEEVES);
  const float hz = pitch_hz(pcm + samples / 3, samples / 3);
  assert(fabsf(hz - 130.8f) < 130.8f * 0.03f);
  /* Daisy Bell opens on G5, sung two octaves down as G3. */
  const size_t daisy = render("aa1 .", ITERATE_KIT_TINYVOICE_DAISY_BELL);
  assert(fabsf(pitch_hz(pcm + daisy / 3, daisy / 3) - 196.0f) < 196.0f * 0.03f);
}

static void singing_keeps_the_tunes_time_through_full_stops(void) {
  const size_t with_stop = render("d ey1 z iy , d ey1 z iy .", ITERATE_KIT_TINYVOICE_DAISY_BELL);
  const size_t without = render("d ey1 z iy d ey1 z iy", ITERATE_KIT_TINYVOICE_DAISY_BELL);
  assert(with_stop == without);
  /* Speaking, the comma is a pause. */
  assert(render("d ey1 z iy , d ey1 z iy .", ITERATE_KIT_TINYVOICE_SPOKEN) >
         render("d ey1 z iy d ey1 z iy .", ITERATE_KIT_TINYVOICE_SPOKEN));
}

static void every_tune_sings(void) {
  for (int tune = ITERATE_KIT_TINYVOICE_SPOKEN; tune <= ITERATE_KIT_TINYVOICE_LASS_OF_AUGHRIM; tune++) {
    const size_t samples = render("hh ax l ow1 .", (enum iterate_kit_tinyvoice_tune)tune);
    assert(samples > 0U);
    assert(peak(pcm, samples) > 4000);
  }
}

static void refuses_what_it_cannot_say(void) {
  assert(render("hh ax l ow1 xx .", ITERATE_KIT_TINYVOICE_SPOKEN) == 0U);
  assert(render("hh ax l ow1 .", (enum iterate_kit_tinyvoice_tune)99) == 0U);
  char too_long[ITERATE_KIT_TINYVOICE_MAX_TOKENS * 3 + 8] = "";
  for (int i = 0; i <= ITERATE_KIT_TINYVOICE_MAX_TOKENS; i++) strcat(too_long, "ah ");
  assert(render(too_long, ITERATE_KIT_TINYVOICE_SPOKEN) == 0U);
}

int main(void) {
  speaks_a_script_the_same_way_every_time();
  sings_each_vowel_on_the_next_note();
  singing_keeps_the_tunes_time_through_full_stops();
  every_tune_sings();
  refuses_what_it_cannot_say();
  return 0;
}
