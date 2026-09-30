require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const ChannelManager = require('./channelManager');
const { verifyChannelAuth, verifyApiRequest } = require('./auth');
const { controlPlane, createDatabase, createPostgresDatabase, initializeControlPlane, findApplication, recordUsage } = require('./controlPlane');

// ---- Config -----------------------------------------------------------
const PORT = process.env.PORT || 6001;
const APP_KEY = process.env.APP_KEY || 'app-key';
const APP_SECRET = process.env.APP_SECRET || 'app-secret';
const APP_ID = process.env.APP_ID || 'app-id';
const ACTIVITY_TIMEOUT_MS = 30_000; // server pings idle sockets after this
const PONG_GRACE_MS = 10_000; // then waits this long for a pong before dropping
const MAX_CHANNELS_PER_TRIGGER = 100;

// ---- State --------------------------------------------------------------
const channelManager = new ChannelManager();
const sockets = new Map(); // socketId -> ws
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, '../data/listening-ear.sqlite');
let pool;
let controlRouter;
const databaseReady = (process.env.DATABASE_URL
  ? Promise.resolve(createPostgresDatabase(process.env.DATABASE_URL))
  : createDatabase(databasePath)
).then((database) => {
  pool = database;
  return initializeControlPlane(pool);
});

// ---- HTTP app (health check + REST trigger API) --------------------------
const app = express();
// Keep the exact request bytes: signatures are computed over the raw body,
// and re-serializing parsed JSON can change key order or whitespace.
const keepRawBody = (req, res, buf) => {
  req.rawBody = buf.toString('utf8');
};
app.use(express.json({ limit: '100kb', verify: keepRawBody }));
app.use(express.text({ type: '*/*', limit: '100kb', verify: keepRawBody }));

app.get('/health', (req, res) => res.json({ ok: true, connections: sockets.size }));
app.use('/control', express.static(path.join(__dirname, '../public')));
app.use('/control/api', (req, res, next) => {
  if (!controlRouter) return res.status(503).json({ error: 'control plane is starting' });
  return controlRouter(req, res, next);
});
databaseReady.then(() => {
  controlRouter = controlPlane({ pool });
});

// POST /apps/:appId/events  { name, channels: [...], data, socket_id? }
// Auth via query params: auth_key, auth_timestamp, auth_signature (see auth.js)
app.post('/apps/:appId/events', async (req, res, next) => {
  try {
    const appConfig = pool
      ? await findApplication(pool, 'app_id', req.params.appId)
      : req.params.appId === APP_ID
        ? { app_id: APP_ID, app_key: APP_KEY, app_secret: APP_SECRET }
        : null;
    if (!appConfig) return res.status(404).json({ error: 'unknown app_id' });

    const rawBody = req.rawBody || '';

    const valid = verifyApiRequest({
      appSecret: appConfig.app_secret,
      method: req.method,
      path: req.path,
      query: req.query,
      body: rawBody,
    });

    if (!valid || req.query.auth_key !== appConfig.app_key) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    let payload;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'invalid JSON body' });
    }

    const { name, channels, channel, data, socket_id } = payload;
    const targetChannels = channels || (channel ? [channel] : []);

    if (!name || targetChannels.length === 0) {
      return res.status(400).json({ error: 'name and channels (or channel) are required' });
    }
    if (!Array.isArray(targetChannels) || targetChannels.length > MAX_CHANNELS_PER_TRIGGER) {
      return res.status(400).json({ error: `channels must be an array of at most ${MAX_CHANNELS_PER_TRIGGER}` });
    }

    for (const ch of targetChannels) {
      broadcastToChannel(ch, {
        event: name,
        channel: ch,
        data,
      }, socket_id);
    }

    await recordUsage(pool, appConfig.id, {
      requests: 1,
      events_sent: targetChannels.length,
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/app' });

// ---- Helpers --------------------------------------------------------------
function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToChannel(channel, message, excludeSocketId) {
  for (const socket of channelManager.socketsIn(channel)) {
    if (excludeSocketId && socket.id === excludeSocketId) continue;
    send(socket, message);
  }
}

function errorTo(socket, code, msg) {
  send(socket, { event: 'listening-ear:error', data: { code, message: msg } });
}

// ---- Connection lifecycle --------------------------------------------------
async function initializeSocket(socket, request) {
  const url = new URL(request.url, 'http://localhost');
  const requestedKey = url.searchParams.get('app_key');
  socket.app = pool
    ? await findApplication(pool, 'app_key', requestedKey)
    : requestedKey && requestedKey !== APP_KEY
      ? null
      : { app_id: APP_ID, app_key: APP_KEY, app_secret: APP_SECRET };

  if (!socket.app) return socket.close(1008, 'unknown application key');

  socket.id = uuidv4();
  socket.isAlive = true;
  sockets.set(socket.id, socket);
  await recordUsage(pool, socket.app.id, { connections_total: 1, active_connections: 1 });

  send(socket, {
    event: 'listening-ear:connection_established',
    data: { socket_id: socket.id, activity_timeout: ACTIVITY_TIMEOUT_MS / 1000 },
  });

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return errorTo(socket, 4001, 'Invalid JSON');
    }
    handleMessage(socket, msg);
  });

  socket.on('close', () => {
    sockets.delete(socket.id);
    recordUsage(pool, socket.app.id, { active_connections: -1 }).catch((error) => {
      console.error('[ListeningEar] failed to record connection close:', error);
    });
    const leftPresence = channelManager.removeSocketEverywhere(socket);
    for (const { channel, userId } of leftPresence) {
      broadcastToChannel(channel, {
        event: 'listening-ear_internal:member_removed',
        channel,
        data: { user_id: userId },
      });
    }
  });
}

wss.on('connection', (socket, request) => {
  initializeSocket(socket, request).catch((error) => {
    console.error('[ListeningEar] failed to initialize connection:', error);
    socket.close(1011, 'connection initialization failed');
  });
});

function handleMessage(socket, msg) {
  const { event, data = {}, channel } = msg;

  switch (event) {
    case 'listening-ear:subscribe':
      return handleSubscribe(socket, data);
    case 'listening-ear:unsubscribe':
      return handleUnsubscribe(socket, data);
    case 'listening-ear:ping':
      return send(socket, { event: 'listening-ear:pong', data: {} });
    default:
      if (event && event.startsWith('client-')) {
        return handleClientEvent(socket, channel, event, data);
      }
      return errorTo(socket, 4002, `Unknown event: ${event}`);
  }
}

function handleSubscribe(socket, data) {
  const { channel, auth, channel_data } = data;
  if (!channel) return errorTo(socket, 4003, 'channel is required');

  const needsAuth = channelManager.isPrivate(channel) || channelManager.isPresence(channel);

  if (needsAuth) {
    const ok = verifyChannelAuth({
      appKey: socket.app.app_key,
      appSecret: socket.app.app_secret,
      socketId: socket.id,
      channel,
      auth,
      channelData: channel_data,
    });
    if (!ok) {
      return send(socket, {
        event: 'listening-ear:subscription_error',
        channel,
        data: { message: 'Auth signature invalid' },
      });
    }
  }

  channelManager.subscribe(channel, socket);

  if (channelManager.isPresence(channel)) {
    let userInfo;
    try {
      userInfo = JSON.parse(channel_data);
    } catch {
      return send(socket, {
        event: 'listening-ear:subscription_error',
        channel,
        data: { message: 'Invalid channel_data for presence channel' },
      });
    }
    const userId = userInfo.user_id;
    const { isNew, userInfo: info } = channelManager.joinPresence(channel, socket, userId, userInfo.user_info);

    const { hash } = channelManager.presenceMemberList(channel);
    send(socket, {
      event: 'listening-ear:subscription_succeeded',
      channel,
      data: { presence: { ids: Object.keys(hash), hash, count: Object.keys(hash).length } },
    });

    if (isNew) {
      broadcastToChannel(channel, {
        event: 'listening-ear_internal:member_added',
        channel,
        data: { user_id: userId, user_info: info },
      }, socket.id);
    }
  } else {
    send(socket, { event: 'listening-ear:subscription_succeeded', channel, data: {} });
  }
}

function handleUnsubscribe(socket, data) {
  const { channel } = data;
  if (!channel) return;
  channelManager.unsubscribe(channel, socket);
  if (channelManager.isPresence(channel)) {
    const left = channelManager.leavePresence(channel, socket);
    if (left) {
      broadcastToChannel(channel, {
        event: 'listening-ear_internal:member_removed',
        channel,
        data: { user_id: left.userId },
      });
    }
  }
}

function handleClientEvent(socket, channel, event, data) {
  if (!channel) return errorTo(socket, 4004, 'channel is required for client events');
  const allowed = channelManager.isPrivate(channel) || channelManager.isPresence(channel);
  if (!allowed) {
    return errorTo(socket, 4005, 'Client events are only allowed on private/presence channels');
  }
  if (!channelManager.socketsIn(channel).has(socket)) {
    return errorTo(socket, 4006, 'You must be subscribed to a channel to send client events');
  }
  broadcastToChannel(channel, { event, channel, data }, socket.id);
}

// ---- Heartbeat: detect dead connections ------------------------------------
const heartbeat = setInterval(() => {
  for (const socket of sockets.values()) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, ACTIVITY_TIMEOUT_MS + PONG_GRACE_MS);

wss.on('close', () => clearInterval(heartbeat));

databaseReady
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Listening Ear server listening on http://localhost:${PORT}`);
      console.log(`WebSocket endpoint: ws://localhost:${PORT}/app?app_key=...`);
      console.log(`REST trigger API:   POST http://localhost:${PORT}/apps/:appId/events`);
    });
  })
  .catch((error) => {
    console.error('[ListeningEar] database initialization failed:', error);
    process.exitCode = 1;
  });
