# BASH_ENV: sourced before each run step, including pnpm install. No npm dependencies.
# Child shells inherit the guard; their lifetime is already in the enclosing step.
if [ -z "${CI_TRACE_SHELL:-}" ]; then
  export CI_TRACE_SHELL="$$"
  node -e 'console.log("@@ci-trace " + JSON.stringify({kind:"shell-start", id:process.env.CI_TRACE_SHELL, step:process.env.GITHUB_ACTION || "shell", time:Date.now()}))'
  ci_trace_exit() {
    local status="$1"
    node -e '
      const event = JSON.stringify({kind:"shell-end", id:process.env.CI_TRACE_SHELL, time:Date.now(), exitCode:Number(process.argv[1])});
      console.log("@@ci-trace " + event);
      if (process.env.GITHUB_OUTPUT) require("node:fs").appendFileSync(process.env.GITHUB_OUTPUT, "ci-trace-end=" + event + "\n");
    ' "$status"
    exit "$status"
  }
  trap 'ci_trace_exit "$?"' EXIT
fi
