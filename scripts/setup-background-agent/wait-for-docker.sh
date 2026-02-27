#!/bin/bash
set -e

# Create log directory
mkdir -p /tmp/docker-logs

# Start Docker daemon in the background with minimal networking to avoid iptables issues
echo "Starting Docker daemon..."
sudo dockerd --iptables=false --bridge=none > /tmp/docker-logs/dockerd.log 2>&1 &
DOCKERD_PID=$!

# Wait for Docker to be ready
echo "Waiting for Docker daemon to be ready..."
timeout=60
counter=0
while ! sudo docker info >/dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "Docker daemon failed to start within ${timeout} seconds"
        echo "Docker daemon logs:"
        cat /tmp/docker-logs/dockerd.log
        exit 1
    fi
    
    # Check if dockerd process is still running
    if ! kill -0 $DOCKERD_PID 2>/dev/null; then
        echo "Docker daemon process died unexpectedly"
        echo "Docker daemon logs:"
        cat /tmp/docker-logs/dockerd.log
        exit 1
    fi
    
    sleep 1
    counter=$((counter + 1))
done

echo "Docker daemon is ready"

# Make docker socket accessible to the agent user's group
sudo chmod 666 /var/run/docker.sock

