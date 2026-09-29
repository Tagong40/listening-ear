# Listening Ear Usage

Listening Ear provides a hosted realtime server and a browser client SDK. Use it to deliver live notifications from your backend to connected frontend users.

## 1. Install the client

After publishing the package to npm:

```bash
npm install listening-ear-client
```

For a local package during development:

```bash
npm install ../listening-ear/client
```

## 2. Configure the client

```js
import ListeningEar from 'listening-ear-client';

const client = new ListeningEar('YOUR_PUBLIC_APP_KEY', {
  wsHost: 'YOUR-APP.herokuapp.com',
  wsPort: 443,
  forceTLS: true,
  authEndpoint: 'https://your-api.example.com/listening-ear/auth'
});
```

The public app key comes from the Listening Ear control console. The app secret must never be included in frontend code.

## 3. Subscribe to a channel

Use public channels when anyone can receive the event:

```js
const channel = client.subscribe('customers');

channel.bind('customer-created', (customer) => {
  console.log('New customer:', customer);
  showToast(`New customer: ${customer.name}`);
});
```

A client can subscribe to multiple channels:

```js
const customers = client.subscribe('customers');
const orders = client.subscribe('orders');
const notifications = client.subscribe('private-admin-notifications');
```

## 4. Private and presence channels

Private and presence channels require your application to provide an auth endpoint. Listening Ear sends this request to your backend:

```http
POST /listening-ear/auth
Content-Type: application/json

{
  "socket_id": "socket-id-from-client",
  "channel_name": "private-admin-notifications"
}
```

Your backend must verify the logged-in user can access the channel and return a signed response using the app secret:

```json
{
  "auth": "YOUR_PUBLIC_APP_KEY:SIGNATURE"
}
```

For a presence channel, include channel data:

```json
{
  "auth": "YOUR_PUBLIC_APP_KEY:SIGNATURE",
  "channel_data": "{\"user_id\":\"user-123\",\"user_info\":{\"name\":\"Ada\"}}"
}
```

Never calculate this signature in the browser.

## 5. Broadcast from your backend

After your backend creates a customer successfully, send a signed event to the Listening Ear REST API:

```http
POST https://YOUR-APP.herokuapp.com/apps/YOUR_APP_ID/events
```

Request body:

```json
{
  "name": "customer-created",
  "channels": ["private-admin-notifications"],
  "data": {
    "id": "customer-123",
    "name": "Ada Lovelace",
    "email": "ada@example.com"
  }
}
```

The request must include these query parameters:

```text
auth_key=YOUR_PUBLIC_APP_KEY
auth_timestamp=CURRENT_UNIX_TIMESTAMP
auth_version=1.0
auth_signature=HMAC_SIGNATURE
```

The signature is generated on your backend with the app secret. See `server/src/auth.js` and `example/trigger-event.js` for the signing implementation.

## 6. Customer creation example

```js
await database.customers.create(customer);

await triggerListeningEar('private-admin-notifications', 'customer-created', {
  id: customer.id,
  name: customer.name,
  email: customer.email
});
```

The frontend receives the event immediately:

```js
channel.bind('customer-created', (customer) => {
  addCustomerToTable(customer);
  showToast(`New customer: ${customer.name}`);
});
```

Only broadcast after the database operation succeeds. Do not broadcast secrets, passwords, access tokens, or sensitive personal data.

## 7. Connection state

```js
client.connection.bind('state_change', (state) => {
  console.log('Listening Ear connection:', state);
});
```

Possible states include:

```text
initialized
connecting
connected
disconnected
unavailable
```

## 8. Client-to-client events

Client events are available only on private and presence channels:

```js
channel.bind('client-typing', (data) => {
  showTypingIndicator(data.user);
});

channel.trigger('client-typing', {
  user: currentUser.name
});
```

Client events are sent to other subscribers and are not echoed to the sender.

## 9. Local development

Start the backend:

```bash
cd server
npm install
npm start
```

The local server uses SQLite by default and stores its database at:

```text
server/data/listening-ear.sqlite
```

The control console is available at:

```text
http://localhost:6001/control/
```

Create an app in the console, then use its public key in your frontend.

## 10. Heroku deployment

The backend uses Heroku Postgres automatically when `DATABASE_URL` is present:

```bash
heroku login
heroku create listening-ear-server
heroku addons:create heroku-postgresql:essential-0 --app listening-ear-server
heroku git:remote --app listening-ear-server
cd server
git push heroku master:main
```

The production endpoints are:

```text
Console: https://YOUR-APP.herokuapp.com/control/
Health:  https://YOUR-APP.herokuapp.com/health
WebSocket: wss://YOUR-APP.herokuapp.com/app?app_key=YOUR_PUBLIC_APP_KEY
```

Use `forceTLS: true` and port `443` in production.

## Security checklist

- Keep the app secret on the backend only.
- Use private channels for user-specific or admin notifications.
- Verify authorization in your application auth endpoint.
- Validate and limit event payloads.
- Use HTTPS and WSS in production.
- Store `DATABASE_URL` and app secrets in Heroku config vars.
- Rotate app secrets if they are exposed.
- Run one realtime dyno until shared channel state is added for horizontal scaling.
