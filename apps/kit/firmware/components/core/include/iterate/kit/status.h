#ifndef ITERATE_KIT_STATUS_H
#define ITERATE_KIT_STATUS_H

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_status {
  ITERATE_KIT_OK = 0,
  ITERATE_KIT_INVALID_ARGUMENT = -1,
  ITERATE_KIT_UNAVAILABLE = -2,
  ITERATE_KIT_IO_ERROR = -3,
  ITERATE_KIT_LIMIT = -4,
  ITERATE_KIT_BACKPRESSURE = -5,
  ITERATE_KIT_STATE_ERROR = -6,
};

#ifdef __cplusplus
}
#endif

#endif
