/* cli_wav.c: owns WAV parsing, frame replay, and the played-timeline sink. */

#include <assert.h>
#include <string.h>

#include "cli_wav.h"
#include "iterate/kit/voice_device_profile.h"

enum {
  /* RIFF chunk headers are a four-character id and a little-endian length. */
  CLI_WAV_CHUNK_HEADER_BYTES = 8,
  CLI_WAV_RIFF_HEADER_BYTES = 12,
  CLI_WAV_SINK_HEADER_BYTES = 44,
  /* The `fmt ` chunk is 16 bytes for PCM; extensible forms add fields we skip. */
  CLI_WAV_FORMAT_MIN_BYTES = 16,
  CLI_WAV_FORMAT_MAX_BYTES = 40,
  CLI_WAV_FORMAT_PCM = 1,
  CLI_WAV_CHANNELS_MONO = 1,
  CLI_WAV_SAMPLE_RATE_HZ = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  CLI_WAV_BITS_PER_SAMPLE = 16,
  CLI_WAV_BYTES_PER_SAMPLE = 2,
  CLI_WAV_BYTE_RATE = CLI_WAV_SAMPLE_RATE_HZ * CLI_WAV_BYTES_PER_SAMPLE,
  /* Offsets of the two length fields a growing recording must patch on close. */
  CLI_WAV_RIFF_SIZE_OFFSET = 4,
  CLI_WAV_DATA_SIZE_OFFSET = 40,
  /* `RIFF` length counts everything after itself: the 44-byte header less 8. */
  CLI_WAV_RIFF_SIZE_BIAS = 36,
  /*
   * Bounded synthesis: three seconds. Long enough for a provider to transcribe
   * something, short enough that a misconfigured run ends rather than talking
   * into the void until the deadline.
   */
  CLI_WAV_SYNTHETIC_FRAMES = 150,
  CLI_WAV_SYNTHETIC_PERIOD_SAMPLES = 80,
  CLI_WAV_SYNTHETIC_AMPLITUDE = 180,
  CLI_WAV_SYNTHETIC_GATE_SAMPLES = 1600,
  CLI_WAV_SYNTHETIC_GATE_PHASES = 3,
};

/* Propagates any non-OK status. Permitted only where nothing is acquired. */
#define CLI_WAV_TRY(expr)                          \
  do {                                             \
    const enum cli_wav_status cli_wav_try_ = (expr); \
    if (cli_wav_try_ != CLI_WAV_OK) return cli_wav_try_; \
  } while (0)

/* Little-endian accessors. WAV is little-endian regardless of the host. */
static uint32_t cli_wav_read_u32(const uint8_t *bytes);
static uint16_t cli_wav_read_u16(const uint8_t *bytes);
static void cli_wav_write_u32(uint8_t *bytes, uint32_t value);
static void cli_wav_write_u16(uint8_t *bytes, uint16_t value);

/* True when the four bytes at `bytes` are the chunk id `id`. */
static bool cli_wav_is_chunk(const uint8_t *bytes, const char *id);

/* Adapter over fread. Fails with CLI_WAV_ERR_IO on a short read. */
static enum cli_wav_status cli_wav_read_exact(
    FILE *file, uint8_t *out, size_t length);

/* Rejects the RIFF/WAVE preamble. Fails with CLI_WAV_ERR_FORMAT. */
static enum cli_wav_status cli_wav_read_riff_header(FILE *file);

/* Walks chunks until `data`, recording its length. Fails with ERR_FORMAT. */
static enum cli_wav_status cli_wav_seek_data(struct cli_wav_source *source);

/* Rejects anything but 16 kHz mono PCM16. Fails with ERR_UNSUPPORTED. */
static enum cli_wav_status cli_wav_check_format(
    const uint8_t *format, uint32_t length);

/* Fills one frame of the bounded test tone. */
static enum cli_wav_status cli_wav_synthesize(
    struct cli_wav_source *source, uint8_t *frame, size_t frame_bytes);

/* Builds the 44-byte canonical header with placeholder lengths. */
static void cli_wav_build_header(uint8_t *header);

/* Rewrites one little-endian length in place. Fails with ERR_IO. */
static enum cli_wav_status cli_wav_patch_length(
    FILE *file, long offset, uint32_t value);

const char *cli_wav_status_name(enum cli_wav_status status)
{
  switch (status) {
    case CLI_WAV_OK: return "ok";
    case CLI_WAV_ERR_ARG: return "bad-argument";
    case CLI_WAV_ERR_OPEN: return "cannot-open";
    case CLI_WAV_ERR_FORMAT: return "not-a-wav";
    case CLI_WAV_ERR_UNSUPPORTED: return "not-16khz-mono-pcm16";
    case CLI_WAV_ERR_IO: return "io";
    default: return "unknown";
  }
}

enum cli_wav_status cli_wav_source_open(
    struct cli_wav_source *source, const char *path)
{
  if (source == NULL) return CLI_WAV_ERR_ARG;
  cli_wav_source_close(source);
  memset(source, 0, sizeof(*source));
  source->synthetic_frames = CLI_WAV_SYNTHETIC_FRAMES;
  if (path == NULL) {
    source->synthetic = true;
    return CLI_WAV_OK;
  }
  source->file = fopen(path, "rb");
  if (source->file == NULL) return CLI_WAV_ERR_OPEN;

  const enum cli_wav_status status = cli_wav_read_riff_header(source->file);
  if (status != CLI_WAV_OK) {
    cli_wav_source_close(source);
    return status;
  }
  const enum cli_wav_status seek = cli_wav_seek_data(source);
  if (seek != CLI_WAV_OK) cli_wav_source_close(source);
  return seek;
}

enum cli_wav_status cli_wav_source_frame(
    struct cli_wav_source *source, uint8_t *frame, size_t frame_bytes)
{
  if (source == NULL || frame == NULL || frame_bytes == 0U) {
    return CLI_WAV_ERR_ARG;
  }
  if (source->synthetic) {
    return cli_wav_synthesize(source, frame, frame_bytes);
  }
  if (source->file == NULL || source->data_remaining == 0U) {
    return CLI_WAV_ERR_IO;
  }
  const size_t wanted = source->data_remaining < frame_bytes
      ? (size_t)source->data_remaining
      : frame_bytes;
  const size_t got = fread(frame, 1U, wanted, source->file);
  if (got == 0U) return CLI_WAV_ERR_IO;
  assert(got <= frame_bytes);
  source->data_remaining -= (uint32_t)got;
  /* A short final read is padded so the caller always sends a whole frame. */
  memset(frame + got, 0, frame_bytes - got);
  return CLI_WAV_OK;
}

void cli_wav_source_close(struct cli_wav_source *source)
{
  if (source == NULL || source->file == NULL) return;
  (void)fclose(source->file);
  source->file = NULL;
  source->data_remaining = 0U;
}

enum cli_wav_status cli_wav_sink_open(
    struct cli_wav_sink *sink, const char *path)
{
  if (sink == NULL || path == NULL) return CLI_WAV_ERR_ARG;
  sink->bytes = 0U;
  sink->file = fopen(path, "wb+");
  if (sink->file == NULL) return CLI_WAV_ERR_OPEN;

  uint8_t header[CLI_WAV_SINK_HEADER_BYTES];
  cli_wav_build_header(header);
  if (fwrite(header, 1U, sizeof(header), sink->file) != sizeof(header)) {
    cli_wav_sink_close(sink);
    return CLI_WAV_ERR_IO;
  }
  return CLI_WAV_OK;
}

enum cli_wav_status cli_wav_sink_write(
    struct cli_wav_sink *sink, const uint8_t *pcm, size_t length)
{
  if (sink == NULL || pcm == NULL) return CLI_WAV_ERR_ARG;
  if (sink->file == NULL) return CLI_WAV_ERR_IO;
  /* The RIFF length field is 32-bit; overflowing it would corrupt the file. */
  if (length > (size_t)(UINT32_MAX - sink->bytes)) return CLI_WAV_ERR_IO;
  if (fwrite(pcm, 1U, length, sink->file) != length) return CLI_WAV_ERR_IO;
  sink->bytes += (uint32_t)length;
  return CLI_WAV_OK;
}

enum cli_wav_status cli_wav_sink_sync(struct cli_wav_sink *sink)
{
  enum cli_wav_status status;
  if (sink == NULL) return CLI_WAV_ERR_ARG;
  if (sink->file == NULL) return CLI_WAV_ERR_IO;
  status = cli_wav_patch_length(
      sink->file, CLI_WAV_RIFF_SIZE_OFFSET,
      CLI_WAV_RIFF_SIZE_BIAS + sink->bytes);
  if (status != CLI_WAV_OK) return status;
  status = cli_wav_patch_length(
      sink->file, CLI_WAV_DATA_SIZE_OFFSET, sink->bytes);
  if (status != CLI_WAV_OK) return status;
  /* Back to the end, because the next write must append, not overwrite. */
  if (fseek(sink->file, 0L, SEEK_END) != 0) return CLI_WAV_ERR_IO;
  return CLI_WAV_OK;
}

void cli_wav_sink_close(struct cli_wav_sink *sink)
{
  if (sink == NULL || sink->file == NULL) return;
  /*
   * Both lengths are unknown until now, so the header written at open was a
   * placeholder. Failing to patch it leaves a file no player will open, which
   * is why close is not optional and its result is not worth propagating —
   * there is nothing a caller could do differently.
   */
  (void)cli_wav_patch_length(
      sink->file, CLI_WAV_RIFF_SIZE_OFFSET, CLI_WAV_RIFF_SIZE_BIAS + sink->bytes);
  (void)cli_wav_patch_length(
      sink->file, CLI_WAV_DATA_SIZE_OFFSET, sink->bytes);
  (void)fclose(sink->file);
  sink->file = NULL;
}

static uint32_t cli_wav_read_u32(const uint8_t *bytes)
{
  assert(bytes != NULL);
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8U) |
      ((uint32_t)bytes[2] << 16U) | ((uint32_t)bytes[3] << 24U);
}

static uint16_t cli_wav_read_u16(const uint8_t *bytes)
{
  assert(bytes != NULL);
  return (uint16_t)((uint16_t)bytes[0] | (uint16_t)((uint16_t)bytes[1] << 8U));
}

static void cli_wav_write_u32(uint8_t *bytes, uint32_t value)
{
  assert(bytes != NULL);
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8U);
  bytes[2] = (uint8_t)(value >> 16U);
  bytes[3] = (uint8_t)(value >> 24U);
}

static void cli_wav_write_u16(uint8_t *bytes, uint16_t value)
{
  assert(bytes != NULL);
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8U);
}

static bool cli_wav_is_chunk(const uint8_t *bytes, const char *id)
{
  assert(bytes != NULL && id != NULL);
  return memcmp(bytes, id, 4U) == 0;
}

static enum cli_wav_status cli_wav_read_exact(
    FILE *file, uint8_t *out, size_t length)
{
  assert(file != NULL && out != NULL);
  return fread(out, 1U, length, file) == length ? CLI_WAV_OK : CLI_WAV_ERR_IO;
}

static enum cli_wav_status cli_wav_read_riff_header(FILE *file)
{
  assert(file != NULL);
  uint8_t header[CLI_WAV_RIFF_HEADER_BYTES];
  if (cli_wav_read_exact(file, header, sizeof(header)) != CLI_WAV_OK) {
    return CLI_WAV_ERR_FORMAT;
  }
  if (!cli_wav_is_chunk(header, "RIFF")) return CLI_WAV_ERR_FORMAT;
  if (!cli_wav_is_chunk(header + 8, "WAVE")) return CLI_WAV_ERR_FORMAT;
  return CLI_WAV_OK;
}

static enum cli_wav_status cli_wav_seek_data(struct cli_wav_source *source)
{
  assert(source != NULL && source->file != NULL);
  bool format_seen = false;
  /*
   * Bounded by the file: every iteration consumes at least a chunk header, so
   * the loop ends at EOF even for a hostile file whose lengths all read zero.
   */
  for (;;) {
    uint8_t chunk[CLI_WAV_CHUNK_HEADER_BYTES];
    if (cli_wav_read_exact(source->file, chunk, sizeof(chunk)) != CLI_WAV_OK) {
      return CLI_WAV_ERR_FORMAT;
    }
    const uint32_t length = cli_wav_read_u32(chunk + 4);
    if (cli_wav_is_chunk(chunk, "fmt ")) {
      uint8_t format[CLI_WAV_FORMAT_MAX_BYTES];
      if (length < CLI_WAV_FORMAT_MIN_BYTES || length > sizeof(format)) {
        return CLI_WAV_ERR_UNSUPPORTED;
      }
      CLI_WAV_TRY(cli_wav_read_exact(source->file, format, length));
      CLI_WAV_TRY(cli_wav_check_format(format, length));
      format_seen = true;
    } else if (cli_wav_is_chunk(chunk, "data")) {
      /* A data chunk before its format leaves the samples uninterpretable. */
      if (!format_seen) return CLI_WAV_ERR_FORMAT;
      source->data_remaining = length;
      return CLI_WAV_OK;
    } else if (fseek(source->file, (long)length, SEEK_CUR) != 0) {
      return CLI_WAV_ERR_FORMAT;
    }
    /* RIFF pads odd-length chunks to an even boundary. */
    if ((length & 1U) != 0U) (void)fseek(source->file, 1L, SEEK_CUR);
  }
}

static enum cli_wav_status cli_wav_check_format(
    const uint8_t *format, uint32_t length)
{
  assert(format != NULL && length >= CLI_WAV_FORMAT_MIN_BYTES);
  (void)length;
  if (cli_wav_read_u16(format) != CLI_WAV_FORMAT_PCM) {
    return CLI_WAV_ERR_UNSUPPORTED;
  }
  if (cli_wav_read_u16(format + 2) != CLI_WAV_CHANNELS_MONO) {
    return CLI_WAV_ERR_UNSUPPORTED;
  }
  if (cli_wav_read_u32(format + 4) != CLI_WAV_SAMPLE_RATE_HZ) {
    return CLI_WAV_ERR_UNSUPPORTED;
  }
  if (cli_wav_read_u16(format + 14) != CLI_WAV_BITS_PER_SAMPLE) {
    return CLI_WAV_ERR_UNSUPPORTED;
  }
  return CLI_WAV_OK;
}

static enum cli_wav_status cli_wav_synthesize(
    struct cli_wav_source *source, uint8_t *frame, size_t frame_bytes)
{
  assert(source != NULL && frame != NULL);
  if (source->synthetic_frame >= source->synthetic_frames) {
    return CLI_WAV_ERR_IO;
  }
  /*
   * A gated sawtooth, not silence. Silence gives a speech provider nothing to
   * transcribe, so a run made of it proves the pipe moved bytes and nothing
   * else. Real runs should pass --mic-wav or --utterance-dir; this exists so
   * the microphone capability is never simply absent.
   */
  const size_t samples = frame_bytes / CLI_WAV_BYTES_PER_SAMPLE;
  for (size_t index = 0U; index < samples; ++index) {
    const uint32_t phase =
        source->synthetic_frame * (uint32_t)samples + (uint32_t)index;
    const int32_t saw = (int32_t)(phase % CLI_WAV_SYNTHETIC_PERIOD_SAMPLES) -
        CLI_WAV_SYNTHETIC_PERIOD_SAMPLES / 2;
    const bool voiced =
        ((phase / CLI_WAV_SYNTHETIC_GATE_SAMPLES) %
         CLI_WAV_SYNTHETIC_GATE_PHASES) != CLI_WAV_SYNTHETIC_GATE_PHASES - 1U;
    const int16_t sample =
        (int16_t)(voiced ? saw * CLI_WAV_SYNTHETIC_AMPLITUDE : 0);
    cli_wav_write_u16(
        frame + index * CLI_WAV_BYTES_PER_SAMPLE, (uint16_t)sample);
  }
  ++source->synthetic_frame;
  return CLI_WAV_OK;
}

static void cli_wav_build_header(uint8_t *header)
{
  assert(header != NULL);
  memset(header, 0, CLI_WAV_SINK_HEADER_BYTES);
  memcpy(header, "RIFF", 4U);
  memcpy(header + 8, "WAVEfmt ", 8U);
  cli_wav_write_u32(header + 16, CLI_WAV_FORMAT_MIN_BYTES);
  cli_wav_write_u16(header + 20, CLI_WAV_FORMAT_PCM);
  cli_wav_write_u16(header + 22, CLI_WAV_CHANNELS_MONO);
  cli_wav_write_u32(header + 24, CLI_WAV_SAMPLE_RATE_HZ);
  cli_wav_write_u32(header + 28, CLI_WAV_BYTE_RATE);
  cli_wav_write_u16(header + 32, CLI_WAV_BYTES_PER_SAMPLE);
  cli_wav_write_u16(header + 34, CLI_WAV_BITS_PER_SAMPLE);
  memcpy(header + 36, "data", 4U);
}

static enum cli_wav_status cli_wav_patch_length(
    FILE *file, long offset, uint32_t value)
{
  assert(file != NULL);
  uint8_t encoded[4];
  cli_wav_write_u32(encoded, value);
  if (fseek(file, offset, SEEK_SET) != 0) return CLI_WAV_ERR_IO;
  if (fwrite(encoded, 1U, sizeof(encoded), file) != sizeof(encoded)) {
    return CLI_WAV_ERR_IO;
  }
  return CLI_WAV_OK;
}
