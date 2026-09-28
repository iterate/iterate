// ─────────────────────────────────────────────────────────────────────────────
// Iterate — a small macOS menu-bar app: sign in to Iterate, and lend this Mac
// to a project's agents (Use my computer).
//
// A thin shell over `iterate ping`, `iterate login`, and
// `iterate use-my-computer --json`. The CLI owns authentication and transport.
//
// Single file, compiled with swiftc and wrapped in a minimal .app bundle by
// build-menubar-app.sh — no Xcode project, no asset catalog: the 𝑖 icon is
// drawn from the brand SVG's paths at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: - Config

/// Where to find the CLI and which project to share this Mac with. Read from
/// ~/.config/iterate/menubar.json so the app needs no launch arguments.
struct MenuBarConfig: Codable {
  var command: String  // e.g. "iterate", or "bun"
  var args: [String]  // e.g. [] or ["/path/bin/iterate.js"]
  var config: String?  // iterate config name, e.g. "preview1"
  var project: String?  // project id or slug
  var cwd: String?  // working directory to spawn in
  var xdgConfigHome: String? = nil

  static func load() -> MenuBarConfig {
    let path = ("~/.config/iterate/menubar.json" as NSString).expandingTildeInPath
    guard let data = FileManager.default.contents(atPath: path),
      let config = try? JSONDecoder().decode(MenuBarConfig.self, from: data)
    else {
      return MenuBarConfig(command: "iterate", args: [], config: nil, project: nil, cwd: nil)
    }
    return config
  }

  /// The argv for a subcommand under this config. `login` takes no `--project`
  /// (it rejects the flag), so callers opt out of it there.
  func argv(for subcommand: [String], includeProject: Bool = true) -> [String] {
    var out = args
    if let config { out += ["--config", config] }
    out += subcommand
    if includeProject, let project { out += ["--project", project] }
    return out
  }
}

// MARK: - Session

/// Whether the CLI has a valid session. `iterate ping` answers it, bounded to
/// 30 s; **Sign in** runs `iterate login` and then checks again.
final class SessionController: ObservableObject {
  static let shared = SessionController()

  @Published var loggedIn = false
  @Published var project: String?
  @Published var lastError: String?

  private var config = MenuBarConfig.load()
  private var process: Process?
  private var loginProcess: Process?
  private var generation = 0  // bumped on every stop(); voids a stale check's result

  func configure(_ next: MenuBarConfig) {
    stop()
    loginProcess?.terminationHandler = nil
    loginProcess?.terminate()
    loginProcess = nil
    loggedIn = false
    project = nil
    lastError = nil
    config = next
    start()
  }

  func start() {
    stop()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["ping"], includeProject: false)
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    if let home = config.xdgConfigHome {
      var environment = ProcessInfo.processInfo.environment
      environment["XDG_CONFIG_HOME"] = home
      process.environment = environment
    }
    process.standardOutput = FileHandle.nullDevice
    let session = generation
    process.terminationHandler = { [weak self] child in
      DispatchQueue.main.async {
        guard let self, self.generation == session else { return }
        self.process = nil
        self.loggedIn = child.terminationStatus == 0
        self.project = self.config.project
        self.lastError = self.loggedIn ? nil : "Sign in or check your connection."
      }
    }
    do {
      try process.run()
      self.process = process
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
        guard let self, self.generation == session, process.isRunning else { return }
        process.terminate()
      }
    } catch {
      loggedIn = false
      lastError = "Could not launch iterate: \(error.localizedDescription)"
    }
  }

  func stop() {
    generation += 1
    process?.terminationHandler = nil
    process?.terminate()
    process = nil
  }

  /// Run `iterate login` (browser OAuth), then check the session again. A
  /// running check is stopped first so its result can't land mid-login.
  func login() {
    guard loginProcess == nil else { return }  // one browser login at a time
    stop()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["login"], includeProject: false)
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    if let home = config.xdgConfigHome {
      var environment = ProcessInfo.processInfo.environment
      environment["XDG_CONFIG_HOME"] = home
      process.environment = environment
    }
    process.terminationHandler = { [weak self] _ in
      Task { @MainActor in
        self?.loginProcess = nil
        self?.start()
      }
    }
    do {
      try process.run()
      loginProcess = process
    } catch {
      lastError = "Could not start login: \(error.localizedDescription)"
      start()
    }
  }
}

// MARK: - Use my computer

/// One agent call to this computer, for the activity list. `running` flips off
/// when its `call-done` lands.
struct ComputerCall: Identifiable, Equatable {
  let id: Int
  let method: String
  let summary: String
  var running: Bool
  var ok = true  // set from call-done; a failed local call must not read as success
}

/// Drives `iterate use-my-computer --json`: lends this Mac to the project's
/// agents and surfaces each call they make, so the menu bar can show it in use.
///
/// Sharing is opt-in (a conscious act), so if the watcher exits we just stop
/// sharing and let the human re-enable — no silent auto-reconnect that would
/// re-lend the machine.
final class ComputerController: ObservableObject {
  static let shared = ComputerController()

  @Published var enabled = false  // the human asked to share
  @Published var sharing = false  // the capability is mounted and live
  @Published var reconnecting = false  // mount dropped; the CLI is re-establishing it
  @Published var computerName: String?  // the itx.<name> agents call
  @Published var recentCalls: [ComputerCall] = []  // capped display list
  @Published private var activeCalls = 0  // in-flight count, independent of the cap
  @Published var lastError: String?

  /// A call is running right now — the menu bar's "in use" indicator. Counted
  /// separately from `recentCalls` so a slow call that scrolls off the capped
  /// display list still keeps the indicator honest.
  var inUse: Bool { activeCalls > 0 }

  private var config = MenuBarConfig.load()
  private var process: Process?
  private var stdinHandle: FileHandle?
  private var stdoutHandle: FileHandle?
  private var buffer = Data()
  private var generation = 0  // bumped on every stop(); voids stale stdout chunks
  private var cancellables = Set<AnyCancellable>()

  private init() {
    // If the app loses its session, stop sharing immediately — the mount is
    // dead anyway, and otherwise the computer could stay lent while the toggle
    // greys out with no way to revoke but quitting.
    SessionController.shared.$loggedIn
      .dropFirst()
      .sink { [weak self] loggedIn in
        if !loggedIn { self?.stop() }
      }
      .store(in: &cancellables)
  }

  func configure(_ next: MenuBarConfig) {
    stop()  // revoke the old project's share before accepting a new project
    config = next
  }

  /// Turn sharing on or off — safe to drive straight from a Toggle binding.
  func setEnabled(_ on: Bool) {
    guard on != enabled else { return }
    enabled = on
    if on { start() } else { stop() }
  }

  private func start() {
    stop()
    enabled = true  // stop() cleared it; we ARE (re)starting
    lastError = nil
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["use-my-computer", "--json"])
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    if let home = config.xdgConfigHome {
      var environment = ProcessInfo.processInfo.environment
      environment["XDG_CONFIG_HOME"] = home
      process.environment = environment
    }

    let stdout = Pipe()
    let stdin = Pipe()  // held open so the child lives; closing it stops sharing
    process.standardOutput = stdout
    process.standardInput = stdin
    self.stdoutHandle = stdout.fileHandleForReading
    self.stdinHandle = stdin.fileHandleForWriting

    let session = generation
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      if chunk.isEmpty {  // EOF — the child closed stdout, i.e. it has exited.
        handle.readabilityHandler = nil
        DispatchQueue.main.async {
          // Tear down HERE, on EOF, NOT in terminationHandler. EOF is delivered on
          // this same handle after every data chunk, so a final `conflict` status
          // line is ingested (and sets the takeover message) before we exit.
          // Terminating off the process's death instead is a separate event that
          // can win the race, bump `generation`, and drop that last line —
          // leaving the generic "Stopped sharing" instead of the takeover error.
          guard let self, self.generation == session else { return }
          self.watcherExited()
        }
        return
      }
      DispatchQueue.main.async {
        guard let self, self.generation == session else { return }  // stale chunk
        self.ingest(chunk)
      }
    }
    process.terminationHandler = { [weak self] _ in
      // Teardown is driven by stdout EOF (above), which is ordered after the
      // child's final line; just release the finished process here. A late
      // callback from a process we already replaced is voided by the guard.
      DispatchQueue.main.async {
        guard let self, self.generation == session else { return }
        self.process = nil
      }
    }
    do {
      try process.run()
      self.process = process
    } catch {
      enabled = false
      detachIO()
      lastError = "Could not share your computer: \(error.localizedDescription)"
    }
  }

  func stop() {
    generation += 1  // any late stdout chunk from this session is now stale
    enabled = false
    process?.terminationHandler = nil
    process?.terminate()
    process = nil
    detachIO()
    sharing = false
    reconnecting = false
    recentCalls = []
    activeCalls = 0
  }

  /// The watcher exited on its own (lost socket, needs-login, crash). We're no
  /// longer sharing — say so honestly rather than silently re-lending the Mac.
  private func watcherExited() {
    generation += 1
    detachIO()
    sharing = false
    reconnecting = false
    recentCalls = []
    activeCalls = 0
    if enabled {
      enabled = false
      if lastError == nil { lastError = "Stopped sharing your computer." }
    }
  }

  /// Drop this session's pipes/handles and any half-read line.
  private func detachIO() {
    stdoutHandle?.readabilityHandler = nil
    stdoutHandle = nil
    stdinHandle = nil
    buffer = Data()
  }

  private func ingest(_ chunk: Data) {
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0A) {
      let lineData = buffer.subdata(in: buffer.startIndex..<newline)
      buffer.removeSubrange(buffer.startIndex...newline)
      guard let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
        continue
      }
      handle(object)
    }
  }

  private func handle(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "status":
      if event["conflict"] as? Bool == true {
        // Another session took the name — the CLI is stopping; reflect that.
        stop()
        lastError = "Another session took over sharing this computer."
      } else if event["loggedIn"] as? Bool == true {
        // `reconnecting:true` = the mount dropped and the CLI is re-establishing
        // it; the plain status (no flag) means we're live again.
        reconnecting = event["reconnecting"] as? Bool == true
        sharing = true
        computerName = event["name"] as? String
      } else {
        // No session: stop, and let the header's Sign in handle it.
        stop()
        lastError = "Sign in first, then share your computer."
      }
    case "call":
      guard let id = event["id"] as? Int else { return }
      activeCalls += 1
      recentCalls.insert(
        ComputerCall(
          id: id,
          method: event["method"] as? String ?? "?",
          summary: event["summary"] as? String ?? "",
          running: true),
        at: 0)
      if recentCalls.count > 5 { recentCalls.removeLast(recentCalls.count - 5) }
    case "call-done":
      guard let id = event["id"] as? Int else { return }
      // Decrement the in-flight count even if the row already scrolled off the
      // capped list, so `inUse` and the menu-bar dot don't stay stuck on.
      if activeCalls > 0 { activeCalls -= 1 }
      guard let index = recentCalls.firstIndex(where: { $0.id == id }) else { return }
      // Reassign the whole element (not a nested mutation) so the @Published
      // array reliably republishes.
      var call = recentCalls[index]
      call.running = false
      call.ok = event["ok"] as? Bool ?? true  // a failed local call is shown as failed, not done
      recentCalls[index] = call
    default:
      break
    }
  }
}

// MARK: - Views

struct DropdownView: View {
  @EnvironmentObject var session: SessionController
  @EnvironmentObject var computer: ComputerController

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      Divider()
      computerSection
      Divider()
      HStack {
        if let error = session.lastError ?? computer.lastError {
          Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
        }
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.borderless).foregroundStyle(.secondary)
      }
    }
    .padding(14)
    .frame(width: 340)
  }

  /// "Use my computer" — a toggle to lend this Mac to the project's agents, and,
  /// while shared, a live list of the calls they make (the machine "in use").
  @ViewBuilder private var computerSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Use my computer").font(.callout).bold()
          Text(computerStatusLine).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }
        Spacer()
        Toggle("", isOn: Binding(get: { computer.enabled }, set: { computer.setEnabled($0) }))
          .labelsHidden()
          .toggleStyle(.switch)
          // Need a session to START sharing, but never trap an ACTIVE share
          // behind a greyed-out switch — always allow turning it off.
          .disabled(!session.loggedIn && !computer.enabled)
      }
      if computer.sharing {
        if computer.recentCalls.isEmpty {
          Text("Waiting for an agent to use it…").font(.caption).foregroundStyle(.secondary)
        } else {
          ForEach(computer.recentCalls) { call in
            HStack(spacing: 6) {
              if call.running {
                ProgressView().controlSize(.small)
              } else if call.ok {
                Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
              } else {
                Image(systemName: "xmark.circle").foregroundStyle(.orange)
              }
              Text("\(call.method) · \(call.summary)")
                .font(.caption)
                .foregroundStyle(call.running ? .primary : .secondary)
                .lineLimit(1)
            }
          }
        }
      }
    }
  }

  private var computerStatusLine: String {
    if !session.loggedIn { return "Sign in to lend this Mac to agents." }
    if computer.sharing {
      let name = computer.computerName.map { "itx.\($0)" } ?? "your computer"
      if computer.reconnecting { return "Reconnecting \(name)…" }
      return computer.inUse ? "In use now — \(name)" : "\(name) is live for this project."
    }
    if computer.enabled { return "Starting…" }
    return "Let agents run dialogs, notifications and Swift here."
  }

  @ViewBuilder private var header: some View {
    if session.loggedIn {
      VStack(alignment: .leading, spacing: 2) {
        Text("Signed in").font(.headline)
        if let project = session.project {
          Text(project).font(.caption).foregroundStyle(.secondary)
        }
        Text("Iterate")
          .font(.caption2).foregroundStyle(.secondary)
      }
    } else {
      HStack {
        Text("Not signed in").font(.headline)
        Spacer()
        Button("Sign in") { session.login() }.buttonStyle(.borderedProminent)
      }
    }
  }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var receivedConfiguration = false

  // `open -a Iterate.app menubar.json` delivers this even to a running app.
  // Unlike launch arguments it can safely retarget the existing menu bar.
  func application(_ sender: NSApplication, openFiles filenames: [String]) {
    do {
      guard filenames.count == 1, let path = filenames.first else {
        throw CocoaError(.fileReadInvalidFileName)
      }
      let data = try Data(contentsOf: URL(fileURLWithPath: path))
      let config = try JSONDecoder().decode(MenuBarConfig.self, from: data)
      ComputerController.shared.configure(config)
      SessionController.shared.configure(config)
      receivedConfiguration = true
      sender.reply(toOpenOrPrint: .success)
    } catch {
      SessionController.shared.lastError = "Could not load configuration: \(error.localizedDescription)"
      sender.reply(toOpenOrPrint: .failure)
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)  // menu-bar only, no dock icon

    if !receivedConfiguration { SessionController.shared.start() }
    // Computer sharing is opt-in — it stays idle until the human flips it on.
  }

  /// Stop sharing and any session check on quit, so the computer is never left
  /// shared behind a closed menu bar.
  func applicationWillTerminate(_ notification: Notification) {
    ComputerController.shared.stop()
    SessionController.shared.stop()
  }
}

@main
struct IterateApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var session = SessionController.shared
  @StateObject private var computer = ComputerController.shared

  var body: some Scene {
    MenuBarExtra {
      DropdownView().environmentObject(session).environmentObject(computer)
    } label: {
      // The 𝑖 template mark, and a green dot while an agent is actively using
      // this computer.
      Image(nsImage: IterateIcon.mark)
      if computer.inUse {
        Image(systemName: "circle.fill").foregroundStyle(.green)
      }
    }
    .menuBarExtraStyle(.window)
  }
}
