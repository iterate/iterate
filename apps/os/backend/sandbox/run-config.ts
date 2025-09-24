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
  const repoPath = workingDirectory ? `/tmp/repo/${workingDirectory}` : "/tmp/repo";

  // Create a single bash script that handles the entire build process
  const buildScript = dedent`
    #!/bin/bash
    set -e  # Exit on any error

    # Function to send callback if URL is provided
    send_callback() {
      local success="$1"
      local stdout="$2"
      local stderr="$3"
      local exit_code="$4"
  
      if [ -n "${callbackUrl || ""}" ]; then
        # Prepare JSON payload
        local payload=$(cat <<EOF
    {
      "buildId": "${options.buildId || ""}",
      "estateId": "${options.estateId || ""}",
      "success": \${success},
      "stdout": $(echo "$stdout" | jq -Rs .),
      "stderr": $(echo "$stderr" | jq -Rs .),
      "exitCode": $exit_code
    }
    EOF
        )

        # Send callback (fire and forget, don't wait for response)
        curl -X POST "${callbackUrl}" \
          -H "Content-Type: application/json" \
          -d "$payload" \
          --max-time 10 \
          2>/dev/null || true
      fi
    }

    # Capture all output
    exec 2>&1
    STDOUT=""
    STDERR=""

    echo "=== Starting build process ==="
    echo "Repository: ${githubRepoUrl}"
    echo "Checkout target: ${checkoutTarget}"
    echo "Working directory: ${workingDirectory || "root"}"
    echo ""

    # Clone the repository
    echo "=== Cloning repository ==="
    if ! git clone https://x-access-token:${githubToken}@${githubRepoUrl.replace("https://", "")} /tmp/repo 2>&1; then
      STDERR="Failed to clone repository"
      send_callback "false" "" "$STDERR" 1
      echo "$STDERR"
      exit 1
    fi

    # Checkout specific commit or branch
    if [ "${checkoutTarget}" != "main" ]; then
      echo "=== Checking out ${checkoutTarget} ==="
      cd /tmp/repo
      if ! git checkout ${checkoutTarget} 2>&1; then
        STDERR="Failed to checkout ${checkoutTarget}"
        send_callback "false" "" "$STDERR" 1
        echo "$STDERR"
        exit 1
      fi
    fi

    # Verify working directory exists
    echo "=== Verifying working directory ==="
    if [ ! -d "${repoPath}" ]; then
      STDERR="Working directory ${workingDirectory} does not exist in the repository"
      send_callback "false" "" "$STDERR" 1
      echo "$STDERR"
      exit 1
    fi

    # Install dependencies
    echo "=== Installing dependencies ==="
    cd ${repoPath}
    if ! pnpm i --silent 2>&1; then
      STDERR="Failed to install dependencies"
      send_callback "false" "" "$STDERR" 1
      echo "$STDERR"
      exit 1
    fi

    # Run pnpm iterate and capture output
    echo "=== Running pnpm iterate ==="
    if OUTPUT=$(pnpm iterate 2>&1); then
      STDOUT="$OUTPUT"
      echo "$OUTPUT"
      send_callback "true" "$STDOUT" "" 0
      exit 0
    else
      EXIT_CODE=$?
      STDERR="$OUTPUT"
      echo "$OUTPUT"
      send_callback "false" "" "$STDERR" $EXIT_CODE
      exit $EXIT_CODE
    fi
  `;

  // Write the script to a file in the sandbox
  await sandbox.writeFile("/tmp/build.sh", buildScript);

  // Make the script executable and run it
  const result = await sandbox.exec("chmod +x /tmp/build.sh && /tmp/build.sh", {
    timeout: 90000, // 90 seconds total timeout
  });

  console.log("Result:", {
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
