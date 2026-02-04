---
state: todo
priority: medium
size: medium
tags:
  - observability
  - metrics
  - cloudflare
---

# Machine Health Metrics to Cloudflare ClickHouse

Collect machine health metrics and store them in Cloudflare's ClickHouse (Analytics Engine).

## Problem

We lack visibility into machine health across the fleet. Need to track metrics over time to identify patterns, debug issues, and monitor reliability.

## Solution

### 1. Define Metrics Schema

Key metrics to collect:

- Machine ID, type (daytona/local-docker)
- CPU/memory usage
- Daemon health status
- Service statuses (pidnap services)
- Network connectivity
- Last successful heartbeat
- Error counts/types

### 2. Cloudflare Analytics Engine Setup

- Create Analytics Engine dataset for machine metrics
- Define data points schema with appropriate blobs/doubles
- Set up retention policies

### 3. Collection Implementation

- Add metrics collection to daemon (or machine DO)
- Emit metrics at regular intervals
- Include relevant dimensions for filtering (org, project, machine type)

### 4. Querying/Dashboard

- Expose metrics via Workers Analytics Engine SQL API
- Consider basic dashboard or alerts based on thresholds

## Related

- Cloudflare Analytics Engine docs
- `apps/os/backend/` - where worker bindings live
- Task: `machine-monitoring-durable-objects.md` - related monitoring infrastructure
