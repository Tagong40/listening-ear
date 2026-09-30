/**
 * Listening Ear -a small, dependency-free realtime client SDK.
 *
 * Usage:
 *   const client = new ListeningEar('app-key', {
 *     wsHost: 'localhost',
 *     wsPort: 6001,
 *     authEndpoint: '/listening-ear/auth', // only needed for private-/presence- channels
 *   });
 *
 *   const channel = client.subscribe('presence-room-1');
 *   channel.bind('new-message', (data) => console.log(data));
 *   channel.trigger('client-typing', { user: 'ada' }); // client event
 *
 *   channel.bind('pusher:subscription_succeeded', () => {
 *     console.log(channel.members.each((m) => console.log(m)));
 *   });
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const ListeningEar = factory();
    root.ListeningEar = ListeningEar;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const CONNECTION_STATES = ['initialized', 'connecting', 'connected', 'unavailable', 'disconnected'];

  class Members {
    constructor() {
      this._members = {}; // userId -> userInfo
      this.myID = null;
    }
    get count() {
      return Object.keys(this._members).length;
    }
    get(userId) {
      return this._members[userId] ? { id: userId, info: this._members[userId] } : null;
    }
    each(callback) {
      Object.keys(this._members).forEach((id) => callback({ id, info: this._members[id] }));
    }
    _reset(hash) {
      this._members = hash || {};
    }
    _add(userId, info) {
      this._members[userId] = info;
    }
    _remove(userId) {
      delete this._members[userId];
    }
  }

  class Channel {
    constructor(name, client) {
      this.name = name;
      this.client = client;
      this.subscribed = false;
      this._callbacks = {}; // event -> [callbacks]
      if (name.startsWith('presence-')) this.members = new Members();
    }

    bind(event, callback) {
      if (!this._callbacks[event]) this._callbacks[event] = [];
      this._callbacks[event].push(callback);
      return this;
    }

    unbind(event, callback) {
      if (!this._callbacks[event]) return this;
      if (!callback) {
        delete this._callbacks[event];
      } else {
        this._callbacks[event] = this._callbacks[event].filter((cb) => cb !== callback);
      }
      return this;
    }

    /** Sends a client event (client-*) to everyone else subscribed to this channel. */
    trigger(event, data) {
      if (!event.startsWith('client-')) {
        throw new Error('trigger() event names must start with "client-"');
      }
      this.client._send({ event, channel: this.name, data });
    }

    _emit(event, data) {
      (this._callbacks[event] || []).forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[ListeningEar] error in "${event}" handler for channel "${this.name}":`, err);
        }
      });
      (this._callbacks['*'] || []).forEach((cb) => cb(event, data));
    }
  }

  class ListeningEar {
    constructor(appKey, options = {}) {
      this.appKey = appKey;
      this.options = Object.assign(
        {
          wsHost: 'localhost',
          wsPort: 6001,
          wsPath: '/app',
          forceTLS: false,
          authEndpoint: '/listening-ear/auth',
          authHeaders: {},
          maxReconnectDelay: 10000,
        },
        options
      );

      this.channels = new Map();
      this.socketId = null;
      this._state = 'initialized';
      this._stateCallbacks = [];
      this._reconnectAttempts = 0;
      this._explicitlyDisconnected = false;

      this._connect();
    }

    // ---- connection state -------------------------------------------------
    get connectionState() {
      return this._state;
    }

    _setState(state) {
      this._state = state;
      this._stateCallbacks.forEach((cb) => cb(state));
    }

    connection = {
      bind: (event, callback) => {
        if (event === 'state_change') this._stateCallbacks.push(callback);
        return this;
      },
    };

    // ---- socket lifecycle ---------------------------------------------------
    _connect() {
      this._explicitlyDisconnected = false;
      const proto = this.options.forceTLS ? 'wss' : 'ws';
      const separator = this.options.wsPath.includes('?') ? '&' : '?';
      const url = `${proto}://${this.options.wsHost}:${this.options.wsPort}${this.options.wsPath}${separator}app_key=${encodeURIComponent(this.appKey)}`;
      this._setState('connecting');

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this._reconnectAttempts = 0;
      };

      this.ws.onmessage = (evt) => this._handleMessage(evt);

      this.ws.onclose = () => {
        this._setState('disconnected');
        this.socketId = null;
        // The server forgets subscriptions when the socket closes, so mark every
        // channel unsubscribed; they're re-subscribed on the next connection_established.
        for (const ch of this.channels.values()) ch.subscribed = false;
        if (!this._explicitlyDisconnected) this._scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[ListeningEar] WebSocket error:', err);
      };
    }

    _scheduleReconnect() {
      this._reconnectAttempts += 1;
      const delay = Math.min(1000 * 2 ** this._reconnectAttempts, this.options.maxReconnectDelay);
      setTimeout(() => {
        if (!this._explicitlyDisconnected) this._connect();
      }, delay);
    }

    disconnect() {
      this._explicitlyDisconnected = true;
      if (this.ws) this.ws.close();
      this._setState('disconnected');
    }

    _send(message) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      } else {
        console.warn('[ListeningEar] Tried to send while socket not open:', message);
      }
    }

    // ---- message handling ---------------------------------------------------
    _handleMessage(evt) {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      const { event, channel, data } = msg;

      if (event === 'pusher:connection_established') {
        this.socketId = data.socket_id;
        this._setState('connected');
        // Re-subscribe to any channels the app had subscribed to before a reconnect.
        for (const ch of this.channels.values()) {
          if (!ch.subscribed) this._subscribeChannel(ch);
        }
        return;
      }

      if (event === 'pusher:pong') return; // heartbeat ack, nothing to do

      if (!channel) return;
      const ch = this.channels.get(channel);
      if (!ch) return;

      switch (event) {
        case 'pusher:subscription_succeeded':
          ch.subscribed = true;
          if (ch.members && data.presence) {
            ch.members._reset(data.presence.hash);
            ch.members.myID = this.socketId;
          }
          ch._emit('pusher:subscription_succeeded', data);
          break;
        case 'pusher:subscription_error':
          ch._emit('pusher:subscription_error', data);
          break;
        case 'pusher_internal:member_added':
          if (ch.members) {
            ch.members._add(data.user_id, data.user_info);
            ch._emit('pusher:member_added', { id: data.user_id, info: data.user_info });
          }
          break;
        case 'pusher_internal:member_removed':
          if (ch.members) {
            const info = ch.members.get(data.user_id)?.info;
            ch.members._remove(data.user_id);
            ch._emit('pusher:member_removed', { id: data.user_id, info });
          }
          break;
        default:
          ch._emit(event, data);
      }
    }

    // ---- public API -----------------------------------------------------------
    subscribe(channelName) {
      if (this.channels.has(channelName)) return this.channels.get(channelName);

      const channel = new Channel(channelName, this);
      this.channels.set(channelName, channel);

      if (this._state === 'connected') this._subscribeChannel(channel);
      return channel;
    }

    unsubscribe(channelName) {
      const channel = this.channels.get(channelName);
      if (!channel) return;
      this._send({ event: 'pusher:unsubscribe', data: { channel: channelName } });
      this.channels.delete(channelName);
    }

    channel(channelName) {
      return this.channels.get(channelName);
    }

    async _subscribeChannel(channel) {
      const name = channel.name;
      const needsAuth = name.startsWith('private-') || name.startsWith('presence-');

      if (!needsAuth) {
        return this._send({ event: 'pusher:subscribe', data: { channel: name } });
      }

      try {
        const res = await fetch(this.options.authEndpoint, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, this.options.authHeaders),
          body: JSON.stringify({ socket_id: this.socketId, channel_name: name }),
        });
        if (!res.ok) throw new Error(`Auth endpoint responded ${res.status}`);
        const { auth, channel_data } = await res.json();
        this._send({ event: 'pusher:subscribe', data: { channel: name, auth, channel_data } });
      } catch (err) {
        console.error(`[ListeningEar] Failed to authenticate channel "${name}":`, err);
        channel._emit('pusher:subscription_error', { message: err.message });
      }
    }
  }

  ListeningEar.CONNECTION_STATES = CONNECTION_STATES;
  return ListeningEar;
});
