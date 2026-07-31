#
# Exact-source patches for ESP-IDF v5.4 tcp_transport.
#
# These rewrites are intentionally textual and guarded. Carrying a thousand-line
# source fork would hide future upstream fixes in an apparently ordinary vendor
# file; an unguarded replacement could silently stop applying after an IDF
# update. Each expected fragment must occur exactly once, and the generated C
# includes the realtime requirement that forced the divergence.
#

function(iterate_kit_replace_exactly_once
    source_variable search replacement description)
  set(source "${${source_variable}}")
  string(FIND "${source}" "${search}" first_offset)
  if(first_offset EQUAL -1)
    message(FATAL_ERROR
      "Iterate tcp_transport patch no longer matches: ${description}")
  endif()

  string(LENGTH "${search}" search_length)
  math(EXPR remainder_offset "${first_offset} + ${search_length}")
  string(SUBSTRING "${source}" ${remainder_offset} -1 remainder)
  string(FIND "${remainder}" "${search}" second_offset)
  if(NOT second_offset EQUAL -1)
    message(FATAL_ERROR
      "Iterate tcp_transport patch became ambiguous: ${description}")
  endif()

  string(REPLACE "${search}" "${replacement}" patched "${source}")
  set(${source_variable} "${patched}" PARENT_SCOPE)
endfunction()

function(iterate_kit_patch_transport_ws input_path output_path)
  file(READ "${input_path}" source)

  set(search [=[
typedef struct {
    uint8_t opcode;
    bool fin;                           /*!< Frame fin flag, for continuations */
    char mask_key[4];                   /*!< Mask key for this payload */
    int payload_len;                    /*!< Total length of the payload */
    int bytes_remaining;                /*!< Bytes left to read of the payload  */
    bool header_received;               /*!< Flag to indicate that a new message header was received */
} ws_transport_frame_state_t;
]=])
  set(replacement [=[
typedef struct {
    uint8_t opcode;
    bool fin;                           /*!< Frame fin flag, for continuations */
    char mask_key[4];                   /*!< Mask key for this payload */
    int payload_len;                    /*!< Total length of the payload */
    int bytes_remaining;                /*!< Bytes left to read of the payload  */
    bool header_received;               /*!< Flag to indicate that a new message header was received */
    /*
     * ITERATE PATCH: a zero-timeout TLS read may split even the two-byte base
     * header. Header bytes are framing state, not disposable scratch storage:
     * losing one forces the outer owner to replace the entire Cap'n Web or PCM
     * generation. Keep at most the RFC 6455 maximum header in the transport so
     * an IDLE pass is lossless and requires no heap allocation.
     */
    unsigned char header[MAX_WEBSOCKET_HEADER_SIZE];
    int header_bytes;
    int header_needed;
} ws_transport_frame_state_t;
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "WebSocket resumable header state")

  set(search [=[
static int esp_transport_read_exact_size(transport_ws_t *ws, char *buffer, int requested_len, int timeout_ms)
{
    int total_read = 0;
    int len = requested_len;

    while (len > 0) {
        int bytes_read = esp_transport_read_internal(ws, buffer, len, timeout_ms);

        if (bytes_read < 0) {
            return bytes_read; // Return error from the underlying read
        }

        if (bytes_read == 0) {
            // If we read 0 bytes, we return an error, since reading exact number of bytes resulted in a timeout operation
            ESP_LOGW(TAG, "Requested to read %d, actually read %d bytes", requested_len, total_read);
            return -1;
        }

        // Update buffer and remaining length
        buffer += bytes_read;
        len -= bytes_read;
        total_read += bytes_read;

        ESP_LOGV(TAG, "Read fragment of %d bytes", bytes_read);
    }
    return total_read;
}
]=])
  set(replacement "")
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "lossy exact-size WebSocket header reader")

  set(search [=[
/* Read and parse the WS header, determine length of payload */
static int ws_read_header(esp_transport_handle_t t, char *buffer, int len, int timeout_ms)
{
    transport_ws_t *ws = esp_transport_get_context_data(t);
    int payload_len;

    char ws_header[MAX_WEBSOCKET_HEADER_SIZE];
    char *data_ptr = ws_header, mask;
    int rlen;
    int poll_read;
    ws->frame_state.header_received = false;
    if ((poll_read = esp_transport_poll_read(ws->parent, timeout_ms)) <= 0) {
        return poll_read;
    }

    // Receive and process header first (based on header size)
    int header = 2;
    int mask_len = 4;
    if ((rlen = esp_transport_read_exact_size(ws, data_ptr, header, timeout_ms)) <= 0) {
        ESP_LOGE(TAG, "Error read data");
        return rlen;
    }
    ws->frame_state.header_received = true;
    ws->frame_state.fin = (*data_ptr & 0x80) != 0;
    ws->frame_state.opcode = (*data_ptr & 0x0F);
    data_ptr ++;
    mask = ((*data_ptr >> 7) & 0x01);
    payload_len = (*data_ptr & 0x7F);
    data_ptr++;
    ESP_LOGD(TAG, "Opcode: %d, mask: %d, len: %d", ws->frame_state.opcode, mask, payload_len);
    if (payload_len == 126) {
        // headerLen += 2;
        if ((rlen = esp_transport_read_exact_size(ws, data_ptr, header, timeout_ms)) <= 0) {
            ESP_LOGE(TAG, "Error read data");
            return rlen;
        }
        payload_len = (uint8_t)data_ptr[0] << 8 | (uint8_t)data_ptr[1];
    } else if (payload_len == 127) {
        // headerLen += 8;
        header = 8;
        if ((rlen = esp_transport_read_exact_size(ws, data_ptr, header, timeout_ms)) <= 0) {
            ESP_LOGE(TAG, "Error read data");
            return rlen;
        }

        if (data_ptr[0] != 0 || data_ptr[1] != 0 || data_ptr[2] != 0 || data_ptr[3] != 0) {
            // really too big!
            payload_len = 0xFFFFFFFF;
        } else {
            payload_len = (uint8_t)data_ptr[4] << 24 | (uint8_t)data_ptr[5] << 16 | (uint8_t)data_ptr[6] << 8 | data_ptr[7];
        }
    }

    if (mask) {
        // Read and store mask
        if (payload_len != 0 && (rlen = esp_transport_read_exact_size(ws, buffer, mask_len, timeout_ms)) <= 0) {
            ESP_LOGE(TAG, "Error read data");
            return rlen;
        }
        memcpy(ws->frame_state.mask_key, buffer, mask_len);
    } else {
        memset(ws->frame_state.mask_key, 0, mask_len);
    }

    ws->frame_state.payload_len = payload_len;
    ws->frame_state.bytes_remaining = payload_len;

    return payload_len;
}
]=])
  set(replacement [=[
/* Read and parse the WS header, determine length of payload */
static int ws_read_header(esp_transport_handle_t t, char *buffer, int len, int timeout_ms)
{
    transport_ws_t *ws = esp_transport_get_context_data(t);
    int payload_len;
    int rlen;
    int poll_read;
    int cursor;
    bool mask;

    (void)buffer;
    (void)len;
    if (ws->frame_state.header_bytes == 0) {
        ws->frame_state.header_received = false;
        ws->frame_state.header_needed = 2;
    }

    while (ws->frame_state.header_bytes < ws->frame_state.header_needed) {
        /*
         * ITERATE PATCH: the HTTP upgrade reader may already own the first
         * frame bytes. Polling only the parent cannot see that spillover. Once
         * a header has begun, the parent TLS read is itself the authoritative
         * nonblocking progress probe, so another poll would add no guarantee.
         */
        if (ws->frame_state.header_bytes == 0 && ws->buffer_len == 0 &&
                (poll_read = esp_transport_poll_read(ws->parent, timeout_ms)) <= 0) {
            return poll_read;
        }
        rlen = esp_transport_read_internal(
                ws,
                (char *)ws->frame_state.header + ws->frame_state.header_bytes,
                ws->frame_state.header_needed - ws->frame_state.header_bytes,
                timeout_ms);
        if (rlen < 0) {
            /* A real transport failure abandons the generation and its header. */
            ws->frame_state.header_bytes = 0;
            ws->frame_state.header_needed = 2;
            return rlen;
        }
        if (rlen == 0) {
            /*
             * No progress is ordinary for the zero-timeout realtime owner.
             * Retain the exact prefix so the next pass resumes rather than
             * parsing a continuation byte as a fresh opcode.
             */
            return 0;
        }
        ws->frame_state.header_bytes += rlen;
        if (ws->frame_state.header_bytes >= 2 &&
                ws->frame_state.header_needed == 2) {
            const unsigned char size_code =
                    ws->frame_state.header[1] & 0x7f;
            const int extended_size =
                    size_code == 126 ? 2 : (size_code == 127 ? 8 : 0);
            const int mask_size =
                    (ws->frame_state.header[1] & WS_MASK) != 0 ? 4 : 0;
            ws->frame_state.header_needed = 2 + extended_size + mask_size;
        }
    }

    ws->frame_state.fin =
            (ws->frame_state.header[0] & WS_FIN) != 0;
    ws->frame_state.opcode =
            ws->frame_state.header[0] & 0x0f;
    mask = (ws->frame_state.header[1] & WS_MASK) != 0;
    payload_len = ws->frame_state.header[1] & 0x7f;
    cursor = 2;
    if (payload_len == 126) {
        payload_len =
                (uint8_t)ws->frame_state.header[cursor] << 8 |
                (uint8_t)ws->frame_state.header[cursor + 1];
        cursor += 2;
    } else if (payload_len == 127) {
        if (ws->frame_state.header[cursor] != 0 ||
                ws->frame_state.header[cursor + 1] != 0 ||
                ws->frame_state.header[cursor + 2] != 0 ||
                ws->frame_state.header[cursor + 3] != 0) {
            payload_len = 0xFFFFFFFF;
        } else {
            payload_len =
                    (uint8_t)ws->frame_state.header[cursor + 4] << 24 |
                    (uint8_t)ws->frame_state.header[cursor + 5] << 16 |
                    (uint8_t)ws->frame_state.header[cursor + 6] << 8 |
                    (uint8_t)ws->frame_state.header[cursor + 7];
        }
        cursor += 8;
    }
    if (mask) {
        memcpy(ws->frame_state.mask_key,
               ws->frame_state.header + cursor,
               sizeof(ws->frame_state.mask_key));
    } else {
        memset(ws->frame_state.mask_key,
               0,
               sizeof(ws->frame_state.mask_key));
    }

    ws->frame_state.payload_len = payload_len;
    ws->frame_state.bytes_remaining = payload_len;
    ws->frame_state.header_received = true;
    ws->frame_state.header_bytes = 0;
    ws->frame_state.header_needed = 2;
    ESP_LOGD(TAG, "Opcode: %d, mask: %d, len: %d",
             ws->frame_state.opcode, mask, payload_len);
    return payload_len;
}
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "resumable WebSocket header parser")

  set(search [=[
    // Receive and process payload
    if (bytes_to_read != 0 && (rlen = esp_transport_read_internal(ws, buffer, bytes_to_read, timeout_ms)) <= 0) {
        ESP_LOGE(TAG, "Error read data");
        return rlen;
    }
]=])
  set(replacement [=[
    /*
     * ITERATE PATCH: zero is a nonblocking wait, not a failed payload. Keep
     * bytes_remaining unchanged so TLS record boundaries, packet loss, or a
     * temporarily empty socket cannot turn the rest of this frame into a new
     * WebSocket header. Negative values remain real transport failures.
     */
    if (bytes_to_read != 0) {
        rlen = esp_transport_read_internal(ws, buffer, bytes_to_read, timeout_ms);
        if (rlen < 0) {
            ESP_LOGE(TAG, "Error read data");
            return rlen;
        }
    }
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "WebSocket payload zero-progress preservation")

  set(search [=[
    if (ws->frame_state.payload_len) {
        if ( (rlen = ws_read_payload(t, buffer, len, timeout_ms)) <= 0) {
            ESP_LOGE(TAG, "Error reading payload data");
            ws->frame_state.bytes_remaining = 0;
            return rlen;
        }
    }
]=])
  set(replacement [=[
    if (ws->frame_state.payload_len) {
        rlen = ws_read_payload(t, buffer, len, timeout_ms);
        if (rlen < 0) {
            ESP_LOGE(TAG, "Error reading payload data");
            ws->frame_state.bytes_remaining = 0;
            return rlen;
        }
        /*
         * ITERATE PATCH: abandoning a partial frame is only safe when the
         * connection is also abandoned. A zero-progress poll keeps this
         * generation and its offset alive; our outer freshness deadline still
         * provides bounded recovery if progress never resumes.
         */
        if (rlen == 0) {
            return 0;
        }
    }
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "WebSocket frame bookkeeping across payload stalls")

  file(WRITE "${output_path}" "${source}")
endfunction()

function(iterate_kit_patch_transport_ssl input_path output_path)
  file(READ "${input_path}" source)

  set(search [=[
static int ssl_write(esp_transport_handle_t t, const char *buffer, int len, int timeout_ms)
{
    int poll;
    transport_esp_tls_t *ssl = ssl_get_context_data(t);
    ESP_STATIC_ANALYZER_CHECK(ssl == NULL, -1);

    if ((poll = esp_transport_poll_write(t, timeout_ms)) <= 0) {
        ESP_LOGW(TAG, "Poll timeout or error, errno=%s, fd=%d, timeout_ms=%d", strerror(errno), ssl->sockfd, timeout_ms);
        return poll;
    }
]=])
  set(replacement [=[
static int ssl_write(esp_transport_handle_t t, const char *buffer, int len, int timeout_ms)
{
    int poll;
    transport_esp_tls_t *ssl = ssl_get_context_data(t);
    ESP_STATIC_ANALYZER_CHECK(ssl == NULL, -1);

    /*
     * ITERATE PATCH: timeout_ms == 0 is our normal realtime probe. Logging a
     * warning for every full TLS/lwIP buffer can block the sole socket owner
     * hundreds of times per second. The caller already counts deferrals, so
     * reserve the synchronous log for an actual poll error.
     */
    poll = esp_transport_poll_write(t, timeout_ms);
    if (poll == 0) {
        return 0;
    }
    if (poll < 0) {
        ESP_LOGW(TAG, "Poll error, errno=%s, fd=%d, timeout_ms=%d", strerror(errno), ssl->sockfd, timeout_ms);
        return poll;
    }
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "TLS zero-timeout write log suppression")

  set(search [=[
    if (ret < 0) {
        ESP_LOGE(TAG, "esp_tls_conn_read error, errno=%s", strerror(errno));
        if (ret == ESP_TLS_ERR_SSL_WANT_READ || ret == ESP_TLS_ERR_SSL_TIMEOUT) {
            ret = ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
        }

        esp_tls_error_handle_t esp_tls_error_handle;
        if (esp_tls_get_error_handle(ssl->tls, &esp_tls_error_handle) == ESP_OK) {
            esp_transport_set_errors(t, esp_tls_error_handle);
        } else {
            ESP_LOGE(TAG, "Error in obtaining the error handle");
        }
]=])
  set(replacement [=[
    if (ret < 0) {
        /*
         * ITERATE PATCH: a zero-timeout read is a scheduling probe, so
         * WANT_READ/WANT_WRITE/TIMEOUT describe ordinary lack of immediate
         * application progress. ESP-IDF v5.4 logs and captures those values as
         * TLS errors before translating WANT_READ to a transport timeout. That
         * produces a false error trail during an otherwise bit-exact realtime
         * audio run and may copy a stale TLS error into later diagnostics.
         *
         * Classify retryable states before the terminal-failure branch. Real
         * negative TLS results still retain ESP-IDF's synchronous log and error
         * handle; this is not a blanket suppression or a compatibility shim.
         */
        if (ret == ESP_TLS_ERR_SSL_WANT_READ ||
                ret == ESP_TLS_ERR_SSL_WANT_WRITE ||
                ret == ESP_TLS_ERR_SSL_TIMEOUT) {
            ret = ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
        } else {
            ESP_LOGE(TAG, "esp_tls_conn_read error, errno=%s", strerror(errno));

            esp_tls_error_handle_t esp_tls_error_handle;
            if (esp_tls_get_error_handle(ssl->tls, &esp_tls_error_handle) == ESP_OK) {
                esp_transport_set_errors(t, esp_tls_error_handle);
            } else {
                ESP_LOGE(TAG, "Error in obtaining the error handle");
            }
        }
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "TLS retryable read classification before error reporting")

  file(WRITE "${output_path}" "${source}")
endfunction()
