#!/bin/bash

# Parse command line arguments and convert to environment variables
while [[ $# -gt 0 ]]; do
  case $1 in
    --iterate-config=*)
      CONFIG_PATH="${1#*=}"
      shift
      ;;
    -c=*)
      CONFIG_PATH="${1#*=}"
      shift
      ;;
    --iterate-config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    -c)
      CONFIG_PATH="$2"
      shift 2
      ;;
    *)
      # Pass through other arguments
      shift
      ;;
  esac
done

# If a config path was provided, pass it through
if [ -n "$CONFIG_PATH" ]; then
  export ITERATE_CONFIG_PATH="$CONFIG_PATH"
fi

# Run the bootstrap and dev server
tsx scripts/pg-estate-bootstrap.ts && CLOUDFLARE_INCLUDE_PROCESS_ENV=true doppler run -- react-router dev
