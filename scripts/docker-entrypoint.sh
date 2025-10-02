#!/bin/bash
set -e

# Start Docker daemon in the background with minimal networking to avoid iptables issues
echo "Starting Docker daemon..."
sudo dockerd --iptables=false --bridge=none > /dev/null 2>&1 &

# Wait for Docker to be ready
echo "Waiting for Docker daemon to be ready..."
timeout=30
counter=0
while ! docker info >/dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "Docker daemon failed to start within ${timeout} seconds"
        exit 1
    fi
    sleep 1
    counter=$((counter + 1))
done

echo "Docker daemon is ready"