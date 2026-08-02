/*
 * macOS execution target for the Waveshare voice runtime.
 *
 * This is deliberately a target adapter, not a voicelab implementation.  It
 * uses the production Cap'n Web connection, POSIX transport, voicelab stream,
 * audio-frame classifier, resource profile, and playout clock.  Its platform
 * seams are limited to monotonic time, stderr logging, WAV source/sink, and an
 * optional CoreAudio sink.  Every queue is fixed-capacity; an unattended run
 * failing a bound exits loudly instead of silently growing a macOS heap that
 * the device does not possess.
 */
#include <AudioToolbox/AudioToolbox.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <csignal>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <inttypes.h>
#include <string>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <vector>

extern "C" {
#include "capnweb/capnweb.h"
#include "iterate/kit/audio_playout.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/posix_itx_transport.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playback_clock.h"
#include "iterate/kit/voicelab_stream.h"
}

namespace {

constexpr size_t kMaxUtterances = 128;
constexpr size_t kMaxTurns = 1024;
constexpr uint32_t kLoopMs = 5;
constexpr uint32_t kConversationGapMs = 1500;
constexpr uint32_t kCallStartRetryMs = 8000;
constexpr uint32_t kCallPendingTimeoutMs = 20000;
constexpr uint32_t kOccupancyBuckets =
    ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES / 32U + 1U;

struct Options {
  const char *project_id = nullptr;
  const char *project_api_key = nullptr;
  const char *os_base_url = nullptr;
  const char *stream_path = "/voicelab/device";
  const char *name = "host";
  const char *mic_wav = nullptr;
  const char *utterance_dir = nullptr;
  const char *speaker_wav = "iterate-kit-playback.wav";
  const char *report_json = "iterate-kit-report.json";
  double converse_minutes = 0.0;
  uint32_t colleague_every = 0;
  bool live_audio = false;
  bool insecure = false;
};

struct WavSource {
  FILE *file = nullptr;
  uint32_t data_remaining = 0;
  bool synthetic = false;
  uint32_t synthetic_frame = 0;
  uint32_t synthetic_frames = 150;
};

struct WavSink {
  FILE *file = nullptr;
  uint32_t bytes = 0;
};

struct AudioQueueSink {
  AudioQueueRef queue = nullptr;
  std::array<AudioQueueBufferRef, 8> buffers{};
  std::array<bool, 8> busy{};
  bool enabled = false;
  uint32_t dropped = 0;
};

struct ByteRing {
  std::array<uint8_t, ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES> bytes{};
  size_t read = 0;
  size_t write = 0;
  size_t used = 0;
};

struct MicRing {
  std::array<std::array<uint8_t, ITERATE_KIT_VOICE_FRAME_BYTES>,
             ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH> frames{};
  size_t read = 0;
  size_t write = 0;
  size_t used = 0;
};

struct TurnReport {
  char utterance[256]{};
  bool colleague = false;
  bool failed = false;
  uint64_t started_ms = 0;
  uint64_t committed_ms = 0;
  uint64_t first_audio_ms = 0;
  uint64_t completed_ms = 0;
  uint32_t frames_sent = 0;
  uint32_t frames_received = 0;
  uint32_t frames_played = 0;
  uint32_t frames_concealed = 0;
  uint32_t sequence_gaps = 0;
  uint32_t underruns = 0;
  uint32_t occupancy_min_ms = UINT32_MAX;
  uint32_t occupancy_max_ms = 0;
  std::array<uint32_t, kOccupancyBuckets> occupancy_histogram{};
  uint32_t occupancy_samples = 0;
};

enum class DriverState {
  kDisabled,
  kWaitCall,
  kStartTurn,
  kSending,
  kWaitAnswer,
  kGap,
  kFinished,
};

struct Runtime {
  Options options;
  int argc = 0;
  char **argv = nullptr;
  iterate_kit_configuration configuration{};
  iterate_kit_itx_connection connection{};
  std::array<capnweb_pending_call,
             ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY> pending_calls{};
  std::array<capnweb_export,
             ITERATE_KIT_VOICE_EXPORT_CAPACITY> exports{};
  std::array<capnweb_import,
             ITERATE_KIT_VOICE_IMPORT_CAPACITY> imports{};
  std::array<capnweb_json_token,
             ITERATE_KIT_VOICE_TOKEN_CAPACITY> tokens{};
  std::array<char, ITERATE_KIT_VOICE_OUTPUT_CAPACITY> output{};
  iterate_kit_spsc_ring control_inbox{};
  iterate_kit_spsc_ring control_outbox{};
  std::array<std::array<uint8_t,
                       ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY>,
             ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS> inbox_storage{};
  std::array<std::array<uint8_t,
                       ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY>,
             ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS> outbox_storage{};
  std::array<size_t, ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS> inbox_lengths{};
  std::array<size_t, ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS> outbox_lengths{};
  iterate_kit_posix_itx_transport transport{};
  iterate_kit_peer peer{};
  iterate_kit_module module{};
  iterate_kit_voicelab voicelab{};
  uint32_t voicelab_generation = 0;
  /*
   * The mount path must OUTLIVE initialization: the connection stores this
   * pointer and does not read it until open(), which happens later, from the
   * run loop. Held as a local it was a dangling pointer into a reclaimed
   * stack frame the moment initialization returned — the mount then failed
   * with CAPNWEB_E_INVALID_ARGUMENT every time, which was the luckiest
   * possible outcome for undefined behaviour and the reason this is written
   * down. Both elements are stable for the life of the process: a literal,
   * and a pointer into argv.
   */
  const char *mount_path[2] = {"kit", "host"};
  /*
   * The last states we ANNOUNCED, so a transition is logged once rather than
   * two hundred times a second. Without this the CLI said "ready" — meaning
   * its own initialization — and then nothing at all, for as long as it ran:
   * a program that never connected and a program in a healthy call produced
   * byte-identical output. The device logs every one of these transitions,
   * and being able to see them is most of why this target exists.
   */
  enum iterate_kit_posix_itx_transport_state announced_transport =
      ITERATE_KIT_POSIX_ITX_IDLE;
  enum iterate_kit_voicelab_state announced_voicelab =
      ITERATE_KIT_VOICELAB_IDLE;
  enum iterate_kit_voicelab_failure announced_failure =
      ITERATE_KIT_VOICELAB_FAILURE_NONE;
  uint32_t frame_sequence = 0;
  MicRing mic_ring;
  ByteRing speaker_ring;
  iterate_kit_playout playout{};
  iterate_kit_voice_playback_clock playback_clock{};
  WavSource source;
  WavSink sink;
  AudioQueueSink live_sink;
  bool wants_call = false;
  bool wants_talk = false;
  bool talking = false;
  bool flushing_turn = false;
  bool answer_done = false;
  bool restart_requested = false;
  uint64_t restart_requested_at_ms = 0;
  bool stop_requested = false;
  bool source_finished = false;
  uint32_t flush_frames_left = 0;
  uint64_t flush_deadline_ms = 0;
  uint64_t turn_started_ms = 0;
  uint64_t next_mic_at_ms = 0;
  uint64_t next_playback_at_ms = 0;
  uint64_t next_stats_at_ms = 0;
  uint64_t next_ping_at_ms = 0;
  uint64_t next_call_attempt_at_ms = 0;
  uint64_t call_pending_since_ms = 0;
  uint64_t unhealthy_since_ms = 0;
  uint64_t last_liveness_ms = 0;
  uint64_t next_liveness_restart_at_ms = 0;
  uint64_t last_pulse_ms = 0;
  uint64_t started_ms = 0;
  uint64_t finish_at_ms = 0;
  uint64_t next_driver_at_ms = 0;
  uint32_t last_ping_count = 0;
  uint32_t downlink_recycles_running = 0;
  uint32_t stats_sequence = 0;
  uint32_t loop_count = 0;
  uint32_t mic_frames_captured = 0;
  uint32_t mic_frames_dropped = 0;
  uint32_t mic_frames_gated = 0;
  uint32_t speaker_frames_played = 0;
  uint32_t speaker_overflow_drops = 0;
  uint32_t speaker_underruns = 0;
  uint32_t speaker_conceal_frames = 0;
  uint32_t speaker_catchup_frames = 0;
  uint32_t speaker_debt_paid = 0;
  uint32_t speaker_write_failures = 0;
  uint32_t speaker_margin_min_ms = 0;
  uint32_t speaker_margin_max_ms = 0;
  uint32_t speaker_writes = 0;
  uint32_t speaker_bad_frames = 0;
  uint32_t barge_in_flushes = 0;
  uint32_t liveness_restarts = 0;
  uint32_t session_restarts = 0;
  uint32_t bridge_losses = 0;
  uint32_t downlink_recycles = 0;
  uint32_t transport_restarts = 0;
  uint32_t calls_lost = 0;
  uint32_t colleague_asked = 0;
  uint32_t colleague_answered = 0;
  bool mounted_once = false;
  DriverState driver = DriverState::kDisabled;
  std::vector<std::string> utterances;
  size_t ordinary_index = 0;
  std::array<TurnReport, kMaxTurns> turns{};
  size_t turn_count = 0;
  TurnReport *current_turn = nullptr;
};

Runtime runtime;
volatile sig_atomic_t interrupted = 0;

uint64_t now_ms(void *) {
  timespec now{};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return static_cast<uint64_t>(now.tv_sec) * 1000U +
      static_cast<uint64_t>(now.tv_nsec / 1000000L);
}

void log_line(const char *level, const char *format, ...) {
  std::fprintf(stderr, "t=%" PRIu64 " level=%s ", now_ms(nullptr), level);
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
  std::fputc('\n', stderr);
}

bool copy_field(char *out, size_t capacity, const char *value) {
  if (value == nullptr || value[0] == '\0' || std::strlen(value) >= capacity) {
    return false;
  }
  std::memcpy(out, value, std::strlen(value) + 1U);
  return true;
}

const char *env_or(const char *flag, const char *environment) {
  return flag != nullptr ? flag : std::getenv(environment);
}

void print_help(FILE *out) {
  std::fprintf(out,
      "Usage: iterate-kit-cli [options]\n\n"
      "Runs the Waveshare voicelab runtime on macOS with the same bounded "
      "resource profile. Flags override their environment variables.\n\n"
      "  --project-id ID       Project id (ITERATE_PROJECT_ID)\n"
      "  --api-key KEY         Project API key (ITERATE_PROJECT_API_KEY)\n"
      "  --os-base-url URL     OS origin, e.g. https://os.iterate.com "
      "(ITERATE_OS_BASE_URL)\n"
      "  --stream-path PATH    Stream path (ITERATE_KIT_STREAM_PATH; "
      "default /voicelab/device)\n"
      "  --name NAME           Mount capability as kit.NAME "
      "(ITERATE_KIT_CAPABILITY_NAME; default host)\n"
      "  --mic-wav FILE        PCM16 mono 16 kHz source for remote PTT "
      "(ITERATE_KIT_MIC_WAV)\n"
      "  --speaker-wav FILE    True played timeline, including concealed "
      "silence (default iterate-kit-playback.wav)\n"
      "  --live-audio          Also send the true timeline to CoreAudio\n"
      "  --converse MINUTES    Run the unattended conversation driver\n"
      "  --utterance-dir DIR   Directory of PCM16 mono 16 kHz WAVs for "
      "--converse\n"
      "  --colleague-every N   Use the colleague-forcing utterance every "
      "Nth turn (0 disables)\n"
      "  --report-json FILE    Unattended JSON report (default "
      "iterate-kit-report.json)\n"
      "  --insecure            Disable TLS certificate verification; local "
      "testing only\n"
      "  --help                Show this help\n");
}

bool parse_u32(const char *text, uint32_t *out) {
  char *end = nullptr;
  errno = 0;
  const unsigned long value = std::strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value > UINT32_MAX) {
    return false;
  }
  *out = static_cast<uint32_t>(value);
  return true;
}

bool parse_options(int argc, char **argv, Options *options) {
  for (int index = 1; index < argc; ++index) {
    const char *arg = argv[index];
    auto value = [&](const char *name) -> const char * {
      if (index + 1 >= argc) {
        std::fprintf(stderr, "%s requires a value\n", name);
        return nullptr;
      }
      return argv[++index];
    };
    if (std::strcmp(arg, "--help") == 0) {
      print_help(stdout);
      std::exit(0);
    } else if (std::strcmp(arg, "--project-id") == 0) {
      options->project_id = value(arg);
    } else if (std::strcmp(arg, "--api-key") == 0) {
      options->project_api_key = value(arg);
    } else if (std::strcmp(arg, "--os-base-url") == 0) {
      options->os_base_url = value(arg);
    } else if (std::strcmp(arg, "--stream-path") == 0) {
      options->stream_path = value(arg);
    } else if (std::strcmp(arg, "--name") == 0) {
      options->name = value(arg);
    } else if (std::strcmp(arg, "--mic-wav") == 0) {
      options->mic_wav = value(arg);
    } else if (std::strcmp(arg, "--speaker-wav") == 0) {
      options->speaker_wav = value(arg);
    } else if (std::strcmp(arg, "--utterance-dir") == 0) {
      options->utterance_dir = value(arg);
    } else if (std::strcmp(arg, "--report-json") == 0) {
      options->report_json = value(arg);
    } else if (std::strcmp(arg, "--converse") == 0) {
      const char *minutes = value(arg);
      char *end = nullptr;
      if (minutes == nullptr) return false;
      options->converse_minutes = std::strtod(minutes, &end);
      if (end == minutes || *end != '\0' || options->converse_minutes <= 0.0) {
        std::fprintf(stderr, "--converse must be a positive number\n");
        return false;
      }
    } else if (std::strcmp(arg, "--colleague-every") == 0) {
      const char *count = value(arg);
      if (count == nullptr || !parse_u32(count, &options->colleague_every)) {
        std::fprintf(stderr, "--colleague-every must be a nonnegative integer\n");
        return false;
      }
    } else if (std::strcmp(arg, "--live-audio") == 0) {
      options->live_audio = true;
    } else if (std::strcmp(arg, "--insecure") == 0) {
      options->insecure = true;
    } else {
      std::fprintf(stderr, "unknown option: %s\n", arg);
      return false;
    }
  }
  options->project_id = env_or(options->project_id, "ITERATE_PROJECT_ID");
  options->project_api_key =
      env_or(options->project_api_key, "ITERATE_PROJECT_API_KEY");
  options->os_base_url = env_or(options->os_base_url, "ITERATE_OS_BASE_URL");
  options->stream_path =
      env_or(options->stream_path, "ITERATE_KIT_STREAM_PATH");
  options->name = env_or(options->name, "ITERATE_KIT_CAPABILITY_NAME");
  options->mic_wav = env_or(options->mic_wav, "ITERATE_KIT_MIC_WAV");
  if (options->project_id == nullptr || options->project_api_key == nullptr ||
      options->os_base_url == nullptr) {
    std::fprintf(stderr,
        "project id, API key, and OS base URL are required; see --help\n");
    return false;
  }
  if (options->converse_minutes > 0.0 && options->utterance_dir == nullptr) {
    std::fprintf(stderr, "--converse requires --utterance-dir\n");
    return false;
  }
  return true;
}

uint32_t read_le32(const uint8_t *bytes) {
  return static_cast<uint32_t>(bytes[0]) |
      (static_cast<uint32_t>(bytes[1]) << 8U) |
      (static_cast<uint32_t>(bytes[2]) << 16U) |
      (static_cast<uint32_t>(bytes[3]) << 24U);
}

uint16_t read_le16(const uint8_t *bytes) {
  return static_cast<uint16_t>(bytes[0]) |
      static_cast<uint16_t>(static_cast<uint16_t>(bytes[1]) << 8U);
}

void write_le32(uint8_t *bytes, uint32_t value) {
  bytes[0] = static_cast<uint8_t>(value);
  bytes[1] = static_cast<uint8_t>(value >> 8U);
  bytes[2] = static_cast<uint8_t>(value >> 16U);
  bytes[3] = static_cast<uint8_t>(value >> 24U);
}

void write_le16(uint8_t *bytes, uint16_t value) {
  bytes[0] = static_cast<uint8_t>(value);
  bytes[1] = static_cast<uint8_t>(value >> 8U);
}

bool wav_source_open(WavSource *source, const char *path) {
  if (source->file != nullptr) std::fclose(source->file);
  *source = WavSource{};
  if (path == nullptr) {
    source->synthetic = true;
    log_line("warn", "no microphone WAV; using bounded voiced test synthesis");
    return true;
  }
  source->file = std::fopen(path, "rb");
  if (source->file == nullptr) return false;
  uint8_t header[12];
  if (std::fread(header, 1, sizeof(header), source->file) != sizeof(header) ||
      std::memcmp(header, "RIFF", 4) != 0 ||
      std::memcmp(header + 8, "WAVE", 4) != 0) return false;
  bool format_ok = false;
  for (;;) {
    uint8_t chunk[8];
    if (std::fread(chunk, 1, sizeof(chunk), source->file) != sizeof(chunk)) {
      break;
    }
    const uint32_t length = read_le32(chunk + 4);
    if (std::memcmp(chunk, "fmt ", 4) == 0) {
      std::array<uint8_t, 40> format{};
      if (length < 16U || length > format.size() ||
          std::fread(format.data(), 1, length, source->file) != length) {
        break;
      }
      format_ok = read_le16(format.data()) == 1U &&
          read_le16(format.data() + 2) == 1U &&
          read_le32(format.data() + 4) == 16000U &&
          read_le16(format.data() + 14) == 16U;
    } else if (std::memcmp(chunk, "data", 4) == 0) {
      if (!format_ok) break;
      source->data_remaining = length;
      return true;
    } else if (std::fseek(source->file, static_cast<long>(length), SEEK_CUR) != 0) {
      break;
    }
    if ((length & 1U) != 0U) (void)std::fseek(source->file, 1L, SEEK_CUR);
  }
  std::fclose(source->file);
  source->file = nullptr;
  return false;
}

bool wav_source_frame(WavSource *source, uint8_t *frame) {
  if (source->synthetic) {
    if (source->synthetic_frame >= source->synthetic_frames) return false;
    /*
     * A changing harmonic vowel-like signal is intentional: silence cannot
     * exercise transcription, and unbounded text-to-speech subprocesses would
     * add a second runtime. Real conversation runs should use --mic-wav or
     * --utterance-dir; synthesis exists so the capability remains functional.
     */
    for (uint32_t i = 0; i < ITERATE_KIT_VOICE_FRAME_SAMPLES; ++i) {
      const uint32_t phase = source->synthetic_frame *
          ITERATE_KIT_VOICE_FRAME_SAMPLES + i;
      const int32_t saw = static_cast<int32_t>(phase % 80U) - 40;
      const int32_t gate = ((phase / 1600U) % 3U) == 2U ? 0 : 1;
      const int16_t sample = static_cast<int16_t>(saw * 180 * gate);
      write_le16(frame + i * sizeof(sample), static_cast<uint16_t>(sample));
    }
    ++source->synthetic_frame;
    return true;
  }
  if (source->file == nullptr || source->data_remaining == 0U) return false;
  const size_t wanted = std::min<size_t>(
      ITERATE_KIT_VOICE_FRAME_BYTES, source->data_remaining);
  const size_t got = std::fread(frame, 1, wanted, source->file);
  source->data_remaining -= static_cast<uint32_t>(got);
  if (got == 0U) return false;
  std::memset(frame + got, 0, ITERATE_KIT_VOICE_FRAME_BYTES - got);
  return true;
}

bool wav_sink_open(WavSink *sink, const char *path) {
  sink->file = std::fopen(path, "wb+");
  if (sink->file == nullptr) return false;
  std::array<uint8_t, 44> header{};
  std::memcpy(header.data(), "RIFF", 4);
  std::memcpy(header.data() + 8, "WAVEfmt ", 8);
  write_le32(header.data() + 16, 16U);
  write_le16(header.data() + 20, 1U);
  write_le16(header.data() + 22, 1U);
  write_le32(header.data() + 24, 16000U);
  write_le32(header.data() + 28, 32000U);
  write_le16(header.data() + 32, 2U);
  write_le16(header.data() + 34, 16U);
  std::memcpy(header.data() + 36, "data", 4);
  return std::fwrite(header.data(), 1, header.size(), sink->file) ==
      header.size();
}

bool wav_sink_write(WavSink *sink, const uint8_t *pcm, size_t length) {
  if (sink->file == nullptr || length > UINT32_MAX - sink->bytes) return false;
  if (std::fwrite(pcm, 1, length, sink->file) != length) return false;
  sink->bytes += static_cast<uint32_t>(length);
  return true;
}

void wav_sink_close(WavSink *sink) {
  if (sink->file == nullptr) return;
  uint8_t value[4];
  write_le32(value, 36U + sink->bytes);
  (void)std::fseek(sink->file, 4L, SEEK_SET);
  (void)std::fwrite(value, 1, sizeof(value), sink->file);
  write_le32(value, sink->bytes);
  (void)std::fseek(sink->file, 40L, SEEK_SET);
  (void)std::fwrite(value, 1, sizeof(value), sink->file);
  std::fclose(sink->file);
  sink->file = nullptr;
}

void audio_queue_callback(void *context, AudioQueueRef,
                          AudioQueueBufferRef buffer) {
  auto *sink = static_cast<AudioQueueSink *>(context);
  for (size_t i = 0; i < sink->buffers.size(); ++i) {
    if (sink->buffers[i] == buffer) sink->busy[i] = false;
  }
}

bool audio_queue_open(AudioQueueSink *sink) {
  AudioStreamBasicDescription format{};
  format.mSampleRate = 16000.0;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger |
      kLinearPCMFormatFlagIsPacked;
  format.mBytesPerPacket = 2;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = 2;
  format.mChannelsPerFrame = 1;
  format.mBitsPerChannel = 16;
  if (AudioQueueNewOutput(&format, audio_queue_callback, sink, nullptr,
                          nullptr, 0, &sink->queue) != noErr) return false;
  for (auto &buffer : sink->buffers) {
    if (AudioQueueAllocateBuffer(sink->queue,
                                 ITERATE_KIT_VOICE_FRAME_BYTES,
                                 &buffer) != noErr) return false;
  }
  if (AudioQueueStart(sink->queue, nullptr) != noErr) return false;
  sink->enabled = true;
  return true;
}

void audio_queue_write(AudioQueueSink *sink, const uint8_t *pcm, size_t length) {
  if (!sink->enabled) return;
  for (size_t i = 0; i < sink->buffers.size(); ++i) {
    if (!sink->busy[i]) {
      std::memcpy(sink->buffers[i]->mAudioData, pcm, length);
      sink->buffers[i]->mAudioDataByteSize = static_cast<UInt32>(length);
      if (AudioQueueEnqueueBuffer(sink->queue, sink->buffers[i], 0, nullptr) ==
          noErr) {
        sink->busy[i] = true;
      } else {
        ++sink->dropped;
      }
      return;
    }
  }
  /* The WAV stays authoritative even if the optional room monitor falls behind. */
  ++sink->dropped;
}

void audio_queue_close(AudioQueueSink *sink) {
  if (sink->queue != nullptr) {
    (void)AudioQueueStop(sink->queue, true);
    (void)AudioQueueDispose(sink->queue, true);
    sink->queue = nullptr;
  }
}

size_t ring_space(const ByteRing &ring) { return ring.bytes.size() - ring.used; }

void mic_ring_clear(MicRing *ring) {
  ring->read = 0;
  ring->write = 0;
  ring->used = 0;
}

void mic_ring_push_latest(MicRing *ring, const uint8_t *frame) {
  if (ring->used == ring->frames.size()) {
    ring->read = (ring->read + 1U) % ring->frames.size();
    --ring->used;
    ++runtime.mic_frames_dropped;
  }
  std::memcpy(ring->frames[ring->write].data(), frame,
              ITERATE_KIT_VOICE_FRAME_BYTES);
  ring->write = (ring->write + 1U) % ring->frames.size();
  ++ring->used;
}

void ring_clear(ByteRing *ring) {
  ring->read = 0;
  ring->write = 0;
  ring->used = 0;
}

bool ring_write(ByteRing *ring, const uint8_t *bytes, size_t length) {
  if (length > ring_space(*ring)) return false;
  const size_t first = std::min(length, ring->bytes.size() - ring->write);
  std::memcpy(ring->bytes.data() + ring->write, bytes, first);
  std::memcpy(ring->bytes.data(), bytes + first, length - first);
  ring->write = (ring->write + length) % ring->bytes.size();
  ring->used += length;
  return true;
}

bool ring_read(ByteRing *ring, uint8_t *bytes, size_t length) {
  if (length > ring->used) return false;
  const size_t first = std::min(length, ring->bytes.size() - ring->read);
  std::memcpy(bytes, ring->bytes.data() + ring->read, first);
  std::memcpy(bytes + first, ring->bytes.data(), length - first);
  ring->read = (ring->read + length) % ring->bytes.size();
  ring->used -= length;
  return true;
}

void observe_occupancy(uint32_t margin_ms) {
  TurnReport *turn = runtime.current_turn;
  if (turn == nullptr) return;
  const uint32_t bucket = std::min<uint32_t>(
      margin_ms, static_cast<uint32_t>(turn->occupancy_histogram.size() - 1U));
  ++turn->occupancy_histogram[bucket];
  ++turn->occupancy_samples;
  turn->occupancy_min_ms = std::min(turn->occupancy_min_ms, margin_ms);
  turn->occupancy_max_ms = std::max(turn->occupancy_max_ms, margin_ms);
}

void write_playback(const uint8_t *pcm) {
  if (!wav_sink_write(&runtime.sink, pcm, ITERATE_KIT_VOICE_FRAME_BYTES)) {
    ++runtime.speaker_write_failures;
    runtime.stop_requested = true;
    return;
  }
  audio_queue_write(&runtime.live_sink, pcm, ITERATE_KIT_VOICE_FRAME_BYTES);
}

void finish_current_turn(uint64_t now);

void playback_poll(uint64_t now) {
  static const std::array<uint8_t, ITERATE_KIT_VOICE_FRAME_BYTES> silence{};
  std::array<uint8_t, ITERATE_KIT_VOICE_FRAME_BYTES> frame{};
  if (runtime.next_playback_at_ms == 0U) runtime.next_playback_at_ms = now;
  if (now < runtime.next_playback_at_ms) return;
  runtime.next_playback_at_ms += ITERATE_KIT_VOICE_FRAME_MS;
  if (now > runtime.next_playback_at_ms + ITERATE_KIT_VOICE_FRAME_MS * 4U) {
    /* Host scheduler stalls are visible, but never replayed as a burst. */
    runtime.next_playback_at_ms = now + ITERATE_KIT_VOICE_FRAME_MS;
  }
  /*
   * A TURN ENDS WHEN ITS OWN ANSWER ENDS.
   *
   * `answer_done` is set by any response completing, and the back office
   * produces responses of its own — every message it sends is spoken as a
   * fresh response. So a turn asked immediately after one of those found the
   * flag already set, was declared finished 576ms after committing with zero
   * frames received, and reported as a failure. The customer had heard
   * nothing wrong; the report was measuring the wrong answer.
   *
   * A turn is finished only once it has actually PLAYED something and the
   * queue has drained. A turn that never gets audio is finished by the
   * deadline instead, which is the honest way to record silence.
   */
  const bool answer_played_out = runtime.answer_done &&
      runtime.speaker_ring.used == 0U && runtime.current_turn != nullptr &&
      runtime.current_turn->frames_played > 0U;
  const bool answer_overdue = runtime.current_turn != nullptr &&
      runtime.current_turn->committed_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now, runtime.current_turn->committed_ms) >
          ITERATE_KIT_VOICE_TURN_MAX_MS;
  if (answer_played_out || answer_overdue) {
    runtime.answer_done = false;
    finish_current_turn(now);
    if (runtime.driver == DriverState::kWaitAnswer) {
      runtime.driver = DriverState::kGap;
      runtime.next_driver_at_ms = now + kConversationGapMs;
    }
  }
  if (!iterate_kit_voice_playback_clock_ready(
          &runtime.playback_clock,
          static_cast<uint32_t>(runtime.speaker_ring.used))) return;
  if (!ring_read(&runtime.speaker_ring, frame.data(), frame.size())) {
    if (iterate_kit_voice_playback_clock_empty(&runtime.playback_clock, now) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
      write_playback(silence.data());
      ++runtime.speaker_conceal_frames;
      if (runtime.current_turn != nullptr) {
        ++runtime.current_turn->frames_concealed;
      }
    }
    return;
  }
  const auto action = iterate_kit_voice_playback_clock_frame(
      &runtime.playback_clock,
      static_cast<uint32_t>(runtime.speaker_ring.used),
      runtime.speaker_frames_played,
      now);
  if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
    ++runtime.speaker_catchup_frames;
    return;
  }
  if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT) {
    ++runtime.speaker_debt_paid;
    return;
  }
  if (action != ITERATE_KIT_VOICE_PLAYBACK_PLAY) return;
  write_playback(frame.data());
  ++runtime.speaker_frames_played;
  ++runtime.speaker_writes;
  const uint32_t margin = static_cast<uint32_t>(runtime.speaker_ring.used / 32U);
  if (runtime.speaker_writes == 1U || margin < runtime.speaker_margin_min_ms) {
    runtime.speaker_margin_min_ms = margin;
  }
  runtime.speaker_margin_max_ms = std::max(runtime.speaker_margin_max_ms, margin);
  observe_occupancy(margin);
  if (runtime.current_turn != nullptr) {
    ++runtime.current_turn->frames_played;
    if (runtime.current_turn->first_audio_ms == 0U) {
      runtime.current_turn->first_audio_ms = now;
    }
  }
}

void on_speaker(void *, const uint8_t *pcm, size_t length,
                const iterate_kit_playout_frame *identity) {
  if ((length & 1U) != 0U || length != ITERATE_KIT_VOICE_FRAME_BYTES ||
      identity == nullptr) {
    ++runtime.speaker_bad_frames;
    return;
  }
  const auto action = iterate_kit_playout_classify(&runtime.playout, identity);
  if (action == ITERATE_KIT_PLAYOUT_IGNORE) return;
  if (action == ITERATE_KIT_PLAYOUT_REPLACE) {
    ring_clear(&runtime.speaker_ring);
    iterate_kit_voice_playback_clock_reprime(&runtime.playback_clock);
  }
  if (length > ring_space(runtime.speaker_ring)) {
    ++runtime.speaker_overflow_drops;
    return;
  }
  if (iterate_kit_voice_playback_clock_audio_arrived(
          &runtime.playback_clock, now_ms(nullptr))) {
    ++runtime.speaker_underruns;
    if (runtime.current_turn != nullptr) ++runtime.current_turn->underruns;
  }
  (void)ring_write(&runtime.speaker_ring, pcm, length);
  if (runtime.current_turn != nullptr) ++runtime.current_turn->frames_received;
}

void finish_current_turn(uint64_t now) {
  if (runtime.current_turn == nullptr) return;
  runtime.current_turn->completed_ms = now;
  runtime.current_turn->failed = runtime.current_turn->frames_played == 0U;
  runtime.current_turn->frames_sent = runtime.voicelab.frames_sent -
      runtime.current_turn->frames_sent;
  runtime.current_turn->sequence_gaps = runtime.playout.gaps -
      runtime.current_turn->sequence_gaps;
  if (runtime.current_turn->colleague && !runtime.current_turn->failed) {
    ++runtime.colleague_answered;
  }
  log_line(runtime.current_turn->failed ? "error" : "info",
      "turn=%zu complete=%s firstAudioMs=%" PRIu64
      " answerMs=%" PRIu64 " sent=%u received=%u played=%u conceal=%u"
      " gaps=%u underruns=%u",
      runtime.turn_count,
      runtime.current_turn->failed ? "failure" : "ok",
      /*
       * Both durations are measured FROM THE COMMIT, so a turn that never
       * committed has no duration to report — and must say 0 rather than the
       * clock's raw reading. "answerMs=14088564" on a turn that lasted eight
       * seconds is a report inventing a fact, and it appeared on exactly the
       * failed turns whose diagnosis mattered most.
       */
      runtime.current_turn->first_audio_ms == 0U ||
              runtime.current_turn->committed_ms == 0U
          ? 0U
          : iterate_kit_voice_elapsed_ms(runtime.current_turn->first_audio_ms,
                                         runtime.current_turn->committed_ms),
      runtime.current_turn->committed_ms == 0U
          ? 0U
          : iterate_kit_voice_elapsed_ms(now,
                                         runtime.current_turn->committed_ms),
      runtime.current_turn->frames_sent,
      runtime.current_turn->frames_received,
      runtime.current_turn->frames_played,
      runtime.current_turn->frames_concealed,
      runtime.current_turn->sequence_gaps,
      runtime.current_turn->underruns);
  runtime.current_turn = nullptr;
}

void on_control(void *, iterate_kit_voicelab_control control) {
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    ring_clear(&runtime.speaker_ring);
    iterate_kit_playout_interrupt(&runtime.playout);
    iterate_kit_voice_playback_clock_reprime(&runtime.playback_clock);
    ++runtime.barge_in_flushes;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /*
     * The answer is finished, so a dry buffer from here is not a deficit — it
     * is simply the end. Telling playback that keeps concealment meaning
     * "audio failed to arrive in time", which is the only reading worth
     * having.
     *
     * It must NOT interrupt the playout. `response.done` is one small text
     * event and the answer is hundreds of large audio events, all sent as
     * fast as the wire takes them, so the completion routinely arrives FIRST.
     * Interrupting here marked the answer abandoned and every frame of it
     * that followed was discarded as stale — measured as turns where the
     * transcript proved the model had answered and the speaker played
     * nothing at all. The next answer carries a higher number and supersedes
     * this one on its own; there is nothing to prepare.
     */
    runtime.answer_done = true;
    iterate_kit_voice_playback_clock_answer_done(&runtime.playback_clock);
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    log_line("info", "call accepted");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    log_line("warn", "call ended by the bridge");
    ++runtime.calls_lost;
    runtime.talking = false;
    runtime.flushing_turn = false;
    runtime.wants_talk = false;
    log_line("warn", "call ended; wantsCall=%s",
             runtime.wants_call ? "true" : "false");
  }
}

void on_transcript(void *, bool from_user, const char *text, bool final) {
  if (final) {
    log_line("info", "transcript speaker=%s text=%s",
             from_user ? "user" : "assistant", text);
  }
}

void on_session_ended(void *) {
  runtime.voicelab.state = ITERATE_KIT_VOICELAB_FAILED;
  runtime.voicelab.failure = ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED;
  runtime.voicelab.has_session_capability = false;
  runtime.voicelab.has_project_capability = false;
  runtime.voicelab.has_stream_capability = false;
  runtime.voicelab.has_connection_capability = false;
  runtime.voicelab.has_previous_connection_capability = false;
  runtime.voicelab.has_callback_capability = false;
  runtime.voicelab_generation = 0U;
}

size_t health_json(char *out, size_t capacity) {
  struct iterate_kit_posix_itx_transport_metrics metrics{};
  struct iterate_kit_spsc_ring_metrics outbox{};
  const uint64_t now = now_ms(nullptr);
  iterate_kit_posix_itx_transport_metrics(&runtime.transport, &metrics);
  iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox);
  const bool gate =
      runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
      runtime.transport.state == ITERATE_KIT_POSIX_ITX_READY &&
      runtime.voicelab_generation == runtime.connection.generation;
  const int length = std::snprintf(out, capacity,
      "{\"transport\":\"%s\",\"voicelab\":\"%s\","
      "\"voicelabFailure\":\"%s\",\"connectionState\":%d,"
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,"
      "\"talking\":%s,\"gateOpen\":%s,\"seq\":%u,\"t\":%" PRIu64
      ",\"framesSent\":%u,\"frameFailures\":%u,\"micCaptured\":%u,"
      "\"micDropped\":%u,\"micGated\":%u,\"spkFrames\":%u,"
      "\"spkPlayed\":%u,\"spkOverflow\":%u,\"spkUnderruns\":%u,"
      "\"spkConceal\":%u,\"spkCatchup\":%u,\"spkDebtPaid\":%u,"
      "\"spkWriteFailures\":%u,\"talkReadFailures\":0,"
      "\"spkMarginMaxMs\":%u,\"spkBadFrames\":%u,\"spkSeqGaps\":%u,"
      "\"spkDecodeFailures\":%u,\"bargeIns\":%u,\"batches\":%u,"
      "\"connGeneration\":%u,\"rttMs\":%u,\"pings\":%u,"
      "\"pingFailures\":%u,\"livenessRestarts\":%u,\"bridgeLosses\":%u,"
      "\"bridgeAgeMs\":%u,\"downlinkRecycles\":%u,\"batchAgeMs\":%u,"
      "\"uptimeMs\":%" PRIu64 ",\"resetReason\":0,\"heapFree\":0,"
      "\"heapMin\":0,\"wsSent\":%u,\"outboxDiscarded\":%u,"
      "\"inboxPublished\":%u,\"inboxConsumed\":%u,"
      "\"inboxDiscarded\":%u,\"inboxHighWater\":%u,"
      "\"sessionGeneration\":%u,\"protoFailures\":%u,"
      "\"recvFailures\":%u,\"sendFailures\":%u,"
      "\"inboxDeferrals\":%u,\"lastAppStatus\":%d,\"dmaLargest\":0,"
      "\"spkMarginMinMs\":%u,\"spkMarginP10Ms\":%u,\"spkWrites\":%u,"
      "\"outboxUsed\":%u,\"outboxSlots\":%u}",
      iterate_kit_posix_itx_transport_state_name(runtime.transport.state),
      iterate_kit_voicelab_state_name(runtime.voicelab.state),
      iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
      static_cast<int>(runtime.connection.state),
      runtime.voicelab.call_active ? "true" : "false",
      runtime.voicelab.call_pending ? "true" : "false",
      runtime.wants_call ? "true" : "false",
      runtime.talking ? "true" : "false", gate ? "true" : "false",
      runtime.stats_sequence++, now, runtime.voicelab.frames_sent,
      runtime.voicelab.frame_send_failures, runtime.mic_frames_captured,
      runtime.mic_frames_dropped, runtime.mic_frames_gated,
      runtime.voicelab.spk_frames_received, runtime.speaker_frames_played,
      runtime.speaker_overflow_drops, runtime.speaker_underruns,
      runtime.speaker_conceal_frames, runtime.speaker_catchup_frames,
      runtime.speaker_debt_paid, runtime.speaker_write_failures,
      runtime.speaker_margin_max_ms, runtime.speaker_bad_frames,
      runtime.playout.gaps, runtime.voicelab.spk_decode_failures,
      runtime.barge_in_flushes, runtime.voicelab.batches_on_connection,
      runtime.voicelab.connection_generation, runtime.voicelab.last_rtt_ms,
      runtime.voicelab.ping_count, runtime.voicelab.ping_failures,
      runtime.liveness_restarts, runtime.bridge_losses,
      runtime.voicelab.last_bridge_ms == 0U ? 0U :
          static_cast<uint32_t>(iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_bridge_ms)),
      runtime.downlink_recycles,
      runtime.voicelab.last_batch_ms == 0U ? 0U :
          static_cast<uint32_t>(iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_batch_ms)),
      iterate_kit_voice_elapsed_ms(now, runtime.started_ms), metrics.control_messages_sent,
      metrics.control_outbox_discarded, metrics.control_inbox.messages_published,
      metrics.control_inbox.messages_consumed, metrics.control_inbox_discarded,
      metrics.control_inbox.high_water_slots, runtime.connection.generation,
      metrics.protocol_failures, metrics.control_receive_failures,
      metrics.control_send_failures, metrics.control_inbox_deferrals,
      metrics.last_capnweb_status, runtime.speaker_margin_min_ms, 0U,
      runtime.speaker_writes, outbox.current_slots,
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS);
  return length > 0 && static_cast<size_t>(length) < capacity ?
      static_cast<size_t>(length) : 0U;
}

capnweb_status set_bool_reply(capnweb_reply *reply) {
  return capnweb_reply_set_boolean(reply, true);
}

capnweb_status capability_start_call(void *, const capnweb_call *,
                                     capnweb_reply *reply) {
  runtime.wants_call = true;
  return set_bool_reply(reply);
}

capnweb_status capability_hang_up(void *, const capnweb_call *,
                                 capnweb_reply *reply) {
  runtime.wants_talk = false;
  runtime.wants_call = false;
  return set_bool_reply(reply);
}

capnweb_status capability_talk_start(void *, const capnweb_call *,
                                    capnweb_reply *reply) {
  runtime.wants_talk = true;
  return set_bool_reply(reply);
}

capnweb_status capability_talk_stop(void *, const capnweb_call *,
                                   capnweb_reply *reply) {
  runtime.wants_talk = false;
  return set_bool_reply(reply);
}

capnweb_status capability_health(void *, const capnweb_call *,
                                 capnweb_reply *reply) {
  static std::array<char, 1536> text{};
  const size_t length = health_json(text.data(), text.size());
  if (length == 0U) {
    return capnweb_reply_set_error(reply, "Error", "health overflow");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, text.data(), length, nullptr, nullptr);
}

void request_process_restart(uint64_t now) {
  if (!runtime.restart_requested) runtime.restart_requested_at_ms = now;
  runtime.restart_requested = true;
}

capnweb_status capability_restart(void *, const capnweb_call *,
                                  capnweb_reply *reply) {
  request_process_restart(now_ms(nullptr));
  return set_bool_reply(reply);
}

iterate_kit_module host_module() {
  static const char *const start_path[] = {"conversation", "start"};
  static const char *const hangup_path[] = {"conversation", "hangUp"};
  static const char *const talk_start_path[] = {"pushToTalk", "start"};
  static const char *const talk_stop_path[] = {"pushToTalk", "stop"};
  static const char *const health_path[] = {"health"};
  static const char *const restart_path[] = {"restart"};
  static const iterate_kit_method methods[] = {
      {start_path, 2U, capability_start_call},
      {hangup_path, 2U, capability_hang_up},
      {talk_start_path, 2U, capability_talk_start},
      {talk_stop_path, 2U, capability_talk_stop},
      {health_path, 1U, capability_health},
      {restart_path, 1U, capability_restart},
  };
  iterate_kit_module module{};
  module.methods = methods;
  module.method_count = sizeof(methods) / sizeof(methods[0]);
  return module;
}

bool append_stats() {
  std::array<char, 1792> message{};
  static constexpr char prefix[] =
      "[{\"type\":\"voicelab/dev-stats\",\"ephemeral\":true,\"payload\":";
  const size_t prefix_length = sizeof(prefix) - 1U;
  std::memcpy(message.data(), prefix, prefix_length);
  const size_t body = health_json(message.data() + prefix_length,
                                  message.size() - prefix_length - 3U);
  if (body == 0U) return false;
  message[prefix_length + body] = '}';
  message[prefix_length + body + 1U] = ']';
  return iterate_kit_voicelab_append_raw(
      &runtime.voicelab, message.data(), prefix_length + body + 2U) ==
      CAPNWEB_OK;
}

bool load_utterances(const char *directory) {
  DIR *dir = opendir(directory);
  if (dir == nullptr) return false;
  for (dirent *entry = readdir(dir); entry != nullptr; entry = readdir(dir)) {
    const std::string name(entry->d_name);
    if (name.size() < 4U || name.substr(name.size() - 4U) != ".wav") continue;
    if (runtime.utterances.size() >= kMaxUtterances) {
      closedir(dir);
      log_line("error", "utterance directory exceeds fixed %zu-file budget",
               kMaxUtterances);
      return false;
    }
    runtime.utterances.emplace_back(std::string(directory) + "/" + name);
  }
  closedir(dir);
  std::sort(runtime.utterances.begin(), runtime.utterances.end());
  return !runtime.utterances.empty();
}

const std::string *select_utterance(bool colleague) {
  if (colleague) {
    for (const auto &path : runtime.utterances) {
      if (path.find("weather") != std::string::npos ||
          path.find("colleague") != std::string::npos) return &path;
    }
    log_line("error",
             "--colleague-every requested but no weather/colleague WAV exists");
    return nullptr;
  }
  for (size_t attempts = 0; attempts < runtime.utterances.size(); ++attempts) {
    const std::string &path =
        runtime.utterances[runtime.ordinary_index++ % runtime.utterances.size()];
    if (path.find("weather") == std::string::npos &&
        path.find("colleague") == std::string::npos) return &path;
  }
  return &runtime.utterances.front();
}

void begin_turn_report(const std::string &path, bool colleague, uint64_t now) {
  if (runtime.turn_count >= runtime.turns.size()) {
    log_line("error", "conversation exceeds fixed %zu-turn report budget",
             runtime.turns.size());
    runtime.stop_requested = true;
    return;
  }
  TurnReport &turn = runtime.turns[runtime.turn_count++];
  std::snprintf(turn.utterance, sizeof(turn.utterance), "%s", path.c_str());
  turn.colleague = colleague;
  turn.started_ms = now;
  /* Store baselines in output fields until completion turns them into deltas. */
  turn.frames_sent = runtime.voicelab.frames_sent;
  turn.sequence_gaps = runtime.playout.gaps;
  runtime.current_turn = &turn;
  if (colleague) ++runtime.colleague_asked;
}

void conversation_driver(uint64_t now) {
  if (runtime.driver == DriverState::kDisabled ||
      runtime.driver == DriverState::kFinished) return;
  if (now >= runtime.finish_at_ms) {
    runtime.wants_talk = false;
    runtime.wants_call = false;
    if (runtime.current_turn != nullptr) {
      runtime.current_turn->failed = runtime.current_turn->frames_played == 0U;
      runtime.current_turn->completed_ms = now;
      runtime.current_turn = nullptr;
    }
    runtime.driver = DriverState::kFinished;
    runtime.stop_requested = true;
    return;
  }
  switch (runtime.driver) {
    case DriverState::kWaitCall:
      runtime.wants_call = true;
      if (runtime.voicelab.call_active) runtime.driver = DriverState::kStartTurn;
      break;
    case DriverState::kStartTurn: {
      if (!runtime.voicelab.call_active) {
        runtime.driver = DriverState::kWaitCall;
        break;
      }
      const size_t number = runtime.turn_count + 1U;
      const bool colleague = runtime.options.colleague_every != 0U &&
          number % runtime.options.colleague_every == 0U;
      const std::string *path = select_utterance(colleague);
      if (path == nullptr || !wav_source_open(&runtime.source, path->c_str())) {
        log_line("error", "cannot open utterance for turn %zu", number);
        runtime.stop_requested = true;
        break;
      }
      begin_turn_report(*path, colleague, now);
      /* Whatever finished before this turn belongs to the turn before it. */
      runtime.answer_done = false;
      runtime.source_finished = false;
      runtime.wants_talk = true;
      runtime.driver = DriverState::kSending;
      log_line("info", "turn=%zu colleague=%s utterance=%s", number,
               colleague ? "true" : "false", path->c_str());
      break;
    }
    case DriverState::kSending:
      if (runtime.source_finished && runtime.mic_ring.used == 0U) {
        runtime.wants_talk = false;
        runtime.driver = DriverState::kWaitAnswer;
        if (runtime.current_turn != nullptr) runtime.current_turn->committed_ms = now;
      }
      break;
    case DriverState::kWaitAnswer:
      if (!runtime.voicelab.call_active) runtime.driver = DriverState::kWaitCall;
      break;
    case DriverState::kGap:
      if (now >= runtime.next_driver_at_ms) runtime.driver = DriverState::kStartTurn;
      break;
    case DriverState::kDisabled:
    case DriverState::kFinished:
      break;
  }
}

void microphone_poll(uint64_t now) {
  if (runtime.next_mic_at_ms == 0U) runtime.next_mic_at_ms = now;
  if (now < runtime.next_mic_at_ms) return;
  runtime.next_mic_at_ms += ITERATE_KIT_VOICE_FRAME_MS;
  if (now > runtime.next_mic_at_ms + ITERATE_KIT_VOICE_FRAME_MS * 4U) {
    ++runtime.mic_frames_dropped;
    runtime.next_mic_at_ms = now + ITERATE_KIT_VOICE_FRAME_MS;
  }
  if (!runtime.talking) {
    ++runtime.mic_frames_gated;
    return;
  }
  std::array<uint8_t, ITERATE_KIT_VOICE_FRAME_BYTES> captured{};
  if (!runtime.source_finished &&
      !wav_source_frame(&runtime.source, captured.data())) {
    runtime.source_finished = true;
  } else if (!runtime.source_finished) {
    ++runtime.mic_frames_captured;
    mic_ring_push_latest(&runtime.mic_ring, captured.data());
  }
  if (runtime.mic_ring.used < ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND &&
      !runtime.source_finished) return;
  if (runtime.mic_ring.used == 0U) return;
  struct iterate_kit_spsc_ring_metrics outbox{};
  iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox);
  const size_t free_slots = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS -
      outbox.current_slots;
  if (free_slots < ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE) {
    /*
     * The capture lane keeps running under control-lane pressure. Its fixed
     * 32-frame latest-wins ring, rather than the transport, decides which old
     * audio is sacrificed if pressure lasts long enough.
     */
    return;
  }
  std::array<const uint8_t *, ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND> pointers{};
  const size_t frame_count = std::min<size_t>(
      runtime.mic_ring.used, ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND);
  for (size_t i = 0; i < frame_count; ++i) {
    pointers[i] = runtime.mic_ring.frames[
        (runtime.mic_ring.read + i) % runtime.mic_ring.frames.size()].data();
  }
  const capnweb_status status = iterate_kit_voicelab_append_frames(
      &runtime.voicelab, pointers.data(), frame_count,
      ITERATE_KIT_VOICE_FRAME_BYTES, runtime.frame_sequence, now);
  if (status == CAPNWEB_OK) {
    runtime.frame_sequence += static_cast<uint32_t>(frame_count);
    runtime.mic_ring.read =
        (runtime.mic_ring.read + frame_count) % runtime.mic_ring.frames.size();
    runtime.mic_ring.used -= frame_count;
    runtime.flush_frames_left = static_cast<uint32_t>(runtime.mic_ring.used);
  }
}

void reconcile_turn(uint64_t now, size_t outbox_free) {
  const bool wants_talk = runtime.wants_call && runtime.wants_talk;
  if (runtime.talking && !runtime.flushing_turn &&
      (runtime.voicelab.state != ITERATE_KIT_VOICELAB_READY ||
       !runtime.voicelab.call_active)) {
    runtime.talking = false;
    runtime.flushing_turn = false;
  }
  if (runtime.talking && !runtime.flushing_turn &&
      iterate_kit_voice_elapsed_ms(now, runtime.turn_started_ms) > ITERATE_KIT_VOICE_TURN_MAX_MS) {
    runtime.wants_talk = false;
  }
  if (wants_talk && !runtime.talking && runtime.voicelab.call_active &&
      outbox_free >= 3U) {
    if (runtime.driver == DriverState::kDisabled) {
      if (!wav_source_open(&runtime.source, runtime.options.mic_wav)) {
        log_line("error", "cannot rewind microphone WAV for new turn");
        runtime.wants_talk = false;
        return;
      }
      runtime.source_finished = false;
    }
    runtime.talking = true;
    runtime.flushing_turn = false;
    runtime.turn_started_ms = now;
    runtime.frame_sequence = 0U;
    mic_ring_clear(&runtime.mic_ring);
    ring_clear(&runtime.speaker_ring);
    iterate_kit_playout_interrupt(&runtime.playout);
    iterate_kit_voice_playback_clock_reprime(&runtime.playback_clock);
    (void)iterate_kit_voicelab_mark_turn(
        &runtime.voicelab, ITERATE_KIT_VOICELAB_TURN_START);
  }
  if (!wants_talk && runtime.talking && !runtime.flushing_turn) {
    runtime.flushing_turn = true;
    runtime.flush_frames_left = static_cast<uint32_t>(runtime.mic_ring.used);
    runtime.flush_deadline_ms = now + ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS;
  }
  if (runtime.flushing_turn &&
      (runtime.mic_ring.used == 0U || now >= runtime.flush_deadline_ms)) {
    if (runtime.mic_ring.used != 0U) {
      runtime.mic_frames_dropped += static_cast<uint32_t>(runtime.mic_ring.used);
      mic_ring_clear(&runtime.mic_ring);
    }
    runtime.talking = false;
    runtime.flushing_turn = false;
    (void)iterate_kit_voicelab_mark_turn(
        &runtime.voicelab, ITERATE_KIT_VOICELAB_TURN_COMMIT);
  }
}

uint32_t histogram_percentile(const TurnReport &turn, uint32_t percentile) {
  if (turn.occupancy_samples == 0U) return 0U;
  const uint32_t target =
      (turn.occupancy_samples * percentile + 99U) / 100U;
  uint32_t seen = 0;
  for (size_t i = 0; i < turn.occupancy_histogram.size(); ++i) {
    seen += turn.occupancy_histogram[i];
    if (seen >= target) return static_cast<uint32_t>(i);
  }
  return static_cast<uint32_t>(turn.occupancy_histogram.size() - 1U);
}

void json_string(FILE *file, const char *text) {
  std::fputc('"', file);
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text);
       *p != '\0'; ++p) {
    if (*p == '"' || *p == '\\') std::fputc('\\', file);
    if (*p >= 0x20U) std::fputc(*p, file);
  }
  std::fputc('"', file);
}

template <typename Getter>
void write_distribution(FILE *file, Getter getter) {
  std::vector<uint64_t> values;
  values.reserve(runtime.turn_count);
  for (size_t i = 0; i < runtime.turn_count; ++i) values.push_back(getter(runtime.turns[i]));
  std::sort(values.begin(), values.end());
  auto at = [&](size_t numerator) -> uint64_t {
    if (values.empty()) return 0U;
    return values[(values.size() - 1U) * numerator / 100U];
  };
  std::fprintf(file,
      "{\"min\":%" PRIu64 ",\"p10\":%" PRIu64
      ",\"p50\":%" PRIu64 ",\"p90\":%" PRIu64 ",\"max\":%" PRIu64 "}",
      values.empty() ? 0U : values.front(), at(10U), at(50U), at(90U),
      values.empty() ? 0U : values.back());
}

bool write_report() {
  FILE *file = std::fopen(runtime.options.report_json, "w");
  if (file == nullptr) return false;
  size_t failures = 0;
  std::fprintf(file, "{\n  \"turns\":[\n");
  for (size_t i = 0; i < runtime.turn_count; ++i) {
    const TurnReport &turn = runtime.turns[i];
    if (turn.failed) ++failures;
    std::fprintf(file, "    {\"index\":%zu,\"utterance\":", i + 1U);
    json_string(file, turn.utterance);
    std::fprintf(file,
        ",\"colleague\":%s,\"failure\":%s,\"timeToFirstAudioMs\":%" PRIu64
        ",\"timeToAnswerCompleteMs\":%" PRIu64
        ",\"framesSent\":%u,\"framesReceived\":%u,\"framesPlayed\":%u,"
        "\"framesConcealed\":%u,\"sequenceGaps\":%u,\"underruns\":%u,"
        "\"ringOccupancyMs\":{\"min\":%u,\"p10\":%u,\"max\":%u}}%s\n",
        turn.colleague ? "true" : "false", turn.failed ? "true" : "false",
        turn.first_audio_ms == 0U ? 0U : turn.first_audio_ms - turn.committed_ms,
        turn.completed_ms > turn.committed_ms ?
            turn.completed_ms - turn.committed_ms : 0U,
        turn.frames_sent, turn.frames_received, turn.frames_played,
        turn.frames_concealed, turn.sequence_gaps, turn.underruns,
        turn.occupancy_min_ms == UINT32_MAX ? 0U : turn.occupancy_min_ms,
        histogram_percentile(turn, 10U), turn.occupancy_max_ms,
        i + 1U == runtime.turn_count ? "" : ",");
  }
  std::fprintf(file, "  ],\n  \"distributions\":{");
  std::fprintf(file, "\"timeToFirstAudioMs\":");
  write_distribution(file, [](const TurnReport &turn) {
    return turn.first_audio_ms == 0U ? 0U : turn.first_audio_ms - turn.committed_ms;
  });
  std::fprintf(file, ",\"timeToAnswerCompleteMs\":");
  write_distribution(file, [](const TurnReport &turn) {
    return turn.completed_ms > turn.committed_ms ? turn.completed_ms - turn.committed_ms : 0U;
  });
  std::fprintf(file, ",\"framesSent\":");
  write_distribution(file, [](const TurnReport &turn) { return turn.frames_sent; });
  std::fprintf(file, ",\"framesReceived\":");
  write_distribution(file, [](const TurnReport &turn) { return turn.frames_received; });
  std::fprintf(file, ",\"framesPlayed\":");
  write_distribution(file, [](const TurnReport &turn) { return turn.frames_played; });
  std::fprintf(file, ",\"framesConcealed\":");
  write_distribution(file, [](const TurnReport &turn) { return turn.frames_concealed; });
  std::fprintf(file, ",\"sequenceGaps\":");
  write_distribution(file, [](const TurnReport &turn) { return turn.sequence_gaps; });
  std::fprintf(file, ",\"underruns\":");
  write_distribution(file, [](const TurnReport &turn) { return turn.underruns; });
  std::fprintf(file, ",\"ringOccupancyMinMs\":");
  write_distribution(file, [](const TurnReport &turn) {
    return turn.occupancy_samples == 0U ? 0U : turn.occupancy_min_ms;
  });
  std::fprintf(file, ",\"ringOccupancyP10Ms\":");
  write_distribution(file, [](const TurnReport &turn) {
    return histogram_percentile(turn, 10U);
  });
  std::fprintf(file, ",\"ringOccupancyMaxMs\":");
  write_distribution(file, [](const TurnReport &turn) {
    return turn.occupancy_max_ms;
  });
  std::fprintf(file,
      "},\n  \"summary\":{\"turns\":%zu,\"failedTurns\":%zu,"
      "\"sessionRestarts\":%u,\"transportRestarts\":%u,"
      "\"connectionRecycles\":%u,\"callsLost\":%u,"
      "\"colleagueQuestionsAsked\":%u,\"colleagueQuestionsAnswered\":%u}\n}\n",
      runtime.turn_count, failures, runtime.session_restarts,
      runtime.transport_restarts, runtime.downlink_recycles,
      runtime.calls_lost, runtime.colleague_asked, runtime.colleague_answered);
  const bool ok = std::fclose(file) == 0;
  std::fprintf(stderr,
      "conversation summary: turns=%zu failures=%zu sessions=%u transports=%u "
      "recycles=%u callsLost=%u colleague=%u/%u report=%s playback=%s\n",
      runtime.turn_count, failures, runtime.session_restarts,
      runtime.transport_restarts, runtime.downlink_recycles, runtime.calls_lost,
      runtime.colleague_answered, runtime.colleague_asked,
      runtime.options.report_json, runtime.options.speaker_wav);
  return ok;
}

bool initialize_runtime() {
  if (!copy_field(runtime.configuration.project_id,
                  sizeof(runtime.configuration.project_id),
                  runtime.options.project_id) ||
      !copy_field(runtime.configuration.project_api_key,
                  sizeof(runtime.configuration.project_api_key),
                  runtime.options.project_api_key) ||
      !copy_field(runtime.configuration.os_base_url,
                  sizeof(runtime.configuration.os_base_url),
                  runtime.options.os_base_url) ||
      !copy_field(runtime.configuration.pcm_base_url,
                  sizeof(runtime.configuration.pcm_base_url),
                  runtime.options.os_base_url)) {
    log_line("error", "configuration value missing or exceeds firmware bound");
    return false;
  }
  if (iterate_kit_spsc_ring_init(
          &runtime.control_inbox, runtime.inbox_storage.data(),
          ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY,
          ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS,
          runtime.inbox_lengths.data()) != ITERATE_KIT_OK ||
      iterate_kit_spsc_ring_init(
          &runtime.control_outbox, runtime.outbox_storage.data(),
          ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
          ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
          runtime.outbox_lengths.data()) != ITERATE_KIT_OK) {
    log_line("error", "bounded control ring initialization failed");
    return false;
  }
  runtime.module = host_module();
  static const char description[] =
      "{\"instructions\":\"The macOS execution target of the Iterate voice "
      "device. It has the device's bounded queues, manual push-to-talk call, "
      "speaker playout policy, health and restart controls.\",\"children\":{"
      "\"conversation\":{\"start\":\"Start a voice call.\","
      "\"hangUp\":\"End the voice call.\"},\"pushToTalk\":{"
      "\"start\":\"Begin the configured WAV utterance.\","
      "\"stop\":\"Commit the utterance and ask for an answer.\"},"
      "\"health\":\"Return device-compatible health JSON.\","
      "\"restart\":\"Re-exec this process.\"}}";
  iterate_kit_peer_options peer_options{};
  peer_options.description_expression = description;
  peer_options.description_expression_length = sizeof(description) - 1U;
  peer_options.modules = &runtime.module;
  peer_options.module_count = 1U;
  if (iterate_kit_peer_init(&runtime.peer, &peer_options) != CAPNWEB_OK) {
    log_line("error", "capability peer initialization failed");
    return false;
  }
  runtime.mount_path[1] = runtime.options.name;
  iterate_kit_itx_connection_options connection_options{};
  connection_options.pending_calls = runtime.pending_calls.data();
  connection_options.pending_call_count = runtime.pending_calls.size();
  connection_options.exports = runtime.exports.data();
  connection_options.export_count = runtime.exports.size();
  connection_options.imports = runtime.imports.data();
  connection_options.import_count = runtime.imports.size();
  connection_options.tokens = runtime.tokens.data();
  connection_options.token_count = runtime.tokens.size();
  connection_options.outbound_buffer = runtime.output.data();
  connection_options.outbound_buffer_size = runtime.output.size();
  connection_options.send_text = iterate_kit_posix_itx_transport_send_text;
  connection_options.send_text_context = &runtime.transport;
  connection_options.project_id = runtime.configuration.project_id;
  connection_options.project_api_key = runtime.configuration.project_api_key;
  connection_options.mount_path = runtime.mount_path;
  connection_options.mount_path_count = 2U;
  connection_options.capability = iterate_kit_peer_capability(&runtime.peer);
  connection_options.instructions = "Iterate voice device (macOS CLI target)";
  connection_options.session_ended = on_session_ended;
  if (iterate_kit_itx_connection_init(
          &runtime.connection, &connection_options) != CAPNWEB_OK) {
    log_line("error", "Cap'n Web connection initialization failed");
    return false;
  }
  iterate_kit_posix_itx_transport_options transport_options{};
  transport_options.configuration = &runtime.configuration;
  transport_options.connection = &runtime.connection;
  transport_options.control_inbox = &runtime.control_inbox;
  transport_options.control_outbox = &runtime.control_outbox;
  transport_options.DANGEROUS_disable_certificate_verification =
      runtime.options.insecure;
  if (iterate_kit_posix_itx_transport_prepare(
          &runtime.transport, &transport_options) != ITERATE_KIT_OK ||
      iterate_kit_posix_itx_transport_start(&runtime.transport) !=
          ITERATE_KIT_OK) {
    log_line("error", "POSIX itx transport initialization failed");
    return false;
  }
  if (!wav_sink_open(&runtime.sink, runtime.options.speaker_wav)) {
    log_line("error", "cannot open speaker WAV: %s", runtime.options.speaker_wav);
    return false;
  }
  if (runtime.options.live_audio && !audio_queue_open(&runtime.live_sink)) {
    log_line("error", "CoreAudio output initialization failed");
    return false;
  }
  if (runtime.options.converse_minutes > 0.0) {
    if (!load_utterances(runtime.options.utterance_dir)) {
      log_line("error", "no usable WAVs in %s", runtime.options.utterance_dir);
      return false;
    }
    runtime.driver = DriverState::kWaitCall;
  } else if (!wav_source_open(&runtime.source, runtime.options.mic_wav)) {
    log_line("error", "invalid microphone WAV: %s", runtime.options.mic_wav);
    return false;
  }
  runtime.started_ms = now_ms(nullptr);
  if (runtime.options.converse_minutes > 0.0) {
    runtime.finish_at_ms = runtime.started_ms + static_cast<uint64_t>(
        runtime.options.converse_minutes * 60000.0);
  }
  iterate_kit_playout_reset(&runtime.playout, 1U);
  iterate_kit_voice_playback_clock_init(&runtime.playback_clock);
  log_line("info",
      "iterate-kit-cli ready mount=kit.%s stream=%s staticBytes=%zu outbox=%u",
      runtime.options.name, runtime.options.stream_path, sizeof(runtime),
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS);
  return true;
}

void start_voicelab_if_ready() {
  if (runtime.transport.state != ITERATE_KIT_POSIX_ITX_READY ||
      runtime.connection.state != ITERATE_KIT_ITX_CONNECTION_READY ||
      runtime.voicelab_generation == runtime.connection.generation) return;
  iterate_kit_voicelab_options options{};
  options.session = &runtime.connection.session;
  options.project_id = runtime.configuration.project_id;
  options.project_api_key = runtime.configuration.project_api_key;
  options.stream_path = runtime.options.stream_path;
  options.call_id = runtime.options.name;
  options.now_ms = now_ms;
  options.on_speaker = on_speaker;
  options.on_control = on_control;
  options.on_transcript = on_transcript;
  const capnweb_status status = iterate_kit_voicelab_start(
      &runtime.voicelab, &options);
  if (status == CAPNWEB_OK) {
    if (runtime.mounted_once) ++runtime.session_restarts;
    runtime.mounted_once = true;
    runtime.voicelab_generation = runtime.connection.generation;
    runtime.frame_sequence = 0U;
    log_line("info", "voicelab mount generation=%u",
             runtime.connection.generation);
  } else {
    log_line("error", "voicelab start failed status=%d", status);
  }
}

void supervise(uint64_t now, size_t outbox_free) {
  if (runtime.transport.state == ITERATE_KIT_POSIX_ITX_FAILED) {
    if (runtime.unhealthy_since_ms == 0U) runtime.unhealthy_since_ms = now;
    if (iterate_kit_voice_elapsed_ms(now, runtime.unhealthy_since_ms) >
        ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS) {
      log_line("error", "transport unrecoverable; re-exec requested");
      request_process_restart(now);
    }
  } else {
    runtime.unhealthy_since_ms = 0U;
  }
  if (runtime.last_liveness_ms == 0U) runtime.last_liveness_ms = now;
  if (runtime.voicelab.ping_count != runtime.last_ping_count) {
    runtime.last_ping_count = runtime.voicelab.ping_count;
    runtime.last_liveness_ms = now;
  }
  if (runtime.transport.state != ITERATE_KIT_POSIX_ITX_READY) {
    runtime.last_liveness_ms = now;
  }
  if (runtime.voicelab.ping_pending &&
      iterate_kit_voice_elapsed_ms(now, runtime.voicelab.ping_started_ms) >
          ITERATE_KIT_VOICE_PING_TIMEOUT_MS &&
      now >= runtime.next_liveness_restart_at_ms) {
    runtime.next_liveness_restart_at_ms =
        now + ITERATE_KIT_VOICE_PING_TIMEOUT_MS;
    ++runtime.liveness_restarts;
    ++runtime.transport_restarts;
    iterate_kit_posix_itx_transport_request_restart(&runtime.transport);
  }
  if (iterate_kit_voice_elapsed_ms(now, runtime.last_liveness_ms) >
      ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS) {
    request_process_restart(now);
  }
  if (runtime.voicelab.state != ITERATE_KIT_VOICELAB_READY) return;
  if (runtime.voicelab.call_active && runtime.voicelab.last_bridge_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_bridge_ms) >
          ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS) {
    /*
     * Dropping a call is the most consequential thing this loop does — it
     * throws away a live provider session and makes the next turn wait for a
     * whole new one — so it says why, with the ages that decided it. Counting
     * it silently made "callsLost=42" a number with no story attached.
     */
    log_line("warn",
             "call dropped: no bridge event for %llums (bridgeAge=%llu batchAge=%llu "
             "batches=%u rtt=%u)",
             (unsigned long long)ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS,
             (unsigned long long)(iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_bridge_ms)),
             (unsigned long long)(runtime.voicelab.last_batch_ms == 0U
                                      ? 0U
                                      : iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_batch_ms)),
             runtime.voicelab.batches_on_connection,
             runtime.voicelab.last_rtt_ms);
    ++runtime.bridge_losses;
    ++runtime.calls_lost;
    iterate_kit_voicelab_forget_call(&runtime.voicelab);
    runtime.next_call_attempt_at_ms = 0U;
  }
  if (runtime.wants_call && runtime.voicelab.has_connection_capability &&
      !runtime.voicelab.recycle_pending && outbox_free >= 4U &&
      runtime.voicelab.last_batch_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now, runtime.voicelab.last_batch_ms) >
          ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS) {
    ++runtime.downlink_recycles;
    if (runtime.downlink_recycles_running >= 3U) {
      runtime.downlink_recycles_running = 0U;
      ++runtime.transport_restarts;
      iterate_kit_posix_itx_transport_request_restart(&runtime.transport);
    } else {
      ++runtime.downlink_recycles_running;
      runtime.voicelab.last_batch_ms = now;
      (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
    }
  }
  if (runtime.downlink_recycles_running > 0U &&
      runtime.voicelab.batches_on_connection > 0U) {
    runtime.downlink_recycles_running = 0U;
  }
}

void reconcile_call(uint64_t now, size_t outbox_free) {
  if (runtime.voicelab.call_pending && runtime.call_pending_since_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now, runtime.call_pending_since_ms) > kCallPendingTimeoutMs) {
    iterate_kit_voicelab_forget_call(&runtime.voicelab);
    runtime.call_pending_since_ms = 0U;
    runtime.next_call_attempt_at_ms = 0U;
  }
  if (!runtime.voicelab.call_pending) runtime.call_pending_since_ms = 0U;
  if (runtime.wants_call && !runtime.voicelab.call_active &&
      !runtime.voicelab.call_pending && outbox_free >= 3U &&
      now >= runtime.next_call_attempt_at_ms) {
    runtime.call_pending_since_ms = now;
    runtime.next_call_attempt_at_ms = now + kCallStartRetryMs;
    (void)iterate_kit_voicelab_start_call(
        &runtime.voicelab,
        "Hi, I am your Iterate device. What can I do for you?");
  }
  if (!runtime.wants_call && runtime.voicelab.call_active && outbox_free >= 3U) {
    (void)iterate_kit_voicelab_end_call(&runtime.voicelab, "host-cli");
  }
}

void pulse(uint64_t now, const struct iterate_kit_spsc_ring_metrics &outbox) {
  if (!(runtime.talking || runtime.voicelab.call_active ||
        iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) < 3000U)) return;
  if (iterate_kit_voice_elapsed_ms(now, runtime.last_pulse_ms) < 1000U) return;
  runtime.last_pulse_ms = now;
  log_line("info",
      "pulse loops=%u outbox=%u/%u sent=%u frames=%u batches=%u rx=%u "
      "gaps=%u played=%u conceal=%u under=%u ringMs=%zu",
      runtime.loop_count, outbox.current_slots,
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
      runtime.transport.control_sender.messages_sent,
      runtime.voicelab.frames_sent, runtime.voicelab.batches_on_connection,
      runtime.voicelab.spk_frames_received, runtime.playout.gaps,
      runtime.speaker_frames_played, runtime.speaker_conceal_frames,
      runtime.speaker_underruns, runtime.speaker_ring.used / 32U);
}

/**
 * Say what changed, once per change.
 *
 * Everything a person needs to answer "why is it not talking?" is a state
 * transition: the transport reaching ready, the voicelab mount walking
 * authenticate -> project -> stream -> connection, or either of them failing.
 * Polled at 200 Hz these must be edge-triggered or they drown the log.
 */
void announce_states() {
  if (runtime.transport.state != runtime.announced_transport) {
    runtime.announced_transport = runtime.transport.state;
    /*
     * A failure carries its evidence with it. "transport state=failed" on its
     * own sends a person to a packet capture; the errno and the counters say
     * in one line whether the socket never opened, the handshake was refused,
     * or the mount ran out of time with the socket perfectly healthy.
     */
    if (runtime.transport.state == ITERATE_KIT_POSIX_ITX_FAILED) {
      log_line("error",
          "transport state=failed url=%s errno=%d capnweb=%d starts=%u opens=%u "
          "errors=%u disconnects=%u mountTimeouts=%u protoFail=%u recvFail=%u "
          "fatal=%u/%u",
          runtime.transport.websocket_url,
          static_cast<int>(runtime.transport.last_platform_error),
          static_cast<int>(runtime.transport.last_capnweb_status),
          runtime.transport.websocket_start_attempts,
          runtime.transport.websocket_connections,
          runtime.transport.websocket_errors,
          runtime.transport.websocket_disconnects,
          runtime.transport.mount_timeouts,
          runtime.transport.protocol_failures,
          runtime.transport.control_receive_failures,
          static_cast<unsigned>(runtime.transport.fatal_failure_latched),
          runtime.transport.fatal_failure_reason);
    } else {
      log_line("info", "transport state=%s",
          iterate_kit_posix_itx_transport_state_name(runtime.transport.state));
    }
  }
  if (runtime.voicelab.state != runtime.announced_voicelab ||
      runtime.voicelab.failure != runtime.announced_failure) {
    runtime.announced_voicelab = runtime.voicelab.state;
    runtime.announced_failure = runtime.voicelab.failure;
    log_line(
        runtime.voicelab.failure == ITERATE_KIT_VOICELAB_FAILURE_NONE ? "info"
                                                                     : "error",
        "voicelab state=%s failure=%s capnweb=%d",
        iterate_kit_voicelab_state_name(runtime.voicelab.state),
        iterate_kit_voicelab_failure_name(runtime.voicelab.failure),
        static_cast<int>(runtime.voicelab.capnweb_status));
  }
}

void run_loop() {
  while (!runtime.stop_requested && interrupted == 0) {
    const uint64_t now = now_ms(nullptr);
    (void)iterate_kit_posix_itx_transport_poll(&runtime.transport, 16U);
    announce_states();
    start_voicelab_if_ready();
    playback_poll(now);
    conversation_driver(now);
    struct iterate_kit_spsc_ring_metrics outbox{};
    iterate_kit_spsc_ring_metrics(&runtime.control_outbox, &outbox);
    const size_t outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS -
        outbox.current_slots;
    supervise(now, outbox_free);
    if (runtime.voicelab.state == ITERATE_KIT_VOICELAB_READY &&
        runtime.transport.state == ITERATE_KIT_POSIX_ITX_READY &&
        runtime.voicelab_generation == runtime.connection.generation) {
      reconcile_call(now, outbox_free);
      reconcile_turn(now, outbox_free);
      microphone_poll(now);
      if (iterate_kit_voicelab_needs_recycle(&runtime.voicelab) &&
          runtime.speaker_ring.used == 0U && !runtime.talking &&
          outbox_free >= 4U) {
        ++runtime.downlink_recycles;
        (void)iterate_kit_voicelab_recycle_connection(&runtime.voicelab);
      }
      if (runtime.next_ping_at_ms == 0U) {
        runtime.next_ping_at_ms = now + 1000U;
        runtime.next_stats_at_ms = now + ITERATE_KIT_VOICE_STATS_INTERVAL_MS;
      }
      if (now >= runtime.next_ping_at_ms && outbox_free >= 3U) {
        (void)iterate_kit_voicelab_ping(&runtime.voicelab);
        runtime.next_ping_at_ms = now + ITERATE_KIT_VOICE_PING_INTERVAL_MS;
      }
      if (now >= runtime.next_stats_at_ms && outbox_free >= 3U) {
        if (!append_stats()) log_line("error", "dev-stats append failed");
        runtime.next_stats_at_ms = now + ITERATE_KIT_VOICE_STATS_INTERVAL_MS;
      }
      pulse(now, outbox);
    }
    ++runtime.loop_count;
    /* Give the one-way transport a full poll interval to put the reply on wire. */
    if (runtime.restart_requested &&
        iterate_kit_voice_elapsed_ms(now, runtime.restart_requested_at_ms) >= 400U) {
      log_line("warn", "re-executing iterate-kit-cli");
      wav_sink_close(&runtime.sink);
      audio_queue_close(&runtime.live_sink);
      (void)iterate_kit_posix_itx_transport_stop(&runtime.transport);
      execv(runtime.argv[0], runtime.argv);
      log_line("error", "execv failed errno=%d", errno);
      runtime.stop_requested = true;
    }
    timespec delay{};
    delay.tv_nsec = static_cast<long>(kLoopMs) * 1000000L;
    (void)nanosleep(&delay, nullptr);
  }
}

void signal_handler(int) { interrupted = 1; }

}  // namespace

int main(int argc, char **argv) {
  runtime.argc = argc;
  runtime.argv = argv;
  if (!parse_options(argc, argv, &runtime.options)) {
    print_help(stderr);
    return 2;
  }
  std::signal(SIGINT, signal_handler);
  std::signal(SIGTERM, signal_handler);
  if (!initialize_runtime()) {
    wav_sink_close(&runtime.sink);
    audio_queue_close(&runtime.live_sink);
    return 1;
  }
  run_loop();
  (void)iterate_kit_posix_itx_transport_stop(&runtime.transport);
  if (runtime.source.file != nullptr) std::fclose(runtime.source.file);
  wav_sink_close(&runtime.sink);
  audio_queue_close(&runtime.live_sink);
  if (runtime.options.converse_minutes > 0.0 && !write_report()) {
    log_line("error", "failed to write report: %s", runtime.options.report_json);
    return 1;
  }
  return 0;
}
