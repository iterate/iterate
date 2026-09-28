#include "iterate/kit/tinyvoice.h"

#include <math.h>
#include <string.h>

enum {
  SAMPLE_RATE = ITERATE_KIT_TINYVOICE_SAMPLE_RATE_HZ,
  /** Parameters move every 2.5 ms; samples between frames interpolate. */
  FRAME_SAMPLES = 40,
  /** Formants reach for the next phoneme 15 ms early (coarticulation). */
  FORMANT_LEAD_FRAMES = 6,
};

#define PI_F 3.14159265f

/* Phoneme kinds; the order matters: everything up to NASAL is a sonorant. */
enum kind { VOWEL, DIPHTHONG, GLIDE, NASAL, FRICATIVE, ASPIRATE, STOP, AFFRICATE };

struct iterate_kit_tinyvoice_phoneme {
  char name[3];
  uint8_t kind;
  bool voiced;
  uint16_t duration_ms;
  /** Formant targets (loci for consonants) and their bandwidths, Hz. */
  uint16_t f1, f2, f3, b1, b2, b3;
  /** Voicing and frication (or burst) amplitude, 0-100. */
  uint8_t voicing, frication;
  /** Frication / burst resonator centre and bandwidth, Hz. */
  uint16_t frication_hz, frication_bandwidth_hz;
  /** Where a diphthong's formants glide to. */
  uint16_t glide_f1, glide_f2, glide_f3;
};

#define PHONEME(name, kind, voiced, ms, f1, f2, f3, b1, b2, b3, av, af, ff, fb, g1, g2, g3) \
  {name, kind, voiced, ms, f1, f2, f3, b1, b2, b3, av, af, ff, fb, g1, g2, g3}

static const struct iterate_kit_tinyvoice_phoneme phonemes[] = {
    /*      name  kind       v   ms   F1    F2    F3   B1   B2   B3   AV  AF    FF    FB  glide to        */
    PHONEME("iy", VOWEL,     1, 150, 300, 2200, 2960,  50, 120, 300, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("ih", VOWEL,     1, 120, 400, 1850, 2570,  50, 100, 140, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("eh", VOWEL,     1, 140, 550, 1720, 2500,  60,  90, 200, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("ae", VOWEL,     1, 200, 660, 1700, 2430,  70, 130, 300, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("aa", VOWEL,     1, 200, 720, 1150, 2600,  90,  70, 160, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("ao", VOWEL,     1, 200, 600,  950, 2570,  90, 100,  80, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("ah", VOWEL,     1, 130, 620, 1220, 2550,  80,  60, 140, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("ax", VOWEL,     1,  80, 500, 1450, 2400,  80, 100, 150,  90,  0,    0,    0,   0,    0,    0),
    PHONEME("uh", VOWEL,     1, 130, 450, 1100, 2350,  80, 100,  80, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("uw", VOWEL,     1, 170, 320,  950, 2250,  60, 100,  80, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("er", VOWEL,     1, 160, 470, 1300, 1600, 100,  60, 110, 100,  0,    0,    0,   0,    0,    0),
    PHONEME("ey", DIPHTHONG, 1, 180, 500, 1800, 2520,  60, 100, 200, 100,  0,    0,    0, 330, 2200, 2700),
    PHONEME("ay", DIPHTHONG, 1, 220, 700, 1200, 2500,  90,  70, 160, 100,  0,    0,    0, 380, 2000, 2600),
    PHONEME("ow", DIPHTHONG, 1, 190, 550,  950, 2350,  80,  90, 100, 100,  0,    0,    0, 400,  800, 2250),
    PHONEME("aw", DIPHTHONG, 1, 230, 700, 1250, 2550,  90,  70, 160, 100,  0,    0,    0, 420,  900, 2350),
    PHONEME("oy", DIPHTHONG, 1, 240, 550,  950, 2450,  80,  90, 100, 100,  0,    0,    0, 380, 1900, 2550),
    PHONEME("w",  GLIDE,     1,  70, 290,  650, 2150,  50,  80,  60,  90,  0,    0,    0,   0,    0,    0),
    PHONEME("y",  GLIDE,     1,  70, 260, 2100, 3000,  40, 250, 500,  90,  0,    0,    0,   0,    0,    0),
    PHONEME("r",  GLIDE,     1,  70, 320, 1050, 1400,  70, 100, 120,  85,  0,    0,    0,   0,    0,    0),
    PHONEME("l",  GLIDE,     1,  70, 330, 1050, 2800,  50, 100, 280,  85,  0,    0,    0,   0,    0,    0),
    PHONEME("m",  NASAL,     1,  75, 270, 1000, 2200,  90, 200, 300,  60,  0,    0,    0,   0,    0,    0),
    PHONEME("n",  NASAL,     1,  65, 270, 1600, 2600,  90, 200, 300,  60,  0,    0,    0,   0,    0,    0),
    PHONEME("ng", NASAL,     1,  90, 270, 2200, 2700,  90, 200, 300,  60,  0,    0,    0,   0,    0,    0),
    PHONEME("f",  FRICATIVE, 0, 110, 340, 1100, 2100, 200, 120, 150,   0, 12, 6500, 4000,   0,    0,    0),
    PHONEME("v",  FRICATIVE, 1,  70, 250, 1100, 2100,  90, 120, 150,  50,  6, 6500, 4000,   0,    0,    0),
    PHONEME("th", FRICATIVE, 0, 100, 320, 1300, 2540, 200,  90, 200,   0,  9, 6000, 4000,   0,    0,    0),
    PHONEME("dh", FRICATIVE, 1,  55, 270, 1300, 2540,  90,  90, 200,  50,  5, 6000, 4000,   0,    0,    0),
    PHONEME("s",  FRICATIVE, 0, 110, 320, 1400, 2530, 200,  90, 200,   0, 55, 5300, 1600,   0,    0,    0),
    PHONEME("z",  FRICATIVE, 1,  80, 250, 1400, 2530,  90,  90, 200,  45, 35, 5300, 1600,   0,    0,    0),
    PHONEME("sh", FRICATIVE, 0, 115, 300, 1840, 2750, 200, 100, 300,   0, 60, 2900, 1400,   0,    0,    0),
    PHONEME("zh", FRICATIVE, 1,  80, 250, 1840, 2750,  90, 100, 300,  45, 40, 2900, 1400,   0,    0,    0),
    PHONEME("hh", ASPIRATE,  0,  70,   0,    0,    0,   0,   0,   0,   0, 50,    0,    0,   0,    0,    0),
    PHONEME("p",  STOP,      0,  90, 400, 1000, 2150, 300, 150, 220,   0, 35, 1400, 2500,   0,    0,    0),
    PHONEME("b",  STOP,      1,  80, 250, 1000, 2150,  90, 150, 220,   0, 25, 1400, 2500,   0,    0,    0),
    PHONEME("t",  STOP,      0,  85, 400, 1700, 2600, 300, 150, 250,   0, 50, 4200, 2000,   0,    0,    0),
    PHONEME("d",  STOP,      1,  75, 250, 1700, 2600,  90, 150, 250,   0, 35, 4200, 2000,   0,    0,    0),
    PHONEME("k",  STOP,      0,  90, 350, 1900, 2500, 300, 150, 250,   0, 50, 2400, 1200,   0,    0,    0),
    PHONEME("g",  STOP,      1,  80, 250, 1900, 2500,  90, 150, 250,   0, 35, 2400, 1200,   0,    0,    0),
    PHONEME("ch", AFFRICATE, 0, 130, 350, 1800, 2800, 300,  90, 300,   0, 60, 3000, 1500,   0,    0,    0),
    PHONEME("jh", AFFRICATE, 1, 110, 260, 1800, 2800,  90,  90, 300,  30, 45, 3000, 1500,   0,    0,    0),
};

/* The synthesis parameters a target holds, in `parameters[]` order. */
enum { F1, F2, F3, B1, B2, B3, VOICING, FRICATION, ASPIRATION, FRICATION_HZ, FRICATION_BW, PITCH };

/*
 * A note is a MIDI pitch, a length in the tune's units, and an optional note
 * the vowel slides to in its last part: the melismas and dotted-rhythm
 * ornaments ("love" in Greensleeves is sung E then F).
 */
struct note {
  uint8_t pitch, length, tail;
};

struct tune {
  const struct note *notes;
  size_t note_count;
  /** Semitones to move the tune into the voice's range (roughly 100-230 Hz). */
  int8_t transpose;
  float unit_ms;
};

/* A minor, 6/8; unit = a sixteenth; sung in C minor. */
static const struct note greensleeves[] = {
    {69, 2, 0}, {72, 4, 0}, {74, 2, 0}, {76, 4, 77}, {76, 2, 0}, {74, 4, 0}, {71, 2, 0}, {67, 4, 69}, {71, 2, 0},
    {72, 4, 0}, {69, 2, 0}, {69, 4, 68}, {69, 2, 0}, {71, 4, 0}, {68, 2, 0}, {64, 4, 0}, {69, 2, 0},
    {72, 4, 0}, {74, 2, 0}, {76, 4, 77}, {76, 2, 0}, {74, 4, 0}, {71, 2, 0}, {67, 4, 69}, {71, 2, 0},
    {72, 4, 71}, {69, 2, 0}, {68, 4, 66}, {68, 2, 0}, {69, 10, 0},
    {79, 6, 0}, {79, 4, 78}, {76, 2, 0}, {74, 4, 0}, {71, 2, 0}, {67, 4, 69}, {71, 2, 0},
    {72, 4, 0}, {69, 2, 0}, {69, 4, 68}, {69, 2, 0}, {71, 4, 0}, {68, 2, 0}, {64, 6, 0},
    {79, 6, 0}, {79, 4, 78}, {76, 2, 0}, {74, 4, 0}, {71, 2, 0}, {67, 4, 69}, {71, 2, 0},
    {72, 4, 71}, {69, 2, 0}, {68, 4, 66}, {68, 2, 0}, {69, 12, 0},
};

/* C major, 3/4; unit = an eighth. One entry per syllable of the 1892 words. */
static const struct note daisy_bell[] = {
    {79, 6, 0}, {76, 6, 0}, {72, 6, 0}, {67, 6, 0}, {69, 2, 0}, {71, 2, 0}, {72, 2, 0}, {69, 4, 0}, {72, 2, 0}, {67, 12, 0},
    {74, 6, 0}, {79, 6, 0}, {76, 6, 0}, {72, 6, 0}, {69, 2, 0}, {71, 2, 0}, {72, 2, 0}, {74, 4, 0}, {76, 2, 0}, {74, 12, 0},
    {76, 2, 0}, {77, 2, 0}, {76, 2, 0}, {74, 4, 0}, {79, 2, 0}, {76, 4, 0}, {74, 2, 0}, {72, 10, 0},
    {74, 2, 0}, {76, 4, 0}, {72, 2, 0}, {69, 4, 0}, {72, 2, 0}, {69, 2, 0}, {67, 10, 0},
    {67, 2, 0}, {72, 4, 0}, {76, 2, 0}, {74, 4, 0}, {67, 2, 0}, {72, 4, 0}, {76, 2, 0}, {74, 2, 0}, {76, 2, 0}, {77, 2, 0},
    {79, 2, 0}, {76, 2, 0}, {72, 2, 0}, {74, 4, 0}, {67, 2, 0}, {72, 12, 0},
};

/*
 * D major, 4/4; unit = an eighth; sung in C. Transcribed from Paul Hardy's
 * Songs Tunebook (pghardy.net), whose syllables are aligned to notes; a
 * melisma ("auld_ lang_") is one note with a tail.
 */
static const struct note auld_lang_syne[] = {
    {57, 2, 0}, {62, 3, 0}, {62, 1, 0}, {62, 2, 0}, {66, 2, 0}, {64, 3, 0}, {62, 1, 0}, {64, 2, 0}, {66, 2, 0}, {62, 3, 0}, {62, 1, 0}, {66, 2, 0}, {69, 2, 0}, {71, 6, 0},
    {71, 2, 0}, {69, 3, 0}, {66, 1, 0}, {66, 2, 0}, {62, 2, 0}, {64, 3, 0}, {62, 1, 0}, {64, 2, 0}, {66, 2, 0}, {62, 4, 59}, {59, 4, 57}, {62, 6, 0},
    {71, 2, 0}, {69, 4, 66}, {66, 4, 62}, {64, 3, 0}, {62, 1, 0}, {64, 2, 0}, {71, 2, 0}, {69, 4, 66}, {66, 4, 69}, {71, 6, 0},
    {74, 2, 0}, {69, 3, 0}, {66, 1, 0}, {66, 2, 0}, {62, 2, 0}, {64, 3, 0}, {62, 1, 0}, {64, 2, 0}, {66, 2, 0}, {62, 4, 59}, {59, 4, 57}, {62, 6, 0},
};

/*
 * G mixolydian, free 3/2 and 2/2; unit = a sixteenth. Joe Heaney's "Lord
 * Gregory", the Lass of Aughrim ballad, from Milner and Kaplan, "Songs of
 * England, Ireland and Scotland" (1983), via folkinfo.org. A slurred run is one
 * syllable with a tail; grace notes and rests are dropped.
 */
static const struct note lass_of_aughrim[] = {
    {55, 8, 59}, {60, 12, 0}, {62, 4, 64}, {62, 8, 59}, {60, 8, 59}, {55, 8, 0}, {60, 4, 62}, {64, 12, 0}, {62, 2, 0}, {60, 2, 64}, {62, 8, 0},
    {64, 4, 65}, {67, 12, 0}, {71, 2, 0}, {69, 2, 0}, {67, 6, 0}, {66, 2, 0}, {62, 8, 0}, {59, 4, 62}, {60, 8, 59}, {55, 6, 0}, {55, 2, 0}, {55, 8, 0},
};

#define TUNE(notes, transpose, unit_ms) {notes, sizeof(notes) / sizeof(notes[0]), transpose, unit_ms}

static const struct tune tunes[] = {
    [ITERATE_KIT_TINYVOICE_GREENSLEEVES] = TUNE(greensleeves, -21, 115.0f),
    [ITERATE_KIT_TINYVOICE_DAISY_BELL] = TUNE(daisy_bell, -24, 150.0f),
    [ITERATE_KIT_TINYVOICE_AULD_LANG_SYNE] = TUNE(auld_lang_syne, -14, 185.0f),
    [ITERATE_KIT_TINYVOICE_LASS_OF_AUGHRIM] = TUNE(lass_of_aughrim, -12, 115.0f),
};

static float midi_hz(int pitch) {
  return 440.0f * exp2f((float)(pitch - 69) / 12.0f);
}

static bool is_vowel(const struct iterate_kit_tinyvoice_phoneme *phoneme) {
  return phoneme != NULL && phoneme->kind <= DIPHTHONG;
}

static size_t parse(struct iterate_kit_tinyvoice *voice, const char *script) {
  size_t count = 0;
  const char *cursor = script;
  while (*cursor == ' ') cursor++;
  while (*cursor != '\0') {
    const char *word = cursor;
    while (*cursor != '\0' && *cursor != ' ') cursor++;
    size_t length = (size_t)(cursor - word);
    struct iterate_kit_tinyvoice_token token = {0};
    if (*word == '.' || *word == ',') {
      token.pause_ms = *word == '.' ? 280U : 120U;
    } else {
      if (word[length - 1] >= '0' && word[length - 1] <= '2') {
        token.stress = (uint8_t)(word[length - 1] - '0');
        length--;
      }
      for (size_t i = 0; i < sizeof(phonemes) / sizeof(phonemes[0]); i++) {
        if (strlen(phonemes[i].name) == length &&
            strncmp(phonemes[i].name, word, length) == 0) {
          token.phoneme = &phonemes[i];
        }
      }
      if (token.phoneme == NULL) return 0;
    }
    if (count == ITERATE_KIT_TINYVOICE_MAX_TOKENS) return 0;
    voice->tokens[count++] = token;
    while (*cursor == ' ') cursor++;
  }
  /* The last syllable before a full stop (its vowel and what follows) is lengthened and falls. */
  bool inside = false;
  for (size_t i = count; i-- > 0;) {
    if (voice->tokens[i].pause_ms > 200U) {
      inside = true;
    } else if (inside && voice->tokens[i].phoneme != NULL) {
      voice->tokens[i].sentence_final = true;
      if (is_vowel(voice->tokens[i].phoneme)) inside = false;
    }
  }
  return count;
}

static void hold(struct iterate_kit_tinyvoice *voice, const float *parameters, float ms) {
  const int frames = (int)(ms * SAMPLE_RATE / 1000.0f / FRAME_SAMPLES + 0.5f);
  if (frames < 1 || voice->target_count == ITERATE_KIT_TINYVOICE_MAX_TARGETS) return;
  struct iterate_kit_tinyvoice_target *target = &voice->targets[voice->target_count++];
  memcpy(target->parameters, parameters, sizeof(target->parameters));
  target->start_frame = voice->frame_count;
  voice->frame_count += (uint32_t)frames;
}

static void formants(float *parameters, const struct iterate_kit_tinyvoice_phoneme *phoneme) {
  parameters[F1] = phoneme->f1;
  parameters[F2] = phoneme->f2;
  parameters[F3] = phoneme->f3;
  parameters[B1] = phoneme->b1;
  parameters[B2] = phoneme->b2;
  parameters[B3] = phoneme->b3;
}

/* Turn tokens into a timeline of parameter targets. */
static void lay_out(struct iterate_kit_tinyvoice *voice) {
  const struct tune *tune = voice->tune == ITERATE_KIT_TINYVOICE_SPOKEN ? NULL : &tunes[voice->tune];
  const struct iterate_kit_tinyvoice_token *tokens = voice->tokens;
  const size_t count = voice->token_count;
  float p[ITERATE_KIT_TINYVOICE_PARAMETER_COUNT] = {500, 1500, 2500, 60, 90, 150, 0, 0, 0, 1000, 1000, 110};
  size_t note_index = 0;
  /* Sung consonants keep the pitch of the note before them. */
  float held_pitch = tune == NULL ? 0.0f : midi_hz(tune->notes[0].pitch + tune->transpose);
  voice->target_count = 0;
  voice->frame_count = 0;
  hold(voice, p, 40.0f);
  for (size_t i = 0, sentence_start = 0, sentence_end = 0; i < count; i++) {
    if (i >= sentence_end) {
      sentence_start = i;
      for (sentence_end = i; sentence_end < count && tokens[sentence_end].pause_ms < 200U; sentence_end++) {
      }
    }
    const struct iterate_kit_tinyvoice_phoneme *phoneme = tokens[i].phoneme;
    const struct iterate_kit_tinyvoice_phoneme *next = i + 1 < count ? tokens[i + 1].phoneme : NULL;
    /* Speech drifts down over a sentence. */
    const float pitch = 120.0f - 20.0f * (float)(i - sentence_start) / (float)(sentence_end - sentence_start + 1);
    float ms = phoneme != NULL
                   ? phoneme->duration_ms * (tokens[i].sentence_final && tune == NULL ? 1.3f : 1.0f)
                   : tokens[i].pause_ms;
    p[VOICING] = p[FRICATION] = p[ASPIRATION] = 0;
    p[PITCH] = tune != NULL ? held_pitch : pitch;
    if (phoneme == NULL) {
      /* A sung pause would break the tune's time, so singing skips it. */
      if (tune == NULL) hold(voice, p, ms);
      continue;
    }
    formants(p, phoneme);
    if (phoneme->frication_hz != 0U) {
      /* Vowels keep the last frication filter, so there is no jump into the next hiss. */
      p[FRICATION_HZ] = phoneme->frication_hz;
      p[FRICATION_BW] = phoneme->frication_bandwidth_hz;
    }
    switch (phoneme->kind) {
      case VOWEL:
      case DIPHTHONG:
        if (tune != NULL) {
          /* The note sets the pitch; the vowel fills the note, minus the consonants before the next vowel. */
          const struct note *note = &tune->notes[note_index++ % tune->note_count];
          const float note_ms = note->length * tune->unit_ms;
          float consonants_ms = 0;
          for (size_t j = i + 1; j < count && !is_vowel(tokens[j].phoneme); j++) {
            if (tokens[j].phoneme != NULL) consonants_ms += tokens[j].phoneme->duration_ms;
          }
          ms = note_ms - consonants_ms > note_ms * 0.4f ? note_ms - consonants_ms : note_ms * 0.4f;
          p[PITCH] = held_pitch = midi_hz(note->pitch + tune->transpose);
          p[VOICING] = phoneme->voicing;
          hold(voice, p, ms * 0.6f);
          if (phoneme->kind == DIPHTHONG) {
            p[F1] = phoneme->glide_f1;
            p[F2] = phoneme->glide_f2;
            p[F3] = phoneme->glide_f3;
          }
          if (note->tail != 0U) p[PITCH] = held_pitch = midi_hz(note->tail + tune->transpose);
          hold(voice, p, ms * 0.4f);
          break;
        }
        ms *= tokens[i].stress != 0U ? 1.0f : 0.7f;
        /* Stressed vowels are higher. */
        p[PITCH] = pitch + (tokens[i].stress == 1U ? 16.0f : tokens[i].stress == 2U ? 6.0f : 0.0f);
        p[VOICING] = phoneme->voicing;
        hold(voice, p, ms * 0.45f);
        if (phoneme->kind == DIPHTHONG) {
          p[F1] = phoneme->glide_f1;
          p[F2] = phoneme->glide_f2;
          p[F3] = phoneme->glide_f3;
        }
        if (tokens[i].sentence_final) p[PITCH] = pitch - 18.0f;
        hold(voice, p, ms * 0.55f);
        break;
      case GLIDE:
      case NASAL:
        p[VOICING] = phoneme->voicing;
        hold(voice, p, ms);
        break;
      case FRICATIVE:
        p[VOICING] = phoneme->voicing;
        p[FRICATION] = phoneme->frication;
        hold(voice, p, ms);
        break;
      case ASPIRATE:
        /* /h/ is breath through the shape of the vowel after it. */
        if (next != NULL) formants(p, next);
        p[ASPIRATION] = phoneme->frication;
        hold(voice, p, ms);
        break;
      case STOP:
      case AFFRICATE:
        /* Closure (with a low voice bar when voiced), then the burst or frication. */
        p[VOICING] = phoneme->voiced ? 12.0f : 0.0f;
        hold(voice, p, ms * (phoneme->kind == STOP ? 0.7f : 0.45f));
        p[VOICING] = phoneme->kind == AFFRICATE ? phoneme->voicing : 0.0f;
        p[FRICATION] = phoneme->frication;
        hold(voice, p, phoneme->kind == AFFRICATE ? ms * 0.55f : phoneme->voiced ? 6.0f : 10.0f);
        if (!phoneme->voiced && next != NULL && next->kind <= NASAL) {
          /* An unvoiced stop aspirates into the sonorant after it. */
          formants(p, next);
          p[FRICATION] = 0;
          p[ASPIRATION] = 40;
          hold(voice, p, 40.0f);
        }
        break;
      default:
        break;
    }
  }
  p[VOICING] = p[FRICATION] = p[ASPIRATION] = 0;
  hold(voice, p, 150.0f);
}

size_t iterate_kit_tinyvoice_prepare(
    struct iterate_kit_tinyvoice *voice,
    const char *script,
    enum iterate_kit_tinyvoice_tune tune) {
  voice->token_count = 0;
  voice->target_count = 0;
  voice->frame_count = 0;
  if (tune > ITERATE_KIT_TINYVOICE_LASS_OF_AUGHRIM) return 0;
  voice->tune = tune;
  voice->token_count = parse(voice, script);
  if (voice->token_count == 0) return 0;
  lay_out(voice);
  return (size_t)voice->frame_count * FRAME_SAMPLES;
}

/* A two-pole resonator (Klatt's), unity gain at DC. */
struct resonator {
  float a, b, c, y1, y2;
};

static void tune_resonator(struct resonator *r, float hz, float bandwidth_hz) {
  const float radius = expf(-PI_F * bandwidth_hz / SAMPLE_RATE);
  r->c = -radius * radius;
  r->b = 2.0f * radius * cosf(2.0f * PI_F * hz / SAMPLE_RATE);
  r->a = 1.0f - r->b - r->c;
}

static float resonate(struct resonator *r, float x) {
  const float y = r->a * x + r->b * r->y1 + r->c * r->y2;
  r->y2 = r->y1;
  r->y1 = y;
  return y;
}

/* Rosenberg's glottal flow pulse over one period (0..1): opening 40%, closing 12%, then closed. */
static float glottal_flow(float phase) {
  if (phase < 0.4f) return 0.5f * (1.0f - cosf(PI_F * phase / 0.4f));
  if (phase < 0.52f) return cosf(PI_F * (phase - 0.4f) / 0.24f);
  return 0.0f;
}

void iterate_kit_tinyvoice_render(const struct iterate_kit_tinyvoice *voice, int16_t *out) {
  /* How fast each parameter follows its target, ms; 0 jumps. Pitch glides between notes. */
  static const float follow_ms[ITERATE_KIT_TINYVOICE_PARAMETER_COUNT] = {12, 12, 12, 12, 12, 12, 3, 1, 3, 0, 0, 35};
  static const float voicing_gain = 9.0f, aspiration_gain = 0.08f, frication_gain = 1.4f, output_gain = 12000.0f;
  float current[ITERATE_KIT_TINYVOICE_PARAMETER_COUNT];
  float previous[ITERATE_KIT_TINYVOICE_PARAMETER_COUNT];
  float follow[ITERATE_KIT_TINYVOICE_PARAMETER_COUNT];
  float phase = 0, previous_flow = 0, previous_cascade = 0;
  uint32_t noise_state = 1U;
  struct resonator cascade[5] = {{0}};
  struct resonator frication = {0};
  size_t written = 0;
  if (voice->target_count == 0) return;
  tune_resonator(&cascade[3], 3300.0f, 250.0f);
  tune_resonator(&cascade[4], 3850.0f, 300.0f);
  for (int k = 0; k < ITERATE_KIT_TINYVOICE_PARAMETER_COUNT; k++) {
    follow[k] = follow_ms[k] > 0.0f ? 1.0f - expf(-2.5f / follow_ms[k]) : 1.0f;
  }
  memcpy(current, voice->targets[0].parameters, sizeof(current));
  for (uint32_t frame = 0, held = 0, lead = 0; frame < voice->frame_count; frame++) {
    /* About 20 cents of vibrato at 5.5 Hz while singing. */
    const float vibrato = voice->tune == ITERATE_KIT_TINYVOICE_SPOKEN
                              ? 1.0f
                              : 1.0f + 0.012f * sinf(2.0f * PI_F * 5.5f * (float)frame * FRAME_SAMPLES / SAMPLE_RATE);
    while (held + 1 < voice->target_count && voice->targets[held + 1].start_frame <= frame) held++;
    while (lead + 1 < voice->target_count && voice->targets[lead + 1].start_frame <= frame + FORMANT_LEAD_FRAMES) lead++;
    memcpy(previous, current, sizeof(current));
    for (int k = 0; k < ITERATE_KIT_TINYVOICE_PARAMETER_COUNT; k++) {
      const float target = voice->targets[k <= B3 ? lead : held].parameters[k];
      current[k] += (target - current[k]) * follow[k];
    }
    for (int k = 0; k < 3; k++) tune_resonator(&cascade[k], current[F1 + k], current[B1 + k]);
    tune_resonator(&frication, current[FRICATION_HZ], current[FRICATION_BW]);
    {
      /* Renormalise the frication resonator to unity gain at its peak rather than at DC. */
      const float radius = expf(-PI_F * current[FRICATION_BW] / SAMPLE_RATE);
      frication.a = (1.0f - radius) *
                    sqrtf(1.0f - 2.0f * radius * cosf(4.0f * PI_F * current[FRICATION_HZ] / SAMPLE_RATE) + radius * radius);
    }
    for (int n = 0; n < FRAME_SAMPLES; n++) {
      const float u = (float)n / FRAME_SAMPLES;
      const float voicing = (previous[VOICING] + (current[VOICING] - previous[VOICING]) * u) / 100.0f;
      const float fricative = (previous[FRICATION] + (current[FRICATION] - previous[FRICATION]) * u) / 100.0f;
      const float breath = (previous[ASPIRATION] + (current[ASPIRATION] - previous[ASPIRATION]) * u) / 100.0f;
      phase += current[PITCH] * vibrato / SAMPLE_RATE;
      if (phase >= 1.0f) phase -= 1.0f;
      const float flow = glottal_flow(phase);
      noise_state = noise_state * 1664525U + 1013904223U;
      const float noise = (float)(int32_t)noise_state * (1.0f / 2147483648.0f);
      /* The flow's derivative: the lips radiate the change in airflow, not the airflow. */
      float x = (flow - previous_flow) * voicing * voicing_gain + noise * breath * aspiration_gain;
      previous_flow = flow;
      for (int k = 0; k < 5; k++) x = resonate(&cascade[k], x);
      /* Voiced fricatives (z, v) buzz: their noise is modulated by the glottal flow. */
      const float hiss = resonate(&frication, noise * fricative * (voicing > 0.0f ? 0.3f + flow : 1.0f));
      /* +6 dB/octave brightens the cascade output. */
      const float y = x - 0.85f * previous_cascade + hiss * frication_gain;
      previous_cascade = x;
      const float sample = y * output_gain;
      out[written++] = (int16_t)(sample > 32767.0f ? 32767.0f : sample < -32768.0f ? -32768.0f : sample);
    }
  }
}
