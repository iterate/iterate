#include "iterate/kit/avatar/face_animator.h"

#include <limits.h>
#include <string.h>

enum {
    ANALYSIS_WINDOWS_PER_SECOND = 100,
    FIRST_BLINK_FRAME = 220,
    FIRST_GAZE_FRAME = 70,
};

const face_envelope_config_t FACE_ENVELOPE_DEFAULT_CONFIG = {
    .speech_floor = 256,
    /*
     * Grok's levelled speech usually peaks around mean |PCM| 3400-4300.
     * Keep the noise floor, but let normal speech use nearly the full visual
     * range instead of reserving half of it for unusually hot audio.
     */
    .mouth_dynamic_range = 4600,
    .attack_percent = 75,
    .release_percent = 25,
};

static uint32_t deterministic_random(uint32_t value)
{
    value += 0x9e3779b9U;
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
    return value;
}

static void publish_begin(face_animator_t *animator)
{
    (void)__atomic_fetch_add(
        &animator->published_sequence, 1U, __ATOMIC_ACQ_REL);
}

static void publish_end(face_animator_t *animator)
{
    (void)__atomic_fetch_add(
        &animator->published_sequence, 1U, __ATOMIC_RELEASE);
}

static uint8_t mouth_open_for_level(const face_animator_t *animator,
                                    uint32_t level)
{
    if (level <= animator->config.speech_floor) {
        return 0;
    }

    uint32_t open =
        ((level - animator->config.speech_floor) * UINT8_MAX) /
        animator->config.mouth_dynamic_range;
    return (uint8_t)(open > UINT8_MAX ? UINT8_MAX : open);
}

static uint8_t smooth_value(const face_animator_t *animator,
                            uint8_t current, uint8_t target)
{
    if (target > current) {
        const uint32_t delta = (uint32_t)target - current;
        const uint32_t movement =
            (delta * animator->config.attack_percent + 99U) / 100U;
        return (uint8_t)(current + movement);
    }
    if (target < current) {
        const uint32_t delta = (uint32_t)current - target;
        const uint32_t movement =
            (delta * animator->config.release_percent + 99U) / 100U;
        return (uint8_t)(current - movement);
    }
    return current;
}

static uint8_t mouth_width_for_crossings(const face_animator_t *animator,
                                         uint8_t mouth_open)
{
    if (mouth_open == 0) {
        return 0;
    }

    const uint32_t possible_crossings =
        animator->window_samples > 1 ? animator->window_samples - 1 : 1;
    const uint32_t crossing_rate =
        animator->zero_crossings * UINT8_MAX / possible_crossings;
    const uint32_t narrowing = crossing_rate > 112 ? 112 : crossing_rate;
    return (uint8_t)(224U - narrowing);
}

static void update_idle_motion(face_animator_t *animator)
{
    static const uint8_t blink[] = {176, 64, 0, 64, 176, 255};
    const uint32_t frame_index =
        __atomic_load_n(&animator->state.frame_index, __ATOMIC_RELAXED);

    if (frame_index >= animator->next_gaze_frame) {
        const uint32_t gaze_random =
            deterministic_random(frame_index ^ 0x5f356495U);
        __atomic_store_n(
            &animator->state.gaze_x,
            (int8_t)((int32_t)(gaze_random % 17U) - 8),
            __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.gaze_y,
            (int8_t)((int32_t)((gaze_random >> 8) % 11U) - 5),
            __ATOMIC_RELAXED);
        animator->next_gaze_frame =
            frame_index + 120U +
            deterministic_random(gaze_random) % 141U;
    }

    if (animator->blink_phase != 0) {
        const size_t phase = (size_t)animator->blink_phase - 1U;
        __atomic_store_n(
            &animator->state.eye_open, blink[phase], __ATOMIC_RELAXED);
        animator->blink_phase += 1;
        if (animator->blink_phase > sizeof(blink) / sizeof(blink[0])) {
            animator->blink_phase = 0;
            animator->next_blink_frame =
                frame_index + 240U +
                deterministic_random(frame_index ^ 0x81e72f39U) % 181U;
        }
    } else if (frame_index >= animator->next_blink_frame) {
        animator->blink_phase = 2;
        __atomic_store_n(
            &animator->state.eye_open, blink[0], __ATOMIC_RELAXED);
    } else {
        __atomic_store_n(
            &animator->state.eye_open, UINT8_MAX, __ATOMIC_RELAXED);
    }
}

static void finish_analysis_window(face_animator_t *animator)
{
    const uint32_t level = animator->sum_abs / animator->window_samples;
    const bool listening = __atomic_load_n(
        &animator->listening_lock, __ATOMIC_ACQUIRE);
    const uint8_t target_open = listening
        ? 0U
        : mouth_open_for_level(animator, level);
    const uint8_t mouth_open = smooth_value(
        animator,
        __atomic_load_n(
            &animator->state.mouth_open, __ATOMIC_RELAXED),
        target_open);
    const uint8_t mouth_width = smooth_value(
        animator,
        __atomic_load_n(
            &animator->state.mouth_width, __ATOMIC_RELAXED),
        mouth_width_for_crossings(animator, target_open));
    const uint32_t frame_index =
        __atomic_load_n(
            &animator->state.frame_index, __ATOMIC_RELAXED) +
        1U;

    __atomic_store_n(
        &animator->state.frame_index, frame_index, __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.level,
        (uint16_t)(level > UINT16_MAX ? UINT16_MAX : level),
        __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.mouth_open, mouth_open, __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.mouth_width, mouth_width, __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.mouth_round,
        (uint8_t)(UINT8_MAX - mouth_width), __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.mouth_press, 0, __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.mouth_teeth,
        (uint8_t)((UINT8_MAX - mouth_width) / 3U), __ATOMIC_RELAXED);
    __atomic_store_n(
        &animator->state.speaking,
        !listening && mouth_open != 0,
        __ATOMIC_RELAXED);
    if (listening) {
        __atomic_store_n(
            &animator->state.activity,
            FACE_ACTIVITY_LISTENING, __ATOMIC_RELAXED);
    } else if (mouth_open != 0) {
        __atomic_store_n(
            &animator->state.activity,
            FACE_ACTIVITY_SPEAKING, __ATOMIC_RELAXED);
    } else if (__atomic_load_n(
                   &animator->state.activity, __ATOMIC_RELAXED) ==
               FACE_ACTIVITY_SPEAKING) {
        __atomic_store_n(
            &animator->state.activity,
            FACE_ACTIVITY_THINKING, __ATOMIC_RELAXED);
    }
    update_idle_motion(animator);
    animator->window_fill = 0;
    animator->sum_abs = 0;
    animator->zero_crossings = 0;
}

void face_animator_init(face_animator_t *animator, uint32_t sample_rate)
{
    (void)face_animator_init_with_config(
        animator, sample_rate, &FACE_ENVELOPE_DEFAULT_CONFIG);
}

bool face_animator_init_with_config(
    face_animator_t *animator, uint32_t sample_rate,
    const face_envelope_config_t *config)
{
    if (animator == NULL) {
        return false;
    }
    if (config == NULL) {
        config = &FACE_ENVELOPE_DEFAULT_CONFIG;
    }
    if (sample_rate == 0 || config->mouth_dynamic_range == 0 ||
        config->attack_percent == 0 || config->attack_percent > 100 ||
        config->release_percent == 0 || config->release_percent > 100) {
        return false;
    }
    memset(animator, 0, sizeof(*animator));
    animator->config = *config;
    animator->window_samples = sample_rate / ANALYSIS_WINDOWS_PER_SECOND;
    if (animator->window_samples == 0) {
        animator->window_samples = 1;
    }
    animator->next_blink_frame = FIRST_BLINK_FRAME;
    animator->next_gaze_frame = FIRST_GAZE_FRAME;
    animator->state.eye_open = 255;
    animator->state.viseme = FACE_VISEME_NONE;
    animator->state.phoneme = FACE_PHONEME_NONE;
    return true;
}

void face_animator_push_pcm(face_animator_t *animator,
                            const int16_t *samples,
                            size_t sample_count)
{
    if (animator == NULL || samples == NULL) {
        return;
    }

    publish_begin(animator);
    for (size_t index = 0; index < sample_count; ++index) {
        const int32_t sample = samples[index];
        const uint32_t magnitude =
            (uint32_t)(sample < 0 ? -sample : sample);
        const int8_t sign = sample > 0 ? 1 : (sample < 0 ? -1 : 0);

        animator->sum_abs += magnitude;
        if (sign != 0) {
            if (animator->last_sign != 0 && sign != animator->last_sign) {
                animator->zero_crossings += 1;
            }
            animator->last_sign = sign;
        }
        animator->window_fill += 1;
        __atomic_fetch_add(
            &animator->state.playout_samples, 1U, __ATOMIC_RELAXED);

        if (animator->window_fill == animator->window_samples) {
            finish_analysis_window(animator);
        }
    }
    publish_end(animator);
}

void face_animator_push_event(
    face_animator_t *animator, const face_stream_event_t *event)
{
    if (animator == NULL || event == NULL) {
        return;
    }
    switch (event->type) {
    case FACE_STREAM_USER_SPEECH_STARTED:
        __atomic_store_n(
            &animator->listening_lock, true, __ATOMIC_RELEASE);
        __atomic_store_n(
            &animator->state.activity,
            FACE_ACTIVITY_LISTENING, __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.mouth_open, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.mouth_width, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.mouth_round, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.mouth_press, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.mouth_teeth, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(
            &animator->state.speaking, false, __ATOMIC_RELAXED);
        break;
    case FACE_STREAM_USER_SPEECH_STOPPED:
    case FACE_STREAM_ASSISTANT_RESPONSE_STARTED:
        __atomic_store_n(
            &animator->listening_lock, false, __ATOMIC_RELEASE);
        __atomic_store_n(
            &animator->state.activity,
            FACE_ACTIVITY_THINKING, __ATOMIC_RELAXED);
        break;
    case FACE_STREAM_ASSISTANT_RESPONSE_DONE:
        __atomic_store_n(
            &animator->listening_lock, false, __ATOMIC_RELEASE);
        __atomic_store_n(
            &animator->state.activity,
            FACE_ACTIVITY_IDLE, __ATOMIC_RELAXED);
        break;
    default:
        break;
    }
}

bool face_animator_snapshot(const face_animator_t *animator,
                            face_animator_state_t *state)
{
    if (animator == NULL || state == NULL) {
        return false;
    }

    const uint32_t before = __atomic_load_n(
        &animator->published_sequence, __ATOMIC_ACQUIRE);
    if ((before & 1U) != 0U) {
        return false;
    }

    face_animator_state_t candidate;
    candidate.frame_index = __atomic_load_n(
        &animator->state.frame_index, __ATOMIC_RELAXED);
    candidate.playout_samples = __atomic_load_n(
        &animator->state.playout_samples, __ATOMIC_RELAXED);
    candidate.level = __atomic_load_n(
        &animator->state.level, __ATOMIC_RELAXED);
    candidate.mouth_open = __atomic_load_n(
        &animator->state.mouth_open, __ATOMIC_RELAXED);
    candidate.mouth_width = __atomic_load_n(
        &animator->state.mouth_width, __ATOMIC_RELAXED);
    candidate.mouth_round = __atomic_load_n(
        &animator->state.mouth_round, __ATOMIC_RELAXED);
    candidate.mouth_press = __atomic_load_n(
        &animator->state.mouth_press, __ATOMIC_RELAXED);
    candidate.mouth_teeth = __atomic_load_n(
        &animator->state.mouth_teeth, __ATOMIC_RELAXED);
    candidate.eye_open = __atomic_load_n(
        &animator->state.eye_open, __ATOMIC_RELAXED);
    candidate.gaze_x = __atomic_load_n(
        &animator->state.gaze_x, __ATOMIC_RELAXED);
    candidate.gaze_y = __atomic_load_n(
        &animator->state.gaze_y, __ATOMIC_RELAXED);
    candidate.viseme = __atomic_load_n(
        &animator->state.viseme, __ATOMIC_RELAXED);
    candidate.phoneme = __atomic_load_n(
        &animator->state.phoneme, __ATOMIC_RELAXED);
    candidate.confidence = __atomic_load_n(
        &animator->state.confidence, __ATOMIC_RELAXED);
    candidate.activity = __atomic_load_n(
        &animator->state.activity, __ATOMIC_RELAXED);
    candidate.speaking = __atomic_load_n(
        &animator->state.speaking, __ATOMIC_RELAXED);

    const uint32_t after = __atomic_load_n(
        &animator->published_sequence, __ATOMIC_ACQUIRE);
    if (before != after) {
        return false;
    }
    *state = candidate;
    return true;
}

static bool envelope_algorithm_init(
    void *state, uint32_t sample_rate,
    const void *config, size_t config_size)
{
    if (config == NULL && config_size != 0) {
        return false;
    }
    if (config != NULL && config_size != sizeof(face_envelope_config_t)) {
        return false;
    }
    return face_animator_init_with_config(
        state, sample_rate, config);
}

static void envelope_algorithm_push(
    void *state, const int16_t *samples, size_t sample_count)
{
    face_animator_push_pcm(state, samples, sample_count);
}

static void envelope_algorithm_event(
    void *state, const face_stream_event_t *event)
{
    face_animator_push_event(state, event);
}

static void envelope_algorithm_snapshot(
    const void *state, face_pose_t *pose)
{
    /* Generic callers retain their prior pose if the one-shot read races. */
    (void)face_animator_snapshot(state, pose);
}

const face_algorithm_t FACE_ALGORITHM_ENVELOPE = {
    .name = "envelope",
    .state_size = sizeof(face_animator_t),
    .state_alignment = _Alignof(face_animator_t),
    .init = envelope_algorithm_init,
    .push_pcm = envelope_algorithm_push,
    .push_event = envelope_algorithm_event,
    .snapshot = envelope_algorithm_snapshot,
};
