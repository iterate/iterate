---
state: draft
priority: high
size: large
dependsOn: []
---

# Massive Tool Integrations Expansion

## Overview

Expand the tools/integrations catalog from ~5 to 50+ integrations across AI, productivity, communication, financial, creative, and infrastructure categories. Leverage the existing egress proxy architecture and secure secrets management to offer metered billing on virtually any API with access tokens.

## Research Summary

**Current State:**

- 5 integrations: Slack, Google, GitHub, Resend, Stripe (Treasury), Daytona
- Custom egress proxy architecture (not MCP-based)
- Secure secrets via magic strings: `getIterateSecret({secretKey: "..."})`
- Hierarchical scoping: global → org → project → user

**Reference Integrations (Moltbot):**

- 50+ integrations across chat, AI, productivity, smart home, media
- Chat: WhatsApp, Telegram, Discord, Signal, iMessage, Teams, Matrix
- AI Models: OpenAI, Anthropic, Google, Grok, Mistral, DeepSeek, Perplexity
- Productivity: Notion, GitHub, Apple Notes, Trello, Obsidian
- Creative: Image gen, GIF search, camera
- Smart Home: Hue, 8sleep, Home Assistant

---

## Phase 1: Core AI Model APIs (P0 - Immediate)

**Goal:** Enable customers to use any frontier AI model via unified interface.

### 1.1 Replicate

- **Purpose:** Run 1000+ open-source models (FLUX, Stable Diffusion, LLaMA, etc.)
- **Billing:** Per-inference pricing
- **Secret:** `replicate.api_token`
- **Egress Rule:** `$.target.host ~> /replicate\.com$/`
- **Tools:** `replicate.run()`, `replicate.predictions.create()`, `replicate.models.list()`

### 1.2 Stability AI

- **Purpose:** Image generation (SDXL, Stable Diffusion 3)
- **Billing:** Per-image pricing
- **Secret:** `stabilityai.api_key`
- **Egress Rule:** `$.target.host ~> /stability\.ai$/`
- **Tools:** `stability.generate()`, `stability.upscale()`

### 1.3 Runway ML

- **Purpose:** Video generation (Gen-4 Turbo)
- **Billing:** Per-video pricing
- **Secret:** `runway.api_key`
- **Egress Rule:** `$.target.host ~> /runwayml\.com$/`
- **Tools:** `runway.generateVideo()`, `runway.generateImage()`

### 1.4 xAI Grok

- **Purpose:** Chat completions via xAI API
- **Billing:** Per-token
- **Secret:** `xai.api_key`
- **Egress Rule:** `$.target.host ~> /api\.x\.ai$/`
- **Tools:** `grok.chat()`, `grok.complete()`

### 1.5 Google Gemini

- **Purpose:** Multimodal AI (text, image, video)
- **Billing:** Per-token
- **Secret:** `google_gemini.api_key`
- **Egress Rule:** `$.target.host ~> /generativelanguage\.googleapis\.com$/`
- **Tools:** `gemini.generate()`, `gemini.chat()`

### 1.6 Mistral AI

- **Purpose:** European LLM provider
- **Billing:** Per-token
- **Secret:** `mistralai.api_key`
- **Egress Rule:** `$.target.host ~> /api\.mistral\.ai$/`
- **Tools:** `mistral.chat()`, `mistral.embed()`

### 1.7 Cohere

- **Purpose:** Embeddings, reranking, classify
- **Billing:** Per-token
- **Secret:** `cohere.api_key`
- **Egress Rule:** `$.target.host ~> /api\.cohere\.com$/`
- **Tools:** `cohere.embed()`, `cohere.rerank()`, `cohere.classify()`

### 1.8 Perplexity

- **Purpose:** Search-augmented AI
- **Billing:** Per-query
- **Secret:** `perplexity.api_key`
- **Egress Rule:** `$.target.host ~> /api\.perplexity\.ai$/`
- **Tools:** `perplexity.search()`, `perplexity.chat()`

### 1.9 Together AI

- **Purpose:** Fast inference for open-source models
- **Billing:** Per-token
- **Secret:** `togetherai.api_key`
- **Egress Rule:** `$.target.host ~> /api\.together\.xyz$/`
- **Tools:** `together.chat()`, `together.completion()`

### 1.10 Fireworks AI

- **Purpose:** Production-grade open-source inference
- **Billing:** Per-token
- **Secret:** `fireworksai.api_key`
- **Egress Rule:** `$.target.host ~> /api\.fireworks\.ai$/`
- **Tools:** `fireworks.chat()`, `fireworks.embed()`

---

## Phase 2: Communication & Messaging (P0)

**Goal:** Enable agents to communicate across any platform.

### 2.1 Twilio

- **Purpose:** SMS, Voice, WhatsApp, Verify
- **Billing:** Per-message/call
- **Secret:** `twilio.account_sid`, `twilio.auth_token`
- **Egress Rule:** `$.target.host ~> /api\.twilio\.com$/`
- **Tools:** `twilio.sms.send()`, `twilio.voice.call()`, `twilio.verify.start()`

### 2.2 SendGrid

- **Purpose:** Transactional email at scale
- **Billing:** Per-email
- **Secret:** `sendgrid.api_key`
- **Egress Rule:** `$.target.host ~> /api\.sendgrid\.com$/`
- **Tools:** `sendgrid.send()`, `sendgrid.template.send()`

### 2.3 Mailgun

- **Purpose:** Transactional email with better deliverability
- **Billing:** Per-email
- **Secret:** `mailgun.api_key`
- **Egress Rule:** `$.target.host ~> /api\.mailgun\.net$/`
- **Tools:** `mailgun.send()`, `mailgun.validate()`

### 2.4 Telegram Bot API

- **Purpose:** Bot messaging platform
- **Billing:** Free (rate limited)
- **Secret:** `telegram.bot_token`
- **Egress Rule:** `$.target.host ~> /api\.telegram\.org$/`
- **Tools:** `telegram.sendMessage()`, `telegram.sendPhoto()`, `telegram.answerCallbackQuery()`

### 2.5 WhatsApp Business API

- **Purpose:** Official WhatsApp business messaging
- **Billing:** Per-conversation (Meta pricing)
- **Secret:** `whatsapp.access_token`
- **Egress Rule:** `$.target.host ~> /graph\.facebook\.com.*whatsapp/`
- **Tools:** `whatsapp.sendMessage()`, `whatsapp.sendTemplate()`

### 2.6 Discord Bot API

- **Purpose:** Server messaging and interactions
- **Billing:** Free
- **Secret:** `discord.bot_token`
- **Egress Rule:** `$.target.host ~> /discord\.com\/api/`
- **Tools:** `discord.sendMessage()`, `discord.createThread()`, `discord.react()`

### 2.7 Signal CLI

- **Purpose:** Privacy-focused messaging
- **Billing:** Free
- **Secret:** `signal.phone_number`
- **Egress Rule:** Custom (local Signal CLI)
- **Tools:** `signal.send()`, `signal.receive()`

---

## Phase 3: Financial Services (P1)

**Goal:** Enable fintech use cases for customers.

### 3.1 Plaid

- **Purpose:** Bank account linking, transactions, balances
- **Billing:** Per-item/transaction sync
- **Secret:** `plaid.client_id`, `plaid.secret`
- **Egress Rule:** `$.target.host ~> /sandbox\.plaid\.com|production\.plaid\.com$/`
- **Tools:** `plaid.accounts.get()`, `plaid.transactions.get()`, `plaid.auth.get()`
- **OAuth:** Yes - requires Link flow

### 3.2 Intrinio

- **Purpose:** Stock market data, fundamentals, ETFs
- **Billing:** Per-API call
- **Secret:** `intrinio.api_key`
- **Egress Rule:** `$.target.host ~> /api-v2\.intrinio\.com$/`
- **Tools:** `intrinio.stock.price()`, `intrinio.company.fundamentals()`, `intrinio.options.chain()`

### 3.3 Alpaca

- **Purpose:** Commission-free stock trading API
- **Billing:** Free for basic
- **Secret:** `alpaca.api_key`, `alpaca.secret_key`
- **Egress Rule:** `$.target.host ~> /(paper-|)api\.alpaca\.markets$/`
- **Tools:** `alpaca.order.create()`, `alpaca.positions.get()`, `alpaca.account.get()`

### 3.4 Stripe (expand beyond Treasury)

- **Purpose:** Payments, billing, subscriptions
- **Billing:** Stripe's standard pricing
- **Secret:** `stripe.secret_key` (exists)
- **Egress Rule:** Already exists
- **Tools to add:** `stripe.customers.create()`, `stripe.paymentLinks.create()`, `stripe.subscriptions.create()`

### 3.5 Wise (formerly TransferWise)

- **Purpose:** International money transfers
- **Billing:** Per-transfer
- **Secret:** `wise.api_key`
- **Egress Rule:** `$.target.host ~> /api\.wise\.com$/`
- **Tools:** `wise.transfer.create()`, `wise.quote.create()`, `wise.recipients.get()`

### 3.6 Brex

- **Purpose:** Corporate card and expense management
- **Billing:** Free API
- **Secret:** `brex.api_key`
- **Egress Rule:** `$.target.host ~> /platform\.brex\.com$/`
- **Tools:** `brex.cards.get()`, `brex.expenses.list()`, `brex.receipts.upload()`

### 3.7 Mercury

- **Purpose:** Startup banking API
- **Billing:** Free for API
- **Secret:** `mercury.api_key`
- **Egress Rule:** `$.target.host ~> /api\.mercury\.com$/`
- **Tools:** `mercury.accounts.get()`, `mercury.transactions.list()`, `mercury.recipients.create()`

---

## Phase 4: Data & Infrastructure (P1)

**Goal:** Enable data operations and infrastructure management.

### 4.1 Pinecone

- **Purpose:** Vector database for RAG/semantic search
- **Billing:** Per-query + storage
- **Secret:** `pinecone.api_key`
- **Egress Rule:** `$.target.host ~> /[a-z-]+\.svc\.environment\.pinecone\.io$/`
- **Tools:** `pinecone.upsert()`, `pinecone.query()`, `pinecone.index.create()`

### 4.2 Weaviate

- **Purpose:** Open-source vector database
- **Billing:** Per-query (cloud)
- **Secret:** `weaviate.api_key`, `weaviate.host`
- **Egress Rule:** Custom host-based
- **Tools:** `weaviate.query()`, `weaviate.createObject()`

### 4.3 Chroma

- **Purpose:** AI-native embedding database
- **Billing:** Cloud pricing
- **Secret:** `chroma.tenant`, `chroma.token`
- **Egress Rule:** `$.target.host ~> /api\.trychroma\.com$/`
- **Tools:** `chroma.add()`, `chroma.query()`

### 4.4 Supabase

- **Purpose:** Backend-as-a-Service (Postgres + Auth + Storage)
- **Billing:** Per-request
- **Secret:** `supabase.url`, `supabase.anon_key`, `supabase.service_role_key`
- **Egress Rule:** `$.target.host ~> /[a-z0-9-]+\.supabase\.co$/`
- **Tools:** `supabase.from().select()`, `supabase.auth.signUp()`, `supabase.storage.upload()`

### 4.5 BigQuery

- **Purpose:** Google Cloud data warehouse
- **Billing:** Per-query ($5/TB)
- **Secret:** `bigquery.project_id`, `bigquery.credentials`
- **Egress Rule:** `$.target.host ~> /bigquery\.googleapis\.com$/`
- **Tools:** `bigquery.query()`, `bigquery.table.insert()`

### 4.6 Snowflake

- **Purpose:** Cloud data platform
- **Billing:** Per-compute
- **Secret:** `snowflake.account`, `snowflake.user`, `snowflake.password`
- **Egress Rule:** Custom (account-specific URLs)
- **Tools:** `snowflake.query()`, `snowflake.stage.put()`

### 4.7 Databricks

- **Purpose:** Lakehouse platform
- **Billing:** Per-DBU
- **Secret:** `databricks.host`, `databricks.token`
- **Egress Rule:** Custom host-based
- **Tools:** `databricks.query()`, `databricks.jobs.run()`

### 4.8 Upstash

- **Purpose:** Serverless Redis + Kafka
- **Billing:** Per-request
- **Secret:** `upstash.redis_rest_url`, `upstash.token`
- **Egress Rule:** `$.target.host ~> /[a-z0-9-]+\.upstash\.io$/`
- **Tools:** `upstash.get()`, `upstash.set()`, `upstash.publish()`

---

## Phase 5: Observability & Monitoring (P1)

**Goal:** Enable agents to monitor and alert on systems.

### 5.1 Sentry

- **Purpose:** Error tracking and performance monitoring
- **Billing:** Per-error event
- **Secret:** `sentry.auth_token`
- **Egress Rule:** `$.target.host ~> /sentry\.io$/`
- **Tools:** `sentry.issues.list()`, `sentry.events.get()`, `sentry.projects.list()`

### 5.2 Datadog

- **Purpose:** Full-stack observability
- **Billing:** Per-metric/log
- **Secret:** `datadog.api_key`, `datadog.app_key`
- **Egress Rule:** `$.target.host ~> /api\.datadoghq\.com$/`
- **Tools:** `datadog.metrics.query()`, `datadog.logs.search()`, `datadog.monitors.create()`

### 5.3 PagerDuty

- **Purpose:** Incident management and alerting
- **Billing:** Per-user
- **Secret:** `pagerduty.api_token`
- **Egress Rule:** `$.target.host ~> /api\.pagerduty\.com$/`
- **Tools:** `pagerduty.incidents.create()`, `pagerduty.schedules.list()`, `pagerduty.alerts.acknowledge()`

### 5.4 New Relic

- **Purpose:** Application performance monitoring
- **Billing:** Per-GB ingested
- **Secret:** `newrelic.api_key`
- **Egress Rule:** `$.target.host ~> /api\.newrelic\.com$/`
- **Tools:** `newrelic.nrql.query()`, `newrelic.alerts.list()`

### 5.5 Better Stack

- **Purpose:** Modern logging and monitoring
- **Billing:** Per-log
- **Secret:** `betterstack.source_token`, `betterstack.api_token`
- **Egress Rule:** `$.target.host ~> /in\.betterstack\.com$/`
- **Tools:** `betterstack.log()`, `betterstack.alert()`

---

## Phase 6: Creative & Media (P2)

**Goal:** Enable creative workflows.

### 6.1 Figma

- **Purpose:** Design file access, comments, assets
- **Billing:** Free tier available
- **Secret:** `figma.access_token`
- **Egress Rule:** `$.target.host ~> /api\.figma\.com$/`
- **Tools:** `figma.files.get()`, `figma.comments.post()`, `figma.images.export()`
- **OAuth:** Yes

### 6.2 Canva

- **Purpose:** Design automation
- **Billing:** Per-design
- **Secret:** `canva.api_token`
- **Egress Rule:** `$.target.host ~> /api\.canva\.com$/`
- **Tools:** `canva.designs.create()`, `canva.export()`

### 6.3 Cloudinary

- **Purpose:** Media transformation and delivery
- **Billing:** Per-transformation
- **Secret:** `cloudinary.cloud_name`, `cloudinary.api_key`, `cloudinary.api_secret`
- **Egress Rule:** `$.target.host ~> /api\.cloudinary\.com$/`
- **Tools:** `cloudinary.upload()`, `cloudinary.transform()`, `cloudinary.analyze()`

### 6.4 Mux

- **Purpose:** Video streaming API
- **Billing:** Per-minute streamed
- **Secret:** `mux.token_id`, `mux.token_secret`
- **Egress Rule:** `$.target.host ~> /api\.mux\.com$/`
- **Tools:** `mux.assets.create()`, `mux.playback.get()`

### 6.5 ImageKit

- **Purpose:** Image optimization and CDN
- **Billing:** Per-transformation
- **Secret:** `imagekit.private_key`, `imagekit.public_key`
- **Egress Rule:** `$.target.host ~> /api\.imagekit\.io$/`
- **Tools:** `imagekit.upload()`, `imagekit.transform()`

---

## Phase 7: Productivity & Project Management (P2)

**Goal:** Enable workflow automation.

### 7.1 Notion

- **Purpose:** Wiki, docs, databases
- **Billing:** Free tier
- **Secret:** `notion.integration_token`
- **Egress Rule:** `$.target.host ~> /api\.notion\.com$/`
- **Tools:** `notion.pages.create()`, `notion.databases.query()`, `notion.blocks.children.append()`

### 7.2 Airtable

- **Purpose:** Database-spreadsheet hybrid
- **Billing:** Per-record
- **Secret:** `airtable.api_key`, `airtable.base_id`
- **Egress Rule:** `$.target.host ~> /api\.airtable\.com$/`
- **Tools:** `airtable.records.list()`, `airtable.records.create()`, `airtable.webhooks.create()`

### 7.3 Linear

- **Purpose:** Modern issue tracking
- **Billing:** Free for small teams
- **Secret:** `linear.api_key`
- **Egress Rule:** `$.target.host ~> /api\.linear\.app$/`
- **Tools:** `linear.issues.create()`, `linear.issues.list()`, `linear.comments.create()`

### 7.4 Asana

- **Purpose:** Project management
- **Billing:** Per-user
- **Secret:** `asana.access_token`
- **Egress Rule:** `$.target.host ~> /app\.asana\.com$/`
- **Tools:** `asana.tasks.create()`, `asana.projects.get()`, `asana.webhooks.create()`
- **OAuth:** Yes

### 7.5 ClickUp

- **Purpose:** All-in-one productivity
- **Billing:** Per-user
- **Secret:** `clickup.api_token`
- **Egress Rule:** `$.target.host ~> /api\.clickup\.com$/`
- **Tools:** `clickup.tasks.create()`, `clickup.spaces.list()`

### 7.6 Trello

- **Purpose:** Kanban boards
- **Billing:** Free tier
- **Secret:** `trello.api_key`, `trello.token`
- **Egress Rule:** `$.target.host ~> /api\.trello\.com$/`
- **Tools:** `trello.cards.create()`, `trello.boards.get()`

### 7.7 Jira

- **Purpose:** Enterprise issue tracking
- **Billing:** Per-user
- **Secret:** `jira.api_token`, `jira.email`
- **Egress Rule:** `$.target.host ~> /[a-z0-9-]+\.atlassian\.net$/`
- **Tools:** `jira.issues.create()`, `jira.search.jql()`

### 7.8 Monday.com

- **Purpose:** Work OS platform
- **Billing:** Per-user
- **Secret:** `monday.api_token`
- **Egress Rule:** `$.target.host ~> /api\.monday\.com$/`
- **Tools:** `monday.items.create()`, `monday.boards.query()`

---

## Phase 8: E-commerce & Business (P2)

**Goal:** Enable retail/commerce automation.

### 8.1 Shopify

- **Purpose:** E-commerce platform
- **Billing:** Per-call
- **Secret:** `shopify.shop_domain`, `shopify.access_token`
- **Egress Rule:** `$.target.host ~> /[a-z-]+\.myshopify\.com$/`
- **Tools:** `shopify.products.list()`, `shopify.orders.create()`, `shopify.customers.get()`

### 8.2 WooCommerce

- **Purpose:** WordPress e-commerce
- **Billing:** Free
- **Secret:** `woocommerce.store_url`, `woocommerce.consumer_key`, `woocommerce.consumer_secret`
- **Egress Rule:** Custom host-based
- **Tools:** `woocommerce.products.get()`, `woocommerce.orders.list()`

### 8.3 Stripe (Commerce expansion)

- **Purpose:** Full payments suite
- **Existing:** Yes - expand tools
- **Add:** `stripe.products.create()`, `stripe.prices.create()`, `stripe.checkout.sessions.create()`

### 8.4 Square

- **Purpose:** Payment processing + POS
- **Billing:** Per-transaction
- **Secret:** `square.access_token`
- **Egress Rule:** `$.target.host ~> /connect\.squareup\.com$/`
- **Tools:** `square.payments.create()`, `square.catalog.list()`

### 8.5 Printful

- **Purpose:** Print-on-demand fulfillment
- **Billing:** Per-order
- **Secret:** `printful.api_key`
- **Egress Rule:** `$.target.host ~> /api\.printful\.com$/`
- **Tools:** `printful.orders.create()`, `printful.products.sync()`

---

## Phase 9: Search & Web Scraping (P2)

**Goal:** Enable data gathering.

### 9.1 Tavily

- **Purpose:** AI search API for RAG
- **Billing:** Per-query
- **Secret:** `tavily.api_key`
- **Egress Rule:** `$.target.host ~> /api\.tavily\.com$/`
- **Tools:** `tavily.search()`, `tavily.extract()`

### 9.2 SerpAPI

- **Purpose:** Search engine results scraping
- **Billing:** Per-query
- **Secret:** `serpapi.api_key`
- **Egress Rule:** `$.target.host ~> /serpapi\.com$/`
- **Tools:** `serpapi.search()`, `serpapi.google()`, `serpapi.maps()`

### 9.3 Brave Search

- **Purpose:** Privacy-focused search API
- **Billing:** Per-query
- **Secret:** `brave.api_key`
- **Egress Rule:** `$.target.host ~> /api\.search\.brave\.com$/`
- **Tools:** `brave.web.search()`, `brave.images.search()`

### 9.4 Firecrawl

- **Purpose:** Web scraping at scale
- **Billing:** Per-page
- **Secret:** `firecrawl.api_key`
- **Egress Rule:** `$.target.host ~> /api\.firecrawl\.dev$/`
- **Tools:** `firecrawl.scrape()`, `firecrawl.crawl()`, `firecrawl.map()`

### 9.5 ScrapingBee

- **Purpose:** Web scraping proxy
- **Billing:** Per-request
- **Secret:** `scrapingbee.api_key`
- **Egress Rule:** `$.target.host ~> /app\.scrapingbee\.com$/`
- **Tools:** `scrapingbee.get()`, `scrapingbee.extract()`

---

## Phase 10: Security & Identity (P3)

**Goal:** Enable security workflows.

### 10.1 1Password

- **Purpose:** Secrets management
- **Billing:** Per-user
- **Secret:** `1password.token`
- **Egress Rule:** `$.target.host ~> /my\.1password\.com$/`
- **Tools:** `1password.items.get()`, `1password.vaults.list()`
- **Note:** Moltbot uses this for credentials

### 10.2 Bitwarden

- **Purpose:** Open-source password manager
- **Billing:** Free tier
- **Secret:** `bitwarden.client_id`, `bitwarden.client_secret`
- **Egress Rule:** `$.target.host ~> /api\.bitwarden\.com$/`
- **Tools:** `bitwarden.items.list()`, `bitwarden.items.get()`

### 10.3 Okta

- **Purpose:** Identity management
- **Billing:** Per-user
- **Secret:** `okta.domain`, `okta.api_token`
- **Egress Rule:** Custom domain-based
- **Tools:** `okta.users.list()`, `okta.groups.get()`

---

## Phase 11: Specialized/Niche (P3)

**Goal:** Cover interesting edge cases.

### 11.1 Remotion

- **Purpose:** Programmatic video generation (React-based)
- **Billing:** Per-render minute
- **Secret:** `remotion.api_key`
- **Egress Rule:** Custom
- **Tools:** `remotion.render()`, `remotion.compositions.list()`
- **Note:** User specifically mentioned this

### 11.2 Excalidraw

- **Purpose:** Collaborative whiteboarding
- **Billing:** Free
- **Secret:** N/A (open source)
- **Egress Rule:** N/A
- **Tools:** `excalidraw.export()`

### 11.3 Cal.com

- **Purpose:** Scheduling infrastructure
- **Billing:** Per-booking
- **Secret:** `calcom.api_key`
- **Egress Rule:** `$.target.host ~> /api\.cal\.com$/`
- **Tools:** `calcom.bookings.create()`, `calcom.availability.get()`

### 11.4 Make (Integromat)

- **Purpose:** Workflow automation
- **Billing:** Per-operation
- **Secret:** `make.api_key`
- **Egress Rule:** `$.target.host ~> /hook\.integromat\.com$/`
- **Tools:** `make.scenario.run()`, `make.webhook.trigger()`

### 11.5 Zapier

- **Purpose:** Workflow automation
- **Billing:** Per-zap
- **Secret:** `zapier.api_key`
- **Egress Rule:** `$.target.host ~> /hooks\.zapier\.com$/`
- **Tools:** `zapier.trigger()`

### 11.6 n8n

- **Purpose:** Self-hosted workflow automation
- **Billing:** Free (self-hosted)
- **Secret:** `n8n.api_key`, `n8n.host`
- **Egress Rule:** Custom host-based
- **Tools:** `n8n.workflow.execute()`, `n8n.execution.get()`

---

## Implementation Guide

### For Each Integration:

1. **Create integration file:**

   ```
   apps/os/backend/integrations/<name>/<name>.ts
   ```

2. **Define egress proxy rule:**

   ```typescript
   {
     secretKey: '<name>.api_key',
     egressProxyRule: '$.target.host ~> /<pattern>$/<flags>'
   }
   ```

3. **Register in connector registry:**

   ```
   apps/os/backend/services/connectors.ts
   ```

4. **Add CLI tool:**

   ```
   apps/cli/procedures/tools.ts
   ```

5. **Add daemon router (if needed):**
   ```
   apps/daemon/server/routers/<name>.ts
   ```

### OAuth vs API Key:

- **OAuth (needs refresh):** Plaid, Figma, Asana, Shopify
- **API Key (static):** Most others

### Metered Billing Setup:

Each integration should have:

- Event tracking middleware
- Rate limiting per organization
- Cost estimation in tool responses

---

## Success Metrics

- **50+ integrations** across all phases
- **< 1 day** to add new simple integration (API key-based)
- **< 3 days** to add OAuth-based integration
- **100%** of integrations use egress proxy (no direct secrets in sandboxes)

---

## Potential Name

**Iterate Tools** or **Iterate Integrations** - unified catalog of 50+ APIs that work out of the box with secure metering.
