// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include "json.h"

#include <string.h>

struct string_cursor {
  const char *json;
  size_t position;
  size_t end;
};

static bool value_is_valid(const struct capnweb_value *value) {
  return value != NULL &&
      value->json != NULL &&
      value->tokens != NULL &&
      value->token != CAPNWEB_NO_TOKEN &&
      value->token < value->token_count;
}

static void set_value(
    const struct capnweb_value *source,
    size_t token,
    struct capnweb_value *destination) {
  destination->json = source->json;
  destination->tokens = source->tokens;
  destination->token_count = source->token_count;
  destination->token = token;
}

static int hex_value(char value) {
  if (value >= '0' && value <= '9') {
    return value - '0';
  }
  if (value >= 'a' && value <= 'f') {
    return value - 'a' + 10;
  }
  if (value >= 'A' && value <= 'F') {
    return value - 'A' + 10;
  }
  return -1;
}

static bool read_hex_quad(struct string_cursor *cursor, uint32_t *result) {
  uint32_t value = 0U;
  size_t index;
  if (cursor->end - cursor->position < 4U) {
    return false;
  }
  for (index = 0U; index < 4U; ++index) {
    int digit = hex_value(cursor->json[cursor->position++]);
    if (digit < 0) {
      return false;
    }
    value = value * 16U + (uint32_t)digit;
  }
  *result = value;
  return true;
}

static enum capnweb_status encode_code_point(
    uint32_t code_point, char bytes[4], size_t *length) {
  if (code_point <= 0x7fU) {
    bytes[0] = (char)code_point;
    *length = 1U;
    return CAPNWEB_OK;
  }
  if (code_point <= 0x7ffU) {
    bytes[0] = (char)(0xc0U | code_point >> 6U);
    bytes[1] = (char)(0x80U | (code_point & 0x3fU));
    *length = 2U;
    return CAPNWEB_OK;
  }
  if (code_point <= 0xffffU) {
    bytes[0] = (char)(0xe0U | code_point >> 12U);
    bytes[1] = (char)(0x80U | (code_point >> 6U & 0x3fU));
    bytes[2] = (char)(0x80U | (code_point & 0x3fU));
    *length = 3U;
    return CAPNWEB_OK;
  }
  if (code_point <= 0x10ffffU) {
    bytes[0] = (char)(0xf0U | code_point >> 18U);
    bytes[1] = (char)(0x80U | (code_point >> 12U & 0x3fU));
    bytes[2] = (char)(0x80U | (code_point >> 6U & 0x3fU));
    bytes[3] = (char)(0x80U | (code_point & 0x3fU));
    *length = 4U;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_MESSAGE;
}

static enum capnweb_status decode_next(
    struct string_cursor *cursor,
    char bytes[4],
    size_t *length,
    bool *done) {
  unsigned char value;
  uint32_t code_point;

  if (cursor->position >= cursor->end) {
    *length = 0U;
    *done = true;
    return CAPNWEB_OK;
  }
  *done = false;
  value = (unsigned char)cursor->json[cursor->position++];
  if (value != '\\') {
    bytes[0] = (char)value;
    *length = 1U;
    return CAPNWEB_OK;
  }
  if (cursor->position >= cursor->end) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }

  value = (unsigned char)cursor->json[cursor->position++];
  switch (value) {
    case '"':
    case '\\':
    case '/':
      bytes[0] = (char)value;
      *length = 1U;
      return CAPNWEB_OK;
    case 'b':
      bytes[0] = '\b';
      *length = 1U;
      return CAPNWEB_OK;
    case 'f':
      bytes[0] = '\f';
      *length = 1U;
      return CAPNWEB_OK;
    case 'n':
      bytes[0] = '\n';
      *length = 1U;
      return CAPNWEB_OK;
    case 'r':
      bytes[0] = '\r';
      *length = 1U;
      return CAPNWEB_OK;
    case 't':
      bytes[0] = '\t';
      *length = 1U;
      return CAPNWEB_OK;
    case 'u':
      break;
    default:
      return CAPNWEB_E_INVALID_MESSAGE;
  }

  if (!read_hex_quad(cursor, &code_point)) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }
  if (code_point >= 0xd800U && code_point <= 0xdbffU) {
    uint32_t low_surrogate;
    if (cursor->end - cursor->position < 6U ||
        cursor->json[cursor->position] != '\\' ||
        cursor->json[cursor->position + 1U] != 'u') {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    cursor->position += 2U;
    if (!read_hex_quad(cursor, &low_surrogate) ||
        low_surrogate < 0xdc00U ||
        low_surrogate > 0xdfffU) {
      return CAPNWEB_E_INVALID_MESSAGE;
    }
    code_point = 0x10000U +
        (code_point - 0xd800U) * 0x400U +
        low_surrogate - 0xdc00U;
  } else if (code_point >= 0xdc00U && code_point <= 0xdfffU) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }
  return encode_code_point(code_point, bytes, length);
}

bool capnweb_value_string_equals(
    const struct capnweb_value *value, const char *expected) {
  const struct capnweb_json_token *token;
  struct string_cursor cursor;
  size_t expected_position = 0U;

  if (!value_is_valid(value) ||
      expected == NULL ||
      value->tokens[value->token].type != CAPNWEB_JSON_STRING) {
    return false;
  }
  token = &value->tokens[value->token];
  cursor = (struct string_cursor){
    value->json,
    token->start,
    token->end,
  };
  for (;;) {
    char bytes[4];
    size_t length;
    bool done;
    size_t index;
    if (decode_next(&cursor, bytes, &length, &done) != CAPNWEB_OK) {
      return false;
    }
    if (done) {
      return expected[expected_position] == '\0';
    }
    for (index = 0U; index < length; ++index) {
      if (expected[expected_position] == '\0' ||
          expected[expected_position] != bytes[index]) {
        return false;
      }
      ++expected_position;
    }
  }
}

enum capnweb_json_type capnweb_value_get_type(
    const struct capnweb_value *value) {
  if (!value_is_valid(value)) {
    return CAPNWEB_JSON_UNDEFINED;
  }
  return value->tokens[value->token].type;
}

size_t capnweb_value_array_size(const struct capnweb_value *value) {
  if (!value_is_valid(value) ||
      value->tokens[value->token].type != CAPNWEB_JSON_ARRAY) {
    return 0U;
  }
  return value->tokens[value->token].count;
}

bool capnweb_value_array_at(
    const struct capnweb_value *value,
    size_t index,
    struct capnweb_value *element) {
  size_t token;
  size_t current;
  if (!value_is_valid(value) ||
      element == NULL ||
      value->tokens[value->token].type != CAPNWEB_JSON_ARRAY ||
      index >= value->tokens[value->token].count) {
    return false;
  }
  token = value->tokens[value->token].child;
  for (current = 0U; current < index; ++current) {
    if (token >= value->token_count) {
      return false;
    }
    token = value->tokens[token].next;
  }
  if (token >= value->token_count) {
    return false;
  }
  set_value(value, token, element);
  return true;
}

bool capnweb_value_object_get(
    const struct capnweb_value *value,
    const char *key,
    struct capnweb_value *element) {
  size_t key_token;
  size_t index;
  if (!value_is_valid(value) ||
      key == NULL ||
      element == NULL ||
      value->tokens[value->token].type != CAPNWEB_JSON_OBJECT) {
    return false;
  }

  key_token = value->tokens[value->token].child;
  for (index = 0U;
       index < value->tokens[value->token].count;
       ++index) {
    struct capnweb_value key_value;
    size_t element_token;
    if (key_token >= value->token_count) {
      return false;
    }
    element_token = value->tokens[key_token].next;
    if (element_token >= value->token_count) {
      return false;
    }
    set_value(value, key_token, &key_value);
    if (capnweb_value_string_equals(&key_value, key)) {
      set_value(value, element_token, element);
      return true;
    }
    key_token = value->tokens[element_token].next;
  }
  return false;
}

bool capnweb_value_get_boolean(
    const struct capnweb_value *value, bool *result) {
  const struct capnweb_json_token *token;
  size_t length;
  if (!value_is_valid(value) ||
      result == NULL ||
      value->tokens[value->token].type != CAPNWEB_JSON_BOOLEAN) {
    return false;
  }
  token = &value->tokens[value->token];
  length = token->end - token->start;
  if (length == 4U &&
      memcmp(value->json + token->start, "true", 4U) == 0) {
    *result = true;
    return true;
  }
  if (length == 5U &&
      memcmp(value->json + token->start, "false", 5U) == 0) {
    *result = false;
    return true;
  }
  return false;
}

bool capnweb_value_get_int64(
    const struct capnweb_value *value, int64_t *result) {
  if (!value_is_valid(value) || result == NULL) {
    return false;
  }
  return capnweb_json_token_get_int64(
      value->json, &value->tokens[value->token], result);
}

enum capnweb_status capnweb_value_copy_string(
    const struct capnweb_value *value,
    char *buffer,
    size_t capacity,
    size_t *length) {
  const struct capnweb_json_token *token;
  struct string_cursor cursor;
  size_t written = 0U;
  bool limited = false;

  if (!value_is_valid(value) ||
      buffer == NULL ||
      capacity == 0U ||
      length == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (value->tokens[value->token].type != CAPNWEB_JSON_STRING) {
    return CAPNWEB_E_INVALID_MESSAGE;
  }
  token = &value->tokens[value->token];
  cursor = (struct string_cursor){
    value->json,
    token->start,
    token->end,
  };
  for (;;) {
    char bytes[4];
    size_t decoded_length;
    bool done;
    enum capnweb_status status = decode_next(
        &cursor, bytes, &decoded_length, &done);
    if (status != CAPNWEB_OK) {
      return status;
    }
    if (done) {
      break;
    }
    if (decoded_length > SIZE_MAX - written) {
      return CAPNWEB_E_LIMIT;
    }
    if (written + decoded_length < capacity) {
      memcpy(buffer + written, bytes, decoded_length);
    } else {
      limited = true;
    }
    written += decoded_length;
  }
  buffer[written < capacity ? written : capacity - 1U] = '\0';
  *length = written;
  return limited ? CAPNWEB_E_LIMIT : CAPNWEB_OK;
}

bool capnweb_value_get_remote_capability(
    const struct capnweb_value *value,
    struct capnweb_remote_capability *capability) {
  struct capnweb_value type;
  struct capnweb_value id_value;
  int64_t id;
  if (capability == NULL ||
      capnweb_value_array_size(value) != 2U ||
      !capnweb_value_array_at(value, 0U, &type) ||
      !capnweb_value_array_at(value, 1U, &id_value) ||
      !capnweb_value_string_equals(&type, "export") ||
      !capnweb_value_get_int64(&id_value, &id) ||
      id >= 0) {
    return false;
  }
  capability->id = id;
  return true;
}

bool capnweb_call_path_equals(
    const struct capnweb_call *call,
    const char *const *segments,
    size_t segment_count) {
  size_t index;
  if (call == NULL ||
      (segments == NULL && segment_count > 0U) ||
      capnweb_value_array_size(&call->path) != segment_count) {
    return false;
  }
  for (index = 0U; index < segment_count; ++index) {
    struct capnweb_value segment;
    if (segments[index] == NULL ||
        !capnweb_value_array_at(&call->path, index, &segment) ||
        !capnweb_value_string_equals(&segment, segments[index])) {
      return false;
    }
  }
  return true;
}
