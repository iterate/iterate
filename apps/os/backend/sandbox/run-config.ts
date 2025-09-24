import { getSandbox } from "@cloudflare/sandbox";
import { typeid } from "typeid-js";
import dedent from "dedent";
import type { CloudflareEnv } from "../../env.ts";

export interface RunConfigOptions {
  githubRepoUrl: string;
  githubToken: string;
  commitHash?: string;
  branch?: string;
  workingDirectory?: string;
  callbackUrl?: string;
  buildId?: string;
  estateId?: string;
}

export interface RunConfigResult {
  success: boolean;
  message: string;
  output: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
}

export interface RunConfigError {
  error: string;
  details?: string;
  commitHash?: string;
}

/**
 * Runs a configuration build in a sandboxed environment
 */

export async function runConfigInSandbox(
  env: CloudflareEnv,
  options: RunConfigOptions,
): Promise<RunConfigResult | RunConfigError> {
  try {
    return await runConfigInSandboxInternal(env, options);
  } catch (error) {
    console.error("Error running config in sandbox:", error);
    return {
      error: "Internal server error during build",
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function runConfigInSandboxInternal(
  env: CloudflareEnv,
  options: RunConfigOptions,
): Promise<RunConfigResult | RunConfigError> {
  const { githubRepoUrl, githubToken, commitHash, branch, workingDirectory, callbackUrl } = options;

  // Get sandbox instance
  const sandboxId = typeid("build").toString();
  const sandbox = getSandbox(env.SANDBOX, sandboxId);

  // Determine the checkout target and working directory
  const checkoutTarget = commitHash || branch || "main";

  // Create a single bash script that handles the entire build process
  const buildScript = dedent(`
    #!/bin/bash
    set -e  # Exit on any error

    # Read arguments passed to the script
    GITHUB_REPO_URL="$1"
    GITHUB_TOKEN="$2"
    CHECKOUT_TARGET="$3"
    WORKING_DIR="$4"
    CALLBACK_URL="$5"
    BUILD_ID="$6"
    ESTATE_ID="$7"

    # Function to send callback if URL is provided
    send_callback() {
      local success="$1"
      local stdout="$2"
      local stderr="$3"
      local exit_code="$4"
  
      if [ -n "$CALLBACK_URL" ]; then
        echo "=== Sending callback to: $CALLBACK_URL ===" >&2

        # Prepare JSON payload safely using jq
        local payload=$(jq -n \\
          --arg buildId "$BUILD_ID" \\
          --arg estateId "$ESTATE_ID" \\
          --argjson success "$success" \\
          --arg stdout "$stdout" \\
          --arg stderr "$stderr" \\
          --argjson exitCode "$exit_code" \\
          '{buildId: $buildId, estateId: $estateId, success: $success, stdout: $stdout, stderr: $stderr, exitCode: $exitCode}')

        # Send callback (fire and forget, don't wait for response)
        curl -X POST "$CALLBACK_URL" \\
          -H "Content-Type: application/json" \\
          -d "$payload" \\
          --max-time 10 \\
          2>&1 | sed 's/^/[CALLBACK] /' >&2 || true

        echo "=== Callback sent ===" >&2
      fi
    }

    # Determine the actual working directory
    if [ -n "$WORKING_DIR" ]; then
      REPO_PATH="/tmp/repo/$WORKING_DIR"
    else
      REPO_PATH="/tmp/repo"
    fi

    echo "=== Starting build process ===" >&2
    echo "Repository: $GITHUB_REPO_URL" >&2
    echo "Checkout target: $CHECKOUT_TARGET" >&2
    echo "Working directory: \${WORKING_DIR:-root}" >&2
    if [ -n "$CALLBACK_URL" ]; then
      echo "Callback URL: $CALLBACK_URL" >&2
    fi
    echo "" >&2

    # Clone the repository
    echo "=== Cloning repository ===" >&2
    # Extract the repo path from the URL safely
    REPO_PATH_FROM_URL=$(echo "$GITHUB_REPO_URL" | sed 's|https://||')
    if ! git clone "https://x-access-token:$GITHUB_TOKEN@$REPO_PATH_FROM_URL" /tmp/repo 2>&1 >&2; then
      STDERR="Failed to clone repository"
      send_callback "false" "" "$STDERR" 1
      echo "ERROR: $STDERR" >&2
      exit 1
    fi

    # Checkout specific commit or branch
    if [ "$CHECKOUT_TARGET" != "main" ] && [ -n "$CHECKOUT_TARGET" ]; then
      echo "=== Checking out $CHECKOUT_TARGET ===" >&2
      cd /tmp/repo
      if ! git checkout "$CHECKOUT_TARGET" 2>&1 >&2; then
        STDERR="Failed to checkout $CHECKOUT_TARGET"
        send_callback "false" "" "$STDERR" 1
        echo "ERROR: $STDERR" >&2
        exit 1
      fi
    fi

    # Verify working directory exists
    echo "=== Verifying working directory ===" >&2
    if [ ! -d "$REPO_PATH" ]; then
      STDERR="Working directory $WORKING_DIR does not exist in the repository"
      send_callback "false" "" "$STDERR" 1
      echo "ERROR: $STDERR" >&2
      exit 1
    fi

    # Install dependencies (suppress output)
    echo "=== Installing dependencies ===" >&2
    cd "$REPO_PATH"
    if ! pnpm i --silent 2>&1 >&2; then
      STDERR="Failed to install dependencies"
      send_callback "false" "" "$STDERR" 1
      echo "ERROR: $STDERR" >&2
      exit 1
    fi

    # Run pnpm iterate and capture ONLY its stdout
    echo "=== Running pnpm iterate ===" >&2
    if OUTPUT=$(pnpm iterate 2>/dev/null); then
      # Success - output to stdout and send callback
      echo "$OUTPUT"
      send_callback "true" "$OUTPUT" "" 0
      exit 0
    else
      EXIT_CODE=$?
      # Failure - capture stderr this time
      STDERR=$(pnpm iterate 2>&1 >/dev/null || true)
      send_callback "false" "" "$STDERR" $EXIT_CODE
      echo "ERROR: pnpm iterate failed with exit code $EXIT_CODE" >&2
      echo "$STDERR" >&2
      exit $EXIT_CODE
    fi
  `);

  // Write the script to a file in the sandbox
  await sandbox.writeFile("/tmp/build.sh", buildScript);

  // Prepare arguments for the script (properly escaped)
  const scriptArgs = [
    githubRepoUrl,
    githubToken,
    checkoutTarget,
    workingDirectory || "",
    callbackUrl || "",
    options.buildId || "",
    options.estateId || "",
  ];

  // Create the command with properly escaped arguments
  const command = [
    "chmod +x /tmp/build.sh &&",
    "/tmp/build.sh",
    ...scriptArgs.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`),
  ].join(" ");

  // Make the script executable and run it with arguments
  const result = await sandbox.exec(command, {
    timeout: 90000, // 90 seconds total timeout
  });

  console.log("Build result", {
    success: result.exitCode === 0,
    message: result.exitCode === 0 ? "Build completed successfully" : "Build failed",
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
  });

  // If callback URL is provided, the script will handle the callback
  // Otherwise, return the result directly
  if (callbackUrl) {
    // When using callback, we just return a simple acknowledgment
    return {
      success: true,
      message: "Build started, results will be sent to callback",
      output: {
        stdout: "Build process initiated",
        stderr: "",
        exitCode: 0,
      },
    };
  }

  // Return the result directly if no callback
  return {
    success: result.exitCode === 0,
    message: result.exitCode === 0 ? "Build completed successfully" : "Build failed",
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
  };
}
