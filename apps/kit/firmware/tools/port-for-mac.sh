#!/bin/sh
# Resolve a board's serial port from its ROM MAC, without touching the board.
#
#   idf.py -p "$(apps/kit/firmware/tools/port-for-mac.sh D8:3B:DA:46:20:34)" flash
#
# TWO WAYS THIS GOES WRONG, and this script exists to stop both.
#
#   `esptool read_mac` RESETS the board it asks. Reading a MAC to find a board
#   therefore reboots it — including the one somebody is mid-conversation with.
#   `ioreg` is passive: it reads what the USB stack already knows.
#
#   A `/dev/cu.usbmodem*` path picked by eye flashes whichever board happened to
#   enumerate there. The numbering follows hub topology and changes when
#   anything is replugged, so the path that was the StackChan this morning is
#   the Waveshare after lunch.
#
# Prints the callout device on stdout and nothing else, so it composes into a
# command substitution. Exits non-zero with a message on stderr when the board
# is not plugged in — never a guess, never an empty string that would make
# `idf.py -p ""` pick a default.
set -eu

if [ $# -ne 1 ]; then
  echo "usage: $(basename "$0") <ROM MAC, e.g. D8:3B:DA:46:20:34>" >&2
  exit 2
fi
mac=$1

# One USB device's properties arrive as a run of lines; the serial number and
# the callout path sit in the same run. Remember the last serial seen and print
# the path when it belongs to the MAC asked for.
port=$(ioreg -r -c IOUSBHostDevice -l -w 0 2>/dev/null | awk -v mac="$mac" '
  /"USB Serial Number"/ { serial = $0 }
  /"IOCalloutDevice"/ {
    if (index(serial, mac) > 0) {
      match($0, /"\/dev\/[^"]+"/)
      print substr($0, RSTART + 1, RLENGTH - 2)
      exit
    }
  }
')

if [ -z "$port" ]; then
  echo "no serial port for $mac — is the board plugged in?" >&2
  exit 1
fi
printf '%s\n' "$port"
