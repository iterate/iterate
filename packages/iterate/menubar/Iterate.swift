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

  /// The argv for `iterate approve --json` (or `login`) under this config.
  func argv(for subcommand: [String]) -> [String] {
    var out = args
    if let config { out += ["--config", config] }
    out += subcommand
    if let project { out += ["--project", project] }
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
  let bodyPreview: String?
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
      DispatchQueue.main.async { self?.watcherExited() }
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
    process.arguments = [config.command] + config.argv(for: ["login"])
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
      var request = HeldRequest(
        offset: offset,
        method: event["method"] as? String ?? "?",
        host: event["host"] as? String ?? "?",
        url: event["url"] as? String ?? "",
        secretPaths: event["secretPaths"] as? [String] ?? [],
        ruleKey: event["ruleKey"] as? String ?? "",
        bodyPreview: event["bodyPreview"] as? String
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

// MARK: - Views

struct DropdownView: View {
  @EnvironmentObject var controller: ApprovalController

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
      HStack {
        if let error = controller.lastError {
          Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
        }
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.borderless).foregroundStyle(.secondary)
      }
    }
    .padding(14)
    .frame(width: 340)
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
      if let preview = request.bodyPreview, !preview.isEmpty {
        Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
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

  var body: some Scene {
    MenuBarExtra {
      DropdownView().environmentObject(controller)
    } label: {
      // The 𝑖 template mark, plus a count when requests are waiting.
      Image(nsImage: IterateIcon.mark)
      if controller.requests.count > 0 {
        Text("\(controller.requests.count)")
      }
    }
    .menuBarExtraStyle(.window)
  }
}
