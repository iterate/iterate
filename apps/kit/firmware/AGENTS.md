# Kit firmware

Read the [firmware guide](README.md) before changing board, audio or provisioning code. For new hardware or sprites, use [adding a board or sprite](adding-a-board-or-sprite.md).

Identify Jonas's bench hardware by the MAC addresses in [test devices](jonas-test-devices.md) before opening a USB serial port.

Board code owns hardware facts; reuse the shared voice loop and protocol. The Mac is a board too (`targets/mac`, `iterate-kit-mac --config <image>`), so a loop change can be run on a laptop before a flash. Inspect health before changing audio behavior. A serial monitor may reboot the board; use stream health during calls. Run the air-path proof (`apps/agents/scripts/voice-board.ts --device <name>`) only on an idle device.

Merged firmware changes become per-device GitHub releases ([Kit firmware releases](../README.md#firmware-releases)). A board's own directories are `devices/<target>` and `targets/<target>`; a board must not read another board's directory, and the release build enforces it.

A change to what the configuration decoder requires (tags, capacities, validation) must bump the ITERKIT magic and add a manifest `configurationFormat` that Kit checks: Kit writes the current image for every release, old ones included.
