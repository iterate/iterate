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
    if ((poll_read = esp_transport_poll_read(ws->parent, timeout_ms)) <= 0) {
        return poll_read;
    }
]=])
  set(replacement [=[
    /*
     * ITERATE PATCH: the HTTP upgrade reader may already have copied the first
     * WebSocket frame into ws->buffer. Polling only the parent socket cannot
     * observe those bytes and can strand the frame until unrelated traffic
     * arrives. Buffered upgrade spillover is already readable by
     * esp_transport_read_internal(), so bypass the socket poll while it exists.
     */
    if (ws->buffer_len == 0 &&
            (poll_read = esp_transport_poll_read(ws->parent, timeout_ms)) <= 0) {
        return poll_read;
    }
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "WebSocket handshake spillover poll")

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
        if (ret == ESP_TLS_ERR_SSL_WANT_READ || ret == ESP_TLS_ERR_SSL_TIMEOUT) {
            ret = ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
        }
]=])
  set(replacement [=[
        /*
         * ITERATE PATCH: TLS may need to write protocol traffic while the
         * application is reading. WANT_WRITE means retry after socket progress,
         * not that the peer disconnected; restarting here would purge fresh
         * audio during a valid TLS state transition.
         */
        if (ret == ESP_TLS_ERR_SSL_WANT_READ ||
                ret == ESP_TLS_ERR_SSL_WANT_WRITE ||
                ret == ESP_TLS_ERR_SSL_TIMEOUT) {
            ret = ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT;
        }
]=])
  iterate_kit_replace_exactly_once(
    source "${search}" "${replacement}"
    "TLS read WANT_WRITE classification")

  file(WRITE "${output_path}" "${source}")
endfunction()
