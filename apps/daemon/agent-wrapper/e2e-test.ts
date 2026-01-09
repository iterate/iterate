#!/usr/bin/env npx tsx
/* eslint-disable no-console, no-empty */
/**
 * E2E test script for agent-wrapper
 *
 * Tests the full flow:
 * 1. Start agent-wrapper (daemon + Pi session)
 * 2. Send a prompt
 * 3. Verify events are processed correctly
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { setTimeout } from "node:timers/promises"

const DATA_DIR = ".iterate"
const TIMEOUT_MS = 30000

interface StreamFile {
  events: Array<{
    offset: string
    eventStreamId: string
    data: {
      type: string
      payload?: unknown
    }
  }>
}

async function cleanup() {
  console.log("🧹 Cleaning up...")

  // Kill any processes on port 3000
  try {
    const lsof = spawn("lsof", ["-t", "-i", ":3000"])
    const pids: Array<string> = []
    lsof.stdout.on("data", (data) => pids.push(data.toString().trim()))
    await new Promise<void>((resolve) => lsof.on("close", resolve))
    for (const pid of pids.filter(Boolean)) {
      try {
        process.kill(parseInt(pid, 10), "SIGKILL")
      } catch {}
    }
  } catch {}

  // Remove data files
  try {
    rmSync(`${DATA_DIR}/daemon.pid`, { force: true })
    rmSync(`${DATA_DIR}/daemon.port`, { force: true })
    rmSync(`${DATA_DIR}/daemon.log`, { force: true })
    rmSync(`${DATA_DIR}/streams`, { recursive: true, force: true })
  } catch {}

  await setTimeout(1000)
}

async function runCommand(
  cmd: string,
  args: Array<string>,
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    // Run as a single shell command to handle argument quoting properly
    const fullCmd = [cmd, ...args].join(" ")
    const proc = spawn("sh", ["-c", fullCmd])
    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (data) => {
      stdout += data.toString()
    })
    proc.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    const timeout = options?.timeout ?? 10000
    const timer = globalThis.setTimeout(() => {
      proc.kill("SIGKILL")
    }, timeout)

    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

function getStreamName(output: string): string | null {
  const match = output.match(/Stream: (pi-[a-f0-9]+)/)
  return match?.[1] ?? null
}

function readStreamFile(streamName: string): StreamFile | null {
  const path = `${DATA_DIR}/streams/${streamName}.json`
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StreamFile
  } catch {
    return null
  }
}

async function main() {
  console.log("🧪 Agent Wrapper E2E Test\n")

  // Cleanup before test
  await cleanup()

  // Start agent-wrapper in background
  console.log("📦 Starting agent-wrapper...")
  const wrapper = spawn("pnpm", ["agent-wrapper", "start"], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  })

  let wrapperOutput = ""
  wrapper.stdout.on("data", (data) => {
    const text = data.toString()
    wrapperOutput += text
    process.stdout.write(text)
  })
  wrapper.stderr.on("data", (data) => {
    const text = data.toString()
    if (!text.includes("npm warn")) {
      wrapperOutput += text
      process.stderr.write(text)
    }
  })

  // Wait for session to start
  const startTime = Date.now()
  let streamName: string | null = null
  while (Date.now() - startTime < TIMEOUT_MS) {
    streamName = getStreamName(wrapperOutput)
    if (streamName && wrapperOutput.includes("[Pi Adapter] Session created")) {
      break
    }
    await setTimeout(500)
  }

  if (!streamName) {
    console.error("\n❌ FAIL: Could not find stream name in output")
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  }

  console.log(`\n✅ Session started: ${streamName}`)

  // Verify session-create event in stream
  await setTimeout(1000)
  const streamBefore = readStreamFile(streamName)
  if (!streamBefore || streamBefore.events.length === 0) {
    console.error("❌ FAIL: No events in stream file")
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  }

  const sessionCreateEvent = streamBefore.events[0]
  if (!sessionCreateEvent?.data.type.includes("session-create")) {
    console.error("❌ FAIL: First event is not session-create")
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  }

  console.log("✅ Session-create event stored")

  // Send a prompt
  console.log("\n📤 Sending prompt...")
  const promptResult = await runCommand("pnpm", ["agent-wrapper", "prompt", streamName, "'hello world'"], {
    timeout: 15000
  })

  if (promptResult.code !== 0) {
    console.error(`❌ FAIL: Prompt command failed with code ${promptResult.code}`)
    console.error(promptResult.stderr)
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  }

  console.log("✅ Prompt sent")

  // Wait for events to be processed
  await setTimeout(2000)

  // Verify prompt event in stream
  const streamAfter = readStreamFile(streamName)
  if (!streamAfter) {
    console.error("❌ FAIL: Could not read stream file after prompt")
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  }

  const promptEvent = streamAfter.events.find((e) => e.data.type.includes("prompt:called"))
  if (!promptEvent) {
    console.error("❌ FAIL: Prompt event not found in stream")
    console.error("Events:", JSON.stringify(streamAfter.events.map((e) => e.data.type), null, 2))
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  }

  console.log("✅ Prompt event stored")

  // Check if adapter processed the prompt (look for "Sending prompt" in output)
  if (wrapperOutput.includes("[Pi Adapter] Sending prompt:")) {
    console.log("✅ Adapter processed prompt")
  } else if (wrapperOutput.includes("[Pi Adapter] No session")) {
    console.error("❌ FAIL: Adapter has no session - race condition!")
    wrapper.kill("SIGKILL")
    await cleanup()
    process.exit(1)
  } else {
    console.log("⚠️  Could not verify adapter processed prompt (may be waiting for Pi SDK)")
  }

  // Cleanup
  console.log("\n🧹 Cleaning up...")
  wrapper.kill("SIGKILL")
  await cleanup()

  console.log("\n✅ All E2E tests passed!\n")
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
