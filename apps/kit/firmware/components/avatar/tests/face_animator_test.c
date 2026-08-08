#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "iterate/kit/avatar/face_animator.h"

_Static_assert(sizeof(face_animator_t) <= 64,
               "the face animator must stay in tiny internal RAM");

static void assert_state_equal(const face_animator_state_t *left,
                               const face_animator_state_t *right)
{
    assert(left->frame_index == right->frame_index);
    assert(left->playout_samples == right->playout_samples);
    assert(left->level == right->level);
    assert(left->mouth_open == right->mouth_open);
    assert(left->mouth_width == right->mouth_width);
    assert(left->eye_open == right->eye_open);
    assert(left->gaze_x == right->gaze_x);
    assert(left->gaze_y == right->gaze_y);
    assert(left->speaking == right->speaking);
}

static void silence_keeps_the_face_at_rest(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    const int16_t silence[320] = {0};

    face_animator_init(&animator, 16000);
    face_animator_push_pcm(
        &animator, silence, sizeof(silence) / sizeof(silence[0]));
    face_animator_snapshot(&animator, &state);

    assert(!state.speaking);
    assert(state.mouth_open == 0);
}

static void voiced_pcm_opens_the_mouth_within_twenty_milliseconds(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    int16_t voiced[320];
    for (size_t index = 0; index < 320; ++index) {
        voiced[index] = (index % 20 < 10) ? 12000 : -12000;
    }

    face_animator_init(&animator, 16000);
    face_animator_push_pcm(
        &animator, voiced, sizeof(voiced) / sizeof(voiced[0]));
    face_animator_snapshot(&animator, &state);

    assert(state.frame_index == 2);
    assert(state.playout_samples == 320);
    assert(state.speaking);
    assert(state.mouth_open >= 128);
}

static void moderate_speech_uses_most_of_the_mouth_range(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    int16_t speech[640];
    for (size_t index = 0; index < 640; ++index) {
        speech[index] = (index % 40 < 20) ? 4000 : -4000;
    }

    face_animator_init(&animator, 16000);
    face_animator_push_pcm(
        &animator, speech, sizeof(speech) / sizeof(speech[0]));
    face_animator_snapshot(&animator, &state);

    assert(state.speaking);
    assert(state.mouth_open >= 190);
}

static void user_speech_locks_an_obvious_closed_mouth_listening_pose(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    int16_t assistant_pcm[320];
    for (size_t index = 0; index < 320; ++index) {
        assistant_pcm[index] =
            (index % 20 < 10) ? 12000 : -12000;
    }

    face_animator_init(&animator, 16000);
    face_animator_push_pcm(&animator, assistant_pcm, 320);
    const face_stream_event_t speech_started = {
        .type = FACE_STREAM_USER_SPEECH_STARTED,
    };
    face_animator_push_event(&animator, &speech_started);
    face_animator_push_pcm(&animator, assistant_pcm, 320);
    face_animator_snapshot(&animator, &state);

    assert(state.activity == FACE_ACTIVITY_LISTENING);
    assert(!state.speaking);
    assert(state.mouth_open == 0U);

    const face_stream_event_t speech_stopped = {
        .type = FACE_STREAM_USER_SPEECH_STOPPED,
    };
    face_animator_push_event(&animator, &speech_stopped);
    face_animator_snapshot(&animator, &state);
    assert(state.activity == FACE_ACTIVITY_THINKING);
}

static void mouth_release_is_smooth_but_bounded(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    int16_t voiced[320];
    const int16_t ten_ms_silence[160] = {0};
    const int16_t two_hundred_ms_silence[3200] = {0};
    for (size_t index = 0; index < 320; ++index) {
        voiced[index] = (index % 20 < 10) ? 12000 : -12000;
    }

    face_animator_init(&animator, 16000);
    face_animator_push_pcm(
        &animator, voiced, sizeof(voiced) / sizeof(voiced[0]));
    face_animator_push_pcm(&animator,
                           ten_ms_silence,
                           sizeof(ten_ms_silence) /
                               sizeof(ten_ms_silence[0]));
    face_animator_snapshot(&animator, &state);

    assert(state.speaking);
    assert(state.mouth_open > 0);

    face_animator_push_pcm(&animator,
                           two_hundred_ms_silence,
                           sizeof(two_hundred_ms_silence) /
                               sizeof(two_hundred_ms_silence[0]));
    face_animator_snapshot(&animator, &state);

    assert(!state.speaking);
    assert(state.mouth_open == 0);
}

static void websocket_packet_boundaries_cannot_change_the_face(void)
{
    face_animator_t contiguous;
    face_animator_t fragmented;
    face_animator_state_t contiguous_state;
    face_animator_state_t fragmented_state;
    int16_t pcm[1733];
    const size_t chunks[] = {1, 37, 3, 159, 320, 11, 503, 2, 697};

    for (size_t index = 0; index < sizeof(pcm) / sizeof(pcm[0]); ++index) {
        const int32_t value =
            (int32_t)((index * 7919U + 1237U) & 0xffffU) - 32768;
        pcm[index] = (int16_t)(value / 2);
    }

    face_animator_init(&contiguous, 16000);
    face_animator_init(&fragmented, 16000);
    face_animator_push_pcm(
        &contiguous, pcm, sizeof(pcm) / sizeof(pcm[0]));

    size_t offset = 0;
    size_t chunk_index = 0;
    while (offset < sizeof(pcm) / sizeof(pcm[0])) {
        size_t count =
            chunks[chunk_index % (sizeof(chunks) / sizeof(chunks[0]))];
        const size_t remaining =
            sizeof(pcm) / sizeof(pcm[0]) - offset;
        if (count > remaining) {
            count = remaining;
        }
        face_animator_push_pcm(&fragmented, pcm + offset, count);
        offset += count;
        chunk_index += 1;
    }

    face_animator_snapshot(&contiguous, &contiguous_state);
    face_animator_snapshot(&fragmented, &fragmented_state);
    assert_state_equal(&contiguous_state, &fragmented_state);
}

static void spectral_activity_changes_mouth_shape_without_an_fft(void)
{
    face_animator_t vowel_like;
    face_animator_t fricative_like;
    face_animator_state_t vowel_state;
    face_animator_state_t fricative_state;
    int16_t slow_crossings[640];
    int16_t fast_crossings[640];

    for (size_t index = 0; index < 640; ++index) {
        slow_crossings[index] =
            (index % 80 < 40) ? 9000 : -9000;
        fast_crossings[index] =
            (index % 4 < 2) ? 9000 : -9000;
    }

    face_animator_init(&vowel_like, 16000);
    face_animator_init(&fricative_like, 16000);
    face_animator_push_pcm(&vowel_like, slow_crossings, 640);
    face_animator_push_pcm(&fricative_like, fast_crossings, 640);
    face_animator_snapshot(&vowel_like, &vowel_state);
    face_animator_snapshot(&fricative_like, &fricative_state);

    assert(vowel_state.speaking);
    assert(fricative_state.speaking);
    assert(vowel_state.mouth_width > fricative_state.mouth_width);
}

static void idle_motion_is_deterministic_on_the_playout_clock(void)
{
    face_animator_t first;
    face_animator_t second;
    face_animator_state_t first_state;
    face_animator_state_t second_state;
    const int16_t silence[160] = {0};
    bool saw_blink = false;
    bool saw_gaze = false;

    face_animator_init(&first, 16000);
    face_animator_init(&second, 16000);
    for (size_t window = 0; window < 500; ++window) {
        face_animator_push_pcm(&first, silence, 160);
        face_animator_push_pcm(&second, silence, 160);
        face_animator_snapshot(&first, &first_state);
        face_animator_snapshot(&second, &second_state);
        assert_state_equal(&first_state, &second_state);
        saw_blink = saw_blink || first_state.eye_open < 255;
        saw_gaze = saw_gaze || first_state.gaze_x != 0 ||
                   first_state.gaze_y != 0;
    }

    assert(saw_blink);
    assert(saw_gaze);
}

/*
 * The display task and analyzer deliberately share core 0 on StackChan. If a
 * lower-priority analyzer is preempted after opening its seqlock, a renderer
 * which waits for the write to finish prevents the analyzer from ever running
 * again. This test fixes that architectural failure mode at the portable seam:
 * an in-progress publication must fail immediately and preserve the last good
 * pose, allowing the renderer to keep drawing and retry 33 ms later.
 */
static void snapshot_never_waits_for_a_preempted_writer(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    face_animator_state_t before;

    face_animator_init(&animator, 16000);
    memset(&state, 0xa5, sizeof(state));
    before = state;
    animator.published_sequence = 1U;

    assert(!face_animator_snapshot(&animator, &state));
    assert(memcmp(&state, &before, sizeof(state)) == 0);
}

int main(void)
{
    silence_keeps_the_face_at_rest();
    voiced_pcm_opens_the_mouth_within_twenty_milliseconds();
    moderate_speech_uses_most_of_the_mouth_range();
    user_speech_locks_an_obvious_closed_mouth_listening_pose();
    mouth_release_is_smooth_but_bounded();
    websocket_packet_boundaries_cannot_change_the_face();
    spectral_activity_changes_mouth_shape_without_an_fft();
    idle_motion_is_deterministic_on_the_playout_clock();
    snapshot_never_waits_for_a_preempted_writer();
    puts("face_animator_test: PASS");
    return 0;
}
