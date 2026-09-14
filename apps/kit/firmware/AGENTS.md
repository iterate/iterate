# Kit firmware

Read the [firmware guide](README.md) before changing board, audio or provisioning code. For new hardware or sprites, use [adding a board or sprite](adding-a-board-or-sprite.md).

Board code owns hardware facts; reuse the shared voice loop and protocol. Inspect health before changing audio behavior. A serial monitor may reboot the board; use stream health during calls. Run air-path proof only on an idle board.
