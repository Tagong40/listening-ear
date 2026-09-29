/**
 * Example of triggering an event FROM YOUR BACKEND to all clients subscribed
 * to a channel -e.g. after saving a new message to your database.
 *
 * Run: node example/trigger-event.js
 */
require('dotenv').config({ path: __dirname + '/../server/.env' });
const { signApiRequest } = require('../server/src/auth');

const HOST = 'http://localhost:6001';
const APP_ID = process.env.APP_ID || 'app-id';
const APP_KEY = process.env.APP_KEY || 'app-key';
const APP_SECRET = process.env.APP_SECRET || 'app-secret';

async function trigger(channel, eventName, data) {
  const path = `/apps/${APP_ID}/events`;
  const body = JSON.stringify({ name: eventName, channels: [channel], data });

  const query = signApiRequest({ appKey: APP_KEY, appSecret: APP_SECRET, method: 'POST', path, body });
  const queryString = new URLSearchParams(query).toString();

  const res = await fetch(`${HOST}${path}?${queryString}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  console.log(res.status, await res.json());
}

trigger('presence-room-1', 'new-message', { text: 'Hello from the backend!', from: 'server' });
