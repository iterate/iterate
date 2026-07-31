import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const patchPath = resolve(
  packageDirectory,
  "firmware/platforms/iterate_esp_idf/idf_overrides/tcp_transport/patch_transport.cmake",
);

const upstreamSslFixture = String.raw`
static int ssl_write(esp_transport_handle_t t, const char *buffer, int len, int timeout_ms)
{
    int poll;
    transport_esp_tls_t *ssl = ssl_get_context_data(t);
    ESP_STATIC_ANALYZER_CHECK(ssl == NULL, -1);

    if ((poll = esp_transport_poll_write(t, timeout_ms)) <= 0) {
        ESP_LOGW(TAG, "Poll timeout or error, errno=%s, fd=%d, timeout_ms=%d", strerror(errno), ssl->sockfd, timeout_ms);
        return poll;
    }
}

static int ssl_read(esp_transport_handle_t t, char *buffer, int len, int timeout_ms)
{
    transport_esp_tls_t *ssl = ssl_get_context_data(t);
    int poll = esp_transport_poll_read(t, timeout_ms);
    int ret = esp_tls_conn_read(ssl->tls, (unsigned char *)buffer, len);
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
    } else if (ret == 0) {
        ret = ERR_TCP_TRANSPORT_CONNECTION_CLOSED_BY_FIN;
    }
    return ret;
}
`;

describe("ESP-IDF tcp_transport source patch", () => {
  test("treats ordinary nonblocking TLS progress as idle without manufacturing an error", () => {
    /*
     * The PCM owner deliberately reads with a zero timeout. mbedTLS reports
     * WANT_READ/WANT_WRITE when that probe has no application bytes yet; this
     * is normal scheduling state, not a failed socket. ESP-IDF v5.4 logs and
     * captures every negative return before classifying WANT_READ as a timeout,
     * which gives an exact, gap-free physical run a contradictory error trail.
     *
     * Exercise the actual CMake source transformer rather than merely looking
     * for reassuring words in it. Retryable results must bypass both the error
     * log and error-handle capture. A genuinely negative TLS result must retain
     * both, or this cleanup would hide the failures diagnostics are for.
     */
    const directory = mkdtempSync(join(tmpdir(), "iterate-kit-transport-patch-"));
    const inputPath = join(directory, "transport_ssl.c");
    const outputPath = join(directory, "transport_ssl.generated.c");
    const scriptPath = join(directory, "apply.cmake");
    writeFileSync(inputPath, upstreamSslFixture);
    writeFileSync(
      scriptPath,
      `include(${JSON.stringify(patchPath)})\niterate_kit_patch_transport_ssl(${JSON.stringify(inputPath)} ${JSON.stringify(outputPath)})\n`,
    );

    const result = spawnSync("cmake", ["-P", scriptPath], { encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const generated = readFileSync(outputPath, "utf8");
    const negativeRead = generated.slice(
      generated.indexOf("    if (ret < 0) {"),
      generated.indexOf("    } else if (ret == 0) {"),
    );
    const retryable = negativeRead.slice(0, negativeRead.indexOf("        } else {"));
    const terminalFailure = negativeRead.slice(negativeRead.indexOf("        } else {"));

    expect(retryable).toContain("ESP_TLS_ERR_SSL_WANT_READ");
    expect(retryable).toContain("ESP_TLS_ERR_SSL_WANT_WRITE");
    expect(retryable).toContain("ESP_TLS_ERR_SSL_TIMEOUT");
    expect(retryable).not.toContain("ESP_LOGE");
    expect(retryable).not.toContain("esp_tls_get_error_handle");
    expect(terminalFailure).toContain('ESP_LOGE(TAG, "esp_tls_conn_read error');
    expect(terminalFailure).toContain("esp_tls_get_error_handle");
  });
});
