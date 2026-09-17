# Kit firmware

Read the [firmware guide](README.md) before changing board, audio or provisioning code. For new hardware or sprites, use [adding a board or sprite](adding-a-board-or-sprite.md).

Board code owns hardware facts; reuse the shared voice loop and protocol. The Mac is a board too (`targets/mac`, `iterate-kit-mac --config <image>`), so a loop change can be run on a laptop before a flash. Inspect health before changing audio behavior. A serial monitor may reboot the board; use stream health during calls. Run the air-path proof (`apps/os-next/scripts/voice-board.ts --device <name>`) only on an idle device.
