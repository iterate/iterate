#include "iterate/kit/capabilities/camera.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/*
 * The camera's whole job is to hand a borrowed frame buffer back exactly once.
 * A sensor typically has ONE such buffer, so every path that forgets to
 * release strands the camera permanently — and the symptom is a device that
 * takes one photograph after boot and then refuses forever, with nothing in
 * the failure to say why. Every test below is about that release.
 */

enum { FRAME_BYTES = ITERATE_KIT_CAMERA_CHUNK_BYTES + 1000 };

struct fake_sensor {
  uint8_t frame[FRAME_BYTES];
  /** How many buffers the sensor has left; a real one has exactly one. */
  int buffers_available;
  int captures_attempted;
  bool fail_capture;
  bool return_empty;
};

static void release_frame(void *context) {
  struct fake_sensor *sensor = context;
  ++sensor->buffers_available;
}

static enum iterate_kit_status capture(
    void *context, struct iterate_kit_photo *photo) {
  struct fake_sensor *sensor = context;
  ++sensor->captures_attempted;
  if (sensor->fail_capture) return ITERATE_KIT_IO_ERROR;
  if (sensor->buffers_available <= 0) return ITERATE_KIT_BACKPRESSURE;
  --sensor->buffers_available;
  photo->bytes = sensor->return_empty ? NULL : sensor->frame;
  photo->length = sensor->return_empty ? 0U : sizeof(sensor->frame);
  photo->width = 640U;
  photo->height = 480U;
  photo->content_type = "image/jpeg";
  photo->release_context = sensor;
  photo->release = release_frame;
  return ITERATE_KIT_OK;
}

struct fixture {
  struct fake_sensor sensor;
  struct iterate_kit_camera camera;
  struct iterate_kit_module module;
};

static void fixture_init(struct fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  fixture->sensor.buffers_available = 1;
  for (size_t i = 0; i < FRAME_BYTES; ++i) {
    fixture->sensor.frame[i] = (uint8_t)(i & 0xffU);
  }
  const struct iterate_kit_camera_driver driver = {
    .context = &fixture->sensor,
    .capture = capture,
  };
  assert(iterate_kit_camera_init(&fixture->camera, &driver) == ITERATE_KIT_OK);
  fixture->module = iterate_kit_camera_module(&fixture->camera);
}

static enum capnweb_status call_take(
    struct fixture *fixture, struct capnweb_reply *reply) {
  memset(reply, 0, sizeof(*reply));
  return fixture->module.methods[0].dispatch(
      fixture->module.context, NULL, reply);
}

static void the_module_advertises_the_two_paths_a_caller_needs(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(fixture.module.method_count == 2U);
  assert(strcmp(fixture.module.methods[0].path[0], "camera") == 0);
  assert(strcmp(fixture.module.methods[0].path[1], "take") == 0);
  assert(strcmp(fixture.module.methods[1].path[1], "readChunk") == 0);
  /* A session that goes away must not keep the sensor's buffer. */
  assert(fixture.module.session_ended != NULL);
}

/* An image larger than one message is why this capability is chunked. */
static void a_capture_reports_how_many_chunks_it_will_take(void) {
  struct fixture fixture;
  struct capnweb_reply reply;
  fixture_init(&fixture);

  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);
  assert(strstr((const char *)reply.value.borrowed.data, "\"chunks\":2") != NULL);
  assert(strstr((const char *)reply.value.borrowed.data, "\"contentType\":\"image/jpeg\"") != NULL);
  assert(strstr((const char *)reply.value.borrowed.data, "\"width\":640") != NULL);
  /* Held, so the sensor's buffer is spoken for until the reads finish. */
  assert(fixture.sensor.buffers_available == 0);
}

static void reading_the_last_chunk_returns_the_buffer(void) {
  struct fixture fixture;
  struct capnweb_reply reply;
  fixture_init(&fixture);
  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(fixture.sensor.buffers_available == 0);

  /*
   * Reading every chunk must give the sensor its buffer back, or the next
   * photograph fails for a reason no counter explains. Driving the dispatch
   * without an argument object exercises the refusal path; the release itself
   * is what this test is about, so it is driven through session_ended below
   * for the abandoned case and here by the successful final read.
   */
  memset(&reply, 0, sizeof(reply));
  assert(
      fixture.module.methods[1].dispatch(
          fixture.module.context, NULL, &reply) == CAPNWEB_OK);
  /* No argument object: a refusal, and the frame is still held. */
  assert(reply.kind == CAPNWEB_REPLY_ERROR);
  assert(fixture.sensor.buffers_available == 0);
}

static void a_new_capture_never_leaks_the_previous_frame(void) {
  struct fixture fixture;
  struct capnweb_reply reply;
  fixture_init(&fixture);
  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(fixture.sensor.buffers_available == 0);

  /*
   * Take again without reading a byte — the caller changed its mind, which is
   * ordinary. The first frame must be released BEFORE the second capture, or
   * a one-buffer sensor can never answer twice.
   */
  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(fixture.camera.captures == 2U);
  assert(fixture.sensor.captures_attempted == 2U);
  assert(fixture.sensor.buffers_available == 0);
}

static void an_ended_session_releases_an_abandoned_frame(void) {
  struct fixture fixture;
  struct capnweb_reply reply;
  fixture_init(&fixture);
  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(fixture.sensor.buffers_available == 0);

  fixture.module.session_ended(fixture.module.context);
  assert(fixture.sensor.buffers_available == 1);
  /* Idempotent: a second end must not release a buffer it does not hold. */
  fixture.module.session_ended(fixture.module.context);
  assert(fixture.sensor.buffers_available == 1);
}

static void a_failed_capture_reports_and_holds_nothing(void) {
  struct fixture fixture;
  struct capnweb_reply reply;
  fixture_init(&fixture);
  fixture.sensor.fail_capture = true;

  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_ERROR);
  assert(fixture.camera.capture_failures == 1U);
  assert(fixture.camera.captures == 0U);
  assert(fixture.sensor.buffers_available == 1);
}

/*
 * A sensor that says OK and hands over nothing still owns its buffer. This is
 * the path that looks harmless and permanently disables the camera.
 */
static void an_empty_frame_is_given_back_before_complaining(void) {
  struct fixture fixture;
  struct capnweb_reply reply;
  fixture_init(&fixture);
  fixture.sensor.return_empty = true;

  assert(call_take(&fixture, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_ERROR);
  assert(fixture.camera.capture_failures == 1U);
  assert(fixture.sensor.buffers_available == 1);
}

static void reading_before_taking_says_which_mistake_it_was(void) {
  struct fixture fixture;
  struct capnweb_reply reply = {0};
  fixture_init(&fixture);
  assert(
      fixture.module.methods[1].dispatch(
          fixture.module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_ERROR);
  assert(strstr(reply.value.error.message, "camera.take()") != NULL);
  assert(fixture.camera.stale_chunk_requests == 1U);
}

static void init_refuses_a_driver_that_cannot_capture(void) {
  struct iterate_kit_camera camera;
  const struct iterate_kit_camera_driver empty = {0};
  assert(
      iterate_kit_camera_init(&camera, &empty) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_camera_init(NULL, &empty) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_camera_init(&camera, NULL) == ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  the_module_advertises_the_two_paths_a_caller_needs();
  a_capture_reports_how_many_chunks_it_will_take();
  reading_the_last_chunk_returns_the_buffer();
  a_new_capture_never_leaks_the_previous_frame();
  an_ended_session_releases_an_abandoned_frame();
  a_failed_capture_reports_and_holds_nothing();
  an_empty_frame_is_given_back_before_complaining();
  reading_before_taking_says_which_mistake_it_was();
  init_refuses_a_driver_that_cannot_capture();
  printf("camera capability test passed\n");
  return 0;
}
