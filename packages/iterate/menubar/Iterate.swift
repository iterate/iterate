// ─────────────────────────────────────────────────────────────────────────────
// Iterate — a small macOS menu-bar app. Today it's the human-in-the-loop
// approver for a project's egress.
//
// Deliberately a THIN shell over the iterate CLI: it owns nothing but the
// menu-bar icon and the dropdown. All transport, auth, streams, key storage,
// and enclave signing live in `iterate approve --json`, which this app spawns
// and talks to over stdio (NDJSON events in, {offset,decision} out). See
// approve-json.ts for the protocol.
//
// Single file, compiled with swiftc and wrapped in a minimal .app bundle by
// build-menubar-app.sh — no Xcode project, no asset catalog: the 𝑖 icon is
// drawn from the brand SVG's paths at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import AppKit
import Combine
import Foundation
import SwiftUI
import UserNotifications

// MARK: - Config

/// Where to find the CLI and which project to watch. Read from
/// ~/.config/iterate/menubar.json so the app needs no launch arguments.
struct MenuBarConfig: Codable {
  var command: String  // e.g. "iterate", or "bun"
  var args: [String]  // e.g. [] or ["/path/bin/iterate.js"]
  var config: String?  // iterate config name, e.g. "preview1"
  var project: String?  // project id or slug
  var cwd: String?  // working directory to spawn in

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

// MARK: - Model

struct HeldRequest: Identifiable, Equatable {
  let offset: Int
  let method: String
  let host: String
  let url: String
  let secretPaths: [String]
  let ruleKey: String
  let body: String?
  var submitting = false
  var id: Int { offset }
}

final class ApprovalController: ObservableObject {
  static let shared = ApprovalController()

  @Published var loggedIn = false  // is there a valid session (from the status line)?
  @Published var connected = false  // is a watcher live and serving right now?
  @Published var principal: String?
  @Published var project: String?
  @Published var keyLabel: String?  // "secure-enclave 9f2c…" or nil (unsigned)
  @Published var requests: [HeldRequest] = []
  @Published var lastError: String?

  /// True once UserNotifications authorization succeeded — gates the rich,
  /// actionable banners; otherwise notify() falls back to osascript.
  var notificationsAuthorized = false

  private let config = MenuBarConfig.load()
  private var process: Process?
  private var loginProcess: Process?
  private var stdinHandle: FileHandle?
  private var stdoutHandle: FileHandle?
  private var buffer = Data()
  private var sawStatus = false  // did THIS watcher session emit a status line?
  private var sessionStart = Date()
  private var reconnectAttempts = 0
  private var generation = 0  // bumped on every stop(); voids stale queued reconnects

  func start() {
    stop()
    sawStatus = false
    sessionStart = Date()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["approve", "--json"])
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }

    let stdout = Pipe()
    let stdin = Pipe()
    process.standardOutput = stdout
    process.standardInput = stdin
    self.stdinHandle = stdin.fileHandleForWriting
    self.stdoutHandle = stdout.fileHandleForReading

    // This session's identity: a chunk that lands after the session ends
    // (generation moved on) is stale and must not touch state.
    let session = generation
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      // Empty data means EOF: clear the handler so it stops firing (otherwise
      // it busy-loops on the closed pipe).
      if chunk.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      DispatchQueue.main.async {
        guard let self, self.generation == session else { return }  // stale chunk
        self.ingest(chunk)
      }
    }
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        // Guard on the session: a late callback from a process we already
        // replaced must not tear down the new one.
        guard let self, self.generation == session else { return }
        self.watcherExited()
      }
    }
    do {
      try process.run()
      self.process = process
    } catch {
      // Launch failed — that's a broken CLI path, NOT a lost session. stop()
      // already cleared `connected`/`requests`; leave `loggedIn` alone so a
      // valid session shows Disconnected + Reconnect rather than routing to a
      // needless browser login.
      self.lastError = "Could not launch iterate: \(error.localizedDescription)"
    }
  }

  /// The watcher process exited. Drop stale rows; don't touch `loggedIn` (the
  /// status line is authoritative). Reconnect only if this session actually
  /// connected (emitted a status) and still believes it's signed in — bounded,
  /// so a watcher that never connects or keeps dying fast won't hot-loop.
  private func watcherExited() {
    generation += 1  // end this session so any late stdout chunk is ignored
    detachIO()  // drop the dead pipes/handle so a click can't write to a corpse
    requests = []
    connected = false  // no live watcher until one reconnects and emits status
    if Date().timeIntervalSince(sessionStart) > 10 { reconnectAttempts = 0 }  // it was stable
    guard loggedIn, sawStatus else { return }  // never connected → no reconnect
    if reconnectAttempts < 5 {
      reconnectAttempts += 1
      // Void this reconnect if the user meanwhile signs in / quits (which
      // bumps the generation) so it can't overlap a login or a fresh watcher.
      let scheduled = generation
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        guard let self, self.generation == scheduled else { return }
        self.start()
      }
    } else {
      lastError = "Approver keeps exiting — click Sign in to retry."
    }
  }

  func stop() {
    generation += 1  // any in-flight reconnect scheduled before now is void
    connected = false
    process?.terminationHandler = nil
    process?.terminate()
    process = nil
    detachIO()
    requests = []
  }

  /// Drop the current session's pipes/handles and any half-read line, so no
  /// late chunk or stray write can touch the next session.
  private func detachIO() {
    stdoutHandle?.readabilityHandler = nil
    stdoutHandle = nil
    stdinHandle = nil
    buffer = Data()
  }

  /// Kick off `iterate login` (browser OAuth), then restart the watcher. Stop
  /// the current watcher first so login never overlaps a running approve.
  func login() {
    guard loginProcess == nil else { return }  // one browser login at a time
    stop()
    reconnectAttempts = 0  // an explicit retry clears the give-up counter
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["login"], includeProject: false)
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
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
      // Login couldn't even launch — don't leave the app with no watcher.
      lastError = "Could not start login: \(error.localizedDescription)"
      start()
    }
  }

  /// Relay a verdict for one held request — from the dropdown OR a notification
  /// action. The CLI does the signing (Touch ID pops there); the row shows a
  /// spinner until the settle/error comes back.
  func decide(offset: Int, _ decision: String) {
    setSubmitting(offset, true)
    let line = #"{"offset":\#(offset),"decision":"\#(decision)"}"# + "\n"
    stdinHandle?.write(Data(line.utf8))
  }

  // MARK: NDJSON ingestion

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
      sawStatus = true  // this watcher connected and spoke
      loggedIn = event["loggedIn"] as? Bool ?? false
      connected = loggedIn  // a live, authed watcher is serving
      lastError = nil
      principal = event["principal"] as? String
      project = event["projectId"] as? String
      if let key = event["key"] as? [String: Any] {
        keyLabel = "\(key["kind"] as? String ?? "key") \((key["keyId"] as? String ?? "").prefix(8))"
      } else {
        keyLabel = nil
      }
    case "requested":
      guard let offset = event["offset"] as? Int else { return }
      let url = event["url"] as? String ?? ""
      let body = event["body"] as? [String: Any]
      var bodyContent = body?["content"] as? String
      if body?["encoding"] as? String == "base64", let content = bodyContent {
        bodyContent = "[base64] \(content)"
      }
      var request = HeldRequest(
        offset: offset,
        method: event["method"] as? String ?? "?",
        host: URL(string: url)?.host ?? url,
        url: url,
        secretPaths: event["secretPaths"] as? [String] ?? [],
        ruleKey: event["ruleKey"] as? String ?? "",
        body: bodyContent
      )
      // A backlog request that already has a grant is shown awaiting the door
      // (spinner), not as a fresh Approve prompt.
      request.submitting = event["submitted"] as? Bool ?? false
      if !requests.contains(where: { $0.offset == offset }) {
        requests.append(request)
        if !request.submitting { notify(request) }
      }
    case "submitted":
      // A grant landed (this app's or another approver's): show the row
      // awaiting the door rather than a fresh prompt, and pull any delivered
      // banner so its Reject can't fire a stray veto against the winning grant.
      if let offset = event["offset"] as? Int {
        setSubmitting(offset, true)
        ApprovalNotifications.withdraw(offset)
      }
    case "settled":
      if let offset = event["offset"] as? Int {
        requests.removeAll { $0.offset == offset }
        ApprovalNotifications.withdraw(offset)
      }
    case "unsettled":
      // The door ignored the grant (key not enrolled / revoked) and the hold is
      // still open — clear the spinner so Approve/Reject return, and say why.
      if let offset = event["offset"] as? Int {
        setSubmitting(offset, false)
      }
      lastError = "A grant wasn’t accepted — is this Mac’s approval key enrolled? (iterate approve --keys)"
    case "error":
      lastError = event["message"] as? String
      // A signing/append failure (e.g. cancelled Touch ID) leaves the request
      // pending — clear its spinner so Approve/Reject come back for a retry.
      setSubmitting(event["offset"] as? Int, false)
    default:
      break
    }
  }

  /// Set a row's spinner, reassigning the element so the @Published array
  /// reliably republishes.
  private func setSubmitting(_ offset: Int?, _ value: Bool) {
    guard let offset, let index = requests.firstIndex(where: { $0.offset == offset }) else { return }
    var updated = requests[index]
    updated.submitting = value
    requests[index] = updated
  }

  /// Ping the human when a request lands, even with the dropdown closed. When
  /// UserNotifications authorization succeeded (needs a signed bundle — see
  /// build-menubar-app.sh SIGN_IDENTITY), post a rich banner with the 𝑖 logo
  /// and Approve/Reject actions that come back through `decide`. Otherwise fall
  /// back to a plain osascript notification — zero setup, works everywhere.
  private func notify(_ request: HeldRequest) {
    let title = "Approval needed"
    let secrets =
      request.secretPaths.isEmpty ? "" : " · spends \(request.secretPaths.joined(separator: ", "))"
    let body = "\(request.method) \(request.host)\(secrets)"

    if notificationsAuthorized {
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.categoryIdentifier = ApprovalNotifications.categoryId
      content.userInfo = ["offset": request.offset]
      if let url = IterateIcon.logoPNGURL,
        let attachment = try? UNNotificationAttachment(identifier: "logo", url: url)
      {
        content.attachments = [attachment]
      }
      let notification = UNNotificationRequest(
        identifier: ApprovalNotifications.identifier(request.offset), content: content, trigger: nil)
      UNUserNotificationCenter.current().add(notification)
      return
    }

    let script = "display notification \(quote(body)) with title \(quote(title))"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", script]
    try? process.run()
  }

  private func quote(_ text: String) -> String {
    "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
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
/// Deliberately simpler than ApprovalController: sharing is opt-in (a conscious
/// act), so if the watcher exits we just stop sharing and let the human
/// re-enable — no silent auto-reconnect that would re-lend the machine.
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

  private let config = MenuBarConfig.load()
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
    ApprovalController.shared.$loggedIn
      .dropFirst()
      .sink { [weak self] loggedIn in
        if !loggedIn { self?.stop() }
      }
      .store(in: &cancellables)
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
        // No session — login is the approver's job; just stop and say so.
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
      // array reliably republishes. Same idiom as ApprovalController.setSubmitting.
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
  @EnvironmentObject var controller: ApprovalController
  @EnvironmentObject var computer: ComputerController

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      Divider()
      if controller.requests.isEmpty {
        Text(controller.loggedIn ? "No requests waiting." : "Sign in to start approving.")
          .foregroundStyle(.secondary)
          .font(.callout)
          .padding(.vertical, 4)
      } else {
        ForEach(controller.requests) { request in
          RequestRow(request: request)
        }
      }
      Divider()
      computerSection
      Divider()
      HStack {
        if let error = controller.lastError ?? computer.lastError {
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
          .disabled(!controller.loggedIn && !computer.enabled)
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
    if !controller.loggedIn { return "Sign in to lend this Mac to agents." }
    if computer.sharing {
      let name = computer.computerName.map { "itx.\($0)" } ?? "your computer"
      if computer.reconnecting { return "Reconnecting \(name)…" }
      return computer.inUse ? "In use now — \(name)" : "\(name) is live for this project."
    }
    if computer.enabled { return "Starting…" }
    return "Let agents run dialogs, notifications and Swift here."
  }

  @ViewBuilder private var header: some View {
    if !controller.loggedIn {
      HStack {
        Text("Not signed in").font(.headline)
        Spacer()
        Button("Sign in") { controller.login() }.buttonStyle(.borderedProminent)
      }
    } else if !controller.connected {
      // Valid session, but no watcher is live (it died and is retrying or gave
      // up) — say so honestly and offer a manual reconnect.
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(controller.principal ?? "signed in").font(.headline)
          Text("Disconnected").font(.caption).foregroundStyle(.orange)
        }
        Spacer()
        Button("Reconnect") { controller.start() }.buttonStyle(.bordered)
      }
    } else {
      VStack(alignment: .leading, spacing: 2) {
        Text(controller.principal ?? "signed in").font(.headline)
        if let project = controller.project {
          Text(project).font(.caption).foregroundStyle(.secondary)
        }
        Text(controller.keyLabel.map { "signing with \($0)" } ?? "grants are unsigned — enroll a key")
          .font(.caption2).foregroundStyle(.secondary)
      }
    }
  }
}

struct RequestRow: View {
  @EnvironmentObject var controller: ApprovalController
  let request: HeldRequest

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("\(request.method) \(request.host)").font(.system(.body, design: .monospaced)).bold()
      if !request.secretPaths.isEmpty {
        Text("spends \(request.secretPaths.joined(separator: ", "))")
          .font(.caption).foregroundStyle(.orange)
      }
      if let body = request.body, !body.isEmpty {
        Text(body).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      HStack {
        Text("rule: \(request.ruleKey)").font(.caption2).foregroundStyle(.secondary)
        Spacer()
        if request.submitting {
          ProgressView().controlSize(.small)
        } else {
          Button("Reject") { controller.decide(offset: request.offset, "rejected") }
            .buttonStyle(.bordered)
          Button("Approve") { controller.decide(offset: request.offset, "granted") }
            .buttonStyle(.borderedProminent)
        }
      }
    }
    .padding(10)
    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
  }
}

// MARK: - Notifications

/// The one actionable-notification category: Approve / Reject, mapped back to
/// `decide` by the delegate. Delivery needs a signed bundle, so it's an
/// opt-in upgrade over the osascript fallback (see notify()).
enum ApprovalNotifications {
  static let categoryId = "APPROVAL"

  static func identifier(_ offset: Int) -> String { "approval-\(offset)" }

  static func register(_ center: UNUserNotificationCenter) {
    let approve = UNNotificationAction(identifier: "APPROVE", title: "Approve", options: [.foreground])
    let reject = UNNotificationAction(
      identifier: "REJECT", title: "Reject", options: [.destructive])
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: categoryId, actions: [approve, reject], intentIdentifiers: [], options: [])
    ])
  }

  /// Pull a delivered banner once its request is no longer answerable here — a
  /// grant landed or it settled — so a stale Reject tap can't append a veto the
  /// door has already passed (egress released on the winning grant).
  static func withdraw(_ offset: Int) {
    UNUserNotificationCenter.current().removeDeliveredNotifications(
      withIdentifiers: [identifier(offset)])
  }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)  // menu-bar only, no dock icon

    // Actionable notifications are best-effort: only an app with a stable
    // signing identity gets authorization. If it's granted we upgrade from the
    // osascript ping to rich Approve/Reject banners; if not, nothing breaks.
    if Bundle.main.bundleIdentifier != nil {
      let center = UNUserNotificationCenter.current()
      center.delegate = self
      ApprovalNotifications.register(center)
      center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        DispatchQueue.main.async { ApprovalController.shared.notificationsAuthorized = granted }
      }
    }

    ApprovalController.shared.start()  // connect at launch, not on first open
    // Computer sharing is opt-in — it stays idle until the human flips it on.
  }

  /// Tear down both watchers on quit so we never leave the computer shared (or an
  /// approver running) behind a closed menu bar.
  func applicationWillTerminate(_ notification: Notification) {
    ComputerController.shared.stop()
    ApprovalController.shared.stop()
  }

  /// Show the banner even when the app is frontmost.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  /// An Approve/Reject tap on a banner routes straight to `decide` (signing —
  /// and Touch ID — happen in the CLI, exactly as from the dropdown).
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let offset = response.notification.request.content.userInfo["offset"] as? Int {
      switch response.actionIdentifier {
      case "APPROVE": ApprovalController.shared.decide(offset: offset, "granted")
      case "REJECT": ApprovalController.shared.decide(offset: offset, "rejected")
      default: break
      }
    }
    completionHandler()
  }
}

@main
struct IterateApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var controller = ApprovalController.shared
  @StateObject private var computer = ComputerController.shared

  var body: some Scene {
    MenuBarExtra {
      DropdownView().environmentObject(controller).environmentObject(computer)
    } label: {
      // The 𝑖 template mark, a count when requests are waiting, and a green dot
      // while an agent is actively using this computer.
      Image(nsImage: IterateIcon.mark)
      if controller.requests.count > 0 {
        Text("\(controller.requests.count)")
      }
      if computer.inUse {
        Image(systemName: "circle.fill").foregroundStyle(.green)
      }
    }
    .menuBarExtraStyle(.window)
  }
}
