# listening-ear-client

Dependency-free browser client for [Listening Ear](https://github.com/Tagong40/listening-ear), a self-hosted realtime WebSocket server with public, private, and presence channels.

- No dependencies, no build step, about 300 lines
- Public, private, and presence channels
- Client events (`client-*`) for things like typing indicators
- Automatic reconnect with backoff, and channels are re-subscribed after reconnecting

## Install

```bash
npm install listening-ear-client
```

```js
import ListeningEar from 'listening-ear-client';
// or
const ListeningEar = require('listening-ear-client');
```

Or load it with a script tag, which defines a global `ListeningEar`:

```html
<script src="https://unpkg.com/listening-ear-client@2/listening-ear.js"></script>
```

## Quick start

```js
const client = new ListeningEar('YOUR_PUBLIC_APP_KEY', {
  wsHost: 'realtime.example.com',
  wsPort: 443,
  forceTLS: true,
});

const channel = client.subscribe('products');

channel.bind('product-updated', (product) => {
  console.log('Product changed:', product);
});
```

Your backend sends `product-updated` events through the server's signed REST API (`POST /apps/:appId/events`). See the [main README](https://github.com/Tagong40/listening-ear#triggering-events-from-your-backend).

The app key is public and safe to ship to browsers. **Never put the app secret in frontend code.**

## Options

`new ListeningEar(appKey, options)`

| Option | Default | Description |
|---|---|---|
| `wsHost` | `'localhost'` | Server hostname |
| `wsPort` | `6001` | Server port. Use `443` for a server behind HTTPS (e.g. Heroku) |
| `forceTLS` | `false` | Connect with `wss://`. Use `true` in production |
| `wsPath` | `'/app'` | WebSocket path on the server |
| `authEndpoint` | `'/listening-ear/auth'` | Your backend endpoint that signs private and presence subscriptions |
| `authHeaders` | `{}` | Extra headers sent to `authEndpoint`, e.g. `{ Authorization: 'Bearer ...' }` |
| `maxReconnectDelay` | `10000` | Maximum wait between reconnect attempts, in ms |

The client connects as soon as it's created.

## Channels

| Channel name | Who can subscribe | Auth required |
|---|---|---|
| `products` | Anyone with the app key | No |
| `private-user-42` | Users your backend approves | Yes |
| `presence-room-1` | Users your backend approves; tracks who's online | Yes |

### Public channels

```js
const channel = client.subscribe('products');
channel.bind('product-created', (data) => { /* ... */ });
```

### Private channels

When you subscribe to a `private-` or `presence-` channel, the client POSTs to your `authEndpoint`:

```json
{ "socket_id": "…", "channel_name": "private-user-42" }
```

Your backend decides whether the current user may join, signs the request with the app secret, and returns `{ "auth": "…" }`. For presence channels it also returns `channel_data`. See [`example/auth-backend.js`](https://github.com/Tagong40/listening-ear/blob/master/example/auth-backend.js) for a working endpoint.

```js
const client = new ListeningEar('YOUR_PUBLIC_APP_KEY', {
  wsHost: 'realtime.example.com',
  wsPort: 443,
  forceTLS: true,
  authEndpoint: 'https://api.example.com/listening-ear/auth',
  authHeaders: { Authorization: `Bearer ${userToken}` },
});

const orders = client.subscribe('private-user-42');
orders.bind('order-shipped', (order) => { /* ... */ });
```

### Presence channels

Presence channels track which users are subscribed.

```js
const room = client.subscribe('presence-room-1');

room.bind('listening-ear:subscription_succeeded', () => {
  console.log(`${room.members.count} online`);
  room.members.each((member) => console.log(member.id, member.info));
});

room.bind('listening-ear:member_added', (member) => console.log('joined', member.id));
room.bind('listening-ear:member_removed', (member) => console.log('left', member.id));
```

`room.members` provides `count`, `get(userId)`, and `each(callback)`. A user with several tabs open counts once, and is only removed when their last tab closes.

### Client events

On private and presence channels, clients can send events straight to other subscribers without going through your backend. Event names must start with `client-`, and the sender does not receive its own event.

```js
room.trigger('client-typing', { user: 'ada' });
room.bind('client-typing', ({ user }) => showTyping(user));
```

## API

### Client

| Member | Description |
|---|---|
| `subscribe(name)` | Subscribes and returns the `Channel`. Calling it again returns the same channel |
| `unsubscribe(name)` | Leaves the channel |
| `channel(name)` | Returns an already subscribed channel, or `undefined` |
| `disconnect()` | Closes the connection and stops reconnecting |
| `connection.bind('state_change', cb)` | Called with `'connecting'`, `'connected'`, or `'disconnected'` |
| `connectionState` | Current connection state |
| `socketId` | This connection's id, or `null` while disconnected |

### Channel

| Member | Description |
|---|---|
| `bind(event, cb)` | Listen for an event. Chainable |
| `bind('*', cb)` | Listen for every event; `cb(eventName, data)` |
| `unbind(event, cb?)` | Remove one callback, or all callbacks for the event |
| `trigger('client-…', data)` | Send a client event (private and presence channels only) |
| `subscribed` | `true` once the server has confirmed the subscription |
| `members` | Presence channels only |

### Channel events

| Event | Payload |
|---|---|
| `listening-ear:subscription_succeeded` | Presence channels: `{ presence: { ids, hash, count } }` |
| `listening-ear:subscription_error` | `{ message }`, e.g. when the auth endpoint rejects the user |
| `listening-ear:member_added` | `{ id, info }` |
| `listening-ear:member_removed` | `{ id, info }` |

## Reconnecting

If the connection drops, the client retries after 2s, 4s, 8s, and so on, up to `maxReconnectDelay`. Once it reconnects it re-subscribes to all your channels, including re-authorizing private and presence channels. Events sent while the client was offline are not replayed, so refetch any data that matters when the connection comes back:

```js
client.connection.bind('state_change', (state) => {
  if (state === 'connected') refreshProducts();
});
```

## Upgrading from 1.x

- The browser file was renamed to `listening-ear.js`. `require('listening-ear-client')` and `import` work unchanged. Update any direct file paths or CDN URLs.
- The old global aliases were removed. Use `ListeningEar`.
- Channel event names now use the `listening-ear:` prefix, e.g. `listening-ear:subscription_succeeded`. This client needs a server running the same version.
- Fixed: channels are now re-subscribed after a reconnect.

## License

MIT
