// ─────────────────────────────────────────────────────────────────────────────
// Iterate Approvals — a menu-bar app for human-in-the-loop egress approvals.
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

  @Published var loggedIn = false
  @Published var principal: String?
  @Published var project: String?
  @Published var keyLabel: String?  // "secure-enclave 9f2c…" or nil (unsigned)
  @Published var requests: [HeldRequest] = []
  @Published var lastError: String?

  private let config = MenuBarConfig.load()
  private var process: Process?
  private var stdinHandle: FileHandle?
  private var buffer = Data()

  func start() {
    stop()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["approve", "--json"])
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }

    let stdout = Pipe()
    let stdin = Pipe()
    process.standardOutput = stdout
    process.standardInput = stdin
    self.stdinHandle = stdin.fileHandleForWriting

    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      // Empty data means EOF: clear the handler so it stops firing (otherwise
      // it busy-loops on the closed pipe).
      if chunk.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      DispatchQueue.main.async { self?.ingest(chunk) }
    }
    // The watcher exited (needs-login, auth loss, or crash): drop the now-stale
    // pending rows and reflect that we're disconnected.
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.loggedIn = false
        self?.requests = []
      }
    }
    do {
      try process.run()
      self.process = process
    } catch {
      self.lastError = "Could not launch iterate: \(error.localizedDescription)"
    }
  }

  func stop() {
    process?.terminationHandler = nil
    process?.terminate()
    process = nil
    stdinHandle = nil
    requests = []
    buffer = Data()  // a partial line from the old watcher must not bleed into the next
  }

  /// Kick off `iterate login` (browser OAuth), then restart the watcher.
  func login() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [config.command] + config.argv(for: ["login"])
    if let cwd = config.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    process.terminationHandler = { [weak self] _ in
      Task { @MainActor in self?.start() }
    }
    try? process.run()
  }

  func decide(_ request: HeldRequest, _ decision: String) {
    if let index = requests.firstIndex(of: request) { requests[index].submitting = true }
    let line = #"{"offset":\#(request.offset),"decision":"\#(decision)"}"# + "\n"
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
      loggedIn = event["loggedIn"] as? Bool ?? false
      principal = event["principal"] as? String
      project = event["projectId"] as? String
      if let key = event["key"] as? [String: Any] {
        keyLabel = "\(key["kind"] as? String ?? "key") \((key["keyId"] as? String ?? "").prefix(8))"
      } else {
        keyLabel = nil
      }
    case "requested":
      guard let offset = event["offset"] as? Int else { return }
      let request = HeldRequest(
        offset: offset,
        method: event["method"] as? String ?? "?",
        host: event["host"] as? String ?? "?",
        url: event["url"] as? String ?? "",
        secretPaths: event["secretPaths"] as? [String] ?? [],
        ruleKey: event["ruleKey"] as? String ?? "",
        bodyPreview: event["bodyPreview"] as? String
      )
      if !requests.contains(request) {
        requests.append(request)
        notify(request)
      }
    case "settled":
      if let offset = event["offset"] as? Int {
        requests.removeAll { $0.offset == offset }
      }
    case "error":
      lastError = event["message"] as? String
      // A signing/append failure (e.g. cancelled Touch ID) leaves the request
      // pending — clear its spinner so Approve/Reject come back for a retry.
      if let offset = event["offset"] as? Int,
        let index = requests.firstIndex(where: { $0.offset == offset })
      {
        requests[index].submitting = false
      }
    default:
      break
    }
  }

  /// A passive macOS notification via osascript — zero entitlements, the same
  /// path use-my-computer uses. Fires when a request arrives so the human is
  /// pinged even with the dropdown closed.
  private func notify(_ request: HeldRequest) {
    let title = "Approval needed"
    let secrets = request.secretPaths.isEmpty ? "" : " · \(request.secretPaths.joined(separator: ", "))"
    let body = "\(request.method) \(request.host)\(secrets)"
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
    if controller.loggedIn {
      VStack(alignment: .leading, spacing: 2) {
        Text(controller.principal ?? "signed in").font(.headline)
        if let project = controller.project {
          Text(project).font(.caption).foregroundStyle(.secondary)
        }
        Text(controller.keyLabel.map { "signing with \($0)" } ?? "grants are unsigned — enroll a key")
          .font(.caption2).foregroundStyle(.secondary)
      }
    } else {
      HStack {
        Text("Not signed in").font(.headline)
        Spacer()
        Button("Sign in") { controller.login() }.buttonStyle(.borderedProminent)
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
          Button("Reject") { controller.decide(request, "rejected") }.buttonStyle(.bordered)
          Button("Approve") { controller.decide(request, "granted") }.buttonStyle(.borderedProminent)
        }
      }
    }
    .padding(10)
    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
  }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)  // menu-bar only, no dock icon
    ApprovalController.shared.start()  // connect at launch, not on first open
  }
}

@main
struct IterateApprovalsApp: App {
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
