---
state: backlog
priority: medium
size: small
tags:
  - signup
  - ux
dependsOn: []
---

# Validate org/project slug uniqueness during signup

## Problem

The signup flow auto-generates organization and project slugs. If the generated
slug is already taken, the user hits an error — bad experience.

## Goal

- Check slug availability before submitting during signup.
- If taken, auto-append a suffix or prompt the user to pick a different one.
