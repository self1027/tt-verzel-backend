# Auction search and filters

`GET /auctions` is public. `GET /auctions/mine` accepts the same query options
and requires an authenticated AUCTIONEER; its results always belong to that user.
Search uses stored product snapshots and needs no external catalog requests.

| Parameter | Meaning |
| --- | --- |
| `q` | Case-insensitive literal substring of the local snapshot title; `%`, `_`, and backslash are ordinary characters. Empty text matches every title. |
| `lifecycleState` | `SCHEDULED`, `LIVE`, `FINALIZING`, `CANCELLED`, `SETTLED`, or `CLOSED_NO_BIDS`. |
| `minPriceCents`, `maxPriceCents` | Inclusive current-price bounds, canonical decimal strings from `0` through `9223372036854775807`. Minimum must not exceed maximum. |
| `sort` | `price_asc`, `price_desc`, `endsAt_asc`, or `endsAt_desc`; all ties use ascending auction UUID. |
| `limit` | Page size from 1 to 100, default 30. |
| `skip` | Legacy zero-based offset from 0 through 2147483647, default 0. |
| `page` | Optional one-based page; offset is `(page - 1) * limit` and cannot exceed 2147483647. Cannot appear together with `skip`, even `skip=0`. |

Current price is the amount of the auction's current bid, or its starting amount
when no valid own-auction current bid exists. A bid belonging to another auction
cannot affect the price. Price comparisons and ordering run in PostgreSQL with
BIGINT precision; clients must avoid converting cent strings to JavaScript Number.
There is no additional current-price response field.

Example:

```text
GET /auctions?q=phone&lifecycleState=LIVE&minPriceCents=10000&maxPriceCents=100000&sort=price_asc&limit=10&page=2
```

Filters combine with AND and run before pagination and counting. `total` includes
all matching rows. Rows and total share one read-only REPEATABLE READ transaction
and one database `asOf` for lifecycle evaluation.

The response retains `{ auctions, total, limit, skip, asOf }`; `page` is translated
to `skip` and is not echoed. With no sort, ordering remains `createdAt DESC, id ASC`.
With no lifecycle filter, terminal auctions remain included. Unknown parameters,
repeated values, invalid enums, malformed amounts, inverted bounds, and pagination
overflow return HTTP 400 with the existing validation-error format.
