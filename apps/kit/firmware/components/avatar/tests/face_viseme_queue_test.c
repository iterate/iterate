#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "iterate/kit/avatar/face_animator.h"
#include "iterate/kit/avatar/face_viseme_queue.h"

static void changes_apply_only_when_playout_reaches_them(void)
{
    face_viseme_queue_t queue;
    face_viseme_change_t change;

    face_viseme_queue_init(&queue);
    assert(face_viseme_queue_push(&queue, 1, 0, FACE_VISEME_AA, 200));
    assert(face_viseme_queue_push(&queue, 1, 3200, FACE_VISEME_O, 180));

    assert(face_viseme_queue_advance(&queue, 1, 0, &change));
    assert(change.viseme == FACE_VISEME_AA);
    assert(!face_viseme_queue_advance(&queue, 1, 3199, &change));
    assert(face_viseme_queue_advance(&queue, 1, 3200, &change));
    assert(change.viseme == FACE_VISEME_O);
    assert(queue.count == 0);
}

static void one_advance_collapses_to_the_newest_crossed_change(void)
{
    face_viseme_queue_t queue;
    face_viseme_change_t change;

    face_viseme_queue_init(&queue);
    assert(face_viseme_queue_push(&queue, 1, 100, FACE_VISEME_AA, 200));
    assert(face_viseme_queue_push(&queue, 1, 200, FACE_VISEME_E, 200));
    assert(face_viseme_queue_push(&queue, 1, 300, FACE_VISEME_SIL, 200));

    assert(face_viseme_queue_advance(&queue, 1, 320, &change));
    assert(change.viseme == FACE_VISEME_SIL);
    assert(queue.count == 0);
}

static void a_newer_answer_supersedes_pending_changes(void)
{
    face_viseme_queue_t queue;
    face_viseme_change_t change;

    face_viseme_queue_init(&queue);
    assert(face_viseme_queue_push(&queue, 1, 4800, FACE_VISEME_AA, 200));
    assert(face_viseme_queue_push(&queue, 2, 0, FACE_VISEME_U, 190));

    /* Playout moved to answer 2: answer 1's pending shape must die. */
    assert(face_viseme_queue_advance(&queue, 2, 0, &change));
    assert(change.viseme == FACE_VISEME_U);
    assert(queue.superseded == 1);
    assert(queue.count == 0);
}

static void changes_for_a_future_answer_wait(void)
{
    face_viseme_queue_t queue;

    face_viseme_queue_init(&queue);
    assert(face_viseme_queue_push(&queue, 3, 0, FACE_VISEME_AA, 200));
    assert(!face_viseme_queue_advance(&queue, 2, 640000, NULL));
    assert(queue.count == 1);
}

static void overflow_drops_the_incoming_change_and_counts_it(void)
{
    face_viseme_queue_t queue;

    face_viseme_queue_init(&queue);
    for (uint32_t index = 0; index < FACE_VISEME_QUEUE_CAPACITY; ++index) {
        assert(face_viseme_queue_push(
            &queue, 1, index * 320, FACE_VISEME_E, 128));
    }
    assert(!face_viseme_queue_push(&queue, 1, 99999, FACE_VISEME_O, 128));
    assert(queue.overflowed == 1);
    assert(queue.count == FACE_VISEME_QUEUE_CAPACITY);
}

static void reset_forgets_everything(void)
{
    face_viseme_queue_t queue;

    face_viseme_queue_init(&queue);
    assert(face_viseme_queue_push(&queue, 1, 0, FACE_VISEME_AA, 200));
    face_viseme_queue_reset(&queue);
    assert(queue.count == 0);
    assert(!face_viseme_queue_advance(&queue, 1, 64000, NULL));
}

static void applied_visemes_reach_the_snapshot(void)
{
    face_animator_t animator;
    face_animator_state_t state;

    face_animator_init(&animator, 16000);
    face_animator_apply_viseme(&animator, FACE_VISEME_O, 210);
    assert(face_animator_snapshot(&animator, &state));
    assert(state.viseme == FACE_VISEME_O);
    assert(state.confidence == 210);

    face_animator_clear_viseme(&animator);
    assert(face_animator_snapshot(&animator, &state));
    assert(state.viseme == FACE_VISEME_NONE);
    assert(state.confidence == 0);
}

static void a_stalled_track_expires_back_to_rest(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    const int16_t silence[160] = {0};

    face_animator_init(&animator, 16000);
    face_animator_apply_viseme(&animator, FACE_VISEME_AA, 210);

    /* 290 ms of playout: still latched. */
    for (uint32_t window = 0; window < 29; ++window) {
        face_animator_push_pcm(&animator, silence, 160);
    }
    assert(face_animator_snapshot(&animator, &state));
    assert(state.viseme == FACE_VISEME_AA);

    /* 300 ms: released. */
    face_animator_push_pcm(&animator, silence, 160);
    assert(face_animator_snapshot(&animator, &state));
    assert(state.viseme == FACE_VISEME_NONE);
    assert(state.confidence == 0);
}

static void a_fresh_viseme_extends_the_expiry(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    const int16_t silence[160] = {0};

    face_animator_init(&animator, 16000);
    face_animator_apply_viseme(&animator, FACE_VISEME_AA, 210);
    for (uint32_t window = 0; window < 20; ++window) {
        face_animator_push_pcm(&animator, silence, 160);
    }
    face_animator_apply_viseme(&animator, FACE_VISEME_E, 210);
    for (uint32_t window = 0; window < 20; ++window) {
        face_animator_push_pcm(&animator, silence, 160);
    }
    assert(face_animator_snapshot(&animator, &state));
    assert(state.viseme == FACE_VISEME_E);
}

static void external_mouth_gates_the_envelope_but_not_the_eyes(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    int16_t voiced[320];
    for (size_t index = 0; index < 320; ++index) {
        voiced[index] = (index % 20 < 10) ? 12000 : -12000;
    }

    face_animator_init(&animator, 16000);
    face_animator_set_external_mouth(&animator, true);
    face_animator_push_pcm(&animator, voiced, 320);
    assert(face_animator_snapshot(&animator, &state));

    /* Loud PCM no longer moves the mouth... */
    assert(state.mouth_open == 0);
    assert(state.mouth_width == 0);
    /* ...but the analysis clock, level meter and lids still run. */
    assert(state.frame_index == 2);
    assert(state.level > 0);
    assert(state.eye_open == 255);
    assert(state.speaking);
}

static void disabling_external_mouth_returns_the_envelope(void)
{
    face_animator_t animator;
    face_animator_state_t state;
    int16_t voiced[320];
    for (size_t index = 0; index < 320; ++index) {
        voiced[index] = (index % 20 < 10) ? 12000 : -12000;
    }

    face_animator_init(&animator, 16000);
    face_animator_set_external_mouth(&animator, true);
    face_animator_push_pcm(&animator, voiced, 320);
    face_animator_set_external_mouth(&animator, false);
    face_animator_push_pcm(&animator, voiced, 320);
    assert(face_animator_snapshot(&animator, &state));
    assert(state.mouth_open >= 128);
}

static void queue_and_animator_compose(void)
{
    face_viseme_queue_t queue;
    face_viseme_change_t change;
    face_animator_t animator;
    face_animator_state_t state;
    const int16_t silence[320] = {0};

    face_viseme_queue_init(&queue);
    face_animator_init(&animator, 16000);
    face_animator_set_external_mouth(&animator, true);

    assert(face_viseme_queue_push(&queue, 7, 0, FACE_VISEME_AA, 220));
    assert(face_viseme_queue_push(&queue, 7, 320, FACE_VISEME_SIL, 220));

    face_animator_push_pcm(&animator, silence, 320);
    if (face_viseme_queue_advance(&queue, 7, 320, &change)) {
        face_animator_apply_viseme(&animator, change.viseme,
                                   change.confidence);
    }
    assert(face_animator_snapshot(&animator, &state));
    assert(state.viseme == FACE_VISEME_SIL);
    assert(state.confidence == 220);
}

int main(void)
{
    changes_apply_only_when_playout_reaches_them();
    one_advance_collapses_to_the_newest_crossed_change();
    a_newer_answer_supersedes_pending_changes();
    changes_for_a_future_answer_wait();
    overflow_drops_the_incoming_change_and_counts_it();
    reset_forgets_everything();
    applied_visemes_reach_the_snapshot();
    a_stalled_track_expires_back_to_rest();
    a_fresh_viseme_extends_the_expiry();
    external_mouth_gates_the_envelope_but_not_the_eyes();
    disabling_external_mouth_returns_the_envelope();
    queue_and_animator_compose();
    printf("face_viseme_queue_test passed\n");
    return 0;
}
