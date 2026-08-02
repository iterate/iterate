/*
 * Is the shared mu-law codec innocent?
 *
 * The device sounds like a mess; the macOS target, running the same C over
 * the same wire format, sounds fine. mulaw_expand is on the downlink path of
 * both, so either it is broken for both — impossible, one of them sounds
 * fine — or it is not the fault. That is worth ten lines of proof rather than
 * an afternoon of listening, and until now the codec had no test at all.
 *
 * Both functions are deliberately static: they are an implementation detail
 * of the voicelab wire format and nothing outside that file may reach for
 * them. So this test includes the translation unit rather than widening the
 * interface to suit a test — the alternative, a public mulaw.h, would invite
 * exactly the second copy of the codec this test exists to rule out. The
 * archive member is then never pulled from libiterate-kit-core, so there is
 * no duplicate definition.
 */

#include "voicelab_stream.c"

#include <assert.h>
#include <stdio.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

enum {
  /* G.711 mu-law's smallest segment: below this the codec is 8x linear. */
  MULAW_SMALLEST_STEP = 8,
  /* The encoder's own clip point. Nothing louder is representable. */
  MULAW_CLIP = 32635,
};

/* The quantisation step of the segment `encoded` landed in. */
static int32_t mulaw_step_for(uint8_t encoded);

/* Encodes then expands one sample, reporting the decoded value it came back as. */
static int16_t mulaw_round_trip(int16_t sample, uint8_t *encoded_out);

/*
 * The whole claim about mu-law, checked over every sample a 16-bit converter
 * can produce: the value comes back inside the quantisation step of the
 * segment it was encoded into. If that holds everywhere then the codec cannot
 * be what makes a device sound bad — it can only ever add the hiss that step
 * size implies, never a click, a dropout, or a wrong sign.
 *
 * The sweep is exhaustive on purpose. Speech test vectors would have missed
 * exactly the sample that matters here: the one at the very bottom of the
 * range, which arrives whenever an input stage clips.
 */
static void every_sample_comes_back_inside_mu_laws_own_step(void)
{
  int32_t worst_error = 0;
  int32_t worst_sample = 0;
  for (int32_t value = INT16_MIN; value <= INT16_MAX; ++value) {
    uint8_t encoded = 0U;
    const int16_t decoded = mulaw_round_trip((int16_t)value, &encoded);
    const int32_t clipped = value > MULAW_CLIP ? MULAW_CLIP
        : (value < -MULAW_CLIP ? -MULAW_CLIP : value);
    int32_t error = (int32_t)decoded - clipped;
    if (error < 0) error = -error;
    if (error > worst_error) {
      worst_error = error;
      worst_sample = value;
    }
    assert(error <= mulaw_step_for(encoded));
  }
  (void)fprintf(
      stderr, "mulaw worst error %d at sample %d\n", worst_error, worst_sample);
  /* The largest legal step is the top segment's, and nothing may exceed it. */
  assert(worst_error <= (int32_t)1 << 10);
}

/*
 * Sign is the one thing a codec may never get wrong. A sign inversion is not
 * distortion, it is a different waveform, and on a full-scale sample it is
 * the loudest possible click. This is the assertion that would have caught an
 * encoder negating a full-scale negative sample into silence.
 */
static void loud_speech_never_changes_sign_or_collapses_to_silence(void)
{
  for (int32_t value = -MULAW_CLIP; value <= -MULAW_CLIP + 4096; ++value) {
    uint8_t encoded = 0U;
    const int16_t decoded = mulaw_round_trip((int16_t)value, &encoded);
    assert(decoded < 0);
    assert(decoded < -MULAW_CLIP + 8192);
  }
  for (int32_t value = MULAW_CLIP - 4096; value <= MULAW_CLIP; ++value) {
    uint8_t encoded = 0U;
    const int16_t decoded = mulaw_round_trip((int16_t)value, &encoded);
    assert(decoded > 0);
  }
  /* The extremes of the container, which is where a clipping input stage lives. */
  uint8_t encoded = 0U;
  assert(mulaw_round_trip(INT16_MIN, &encoded) < -MULAW_CLIP + 8192);
  assert(mulaw_round_trip(INT16_MAX, &encoded) > MULAW_CLIP - 8192);
}

/*
 * The downlink's half of the codec, on its own. Expansion is a total function
 * of one byte with a fixed table: every one of the 256 codes decodes, the
 * mapping is strictly monotonic, and it is the same table G.711 specifies. A
 * function with those properties cannot behave differently on an ESP32 than
 * on a Mac, which is the actual question being asked of it.
 */
static void expansion_is_total_monotonic_and_the_specified_table(void)
{
  /*
   * G.711 stores the code inverted, so the byte order is not the sample
   * order: 0x00..0x7F ascends from the most negative sample to negative zero,
   * and 0x80..0xFF descends from the most positive sample to positive zero.
   * Both halves must be strictly monotonic — a table with a repeated or
   * out-of-order entry would map two different loudnesses onto one sample and
   * flatten speech in a way no listener could describe.
   */
  int32_t previous = INT32_MIN;
  for (int32_t code = 0; code < 128; ++code) {
    uint8_t buffer[2] = {(uint8_t)code, 0U};
    assert(mulaw_expand(buffer, 1U, sizeof(buffer)) == 2U);
    const int16_t decoded =
        (int16_t)((uint16_t)buffer[0] | ((uint16_t)buffer[1] << 8));
    assert((int32_t)decoded > previous);
    assert(decoded <= 0);
    previous = (int32_t)decoded;
  }
  previous = INT32_MAX;
  for (int32_t code = 128; code < 256; ++code) {
    uint8_t buffer[2] = {(uint8_t)code, 0U};
    assert(mulaw_expand(buffer, 1U, sizeof(buffer)) == 2U);
    const int16_t decoded =
        (int16_t)((uint16_t)buffer[0] | ((uint16_t)buffer[1] << 8));
    assert((int32_t)decoded < previous);
    assert(decoded >= 0);
    previous = (int32_t)decoded;
  }
  uint8_t anchors[4] = {0x00U, 0x7FU, 0x80U, 0xFFU};
  const int16_t expected[4] = {-32124, 0, 32124, 0};
  for (size_t index = 0U; index < sizeof(anchors); ++index) {
    uint8_t buffer[2] = {anchors[index], 0U};
    assert(mulaw_expand(buffer, 1U, sizeof(buffer)) == 2U);
    const int16_t decoded =
        (int16_t)((uint16_t)buffer[0] | ((uint16_t)buffer[1] << 8));
    assert(decoded == expected[index]);
  }
}

/*
 * Expansion doubles its input in place, so the one way it can hurt anybody is
 * by writing past the buffer it was handed. A frame that will not fit must be
 * refused whole; expanding half of it would put the second half of the
 * previous frame on the end of this one, which is a click on every frame.
 */
static void a_frame_that_will_not_fit_is_refused_rather_than_truncated(void)
{
  uint8_t buffer[4] = {0x10U, 0x20U, 0x30U, 0x40U};
  const uint8_t before[4] = {0x10U, 0x20U, 0x30U, 0x40U};
  assert(mulaw_expand(buffer, 3U, sizeof(buffer)) == 0U);
  assert(memcmp(buffer, before, sizeof(buffer)) == 0);
  assert(mulaw_expand(buffer, 2U, sizeof(buffer)) == 4U);
}

/* Little-endian PCM16, because that is what every other stage assumes. */
static void expansion_writes_little_endian_pcm16(void)
{
  uint8_t buffer[2] = {0x80U, 0U};
  assert(mulaw_expand(buffer, 1U, sizeof(buffer)) == 2U);
  assert(buffer[0] == (uint8_t)(32124U & 0xFFU));
  assert(buffer[1] == (uint8_t)((32124U >> 8) & 0xFFU));
}

static int32_t mulaw_step_for(uint8_t encoded)
{
  const uint8_t value = (uint8_t)~encoded;
  const uint8_t exponent = (uint8_t)((value >> 4) & 0x07U);
  const int32_t step = (int32_t)1 << (exponent + 3);
  return step < MULAW_SMALLEST_STEP ? MULAW_SMALLEST_STEP : step;
}

static int16_t mulaw_round_trip(int16_t sample, uint8_t *encoded_out)
{
  assert(encoded_out != NULL);
  const uint8_t pcm[2] = {
    (uint8_t)((uint16_t)sample & 0xFFU),
    (uint8_t)(((uint16_t)sample >> 8) & 0xFFU),
  };
  uint8_t encoded[1] = {0U};
  assert(mulaw_encode(pcm, sizeof(pcm), encoded) == 1U);
  *encoded_out = encoded[0];
  uint8_t buffer[2] = {encoded[0], 0U};
  assert(mulaw_expand(buffer, 1U, sizeof(buffer)) == 2U);
  return (int16_t)((uint16_t)buffer[0] | ((uint16_t)buffer[1] << 8));
}

int main(void)
{
  every_sample_comes_back_inside_mu_laws_own_step();
  loud_speech_never_changes_sign_or_collapses_to_silence();
  expansion_is_total_monotonic_and_the_specified_table();
  a_frame_that_will_not_fit_is_refused_rather_than_truncated();
  expansion_writes_little_endian_pcm16();
  return 0;
}
