#include "zectrix_epd.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <new>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ssd2683_waveform.h"

namespace {

constexpr char kTag[] = "zectrix_epd";
constexpr int kWidth = ZECTRIX_EPD_PANEL_WIDTH;
constexpr int kHeight = ZECTRIX_EPD_PANEL_HEIGHT;
constexpr int kBwStride = kWidth / 8;
constexpr int kNativeStride = kWidth / 4;
constexpr size_t kMaxTransferSize = 1024;
constexpr int64_t kExternalRefreshTimeoutUs = 5LL * 1000 * 1000;

class MutexGuard {
public:
    explicit MutexGuard(SemaphoreHandle_t mutex) : mutex_(mutex) {
        locked_ = mutex_ != nullptr && xSemaphoreTake(mutex_, portMAX_DELAY) == pdTRUE;
    }
    ~MutexGuard() {
        if (locked_) {
            xSemaphoreGive(mutex_);
        }
    }
    bool locked() const { return locked_; }

private:
    SemaphoreHandle_t mutex_ = nullptr;
    bool locked_ = false;
};

uint8_t ReadPackedBit(const uint8_t* data, size_t stride, int x, int y) {
    return static_cast<uint8_t>((data[static_cast<size_t>(y) * stride + x / 8] >>
                                 (7 - (x & 7))) &
                                1U);
}

void WritePackedBit(uint8_t* data, size_t stride, int x, int y, uint8_t bit) {
    uint8_t& value = data[static_cast<size_t>(y) * stride + x / 8];
    const uint8_t mask = static_cast<uint8_t>(1U << (7 - (x & 7)));
    if (bit != 0) {
        value |= mask;
    } else {
        value &= static_cast<uint8_t>(~mask);
    }
}

}  // namespace

struct zectrix_epd_t {
    explicit zectrix_epd_t(const zectrix_epd_config_t& value) : config(value) {}

    zectrix_epd_config_t config = {};
    spi_device_handle_t spi = nullptr;
    SemaphoreHandle_t mutex = nullptr;
    uint8_t* shadow = nullptr;
    uint8_t* dma_buffer = nullptr;
    bool owns_bus = false;
    bool bus_initialized = false;
    bool receive_mode = false;
    bool powered = false;
    bool controller_ready = false;
    bool internal_power_on = false;
    bool shadow_valid = false;

    void SetCs(int level) { gpio_set_level(config.pin_cs, level); }
    void SetDc(int level) { gpio_set_level(config.pin_dc, level); }
    void SetReset(int level) { gpio_set_level(config.pin_reset, level); }

    esp_err_t ConfigureSpi(bool receive) {
        if (spi != nullptr) {
            esp_err_t err = spi_bus_remove_device(spi);
            if (err != ESP_OK) {
                return err;
            }
            spi = nullptr;
        }
        if (bus_initialized && owns_bus) {
            esp_err_t err = spi_bus_free(config.spi_host);
            if (err != ESP_OK) {
                return err;
            }
            bus_initialized = false;
        }

        if (!config.initialize_spi_bus && receive) {
            return ESP_ERR_NOT_SUPPORTED;
        }

        if (config.initialize_spi_bus) {
            spi_bus_config_t bus_config = {};
            bus_config.miso_io_num = receive ? config.pin_mosi : -1;
            bus_config.mosi_io_num = receive ? -1 : config.pin_mosi;
            bus_config.sclk_io_num = config.pin_sclk;
            bus_config.quadwp_io_num = -1;
            bus_config.quadhd_io_num = -1;
            bus_config.max_transfer_sz = kMaxTransferSize;
            esp_err_t err = spi_bus_initialize(config.spi_host, &bus_config,
                                               SPI_DMA_CH_AUTO);
            if (err != ESP_OK) {
                return err;
            }
            owns_bus = true;
            bus_initialized = true;
        }

        spi_device_interface_config_t device_config = {};
        device_config.spics_io_num = -1;
        device_config.clock_speed_hz = receive ? std::min(config.spi_clock_hz, 8000000)
                                               : config.spi_clock_hz;
        device_config.mode = 0;
        device_config.queue_size = 1;
        esp_err_t err = spi_bus_add_device(config.spi_host, &device_config, &spi);
        if (err != ESP_OK) {
            if (owns_bus && bus_initialized) {
                spi_bus_free(config.spi_host);
                bus_initialized = false;
            }
            return err;
        }
        receive_mode = receive;
        return ESP_OK;
    }

    esp_err_t Transmit(const uint8_t* data, size_t size) {
        if (spi == nullptr || data == nullptr || size == 0) {
            return ESP_ERR_INVALID_STATE;
        }
        size_t offset = 0;
        while (offset < size) {
            const size_t chunk = std::min(kMaxTransferSize, size - offset);
            spi_transaction_t transaction = {};
            transaction.length = chunk * 8;
            if (chunk <= sizeof(transaction.tx_data)) {
                transaction.flags = SPI_TRANS_USE_TXDATA;
                std::memcpy(transaction.tx_data, data + offset, chunk);
            } else {
                if (dma_buffer == nullptr) {
                    return ESP_ERR_INVALID_STATE;
                }
                std::memcpy(dma_buffer, data + offset, chunk);
                transaction.tx_buffer = dma_buffer;
            }
            const esp_err_t err = spi_device_polling_transmit(spi, &transaction);
            if (err != ESP_OK) {
                return err;
            }
            offset += chunk;
        }
        return ESP_OK;
    }

    esp_err_t SendCommand(uint8_t command) {
        SetDc(0);
        SetCs(0);
        const esp_err_t err = Transmit(&command, 1);
        SetCs(1);
        return err;
    }

    esp_err_t SendData(uint8_t data) {
        SetDc(1);
        SetCs(0);
        const esp_err_t err = Transmit(&data, 1);
        SetCs(1);
        return err;
    }

    esp_err_t SendBytes(const uint8_t* data, size_t size) {
        SetDc(1);
        SetCs(0);
        const esp_err_t err = Transmit(data, size);
        SetCs(1);
        return err;
    }

    esp_err_t ReadData(uint8_t* value) {
        if (value == nullptr || !owns_bus) {
            return ESP_ERR_NOT_SUPPORTED;
        }
        esp_err_t err = ConfigureSpi(true);
        if (err != ESP_OK) {
            return err;
        }
        SetDc(1);
        SetCs(0);
        spi_transaction_t transaction = {};
        transaction.length = 8;
        transaction.flags = SPI_TRANS_USE_RXDATA;
        err = spi_device_polling_transmit(spi, &transaction);
        if (err == ESP_OK) {
            *value = transaction.rx_data[0];
        }
        SetCs(1);
        const esp_err_t restore_err = ConfigureSpi(false);
        return err != ESP_OK ? err : restore_err;
    }

    esp_err_t WaitBusy(const char* operation, int64_t timeout_us = -1) {
        if (timeout_us < 0) {
            timeout_us = static_cast<int64_t>(config.busy_timeout_ms) * 1000;
        }
        const int64_t start = esp_timer_get_time();
        while (gpio_get_level(config.pin_busy) == 0) {
            if (esp_timer_get_time() - start >= timeout_us) {
                ESP_LOGE(kTag, "BUSY timeout during %s", operation);
                return ESP_ERR_TIMEOUT;
            }
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        return ESP_OK;
    }

    esp_err_t HardwareReset() {
        SetReset(1);
        vTaskDelay(pdMS_TO_TICKS(10));
        SetReset(0);
        vTaskDelay(pdMS_TO_TICKS(20));
        SetReset(1);
        vTaskDelay(pdMS_TO_TICKS(10));
        return WaitBusy("reset");
    }

    esp_err_t SelectOtp() {
        esp_err_t err = SendCommand(0x00);
        if (err == ESP_OK) err = SendData(0x2F);
        if (err == ESP_OK) err = SendData(0x0E);
        if (err == ESP_OK) err = SendCommand(0xE9);
        if (err == ESP_OK) err = SendData(0x01);
        if (err == ESP_OK) err = WaitBusy("OTP init");
        controller_ready = err == ESP_OK;
        return err;
    }

    esp_err_t PrepareOtpRefresh() {
        if (!powered) {
            return ESP_ERR_INVALID_STATE;
        }
        // SSD2683 does not reliably accept a second refresh after its internal
        // power-off command without a fresh reset/OTP selection. The physical
        // image is retained, so this is also safe before a transition-based
        // partial refresh.
        internal_power_on = false;
        controller_ready = false;
        esp_err_t err = HardwareReset();
        if (err == ESP_OK) {
            err = SelectOtp();
        }
        return err;
    }

    esp_err_t PowerOnLocked() {
        if (powered && controller_ready) {
            return ESP_OK;
        }
        gpio_hold_dis(config.pin_power);
        esp_err_t err = gpio_set_level(config.pin_power, 1);
        gpio_hold_en(config.pin_power);
        if (err != ESP_OK) {
            return err;
        }
        powered = true;
        vTaskDelay(pdMS_TO_TICKS(10));
        err = HardwareReset();
        if (err == ESP_OK) {
            err = SelectOtp();
        }
        if (err != ESP_OK) {
            PowerOffLocked();
        }
        return err;
    }

    esp_err_t PowerOffLocked() {
        esp_err_t result = ESP_OK;
        if (powered && internal_power_on && spi != nullptr) {
            result = SendCommand(0x02);
            if (result == ESP_OK) result = SendData(0x00);
            if (result == ESP_OK) result = WaitBusy("power off");
        }
        gpio_hold_dis(config.pin_power);
        const esp_err_t gpio_err = gpio_set_level(config.pin_power, 0);
        gpio_hold_en(config.pin_power);
        if (result == ESP_OK) {
            result = gpio_err;
        }
        powered = false;
        controller_ready = false;
        internal_power_on = false;
        return result;
    }

    esp_err_t SetTemperatureForOtp() {
        esp_err_t err = SendCommand(0x40);
        if (err == ESP_OK) err = WaitBusy("temperature read");
        uint8_t temperature = 25;
        if (err == ESP_OK && owns_bus) {
            err = ReadData(&temperature);
        }
        if (err == ESP_ERR_NOT_SUPPORTED) {
            temperature = 25;
            err = ESP_OK;
        }
        uint8_t encoded = 244;
        if (temperature <= 5) encoded = 232;
        else if (temperature <= 10) encoded = 235;
        else if (temperature <= 20) encoded = 238;
        else if (temperature <= 30) encoded = 241;
        else if (temperature <= 127) encoded = 244;
        if (err == ESP_OK) err = SendCommand(0xE0);
        if (err == ESP_OK) err = SendData(0x02);
        if (err == ESP_OK) err = SendCommand(0xE6);
        if (err == ESP_OK) err = SendData(encoded);
        if (err == ESP_OK) err = SendCommand(0xA5);
        if (err == ESP_OK) err = WaitBusy("temperature activate");
        if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(10));
        return err;
    }

    esp_err_t TriggerOtpRefresh() {
        esp_err_t err = SendCommand(0x04);
        if (err == ESP_OK) err = WaitBusy("internal power on");
        if (err == ESP_OK) internal_power_on = true;
        if (err != ESP_OK) {
            controller_ready = false;
            internal_power_on = false;
            return err;
        }
        if (err == ESP_OK) err = SendCommand(0x12);
        if (err == ESP_OK) err = SendData(0x00);
        if (err == ESP_OK) err = WaitBusy("display refresh");
        if (err != ESP_OK) {
            // Do not issue 0x02 while BUSY is still asserted. Mark the
            // controller unusable so power_off() cuts the external rail.
            controller_ready = false;
            internal_power_on = false;
            return err;
        }
        err = SendCommand(0x02);
        if (err == ESP_OK) err = SendData(0x00);
        if (err == ESP_OK) err = WaitBusy("internal power off");
        internal_power_on = false;
        if (err != ESP_OK) {
            controller_ready = false;
        }
        return err;
    }

    esp_err_t WriteOtpFrame(const uint8_t* framebuffer) {
        esp_err_t err = SetTemperatureForOtp();
        if (err == ESP_OK) err = SendCommand(0x10);
        std::array<uint8_t, kNativeStride> line = {};
        for (int y = 0; err == ESP_OK && y < kHeight; ++y) {
            for (int source_byte = 0; source_byte < kBwStride; ++source_byte) {
                const uint8_t input = framebuffer[static_cast<size_t>(y) * kBwStride +
                                                  source_byte];
                uint8_t first = 0;
                uint8_t second = 0;
                for (int bit = 0; bit < 8; ++bit) {
                    const uint8_t pixel = static_cast<uint8_t>((input >> (7 - bit)) & 1U);
                    if (bit < 4) {
                        first |= static_cast<uint8_t>(pixel << (6 - bit * 2));
                    } else {
                        second |= static_cast<uint8_t>(pixel << (14 - bit * 2));
                    }
                }
                line[static_cast<size_t>(source_byte) * 2] = first;
                line[static_cast<size_t>(source_byte) * 2 + 1] = second;
            }
            err = SendBytes(line.data(), line.size());
        }
        if (err == ESP_OK) err = TriggerOtpRefresh();
        return err;
    }

    esp_err_t DisplayOtpWhiteBase() {
        std::array<uint8_t, kNativeStride> white_line = {};
        white_line.fill(0x55);
        esp_err_t err = SetTemperatureForOtp();
        if (err == ESP_OK) err = SendCommand(0x10);
        for (int y = 0; err == ESP_OK && y < kHeight; ++y) {
            err = SendBytes(white_line.data(), white_line.size());
        }
        if (err == ESP_OK) err = TriggerOtpRefresh();
        return err;
    }

    esp_err_t SetPartialWindow(int x0, int y0, int x1, int y1) {
        esp_err_t err = SendCommand(0x83);
        const uint8_t values[] = {
            static_cast<uint8_t>((x0 >> 8) & 0x03), static_cast<uint8_t>(x0),
            static_cast<uint8_t>((x1 >> 8) & 0x03), static_cast<uint8_t>(x1),
            static_cast<uint8_t>((y0 >> 8) & 0x03), static_cast<uint8_t>(y0),
            static_cast<uint8_t>((y1 >> 8) & 0x03), static_cast<uint8_t>(y1), 0x01};
        for (uint8_t value : values) {
            if (err == ESP_OK) err = SendData(value);
        }
        return err;
    }

    esp_err_t InitExternalWaveform(const uint8_t* waveform, size_t size) {
        if (waveform == nullptr || size != ssd2683_waveform::kWaveformSize) {
            return ESP_ERR_INVALID_ARG;
        }
        esp_err_t err = HardwareReset();
        if (err == ESP_OK) err = SendCommand(0x00);
        if (err == ESP_OK) err = SendData(0x2F);
        if (err == ESP_OK) err = SendData(0x8E);
        if (err == ESP_OK) err = SendCommand(0x01);
        const uint8_t power_values[] = {0x07, waveform[0], waveform[1], waveform[2],
                                        waveform[3], waveform[4]};
        for (uint8_t value : power_values) {
            if (err == ESP_OK) err = SendData(value);
        }
        if (err == ESP_OK) err = SendCommand(0x30);
        if (err == ESP_OK) err = SendData(waveform[6]);
        if (err == ESP_OK) err = SendCommand(0x82);
        if (err == ESP_OK) err = SendData(waveform[5]);
        if (err == ESP_OK) err = SendCommand(0x06);
        const uint8_t booster[] = {0x0F, 0x8B, 0x9C, 0xAA};
        for (uint8_t value : booster) {
            if (err == ESP_OK) err = SendData(value);
        }
        if (err == ESP_OK) err = SendCommand(0xE7);
        if (err == ESP_OK) err = SendData(0x98);
        if (err == ESP_OK) err = SendCommand(0x50);
        if (err == ESP_OK) err = SendData(0x37);
        if (err == ESP_OK) err = SendCommand(0x61);
        const uint8_t resolution[] = {0x01, 0x90, 0x01, 0x2C};
        for (uint8_t value : resolution) {
            if (err == ESP_OK) err = SendData(value);
        }
        if (err == ESP_OK) err = SendCommand(0x62);
        if (err == ESP_OK) err = SendData(0x64);
        if (err == ESP_OK) err = SendData(0x53);
        if (err == ESP_OK) err = SendCommand(0x65);
        for (int i = 0; err == ESP_OK && i < 4; ++i) err = SendData(0x00);
        if (err == ESP_OK) err = SendCommand(0xE9);
        if (err == ESP_OK) err = SendData(0x01);
        if (err == ESP_OK) err = WaitBusy("external waveform init");
        if (err == ESP_OK) err = SendCommand(0x20);
        if (err == ESP_OK) err = SendBytes(waveform, size);
        controller_ready = err == ESP_OK;
        return err;
    }

    esp_err_t LoadExternalWaveform(const uint8_t* waveform, size_t size) {
        if (waveform == nullptr || size != ssd2683_waveform::kWaveformSize) {
            return ESP_ERR_INVALID_ARG;
        }
        esp_err_t err = WaitBusy("external waveform reload");
        if (err == ESP_OK) err = SendCommand(0x30);
        if (err == ESP_OK) err = SendData(waveform[6]);
        if (err == ESP_OK) err = SendCommand(0x20);
        if (err == ESP_OK) err = SendBytes(waveform, size);
        return err;
    }

    esp_err_t WriteGrayPass(int pass, const uint8_t* framebuffer) {
        esp_err_t err = SendCommand(0x10);
        if (err == ESP_OK) err = WaitBusy("4bpp RAM write");
        std::array<uint8_t, kNativeStride> line = {};
        for (int y = 0; err == ESP_OK && y < kHeight; ++y) {
            for (int byte_x = 0; byte_x < kNativeStride; ++byte_x) {
                uint8_t packed = 0;
                for (int index = 0; index < 4; ++index) {
                    const int x = byte_x * 4 + index;
                    const size_t pixel = static_cast<size_t>(y) * kWidth + x;
                    const uint8_t pair = framebuffer[pixel / 2];
                    const uint8_t level = (pixel & 1U) ? pair & 0x0F : pair >> 4;
                    const uint8_t code =
                        ssd2683_waveform::VendorGray16RenderPassOfLevel(level) ==
                                static_cast<size_t>(pass)
                            ? ssd2683_waveform::VendorGray16RenderCodeOfLevel(level)
                            : 0;
                    packed |= static_cast<uint8_t>(code << (6 - index * 2));
                }
                line[byte_x] = packed;
            }
            err = SendBytes(line.data(), line.size());
        }
        return err;
    }

    esp_err_t TriggerExternalBatch(bool power_on) {
        esp_err_t err = ESP_OK;
        if (power_on) {
            err = SendCommand(0x04);
            if (err == ESP_OK) err = WaitBusy("external power on");
            if (err == ESP_OK) internal_power_on = true;
            if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(10));
        }
        if (err == ESP_OK) err = SendCommand(0x12);
        if (err == ESP_OK) err = SendData(0x00);
        if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(10));
        if (err == ESP_OK) {
            err = WaitBusy("external display refresh", kExternalRefreshTimeoutUs);
        }
        return err;
    }

    esp_err_t RestoreOtp() {
        internal_power_on = false;
        esp_err_t err = HardwareReset();
        if (err == ESP_OK) err = SelectOtp();
        return err;
    }
};

extern "C" void zectrix_epd_get_default_config(zectrix_epd_config_t* config) {
    if (config == nullptr) {
        return;
    }
    *config = {};
    config->spi_host = SPI3_HOST;
    config->pin_dc = GPIO_NUM_10;
    config->pin_cs = GPIO_NUM_11;
    config->pin_sclk = GPIO_NUM_12;
    config->pin_mosi = GPIO_NUM_13;
    config->pin_reset = GPIO_NUM_9;
    config->pin_busy = GPIO_NUM_8;
    config->pin_power = GPIO_NUM_6;
    config->spi_clock_hz = 20 * 1000 * 1000;
    config->busy_timeout_ms = 2000;
    config->initialize_spi_bus = true;
}

extern "C" esp_err_t zectrix_epd_new(const zectrix_epd_config_t* config,
                                      zectrix_epd_handle_t* out_handle) {
    if (out_handle != nullptr) {
        *out_handle = nullptr;
    }
    if (config == nullptr || out_handle == nullptr || config->spi_clock_hz <= 0 ||
        config->busy_timeout_ms == 0 ||
        !GPIO_IS_VALID_OUTPUT_GPIO(config->pin_cs) ||
        !GPIO_IS_VALID_OUTPUT_GPIO(config->pin_dc) ||
        !GPIO_IS_VALID_OUTPUT_GPIO(config->pin_reset) ||
        !GPIO_IS_VALID_GPIO(config->pin_busy) ||
        !GPIO_IS_VALID_OUTPUT_GPIO(config->pin_mosi) ||
        !GPIO_IS_VALID_OUTPUT_GPIO(config->pin_sclk) ||
        !GPIO_IS_VALID_OUTPUT_GPIO(config->pin_power)) {
        return ESP_ERR_INVALID_ARG;
    }
    auto* epd = new (std::nothrow) zectrix_epd_t(*config);
    if (epd == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    epd->mutex = xSemaphoreCreateMutex();
    epd->shadow = static_cast<uint8_t*>(
        heap_caps_malloc(ZECTRIX_EPD_1BPP_FRAME_BYTES, MALLOC_CAP_8BIT));
    epd->dma_buffer = static_cast<uint8_t*>(heap_caps_malloc(
        kMaxTransferSize, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
    if (epd->mutex == nullptr || epd->shadow == nullptr || epd->dma_buffer == nullptr) {
        if (epd->mutex != nullptr) vSemaphoreDelete(epd->mutex);
        if (epd->shadow != nullptr) heap_caps_free(epd->shadow);
        if (epd->dma_buffer != nullptr) heap_caps_free(epd->dma_buffer);
        delete epd;
        return ESP_ERR_NO_MEM;
    }
    std::memset(epd->shadow, 0xFF, ZECTRIX_EPD_1BPP_FRAME_BYTES);

    gpio_config_t output = {};
    output.pin_bit_mask = (1ULL << config->pin_cs) | (1ULL << config->pin_dc) |
                          (1ULL << config->pin_reset) | (1ULL << config->pin_power);
    output.mode = GPIO_MODE_OUTPUT;
    output.pull_up_en = GPIO_PULLUP_ENABLE;
    esp_err_t err = gpio_config(&output);
    gpio_config_t input = {};
    input.pin_bit_mask = 1ULL << config->pin_busy;
    input.mode = GPIO_MODE_INPUT;
    input.pull_up_en = GPIO_PULLUP_ENABLE;
    if (err == ESP_OK) err = gpio_config(&input);
    if (err == ESP_OK) {
        epd->SetCs(1);
        epd->SetDc(1);
        epd->SetReset(1);
        gpio_hold_dis(config->pin_power);
        err = gpio_set_level(config->pin_power, 0);
        gpio_hold_en(config->pin_power);
    }
    if (err == ESP_OK) err = epd->ConfigureSpi(false);
    if (err != ESP_OK) {
        if (epd->spi != nullptr) spi_bus_remove_device(epd->spi);
        if (epd->owns_bus && epd->bus_initialized) spi_bus_free(config->spi_host);
        vSemaphoreDelete(epd->mutex);
        heap_caps_free(epd->shadow);
        heap_caps_free(epd->dma_buffer);
        delete epd;
        return err;
    }
    *out_handle = epd;
    return ESP_OK;
}

extern "C" esp_err_t zectrix_epd_del(zectrix_epd_handle_t handle) {
    if (handle == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t result = handle->PowerOffLocked();
    if (handle->spi != nullptr) {
        const esp_err_t err = spi_bus_remove_device(handle->spi);
        if (result == ESP_OK) result = err;
        handle->spi = nullptr;
    }
    if (handle->owns_bus && handle->bus_initialized) {
        const esp_err_t err = spi_bus_free(handle->config.spi_host);
        if (result == ESP_OK) result = err;
    }
    vSemaphoreDelete(handle->mutex);
    heap_caps_free(handle->shadow);
    heap_caps_free(handle->dma_buffer);
    delete handle;
    return result;
}

extern "C" esp_err_t zectrix_epd_power_on(zectrix_epd_handle_t handle) {
    if (handle == nullptr) return ESP_ERR_INVALID_ARG;
    MutexGuard guard(handle->mutex);
    return guard.locked() ? handle->PowerOnLocked() : ESP_FAIL;
}

extern "C" esp_err_t zectrix_epd_power_off(zectrix_epd_handle_t handle) {
    if (handle == nullptr) return ESP_ERR_INVALID_ARG;
    MutexGuard guard(handle->mutex);
    return guard.locked() ? handle->PowerOffLocked() : ESP_FAIL;
}

extern "C" bool zectrix_epd_is_powered(zectrix_epd_handle_t handle) {
    if (handle == nullptr) return false;
    MutexGuard guard(handle->mutex);
    return guard.locked() && handle->powered;
}

extern "C" esp_err_t zectrix_epd_refresh_full_1bpp(zectrix_epd_handle_t handle,
                                                    const uint8_t* framebuffer,
                                                    size_t framebuffer_size) {
    if (handle == nullptr || framebuffer == nullptr ||
        framebuffer_size != ZECTRIX_EPD_1BPP_FRAME_BYTES) {
        return ESP_ERR_INVALID_ARG;
    }
    MutexGuard guard(handle->mutex);
    if (!guard.locked()) return ESP_FAIL;
    if (!handle->powered || !handle->controller_ready) return ESP_ERR_INVALID_STATE;
    esp_err_t err = handle->PrepareOtpRefresh();
    if (err == ESP_OK) {
        err = handle->WriteOtpFrame(framebuffer);
    }
    if (err == ESP_OK) {
        std::memcpy(handle->shadow, framebuffer, framebuffer_size);
        handle->shadow_valid = true;
    } else {
        handle->shadow_valid = false;
    }
    return err;
}

extern "C" esp_err_t zectrix_epd_refresh_partial_1bpp(
    zectrix_epd_handle_t handle, const zectrix_epd_rect_t* rect,
    const uint8_t* pixels, size_t pixels_size) {
    if (handle == nullptr || rect == nullptr || pixels == nullptr || rect->x < 0 ||
        rect->y < 0 || rect->width <= 0 || rect->height <= 0 ||
        rect->x + rect->width > kWidth || rect->y + rect->height > kHeight) {
        return ESP_ERR_INVALID_ARG;
    }
    const size_t source_stride = static_cast<size_t>((rect->width + 7) / 8);
    if (pixels_size != source_stride * static_cast<size_t>(rect->height)) {
        return ESP_ERR_INVALID_SIZE;
    }
    MutexGuard guard(handle->mutex);
    if (!guard.locked()) return ESP_FAIL;
    if (!handle->powered || !handle->controller_ready || !handle->shadow_valid) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = handle->PrepareOtpRefresh();
    if (err != ESP_OK) {
        handle->shadow_valid = false;
        return err;
    }

    const int x0 = rect->x & ~7;
    const int aligned_x_end =
        std::min(kWidth, (rect->x + rect->width + 7) & ~7);
    const int x1 = aligned_x_end - 1;
    const int y0 = rect->y;
    const int y1 = rect->y + rect->height - 1;
    const int output_stride = ((x1 - x0 + 1) / 8) * 2;
    std::array<uint8_t, kNativeStride> line = {};

    err = handle->SendCommand(0x50);
    if (err == ESP_OK) err = handle->SendData(0x77);
    if (err == ESP_OK) err = handle->SendCommand(0xE0);
    if (err == ESP_OK) err = handle->SendData(0x00);
    if (err == ESP_OK) err = handle->SendCommand(0xA5);
    if (err == ESP_OK) err = handle->WaitBusy("partial temperature");
    if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(10));
    if (err == ESP_OK) err = handle->SetPartialWindow(x0, y0, x1, y1);
    if (err == ESP_OK) err = handle->SendCommand(0x10);
    if (err == ESP_OK) err = handle->WaitBusy("partial RAM write");

    for (int y = y0; err == ESP_OK && y <= y1; ++y) {
        std::fill_n(line.begin(), output_stride, 0);
        for (int x = x0; x <= x1; ++x) {
            const uint8_t old_pixel = ReadPackedBit(handle->shadow, kBwStride, x, y);
            uint8_t new_pixel = old_pixel;
            if (x >= rect->x && x < rect->x + rect->width) {
                new_pixel = ReadPackedBit(pixels, source_stride, x - rect->x, y - rect->y);
            }
            const uint8_t transition = static_cast<uint8_t>((old_pixel << 1) | new_pixel);
            const int relative_x = x - x0;
            line[static_cast<size_t>(relative_x / 4)] |=
                static_cast<uint8_t>(transition << (6 - (relative_x & 3) * 2));
        }
        err = handle->SendBytes(line.data(), static_cast<size_t>(output_stride));
    }
    if (err == ESP_OK) err = handle->TriggerOtpRefresh();
    if (err == ESP_OK) {
        for (int y = 0; y < rect->height; ++y) {
            for (int x = 0; x < rect->width; ++x) {
                WritePackedBit(handle->shadow, kBwStride, rect->x + x, rect->y + y,
                               ReadPackedBit(pixels, source_stride, x, y));
            }
        }
    } else {
        // A timeout can leave part of the physical window updated. Refuse any
        // further transition refresh until a full B/W frame re-establishes a
        // trustworthy old-image baseline.
        handle->shadow_valid = false;
    }
    return err;
}

extern "C" esp_err_t zectrix_epd_refresh_full_4bpp(zectrix_epd_handle_t handle,
                                                    const uint8_t* framebuffer,
                                                    size_t framebuffer_size) {
    if (handle == nullptr || framebuffer == nullptr ||
        framebuffer_size != ZECTRIX_EPD_4BPP_FRAME_BYTES) {
        return ESP_ERR_INVALID_ARG;
    }
    MutexGuard guard(handle->mutex);
    if (!guard.locked()) return ESP_FAIL;
    if (!handle->powered || !handle->controller_ready) return ESP_ERR_INVALID_STATE;

    esp_err_t err = handle->PrepareOtpRefresh();
    if (err == ESP_OK) {
        err = handle->DisplayOtpWhiteBase();
    }
    bool session_open = false;
    for (size_t pass = 0;
         err == ESP_OK && pass < ssd2683_waveform::kVendorGray16RenderPassCount;
         ++pass) {
        const auto& waveform = ssd2683_waveform::kVendorGray16RenderWaveforms[pass];
        if (!session_open) {
            err = handle->InitExternalWaveform(waveform.data(), waveform.size());
            session_open = err == ESP_OK;
        } else {
            err = handle->LoadExternalWaveform(waveform.data(), waveform.size());
        }
        if (err == ESP_OK) err = handle->WriteGrayPass(static_cast<int>(pass), framebuffer);
        if (err == ESP_OK) err = handle->TriggerExternalBatch(pass == 0);
    }
    if (session_open && handle->internal_power_on) {
        esp_err_t off_err = handle->SendCommand(0x02);
        if (off_err == ESP_OK) off_err = handle->SendData(0x00);
        if (off_err == ESP_OK) off_err = handle->WaitBusy("4bpp internal power off");
        handle->internal_power_on = false;
        if (err == ESP_OK) err = off_err;
    }
    const esp_err_t restore_err = handle->RestoreOtp();
    if (err == ESP_OK) err = restore_err;
    handle->shadow_valid = false;
    return err;
}
