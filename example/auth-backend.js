/**
 * Minimal example of the auth endpoint YOUR backend needs to expose.
 *
 * The client SDK POSTs { socket_id, channel_name } here whenever it needs
 * to subscribe to a private-* or presence-* channel. This endpoint decides
 * whether the current (logged-in) user is allowed to join that channel,
 * then signs the subscription using your app secret — which never reaches
 * the browser.
 *
 * Run alongside the main server:
 *   node example/auth-backend.js
 */
require('dotenv').config({ path: __dirname + '/../server/.env' });
const express = require('express');
const cors = require('cors'); // npm install cors, only needed if UI is served from a different origin
const { signChannelAuth } = require('../server/src/auth');

const APP_KEY = process.env.APP_KEY || 'app-key';
const APP_SECRET = process.env.APP_SECRET || 'app-secret';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/listening-ear/auth', (req, res) => {
  const { socket_id, channel_name } = req.body;

  // --- In a real app: look up the actual logged-in user from the session/JWT ---
  const currentUser = { id: 'user-' + Math.floor(Math.random() * 1000), name: 'Guest' };

  // --- Authorization check: would go here for private-* channels, e.g. ---
  // if (!userCanAccess(currentUser, channel_name)) return res.status(403).end();

  const presenceData = channel_name.startsWith('presence-')
    ? { user_id: currentUser.id, user_info: { name: currentUser.name } }
    : undefined;

  const authResponse = signChannelAuth({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    socketId: socket_id,
    channel: channel_name,
    presenceData,
  });

  res.json(authResponse);
});

app.listen(6002, () => console.log('Auth backend listening on http://localhost:6002'));
