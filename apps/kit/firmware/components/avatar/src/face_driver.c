#include "iterate/kit/avatar/face_driver.h"

#include <stdint.h>
#include <string.h>

bool face_driver_init(face_driver_t *driver,
                      const face_algorithm_t *algorithm,
                      void *state, size_t state_size,
                      uint32_t sample_rate,
                      const void *config, size_t config_size)
{
    if (driver == NULL || algorithm == NULL || state == NULL ||
        algorithm->init == NULL || algorithm->push_pcm == NULL ||
        algorithm->snapshot == NULL ||
        state_size < algorithm->state_size ||
        algorithm->state_alignment == 0 ||
        ((uintptr_t)state % algorithm->state_alignment) != 0) {
        return false;
    }

    memset(driver, 0, sizeof(*driver));
    memset(state, 0, algorithm->state_size);
    if (!algorithm->init(
            state, sample_rate, config, config_size)) {
        return false;
    }
    driver->algorithm = algorithm;
    driver->state = state;
    return true;
}

void face_driver_push_pcm(face_driver_t *driver,
                          const int16_t *samples, size_t sample_count)
{
    if (driver == NULL || driver->algorithm == NULL ||
        driver->state == NULL) {
        return;
    }
    driver->algorithm->push_pcm(driver->state, samples, sample_count);
}

void face_driver_push_event(
    face_driver_t *driver, const face_stream_event_t *event)
{
    if (driver == NULL || driver->algorithm == NULL ||
        driver->state == NULL ||
        driver->algorithm->push_event == NULL ||
        event == NULL) {
        return;
    }
    driver->algorithm->push_event(driver->state, event);
}

void face_driver_snapshot(const face_driver_t *driver, face_pose_t *pose)
{
    if (pose == NULL) {
        return;
    }
    if (driver == NULL || driver->algorithm == NULL ||
        driver->state == NULL) {
        memset(pose, 0, sizeof(*pose));
        pose->eye_open = UINT8_MAX;
        pose->viseme = FACE_VISEME_NONE;
        pose->phoneme = FACE_PHONEME_NONE;
        return;
    }
    driver->algorithm->snapshot(driver->state, pose);
}

const char *face_driver_name(const face_driver_t *driver)
{
    if (driver == NULL || driver->algorithm == NULL) {
        return "none";
    }
    return driver->algorithm->name;
}

size_t face_driver_state_size(const face_driver_t *driver)
{
    if (driver == NULL || driver->algorithm == NULL) {
        return 0;
    }
    return driver->algorithm->state_size;
}
