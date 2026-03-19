# Master Tour API PoC

Proof of concept client for the [Eventric Master Tour](https://www.eventric.com/master-tour-management-software/) REST API.

## API Overview

- **Base URL**: `https://my.eventric.com/portal/api/v5`
- **Auth**: OAuth 1.0a (HMAC-SHA1). Exchange username/password for key/secret via `getkeys`, then sign all subsequent requests.
- **Format**: JSON responses with `{ success, message, data }` shape
- **Docs**: https://my.eventric.com/portal/apidocs

## Quick Start

```bash
cd experiments/master-tour-api
pnpm install

# Exchange credentials for OAuth keys
MASTERTOUR_USERNAME=you@example.com MASTERTOUR_PASSWORD=yourpass node getkeys.mjs

# Run full demo (list tours, get details, crew)
MASTERTOUR_USERNAME=you@example.com MASTERTOUR_PASSWORD=yourpass node demo.mjs
```

## Auth Flow

1. `GET /getkeys?username=X&password=Y&version=10` → returns OAuth consumer key/secret
2. Sign all subsequent requests with OAuth 1.0a (HMAC-SHA1) using that key/secret
3. Include `version=10` param on all requests

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/getkeys` | Exchange credentials for OAuth key/secret |
| GET | `/tours` | List all tours |
| GET | `/tour/:tourId` | Tour details with dates |
| GET | `/tour/:tourId/crew` | Tour crew/personnel |
| GET | `/tour/:tourId/summary/:date` | Daily itinerary summary |
| GET | `/day/:dayId` | Day details |
| GET | `/day/:dayId/events` | Events for a day |
| GET | `/day/:dayId/hotels` | Hotels for a day |
| GET | `/hotel/:hotelId/contacts` | Hotel contacts |
| GET | `/hotel/:hotelId/roomlist` | Room inventory |
| GET | `/event/:eventId/guestlist` | Guest list |
| GET | `/event/:eventId/setlist` | Set list |
| GET | `/company/:companyId/contacts` | Company contacts |
| GET | `/push/history` | Push notification history |
| PUT | `/day/:dayId` | Update day notes |
| POST | `/itinerary` | Create itinerary item |
| PUT | `/itinerary/:itemId` | Update itinerary item |
| DELETE | `/itinerary/:itemId` | Delete itinerary item |
| POST | `/guestlist` | Create guest entry |
| PUT | `/guestlist/:id` | Update guest entry |

## Verified

The `getkeys` endpoint returns **HTTP 401** for invalid credentials (confirmed live 2026-03-19), proving the API is active and correctly gating access.

## Files

- `client.mjs` — Full API client with OAuth 1.0a signing (depends on `oauth-1.0a` npm package)
- `getkeys.mjs` — Standalone script to test credential exchange
- `demo.mjs` — End-to-end demo: auth → list tours → get details → get crew
