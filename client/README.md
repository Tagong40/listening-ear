# Listening Ear Client

Browser client for the self-hosted Listening Ear realtime server.

## Install

Install it from npm:

```bash
npm install listening-ear-client
```

## Use

```js
const ListeningEar = require('listening-ear-client');

const client = new ListeningEar('public-app-key', {
  wsHost: 'realtime.example.com',
  wsPort: 443,
  forceTLS: true,
  authEndpoint: 'https://api.example.com/listening-ear/auth'
});

const channel = client.subscribe('private-orders');
channel.bind('order-updated', (data) => {
  console.log(data);
});
```

For a browser script, serve `listening-ear.js` and use `new ListeningEar(...)`.
Private and presence channels require an application-owned auth endpoint.
Never put the app secret in browser code.

The client includes the public app key in its WebSocket URL, allowing one
Listening Ear server to host multiple applications.