/*
 * These tests run the actual ESP-IDF WebSocket transport selected by the
 * firmware build. The parent TCP/TLS byte stream is scripted, but the upgrade,
 * frame header parser, payload bookkeeping, and project override are real.
 * That is the lowest-cost way to keep our compatibility patch tied to the
 * upstream implementation it corrects.
 */

#include <array>
#include <cstddef>
#include <cstring>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "esp_transport.h"
#include "esp_transport_ws.h"

extern "C" {
#include "Mockesp_tls_crypto.h"
#include "Mockmock_transport.h"
#include "iterate/kit/websocket_rx.h"
}

namespace {

using unique_transport = std::unique_ptr<
    std::remove_pointer_t<esp_transport_handle_t>,
    decltype(&esp_transport_destroy)>;

struct scripted_parent {
  esp_transport_handle_t handle = nullptr;
  std::vector<std::string> reads;
  std::size_t read_index = 0;
  int poll_result = 1;
};

scripted_parent script;

std::string upgrade_response() {
  return "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept:\r\n"
      "\r\n";
}

int accept_all_writes(
    esp_transport_handle_t transport,
    const char *bytes,
    int byte_count,
    int timeout_ms,
    int call_index) {
  (void)call_index;
  REQUIRE(transport == script.handle);
  REQUIRE(bytes != nullptr);
  REQUIRE(byte_count > 0);
  REQUIRE(timeout_ms > 0);
  return byte_count;
}

int read_next_fragment(
    esp_transport_handle_t transport,
    char *destination,
    int capacity,
    int timeout_ms,
    int call_index) {
  (void)timeout_ms;
  (void)call_index;
  REQUIRE(transport == script.handle);
  REQUIRE(destination != nullptr);
  REQUIRE(capacity > 0);
  if (script.read_index == script.reads.size()) {
    return 0;
  }
  const std::string &fragment =
      script.reads[script.read_index++];
  if (fragment.empty()) {
    return 0;
  }
  REQUIRE(fragment.size() <=
      static_cast<std::size_t>(capacity));
  std::memcpy(
      destination, fragment.data(), fragment.size());
  return static_cast<int>(fragment.size());
}

int poll_scripted_parent(
    esp_transport_handle_t transport,
    int timeout_ms,
    int call_index) {
  (void)timeout_ms;
  (void)call_index;
  REQUIRE(transport == script.handle);
  return script.poll_result;
}

struct websocket_fixture {
  unique_transport parent{
      esp_transport_init(), esp_transport_destroy};
  unique_transport websocket{
      nullptr, esp_transport_destroy};

  explicit websocket_fixture(std::vector<std::string> reads)
      : websocket(nullptr, esp_transport_destroy) {
    REQUIRE(parent != nullptr);
    script = {
      .handle = parent.get(),
      .reads = std::move(reads),
      .read_index = 0,
      .poll_result = 1,
    };

    mock_destroy_IgnoreAndReturn(ESP_OK);
    mock_write_Stub(accept_all_writes);
    mock_read_Stub(read_next_fragment);
    mock_poll_read_Stub(poll_scripted_parent);
    mock_connect_ExpectAndReturn(
        parent.get(), "localhost", 8080, 50, ESP_OK);
    esp_crypto_sha1_IgnoreAndReturn(0);
    esp_crypto_base64_encode_IgnoreAndReturn(0);

    esp_transport_set_func(
        parent.get(),
        mock_connect,
        mock_read,
        mock_write,
        mock_close,
        mock_poll_read,
        mock_poll_write,
        mock_destroy);
    websocket.reset(esp_transport_ws_init(parent.get()));
    REQUIRE(websocket != nullptr);
    REQUIRE(esp_transport_connect(
        websocket.get(), "localhost", 8080, 50) == 0);
  }
};

}  // namespace

/*
 * ESP-IDF's upgrade reader can over-read the first WebSocket frame into its
 * private HTTP buffer. Its stock frame reader polls only the now-empty parent
 * socket and therefore strands that already-received audio until some unrelated
 * packet arrives. A voice server is allowed to speak immediately after upgrade,
 * so prove buffered spillover is readable even when the socket itself is idle.
 */
TEST_CASE(
    "upgrade spillover is visible without later socket traffic",
    "[iterate][websocket_transport]") {
  std::string response = upgrade_response();
  response.append(
      std::string{
        static_cast<char>(0x82),
        static_cast<char>(0x04),
        'T',
        'e',
        's',
        't',
      });
  websocket_fixture fixture({response});
  std::array<char, 4> payload{};

  script.poll_result = 0;
  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0) == static_cast<int>(payload.size()));
  REQUIRE(std::string(payload.data(), payload.size()) ==
      "Test");
}

/*
 * Header and payload commonly occupy separate TLS records. If the second half
 * of a 640-byte PCM payload is delayed, a zero-timeout read must retain the
 * first half and its bytes_remaining count. Stock IDF 5.4 clears that count,
 * so recovered payload bytes are parsed as a new frame header and the device
 * reconnects repeatedly under ordinary loss. This exact sequence proves wait,
 * resume, and byte order against the patched real transport.
 */
TEST_CASE(
    "zero payload progress retains the current frame",
    "[iterate][websocket_transport]") {
  websocket_fixture fixture({
    upgrade_response(),
    std::string{
      static_cast<char>(0x82),
      static_cast<char>(0x04),
    },
    "Te",
    "",
    "st",
  });
  std::array<char, 4> payload{};

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0) == 2);
  REQUIRE(std::string(payload.data(), 2) == "Te");

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data() + 2,
      2,
      0) == 0);

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data() + 2,
      2,
      0) == 2);
  REQUIRE(std::string(payload.data(), payload.size()) ==
      "Test");
}

/*
 * The two-byte RFC 6455 header is not guaranteed to occupy one TLS read. A
 * scheduler preemption, record boundary, or ordinary packet loss can expose
 * byte one now and byte two on the next zero-timeout owner pass. Stock IDF's
 * exact-size helper consumes byte one, converts the intervening no-progress
 * result to `-1`, and forgets that byte. Our outer connection must then tear
 * down both its parser and Cap'n Web/PCM generation because framing trust is
 * genuinely gone. That was observed physically as synchronized control and
 * PCM reconnects with `lastTransportErrno == -1` while Wi-Fi remained healthy.
 *
 * The lower parser therefore owns the partial header just as it already owns
 * `bytes_remaining` for a partial payload. IDLE must preserve it, and the next
 * pass must produce the original frame byte-for-byte. A test that merely maps
 * `-1` to IDLE in the outer wrapper would pass over corrupted framing, so this
 * test exercises the real IDF parser through recovery as well.
 */
TEST_CASE(
    "zero header progress retains the current frame",
    "[iterate][websocket_transport][reconnect]") {
  websocket_fixture fixture({
    upgrade_response(),
    std::string{static_cast<char>(0x82)},
    "",
    std::string{static_cast<char>(0x04)},
    "Test",
  });
  std::array<char, 4> payload{};

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0) == 0);
  REQUIRE(esp_transport_ws_get_read_opcode(
      fixture.websocket.get()) == WS_TRANSPORT_OPCODES_NONE);

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0) == static_cast<int>(payload.size()));
  REQUIRE(std::string(payload.data(), payload.size()) ==
      "Test");
  REQUIRE(esp_transport_ws_get_read_opcode(
      fixture.websocket.get()) == WS_TRANSPORT_OPCODES_BINARY);
  REQUIRE(esp_transport_ws_get_read_payload_len(
      fixture.websocket.get()) == static_cast<int>(payload.size()));
  REQUIRE(esp_transport_ws_get_fin_flag(
      fixture.websocket.get()));
}

/*
 * Device PCM uses 640-byte frames, whose wire header includes the 16-bit
 * extended length. Retaining only the two-byte base header would make the
 * four-byte production header look safe in small fixtures while still losing
 * framing whenever the extended length straddles TLS progress. Exercise the
 * exact audio-frame size and stall after the first extended-length byte.
 */
TEST_CASE(
    "zero progress inside a PCM extended header retains the frame",
    "[iterate][websocket_transport][reconnect][pcm]") {
  const std::string pcm_payload(640, 'P');
  websocket_fixture fixture({
    upgrade_response(),
    std::string{
      static_cast<char>(0x82),
      static_cast<char>(0x7e),
    },
    std::string{static_cast<char>(0x02)},
    "",
    std::string{static_cast<char>(0x80)},
    pcm_payload,
  });
  std::array<char, 640> payload{};

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0) == 0);
  REQUIRE(esp_transport_ws_get_read_opcode(
      fixture.websocket.get()) == WS_TRANSPORT_OPCODES_NONE);

  REQUIRE(esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0) == static_cast<int>(payload.size()));
  REQUIRE(std::string(payload.data(), payload.size()) ==
      pcm_payload);
  REQUIRE(esp_transport_ws_get_read_payload_len(
      fixture.websocket.get()) == static_cast<int>(payload.size()));
}

/*
 * Finite PCM playback ends with the exact RFC 6455 bytes `82 00`: a final
 * empty BINARY frame. Its zero-byte payload is numerically identical to a
 * nonblocking read that made no progress, so the lower ESP-IDF parser must
 * preserve opcode/length/FIN metadata and the portable classifier must use
 * that metadata to emit ordered DATA. Testing only either half would permit a
 * future transport update to erase the marker between them and leave cyclic
 * DMA running silence forever after every response.
 */
TEST_CASE(
    "final empty binary wire frame reaches the ordered data path",
    "[iterate][websocket_transport][pcm_eos]") {
  websocket_fixture fixture({
    upgrade_response(),
    std::string{
      static_cast<char>(0x82),
      static_cast<char>(0x00),
    },
  });
  std::array<char, 1> payload{};
  iterate_kit_websocket_rx rx{};
  iterate_kit_websocket_rx_chunk chunk{};

  const int read_result = esp_transport_read(
      fixture.websocket.get(),
      payload.data(),
      static_cast<int>(payload.size()),
      0);
  const auto opcode =
      esp_transport_ws_get_read_opcode(fixture.websocket.get());
  const int payload_size =
      esp_transport_ws_get_read_payload_len(
          fixture.websocket.get());
  const bool final =
      esp_transport_ws_get_fin_flag(fixture.websocket.get());

  REQUIRE(read_result == 0);
  REQUIRE(opcode == WS_TRANSPORT_OPCODES_BINARY);
  REQUIRE(payload_size == 0);
  REQUIRE(final);
  REQUIRE(iterate_kit_websocket_rx_init(&rx) ==
      ITERATE_KIT_OK);

  const iterate_kit_websocket_rx_read read = {
    .bytes = nullptr,
    .byte_count = 0,
    .payload_size = 0,
    .opcode =
        static_cast<iterate_kit_websocket_opcode>(opcode),
    .final = final,
    .has_frame = opcode != WS_TRANSPORT_OPCODES_NONE,
  };
  REQUIRE(iterate_kit_websocket_rx_feed(
      &rx, &read, &chunk) == ITERATE_KIT_WEBSOCKET_RX_DATA);
  REQUIRE(chunk.bytes == nullptr);
  REQUIRE(chunk.byte_count == 0);
  REQUIRE(chunk.payload_size == 0);
  REQUIRE(chunk.payload_offset == 0);
  REQUIRE(chunk.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  REQUIRE(chunk.final);
}
