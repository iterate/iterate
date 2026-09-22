# ZECTRIX NOTE4 sources

`zectrix_epd.cc`, `zectrix_epd.h` and `ssd2683_waveform.h` derive from the
MIT-licensed SSD2683 driver in
[ZECTRIX's reference demo](https://github.com/itopinion/zectrix-note4-epd-demo),
revision `ca285c98ed0641f86780edb1f5ec77b0335fe649`. Its license is retained
in `LICENSE.zectrix.md`. The driver is unchanged; the waveform header keeps
only the five grayscale tables it uses, expanded byte-for-byte from the
vendor constants. Unused experimental waveforms and generators are omitted. The hardware pin assignments and ES8311 configuration
come from the same repository's `zectrix_board` component; see
`LICENSE.zectrix.md`.

`status_font.h` reuses the small status font from this repository's Waveshare
display implementation. No vendor consumer firmware is distributed.
