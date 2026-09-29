# listening-ear

A working, self-hosted realtime channel service:
a Node.js WebSocket server (public/private/presence channels, client events,
a signed REST "trigger" API) plus a dependency-free browser client SDK with
an event-channel API (`subscribe`, `bind`, presence `members`, etc).

It's intentionally simplified compared to managed realtime platforms (single
in-memory process, no clustering/webhooks/queues) but implements the real
protocol shapes and the real HMAC auth scheme, so it's a solid base to
extend or to learn how realtime channel systems work under the hood.

## Architecture

```
  Browser (listening-ear.js)  <--WebSocket-->  server/src/server.js  <--HTTP POST-->  Your backend
        |                                          |                                   |
   subscribe/bind                          channelManager.js                   auth-backend.js
   presence members                        (in-memory channel &                (signs private/
                                             presence state)                     presence subscriptions)
```

- **`server/`** — the realtime server. WebSocket endpoint at `ws://host:port/app`,
  plus an HTTP endpoint `POST /apps/:appId/events` your backend calls to push
  events out to subscribers (this is how you go from "user posted a comment"
  in your DB layer to "everyone viewing that page sees it instantly").
- **`client/listening-ear.js`** — drop into any web page with a `<script>` tag.
  No build step, no dependencies.
- **`example/`** — a runnable demo: a presence-channel chat page, an example
  auth backend, and an example server-side trigger script.

For an application, install the client package from `client/` (or publish it
to your private npm registry) and use `new ListeningEar(appKey, options)`.
The wire protocol is modeled on Pusher's (`pusher:*` event names, same HMAC auth scheme), which makes it a useful reference for how hosted realtime services work.

## Channel types

| Prefix       | Who can subscribe                  | Notes                                      |
|--------------|-------------------------------------|---------------------------------------------|
| *(none)*     | Anyone                              | Public channels, no auth needed             |
| `private-`   | Authenticated users your backend allows | Requires a signed `auth` token         |
| `presence-`  | Same as private                     | Also tracks & broadcasts member list        |

Only `private-`/`presence-` channels allow **client events** (`client-*`),
which are relayed peer-to-peer through the server without hitting your
backend — useful for things like "user is typing…" indicators.

## Running it

```bash
# 1. Start the realtime server
cd server
npm install
cp .env.example .env
npm start
# -> ws://localhost:6001/app, REST trigger at :6001/apps/app-id/events

# 2. Start the example auth backend (needed for the presence-channel demo)
cd ../example
npm install express cors dotenv   # if not already installed at the repo root
node auth-backend.js
# -> http://localhost:6002/listening-ear/auth

# 3. Open example/index.html in a browser (e.g. `open example/index.html`
#    or serve it with any static file server)

# 4. Trigger an event from a separate "backend" process — you'll see it
#    show up live in the browser tab you opened:
node trigger-event.js
```

## Production packaging

Run the realtime server as a single container. The auth endpoint remains part
of your application because it owns user authentication and channel access.

```bash
cd server
docker build -t listening-ear-server .
docker run --rm -p 6001:6001 -v listening-ear-data:/app/data \
  -e DATABASE_PATH=/app/data/listening-ear.sqlite \
  listening-ear-server
```

The container exposes `GET /health`, WebSockets at `/app`, and the signed
trigger API at `/apps/:appId/events`. Put it behind HTTPS/WSS termination and
configure the browser SDK with the public hostname, `forceTLS: true`, and your
production auth endpoint. Never expose `APP_SECRET` to the browser.

With SQLite enabled by default, the server also provides the Listening Ear
control console at `/control/`. Users can register, create applications, view
public keys, and rotate secrets. Each WebSocket client sends its application
key automatically, so applications stored in SQLite use separate channel and
REST credentials. Persist `/app/data` in production.

This implementation keeps channel and presence state in memory. Run one
replica in production, or replace `ChannelManager` with a shared Redis-backed
implementation before scaling horizontally. Store `APP_SECRET` in your
platform's secret manager rather than in an image or committed `.env` file.

## Tests

Run the server and client test suites independently:

```bash
cd server && npm test
cd ../client && npm test
```

The tests cover channel and presence lifecycle behavior, auth signature
validation, and the published client module surface.

## Deploying the server to Heroku

Deploy the `server/` directory as the Heroku app. Heroku supports WebSockets,
so the same web dyno serves the dashboard, REST API, and `/app` WebSocket path.

```bash
heroku login
heroku create listening-ear-server
heroku addons:create heroku-postgresql:essential-0 --app listening-ear-server
git subtree push --prefix server heroku main
```

After deployment, open the control console at:

```text
https://YOUR-APP.herokuapp.com/control/
```

Configure the client with the Heroku hostname:

```js
const client = new ListeningEar('your-app-key', {
  wsHost: 'YOUR-APP.herokuapp.com',
  wsPort: 443,
  forceTLS: true,
  authEndpoint: 'https://your-api.example.com/listening-ear/auth'
});
```

The server uses Heroku Postgres automatically when Heroku provides
`DATABASE_URL`, so users, app keys, secrets, and analytics persist in the
managed database. Local development continues to use SQLite through
`DATABASE_PATH`.

The included `app.json` provisions the `heroku-postgresql:essential-0` add-on.
For a larger production workload, choose a larger Heroku Postgres plan.

## How auth works (private/presence channels)

1. Client wants to subscribe to `private-orders-42` or `presence-room-1`.
2. Client SDK POSTs `{ socket_id, channel_name }` to your `authEndpoint`
   (you implement this — see `example/auth-backend.js`).
3. Your backend checks the current user is allowed on that channel, then
   signs `HMAC_SHA256(appSecret, "${socketId}:${channel}[:${channelData}]")`
   and returns `{ auth: "appKey:signature", channel_data? }`.
4. Client SDK sends that `auth`/`channel_data` in its protocol subscribe
   message; the server verifies the signature using the same secret before
   allowing the subscription. The app secret never reaches the browser.

## Triggering events from your backend

`POST /apps/:appId/events?auth_key=...&auth_timestamp=...&auth_signature=...`
with body `{ name, channels: [...], data }`. The query signature is an
HMAC over the method, path, sorted query params, and an MD5 of the body —
see `server/src/auth.js#signApiRequest` / `#verifyApiRequest`. This mirrors
The compatible REST auth scheme (simplified: no `auth_version` nuance beyond
what's needed here).

## Client SDK API

```js
const client = new ListeningEar('app-key', {
  wsHost: 'localhost', wsPort: 6001, authEndpoint: '/listening-ear/auth',
});

const channel = client.subscribe('presence-room-1');
channel.bind('new-message', (data) => { /* ... */ });
channel.bind('pusher:member_added', ({ id, info }) => { /* ... */ });
channel.trigger('client-typing', { user: 'ada' }); // client event

client.connection.bind('state_change', (state) => console.log(state));
client.unsubscribe('presence-room-1');
client.disconnect();
```

## What's simplified vs. managed realtime services

- Single process, in-memory state — no horizontal scaling (would need
  Redis pub/sub or similar to share channel state across server instances).
- No webhooks, no watchlist/user-authentication events, no channel
  existence/occupied events beyond presence.
- REST auth is a workable HMAC scheme but not byte-for-byte identical to
  managed provider signature specifications.
- No TLS termination built in — put this behind a reverse proxy (nginx,
  Caddy) with TLS in any real deployment, and set `forceTLS: true` /
  use `wss://` on the client.

## Where to take it next

- Swap the in-memory `ChannelManager` for a Redis-backed one to run
  multiple server instances behind a load balancer.
- Add channel occupied/vacated webhooks to notify your backend.
- Add rate limiting / per-app connection limits.
- Persist presence member `user_info` lookups from your real user model.
