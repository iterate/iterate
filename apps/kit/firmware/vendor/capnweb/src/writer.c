// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "writer.h"

#include <stdio.h>
#include <string.h>

static void fail_transport(struct capnweb_writer *writer) {
  writer->status = CAPNWEB_E_TRANSPORT;
}

static void flush(struct capnweb_writer *writer) {
  if (writer->status != CAPNWEB_OK || writer->length == 0U) {
    return;
  }
  if (writer->send(
          writer->context,
          CAPNWEB_TEXT_DATA,
          writer->buffer,
          writer->length) != CAPNWEB_OK) {
    fail_transport(writer);
    return;
  }
  writer->length = 0U;
}

enum capnweb_status capnweb_writer_begin(
    struct capnweb_writer *writer,
    capnweb_send_text_fn send,
    void *context,
    char *buffer,
    size_t capacity) {
  if (writer == NULL ||
      send == NULL ||
      buffer == NULL ||
      capacity == 0U) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  *writer = (struct capnweb_writer){
    send,
    context,
    buffer,
    capacity,
    0U,
    CAPNWEB_OK,
  };
  if (send(context, CAPNWEB_TEXT_BEGIN, NULL, 0U) != CAPNWEB_OK) {
    fail_transport(writer);
  }
  return writer->status;
}

void capnweb_writer_write(
    struct capnweb_writer *writer, const char *data, size_t length) {
  if (writer == NULL ||
      writer->status != CAPNWEB_OK ||
      (data == NULL && length > 0U)) {
    if (writer != NULL && writer->status == CAPNWEB_OK) {
      writer->status = CAPNWEB_E_INVALID_ARGUMENT;
    }
    return;
  }

  while (length > 0U && writer->status == CAPNWEB_OK) {
    size_t available = writer->capacity - writer->length;
    size_t chunk = length < available ? length : available;
    memcpy(writer->buffer + writer->length, data, chunk);
    writer->length += chunk;
    data += chunk;
    length -= chunk;
    if (writer->length == writer->capacity) {
      flush(writer);
    }
  }
}

void capnweb_writer_write_c_string(
    struct capnweb_writer *writer, const char *value) {
  if (value == NULL) {
    if (writer != NULL && writer->status == CAPNWEB_OK) {
      writer->status = CAPNWEB_E_INVALID_ARGUMENT;
    }
    return;
  }
  capnweb_writer_write(writer, value, strlen(value));
}

void capnweb_writer_write_quoted(
    struct capnweb_writer *writer, const char *value) {
  if (value == NULL) {
    if (writer != NULL && writer->status == CAPNWEB_OK) {
      writer->status = CAPNWEB_E_INVALID_ARGUMENT;
    }
    return;
  }
  capnweb_writer_write_quoted_span(writer, value, strlen(value));
}

void capnweb_writer_write_quoted_span(
    struct capnweb_writer *writer, const char *value, size_t length) {
  const unsigned char *cursor;
  size_t position;
  if (writer == NULL) {
    return;
  }
  if (value == NULL && length > 0U) {
    if (writer->status == CAPNWEB_OK) {
      writer->status = CAPNWEB_E_INVALID_ARGUMENT;
    }
    return;
  }

  cursor = (const unsigned char *)value;
  capnweb_writer_write(writer, "\"", 1U);
  for (position = 0U;
       position < length && writer->status == CAPNWEB_OK;
       ++position) {
    char escaped[7];
    size_t escaped_length = 1U;
    unsigned char character = cursor[position];
    switch (character) {
      case '"':
        capnweb_writer_write(writer, "\\\"", 2U);
        break;
      case '\\':
        capnweb_writer_write(writer, "\\\\", 2U);
        break;
      case '\b':
        capnweb_writer_write(writer, "\\b", 2U);
        break;
      case '\f':
        capnweb_writer_write(writer, "\\f", 2U);
        break;
      case '\n':
        capnweb_writer_write(writer, "\\n", 2U);
        break;
      case '\r':
        capnweb_writer_write(writer, "\\r", 2U);
        break;
      case '\t':
        capnweb_writer_write(writer, "\\t", 2U);
        break;
      default:
        if (character < 0x20U) {
          int written = snprintf(
              escaped,
              sizeof(escaped),
              "\\u%04x",
              (unsigned int)character);
          if (written != 6) {
            writer->status = CAPNWEB_E_STATE;
            break;
          }
          escaped_length = (size_t)written;
        } else {
          escaped[0] = (char)character;
        }
        capnweb_writer_write(writer, escaped, escaped_length);
        break;
    }
  }
  capnweb_writer_write(writer, "\"", 1U);
}

void capnweb_writer_write_base64(
    struct capnweb_writer *writer, const uint8_t *data, size_t length) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t position = 0U;

  if (writer == NULL) {
    return;
  }
  if (data == NULL && length > 0U) {
    if (writer->status == CAPNWEB_OK) {
      writer->status = CAPNWEB_E_INVALID_ARGUMENT;
    }
    return;
  }
  while (length - position >= 3U && writer->status == CAPNWEB_OK) {
    char encoded[4];
    uint32_t value =
        (uint32_t)data[position] << 16U |
        (uint32_t)data[position + 1U] << 8U |
        (uint32_t)data[position + 2U];
    encoded[0] = alphabet[(value >> 18U) & 0x3fU];
    encoded[1] = alphabet[(value >> 12U) & 0x3fU];
    encoded[2] = alphabet[(value >> 6U) & 0x3fU];
    encoded[3] = alphabet[value & 0x3fU];
    capnweb_writer_write(writer, encoded, sizeof(encoded));
    position += 3U;
  }
  if (length - position == 1U) {
    char encoded[2];
    uint32_t value = (uint32_t)data[position] << 16U;
    encoded[0] = alphabet[(value >> 18U) & 0x3fU];
    encoded[1] = alphabet[(value >> 12U) & 0x3fU];
    capnweb_writer_write(writer, encoded, sizeof(encoded));
  } else if (length - position == 2U) {
    char encoded[3];
    uint32_t value =
        (uint32_t)data[position] << 16U |
        (uint32_t)data[position + 1U] << 8U;
    encoded[0] = alphabet[(value >> 18U) & 0x3fU];
    encoded[1] = alphabet[(value >> 12U) & 0x3fU];
    encoded[2] = alphabet[(value >> 6U) & 0x3fU];
    capnweb_writer_write(writer, encoded, sizeof(encoded));
  }
}

enum capnweb_status capnweb_writer_finish(struct capnweb_writer *writer) {
  if (writer == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  flush(writer);
  if (writer->status != CAPNWEB_OK) {
    return writer->status;
  }
  if (writer->send(
          writer->context, CAPNWEB_TEXT_END, NULL, 0U) != CAPNWEB_OK) {
    fail_transport(writer);
  }
  return writer->status;
}
