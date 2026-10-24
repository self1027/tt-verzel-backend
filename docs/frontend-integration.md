# Frontend integration handoff

The backend serves HTTP and Socket.IO from the same origin. Local defaults:
`http://localhost:3000` for the API, `http://localhost:5173` for a Vite frontend.
The frontend and hosting/deployment remain outside this backend delivery.
The maintained HTTP contract is [`openapi.json`](openapi.json).

Set frontend `VITE_API_URL=http://localhost:3000` and backend
`CORS_ORIGINS=http://localhost:5173`. `CORS_ORIGINS` is a comma-separated list of
exact allowed HTTP(S) origins. For Vercel, configure the backend with the actual
frontend origin such as `https://your-project.vercel.app`; configure the frontend
with the HTTPS backend URL. Add preview origins explicitly when needed. These
settings document integration; they do not deploy either application.

POST `/auth/login` with `{ "email": "bidder1@verzel.local", "password": "..." }`.
Use the configured seed password, then attach `Authorization: Bearer <accessToken>`
to protected requests. The login result contains `accessToken`, `tokenType`,
`expiresIn`, and `user`. GET `/auth/me` restores current user state. A 401 means
the session must be renewed; a 403 means the current role cannot perform the
operation. There is no registration or administrator endpoint.

| Screen/action | Endpoint and access |
| --- | --- |
| Browse/search catalog | GET `/catalog/external`, `/catalog/external/search?q=...`, `/catalog/categories`; Bearer |
| Import product | POST `/catalog/import/{externalNumericId}`; AUCTIONEER; empty body |
| Stored products | GET `/catalog/products`, `/catalog/products/{snapshotUuid}`; Bearer |
| Public lots/details | GET `/auctions`, `/auctions/{uuid}`; public |
| Own lots | GET `/auctions/mine`; AUCTIONEER |
| Publish/edit/cancel | POST `/auctions`, PATCH `/auctions/{uuid}`, POST `/auctions/{uuid}/cancel`; owner AUCTIONEER |
| Balance/history | GET `/wallet`, `/wallet/transactions`; Bearer |
| Simulated deposit | POST `/wallet/deposits`; BIDDER; `Idempotency-Key` header and `{ "amountCents": "10000" }` |
| Bid/history | POST or GET `/auctions/{uuid}/bids`; POST requires BIDDER, key header, amount body; GET is public |
| Own bids | GET `/auctions/bids/mine`; BIDDER |
| Audit | GET `/auctions/{uuid}/audit`, `/auctions/{uuid}/audit/events`; public |
| Share receipt | GET `/auctions/{uuid}/receipt`; public after financial settlement |

All cents and sequences travel as decimal strings. Use `BigInt` for arithmetic
and convert back to strings before JSON serialization. Display currency without
passing large integer cents through JavaScript Number. Generate one idempotency
key per intended deposit/bid, keep it across network retries, and use a new key
for a different amount. Successful bid/deposit requests return 201, including
idempotent replay. Render `error.code` from error responses; preserve a friendly
message for validation failures and financial conflicts.

Auction search accepts `q`, `lifecycleState`, `minPriceCents`, `maxPriceCents`,
`sort`, `limit`, and either one-based `page` or legacy `skip`. Example:
`/auctions?q=mascara&lifecycleState=LIVE&minPriceCents=1000&sort=price_asc&limit=10&page=1`.
Unknown/repeated keys and `page` together with `skip` fail validation. Title
search is a literal case-insensitive substring of stored snapshots, including
literal `%`, `_` and backslash. Price means current own-auction bid amount or
starting amount. Range bounds are inclusive canonical nonnegative BIGINT strings.
Sort choices are `price_asc`, `price_desc`, `endsAt_asc`, `endsAt_desc`; ties use
ascending UUID. Default is createdAt descending then UUID ascending, including
terminal lots. Response remains `{ auctions, total, limit, skip, asOf }`.

The auction view exposes `currentBidId`; get `/auctions/{uuid}/bids` for
`currentBid`, `endsAt`, status and `asOf`. Minimum bid is `startingBidCents` with
no leader, otherwise current amount plus `minIncrementCents`. A leading bidder
cannot rebid. LIVE means startsAt <= server time < endsAt and PUBLISHED status.
An accepted bid in the final two minutes adds two minutes to the existing
deadline. Treat all server responses as authoritative, including updated endsAt;
derive countdowns from `asOf` and refresh after conflicts.

Use Socket.IO client v4 against the API origin with default `/socket.io` path:

```js
import { io } from 'socket.io-client';
const api = import.meta.env.VITE_API_URL;
const socket = io(api);
const refresh = () => Promise.all([
  fetch(`${api}/auctions/${auctionId}`).then(r => r.json()),
  fetch(`${api}/auctions/${auctionId}/bids`).then(r => r.json()),
]); // Apply the returned snapshots to your UI; include a protected wallet fetch when signed in.
socket.on('connect', () => {
  socket.emit('auction:join', { auctionId }, ack => {
    if (ack.ok) void refresh();
  });
});
for (const name of ['bid:accepted', 'auction:extended', 'auction:ended',
  'auction:settled', 'auction:cancelled', 'auction:integrity-warning']) {
  socket.on(name, () => { void refresh(); });
}
// On screen cleanup: socket.emit('auction:leave', { auctionId }, ack => {});
// Then remove handlers or disconnect this screen's socket.
```

Set `api` to your API base URL and `auctionId` to the current auction UUID.
Subscriptions are public and normalized to lowercase UUID. The server joins
`auction:<uuid>` internally; emit `auction:join` with the object above, rather
than sending a room name. Acknowledgment is `{ ok: true }` or
`{ ok: false, error: 'INVALID_AUCTION' | 'ROOM_LIMIT' }`. Each connection may
subscribe to 100 distinct rooms; leave unused rooms. Reconnect establishes a new
subscription lifecycle, so rejoin and fetch authoritative REST snapshots on
every `connect`. Add a modest polling fallback while the screen is visible.

Socket events are public hints after commit, with `auctionId` in their payload.
They are not a wallet feed or a durable transaction receipt. Delivery can be
missed during reconnect, and there is no multi-instance Redis adapter. Coalesce
refreshes and ignore stale overlapping fetches. Keep user credentials and wallet
data in authenticated HTTP flows.

When a lot becomes FINALIZING, the automatic settlement worker waits for an
independently verified audit proof and rechecks it under financial locks. Pending
anchoring or witness outage can delay settlement; do not show the winner's payment
as complete merely because the countdown ended. No-bid auctions become
`CLOSED_NO_BIDS`; winning auctions become `SETTLED`. There is no frontend manual
settle endpoint.

Audit `/audit` returns `VERIFIED`, `PENDING_ANCHOR`, `TAMPERED`, or
`VERIFICATION_UNAVAILABLE` (HTTP 503 for unavailable verification). VERIFIED means
the current local chain and operational replay match the independent latest
witness head. Pending does not mean verified. `/audit/events` uses `after` as an
exclusive sequence cursor and labels successful pages `EVENT_PAGE_ONLY`; a page
of hashes does not establish witness verification. A tamper warning needs an
incident state in the UI, never an automatic seller refund/cancel action.

Receipt returns `{ receipt }` with auction/product snapshot, canonical amount,
endsAt, settledAt, settlementId, pseudonymous winningBid, auditUrl and receiptUrl.
It returns 404 before financial settlement, including no-bid closure, and 409
for inconsistent financial records. Treat relative links as relative to the API
origin. The public receipt does not disclose email, bidder user ID, wallet IDs or
the internal receipt token. Its existence is separate from witness verification.

Seller cancellation is limited to unexpired PUBLISHED lots without bids. There
is no seller undo of a winning bid, administrator cancellation/refund flow, or
automatic cancellation of a TAMPERED incident. The optional demo seed creates an
initially LIVE lot and pristine-wallet simulated deposits; restarts preserve
existing dates and balances. See [`demo-seed.md`](demo-seed.md).
