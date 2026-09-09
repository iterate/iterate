#include "iterate/kit/button.h"

#include <assert.h>
#include <stddef.h>

/** One sampled level and the consumable events/held level after that sample. */
struct button_sample {
  bool pressed;
  uint64_t at_ms;
  bool inject_tap;
  struct { bool press; bool tap; bool held; bool end_hold; } becomes;
};

/** A fresh classifier driven by an ordered sequence of samples. */
struct button_case {
  const char *name;
  struct button_sample samples[10];
  size_t count;
};

int main(void) {
  const struct button_case cases[] = {
    {"bounce shorter than debounce", {
      {true, 100, false, {false, false, false, false}},
      {false, 129, false, {false, false, false, false}},
      {false, 200, false, {false, false, false, false}},
    }, 3},
    {"tap at 200 ms", {
      {true, 0, false, {false, false, false, false}},
      {true, 29, false, {false, false, false, false}},
      {true, 30, false, {true, false, false, false}},
      {false, 200, false, {false, false, false, false}},
      {false, 230, false, {false, true, false, false}},
    }, 5},
    {"hold and end once while down, re-arm on release", {
      {true, 0, false, {false, false, false, false}},
      {true, 30, false, {true, false, false, false}},
      {true, 279, false, {false, false, false, false}},
      {true, 300, false, {false, false, true, false}},
      {true, 829, false, {false, false, true, false}},
      {true, 830, false, {false, false, true, true}},
      {true, 2000, false, {false, false, true, false}},
      {false, 2001, false, {false, false, true, false}},
      {false, 2031, false, {false, false, false, false}},
    }, 9},
    {"inject tap", {{false, 0, true, {false, true, false, false}}}, 1},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    struct iterate_kit_button button = {0};
    for (size_t j = 0; j < cases[i].count; ++j) {
      const struct button_sample *sample = &cases[i].samples[j];
      iterate_kit_button_update(&button, sample->pressed, sample->at_ms);
      if (sample->inject_tap) iterate_kit_button_inject_tap(&button);
      assert(iterate_kit_button_take_press(&button) == sample->becomes.press);
      assert(iterate_kit_button_take_tap(&button) == sample->becomes.tap);
      assert(iterate_kit_button_held(&button) == sample->becomes.held);
      assert(iterate_kit_button_take_end_hold(&button) == sample->becomes.end_hold);
      assert(!iterate_kit_button_take_press(&button));
      assert(!iterate_kit_button_take_tap(&button));
      assert(!iterate_kit_button_take_end_hold(&button));
    }
  }
  return 0;
}
