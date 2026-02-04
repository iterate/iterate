Spec: Passthrough Billing for LLM Usage with Stripe Advanced Usage-Based Billing
Overview and Objectives
We need to implement a passthrough usage-based billing system for our AI platform. This system will track customers' usage of various AI models (e.g. OpenAI GPT models or Replicate tasks) and charge them according to provider costs (passthrough pricing). We will leverage Stripe's new Advanced Usage-Based Billing to handle multi-dimensional usage data and pricing. The goal is to have a single, unified usage meter with dimensional pricing so that different models (and usage types like tokens vs. compute seconds) can be billed at different rates without creating dozens of separate meters. This spec outlines the design for usage tracking, data aggregation, Stripe configuration, and pricing setup to achieve accurate passthrough billing.
Requirements and Key Points
Usage Metrics to Track: For each AI request, we capture the provider (e.g. openai or replicate), the specific model used, the number of input tokens, output tokens, and any compute time (for non-token tasks). An example log entry:
provider: 'openai', model: 'gpt-4o-mini-2024-07-18', inputTokens: 8, outputTokens: 5, computeSeconds: undefined, organizationId: 'org\_...'
We need to aggregate these usage metrics per customer organization. Each organization’s usage of each model will be tallied for billing.
Dimensions: We will use provider and model as dimensions in the billing system, so usage can be broken down by model (and provider)
. This allows granular pricing based on model or provider attributes (e.g. charging GPT-4 tokens at a different rate than GPT-3.5)
. We will not add extra dimensions for input vs output tokens – instead, we'll treat token usage as a single unit to simplify billing (combining input and output tokens). Compute time (seconds) will be handled similarly as a unit for applicable providers.
Stripe Advanced Usage Billing: We will use Stripe’s advanced usage-based billing (in preview) which supports multi-dimensional usage records and rate cards
. Key Stripe components we will use:
Meter: a usage aggregator that sums up reported usage events. We will create one global Meter (e.g. “AI Usage Meter”) to track all usage events
. This meter will have dimensions for provider and model, allowing Stripe to record usage tagged by those properties. The meter’s aggregation method will be “Sum” (since we sum tokens or seconds)
.
Meter Events: usage records sent to Stripe. Each event includes the meter’s event_name, the customer ID, a value (quantity), and dimension tags. Stripe will aggregate these over the billing period. For example, we will send events like:
{
"event_name": "ai_usage",
"payload": {
"stripe_customer_id": "<cust_id>",
"value": "13",
"provider": "openai",
"model": "gpt-4o-mini-2024-07-18"
}
}
(This indicates a customer used 13 tokens on the GPT-4o-mini model.) Stripe’s meter is configured to interpret stripe_customer_id and value from the payload by default
, and it will also capture the extra keys (provider and model) as dimension values since we specify those dimension keys in the meter setup
.
Rate Card and Rates: We will define a Stripe Rate Card representing our usage-based product. The rate card will contain multiple rates – each rate corresponds to a specific pricing rule for a given dimension combination
. In our case, each model (and provider) will have its own rate (price per unit). Stripe allows up to 500 rates per rate card
, so we can comfortably add a rate for each distinct model we support. The rate card will be part of a Pricing Plan that customers subscribe to (no need for multiple subscription items per model – one plan covers all usage via the rate card).
Batch Usage Reporting (15-minute Intervals): Instead of sending an event for every single API request, we will aggregate usage and report periodically (e.g. every 15 minutes). A batch job will run ~every 15 minutes to collect usage data from the Cloudflare Analytics Engine and push it to Stripe. Batched reporting prevents hitting Stripe's API rate limits and allows us to send one consolidated usage event per org/model per interval (rather than thousands of small events).
Cloudflare Analytics Query: We will use a query on our Analytics Engine to retrieve usage in the last interval. For example:
SELECT
index1 AS organizationId,
blob1 AS provider,
blob2 AS model,
SUM(\_sample_interval _ double1) AS inputTokens,
SUM(\_sample_interval _ double2) AS outputTokens,
SUM(\_sample_interval \* double3) AS computeSeconds
FROM usage_dataset
WHERE timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY organizationId, provider, model;
This yields total input tokens, output tokens, and compute seconds per org per model for the last 15 minutes. (Note: since our system is new and not yet live, we don't need to handle historical backfill or backward compatibility of data formats.)
Data Aggregation Logic: For each record returned by the query, we will determine a usage quantity and corresponding dimension:
If inputTokens/outputTokens are present (for LLM API calls), we compute totalTokens = inputTokens + outputTokens for that model. This total token count will be our usage quantity (units of “tokens”). We are combining input and output tokens into one unit count for simplicity, assuming a unified price per token. (Important: We assume either the provider charges the same for input vs output tokens, or we have chosen to treat them equally for billing. If needed in the future, we could expand dimensions to include token_type to price them differently
, but for now we opt for simplicity.)
If computeSeconds is present (for compute-based tasks like Replicate), the usage quantity is the number of seconds. We will treat “seconds of compute” as the unit for those events. (If both token and compute values exist, we handle them as separate events, but typically a given provider’s usage will be one type or the other.)
Unit consistency: Stripe expects usage values as integers (in string form)
. If we have fractional seconds, we will convert to a suitable integer unit (e.g. milliseconds or round up seconds) to avoid decimals in usage reports. For example, 12.5 seconds might be reported as “12500” milliseconds if our pricing is per millisecond, or as “13” seconds if rounding – this must align with how we define the price per unit in Stripe. We will choose units such that pricing remains accurate and no significant rounding error accumulates.
Idempotency and No-Duplicates: The batch job must ensure it doesn’t double-count usage if it overlaps intervals. We will likely configure the Stripe meter for pre-aggregated hourly ingestion, or track the last timestamp processed. If using pre-aggregated mode on the meter, sending multiple events in the same hour will cause Stripe to only use the latest event’s value for that hour
. Alternatively, we ensure our queries cover discrete non-overlapping intervals (e.g. each run processes a distinct 15-min window) and pass a unique identifier for each meter event (like <org>-<model>-<timestamp>) to prevent duplicates
. For safety, we can use the query timestamp range and organization/model as part of an idempotency key.
Stripe Meter Setup: We will create the Meter via Stripe API or Dashboard with the following configuration:
Display Name: e.g. "AI Usage".
Event Name: e.g. ai_usage (this is the identifier used when reporting events to Stripe)
.
Aggregation Method: Sum (sum up all usage values in the period)
.
Customer Mapping: use the default mapping of stripe_customer_id from event payload to Stripe Customer (so Stripe knows which customer the usage is for)
.
Value Key: use the default value key in payload to read the usage amount
.
Dimensions: configure two dimensions – provider and model – for this meter (via Advanced settings)
. These tell Stripe that usage events may include these keys, which can be used for analytics and pricing differentiation. By tagging usage with these dimensions, we unlock the ability to “granularly price usage based on a combination of attributes” (for example, charging different rates for different models)
. Some example dimensions given by Stripe include LLM model, token type, region, etc
, which aligns with our use-case.
Stripe Rate Card and Pricing Plan: We will create a Rate Card under Stripe’s advanced pricing plan system. This rate card will define how usage is charged per unit for the various models. Key steps and structures:
Pricing Plan: Create a Pricing Plan (e.g. “AI Passthrough Plan”) in Stripe (via API or Dashboard). This plan will be a container for our usage charges (the rate card). We might not have any fixed fee or credits initially, just the usage-based component. The plan is what customers will subscribe to (likely one plan for all customers on usage billing).
Rate Card: Attach a Rate Card component to the pricing plan. Configure the rate card’s service interval and currency. For example, service interval = 1 month (meaning usage is measured monthly for billing) and billing interval could also be monthly (so invoices go out monthly). We’ll use USD as currency (or the relevant currency).
Metered Items and Rates: For each unique billable model (and provider) combination, we will define a rate in the rate card. Each rate corresponds to a metered usage item with a specific price. We will link these rates to our single Meter created above. Stripe allows multiple rates on one meter
, distinguished by dimensions or metered item definitions. Our approach:
Metered Item per Model: We will create a Metered Item for each model or category. A metered item represents “the specific item the customer is paying for, such as an LLM model”
. In our case, examples might be “OpenAI GPT-4 Tokens” or “Replicate StableDiffusion Compute”. Each metered item is associated with the common AI Usage meter, but will be used to apply a price for events matching that item’s dimensions.
Dimension Filters: When configuring each metered item / rate, we will specify which dimension values it applies to. For example, for a rate called "GPT-4 (OpenAI) tokens", we set it to use the AI Usage meter and apply when provider = openai and model = gpt-4o-mini-2024-07-18 (assuming that is our internal code for GPT-4 model). Stripe’s advanced pricing allows defining rates that vary based on the dimension properties of the usage
. This means the system can automatically apply the correct rate when usage events with those dimension values are processed. In effect, this acts like a filter ensuring that the GPT-4 rate only charges for usage events tagged with that model. We will do this for each distinct model we want to price differently.
Pricing Units: Each rate will include the price per unit and unit configuration. Since many provider costs are tiny (e.g. fractions of a cent per token), we’ll leverage Stripe’s “packages of units” feature to avoid rounding issues
. For example, if OpenAI charges $0.03 per 1,000 tokens, we can configure the rate as Package of 1000 units = $0.03 (USD). That means Stripe will charge $0.03 for each 1000 tokens used. If a customer uses, say, 500 tokens, we have options: we can allow partial packages or choose to round up. In Stripe, we can set partial package handling to round up or down
. To match exact passthrough cost, we might allow partial packages (so charges scale linearly with actual usage) – Stripe would then calculate cost proportionally, or we can choose a sufficiently small unit (like 1 token = $0.00003, though Stripe typically only allows two decimal places, hence using package is cleaner). We will configure each model’s rate such that the smallest billable unit and price reflect the provider’s pricing as closely as possible.
Compute Seconds Pricing: Similarly, for compute-based usage (e.g. Replicate), if the provider charges e.g. $0.001 per second of compute, we could set a rate like “Compute Second – Model X” with 1 unit = $0.001. If that’s too granular for Stripe’s currency precision, we might set 1000 seconds = $1.00 (just an example) or use milliseconds as units. The exact configuration will be based on the provider's rate card. The main point is each distinct usage type gets a corresponding rate mapping usage units to a price.
We will list out all current models/providers and their cost per unit in a config or table (the “rate card definition”). This will include OpenAI models (each model’s per-token cost), any Anthropic/Cohere models if applicable, and Replicate models or compute ($ per second). This list can be maintained easily so that if providers change prices or new models are added, we can update the rates. Since we are doing pure passthrough initially, the price per unit will exactly match the provider’s price. However, we will keep the system flexible to markups or adjustments – for example, by maintaining our own rate multipliers or adding a fixed overhead if needed in the future. (Initially, though, "passthrough" means 1 unit billed at exactly our cost from provider.)
Example Rate Entries:
OpenAI GPT-4 (example) – Metered item: “GPT-4 Tokens (OpenAI)”, uses AI Usage meter, applies when provider=openai AND model=gpt-4o-mini-2024-07-18. Pricing: $0.06 per 1000 tokens (if GPT-4 costs $0.06 per 1K output tokens and $0.03 per 1K input, we might simplify to one blended rate or choose the higher to be safe – since we opted not to separate input vs output tokens, we likely use the higher rate for all tokens on this model to ensure we cover cost). Note: Alternatively, we might actually separate GPT-4 into two rates internally (one for input tokens at $0.03/1K and one for output at $0.06/1K) by treating token_type as a dimension – but per earlier requirement, we decided against multi-dimension for token type. The simpler approach is to charge all GPT-4 tokens at the higher completion rate; this slightly overcharges prompt tokens but ensures we don’t undercharge on completions. This trade-off should be discussed, but given the complexity it avoids, we proceed with one rate per model for now.)
OpenAI GPT-3.5 – e.g. $0.002 per 1K tokens (just example pricing).
Custom GPT-4 Mini (July 2024) – The example model gpt-4o-mini-2024-07-18 suggests a custom or fine-tuned model; its rate would be whatever OpenAI charges for that model’s endpoint (likely similar to GPT-4 or something, which we have from the provider’s pricing). We include a rate for it.
Replicate Stable Diffusion – If charged per second of GPU, e.g. $0.0004 per second, we set perhaps 1 second = $0.0004 (or 1000 seconds = $0.40 to avoid tiny decimals). This rate applies when provider=replicate AND model=stable-diffusion-v1 (for example). If replicate has different models with different pricing, each needs its own rate. If many replicate models share the same pricing (or if we standardize e.g. all replicate compute at $X per second), we could use a single rate for all replicate usage by grouping dimension conditions (e.g. provider=replicate with any model -> one price). However, to be precise, it’s safer to price per model if costs vary. We can compress identical prices by reusing the same rate for multiple dimension values if Stripe supports an “OR” (not sure if UI allows grouping models; if not, we just duplicate rates as needed).
Stripe Subscription: Once the pricing plan (with the rate card) is set up, each customer organization’s Stripe customer will be subscribed to this plan. This subscription links them to the usage meter and rates. All usage events we send with a given stripe_customer_id will accumulate under their subscription. At the end of each billing period (monthly, presumably), Stripe will automatically generate an invoice with line items for each metered item used
. For each model the customer used, there will be a line item calculating the cost: e.g. “GPT-4 Tokens – 15,000 units at $0.00006 each = $0.90” (example). Because we have multiple rates in one plan, the invoice can list multiple usage charges for different models, all under the one subscription. This satisfies our goal of one subscription per customer rather than one per model.
Passthrough Pricing and Customization: The billing rates will initially match the provider’s prices exactly (passthrough). We will verify the current pricing from each provider: e.g. OpenAI’s price per 1K tokens for each model, Replicate’s price per second for each model or hardware type, etc., and use those in the Stripe rate card. These should be kept in sync with any provider changes. To make this maintainable:
We will centralize the rate definitions in our codebase (for instance, a configuration object or database table listing each provider:model -> costPerUnit). The Stripe meter and rate card will be configured according to this data. For example, we might auto-generate the BILLING_METERS or metered items from this config (in the code today, we have a meters.generated.ts or similar that could be populated from such data).
If we need to adjust pricing (e.g. add a margin or special discounts), we can update this config and push a new rate to Stripe or adjust the price. Advanced Stripe billing allows updating rates or adding new ones without disrupting existing subscriptions (adding new rates does not force a new plan version by default
, which is convenient for rolling out new model prices)
. We should ensure adding a new model’s rate is a straightforward operation (possibly via the Stripe API or dashboard).
Versioning and Migration: Because all customers are on the same pricing plan, if we change a price for an existing model, we might create a new version of the rate card or plan depending on Stripe’s requirements. However, in passthrough scenario, price changes would only occur when the provider changes their price. In such a case, ideally we want to update everyone’s rate (since it’s passthrough). Stripe’s advanced pricing can either migrate existing subscriptions to the new price automatically or keep grandfathered pricing. We likely want to update everyone, which Stripe supports by making the new rate the default and applying it (since we’re not doing custom contracts per customer). We should document a procedure for updating rates: e.g. via the Dashboard or API, update the rate card’s rate or add a new version, and ensure all subs move to it.
System Workflow Summary:
Usage Logging: As AI requests are served in our system (e.g. via an egress proxy), we log usage events (provider, model, tokens, seconds, orgId). This data flows into Cloudflare Analytics Engine essentially in real-time.
Periodic Aggregation Job: Every 15 minutes, our backend service runs a job (could be a scheduled function or cron) that queries the Analytics Engine for usage in the last 15 minutes per org/model. For each result:
Determine the stripeCustomerId for the organization (lookup from our DB billing accounts table).
Prepare a Stripe meter event for that usage. We use the AI Usage meter’s event_name and include the customer, value, and dimension keys. For instance, if Org123 used 500 tokens on GPT-3.5 and 300 tokens on GPT-4 in that interval, we send two events: one with value "500", provider: openai, model: gpt-3.5 and another with "300", provider: openai, model: gpt-4. If Org123 also used 10 seconds on a Replicate model, that’s a third event with provider: replicate, model: X, value: 10.
We include a unique identifier for each event (idempotency key) such as ${organizationId}-${model}-${intervalStartTime} to avoid replaying data. If the job fails mid-way, it can safely retry sending the same events without double billing (Stripe will ignore duplicates with same identifier).
Log the usage report action for audit.
Stripe Processing: Stripe receives these meter events and records them against our meter. Because the meter has dimensions, the usage is tracked segmented by model. The advanced rate card recognizes usage with particular dimension values and assigns the appropriate rate. This means Stripe accumulates separate subtotals per model (per rate).
Invoice Generation: At the end of the billing period (e.g. month-end), Stripe will create an invoice for each subscription. The invoice will include a line item for each rate where usage > 0. e.g. “GPT-4 tokens: 12,000 units × $0.00006 = $0.72”, “GPT-3.5 tokens: 45,000 units × $0.000002 = $0.09”, “Replicate StableDiffusion: 50 sec × $0.0004 = $0.02” (numbers just illustrative). The sum of these is charged to the customer’s payment method on file.
Customer Visibility: Customers can be shown a breakdown of their usage and costs. Because we’re tagging usage by model and provider, we can present this in our UI and it will match the invoice. (Stripe’s API also allows querying usage records and invoice line items by dimension, etc., which could be used for a detailed usage dashboard if needed
.)
Cloudflare Analytics Engine Integration: We rely on Cloudflare’s Analytics Engine as the source of truth for usage counts. We need to ensure that the data is accurate and timely: the 15-minute window is a trade-off between real-time billing and performance. A slight delay (billing latency of up to 15 minutes) is acceptable. If the Analytics Engine provides slightly delayed data, our system will still catch it on the next run. We should monitor this process and set up alerts for any discrepancies (e.g. if the query fails or returns unusually high values, etc.). Over time, we may adjust the interval (perhaps to 5 minutes or 1 hour) depending on load and Stripe API limits. For now, 15 minutes is a reasonable batch size to keep Stripe events below rate limits and invoices current.
Testing and Verification: Since this is a new implementation (not yet live), we should thoroughly test it in Stripe’s test mode or preview environment. We will:
Simulate usage for a test organization across multiple models and ensure the meter events are recorded correctly. Verify in Stripe Dashboard that the meter is receiving events with dimension tags, and that the aggregated totals match what we sent.
Generate a test invoice (Stripe allows using test clocks to simulate end-of-period)
to see that the line items and pricing are correct. For example, if we report 100 tokens for GPT-4 and 200 tokens for GPT-3.5, does the invoice show the correct charges per our configured rates? This will confirm the rate card is set up correctly with dimensions.
Adjust and iterate on configuration (especially unit packaging) if the invoice shows rounding or pricing issues. For instance, if Stripe rounded up small usage due to package settings and that’s not desired, we might switch to smaller packages or individual units. Our goal is that the amount charged by Stripe for a given usage exactly equals the cost we incur from the provider for that usage (passthrough). Minor discrepancies (like $0.01 off due to rounding) should be minimized.
Test edge cases: zero usage (should result in $0 charge), extremely high usage (ensure our system can handle large numbers of tokens – Stripe should be fine summing them, but we should confirm no overflow or performance issues in our analytics query or code), and usage spanning multiple models.
Deployment and Maintenance:
Once tested, we will deploy the batch job as a background worker. We’ll ensure the Stripe API keys (with the required 2026-01-28.preview Stripe API version for advanced billing) are properly configured.
We will monitor the job logs and Stripe dashboards especially for the first billing cycles. Any errors in sending meter events (network issues, Stripe downtime) should be caught and retried. We might implement a small buffer so that if a 15-min batch fails, we try again shortly after, or include the 15-min window in the next run to catch missed data (taking care with idempotency).
Adding New Models/Providers: If we onboard a new model or provider, we must update our pricing config and add a rate for it in Stripe before usage starts (to ensure those events are priced). If an event comes in for a model with no corresponding rate, Stripe might either default to some catch-all rate if configured or just accrue usage that doesn’t translate to a charge (which we want to avoid). Ideally, our system could detect an unknown model usage and alert us. In practice, we control which models are available, so we will pre-configure their pricing.
Scaling Considerations: Stripe’s advanced usage can handle hundreds of rates and many events. We expect possibly many organizations and various models, but within Stripe’s limits (500 rates per meter, which is plenty now). Cloudflare’s analytics can aggregate efficiently. We should ensure our query is optimized (using indexes if available on organizationId, etc., though the sample uses index1/blob1 which likely are indexed fields). If usage volume grows, we could consider increasing batch frequency or splitting by provider to manage data sizes. However, Cloudflare’s engine is quite capable of time-series aggregation, so 15-min window grouping by org and model should be fine.
Cost Monitoring: Since this is passthrough, our revenue from usage should equal the provider costs (assuming no markup). We can periodically reconcile to ensure we aren’t under/over-charging: for example, sum up Stripe invoice amounts vs. our provider billing. Any mismatch might indicate a misconfigured rate or an unaccounted dimension (e.g. if we forgot to charge for output tokens separately and it was significant). We should be prepared to adjust rates if needed to true-up.
Conclusion
In summary, this design uses Stripe’s advanced usage-based billing with a single meter and multi-dimensional rate card to implement flexible, per-model usage billing. The dimensions provider and model on the meter allow us to charge different rates for different models under one unified meter
. We will batch-report usage from our Cloudflare Analytics data every 15 minutes, ensuring Stripe stays up-to-date with customer usage without performance issues. Prices are set to mirror provider costs (passthrough), but the system is built such that updating pricing or adding new models is straightforward via the Stripe rate card (no need for new meters per model). This approach avoids the “billion meters” problem by leveraging Stripe’s rate card dimensions, while still giving us fine-grained control over pricing per model. Once implemented, our customers will be billed accurately for their AI usage, and our billing infrastructure will be scalable and maintainable under the new Stripe Billing model. Sources: Stripe Advanced Usage-Based Billing documentation was referenced for concepts of meters, dimensions, and rate cards
. These confirm that we can tag usage by model and vary pricing accordingly. The Cloudflare Analytics query and usage log format are based on our internal logging. The plan aligns with Stripe's recommended usage-based billing practices for AI services (e.g. measuring tokens as a metered unit)
. This spec will guide the coding agent in implementing the solution end-to-end.
Citations

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure
GitHub
usage-reporter.ts

https://github.com/iterate/iterate/blob/588e4ffe1a9c0006a1bc93b88cdb4a53d2a08fe9/apps/os/backend/integrations/stripe/usage-reporter.ts#L23-L29

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

How advanced usage-based billing works - Stripe Documentation

https://docs.stripe.com/billing/subscriptions/usage-based/advanced/about

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans

docs.stripe.com

https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure
All Sources
