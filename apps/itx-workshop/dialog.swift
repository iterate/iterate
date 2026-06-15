// Step 1 native-macOS dialog program from itx-explainer.md.
// This is the exact `runSwift(...)` body the workshop doc shows: a Worker calls
// back into the laptop, which pops a native NSAlert with a text field and reads
// what the human typed.
//
// Two ways to run it, both REAL (the AppKit modal loop actually executes):
//   swift dialog.swift                         # interactive: pop the dialog, type, click OK
//   ITX_DIALOG_AUTODISMISS=Aurora swift dialog.swift   # headless proof: presets the
//                                              # field, runs the real modal, auto-dismisses,
//                                              # prints the value. Used by `npm run proof:swift`.
// And type-checked without running: swiftc -typecheck dialog.swift

import AppKit

_ = NSApplication.shared
let a = NSAlert()
a.messageText = "Agent needs your input"
a.informativeText = "What should I name the project?"
let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
a.accessoryView = field
a.addButton(withTitle: "OK")

// Headless proof mode: simulate the human typing, then abort the modal after a
// tick so the real runModal() loop runs to completion without a human. Without
// the env var this blocks on the real dialog, exactly as in the narrative.
if let preset = ProcessInfo.processInfo.environment["ITX_DIALOG_AUTODISMISS"] {
  field.stringValue = preset
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.abortModal() }
}

NSApp.activate(ignoringOtherApps: true)
a.runModal()
print(field.stringValue) // → whatever the human typed
