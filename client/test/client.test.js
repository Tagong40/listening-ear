const test = require('node:test');
const assert = require('node:assert/strict');

const ListeningEar = require('../listening-ear');

test('exports the ListeningEar client', () => {
    assert.equal(ListeningEar.name, 'ListeningEar');
    assert.deepEqual(ListeningEar.CONNECTION_STATES, [
        'initialized',
        'connecting',
        'connected',
        'unavailable',
        'disconnected',
    ]);
});
test('re-subscribes to channels after the connection drops and reconnects', async (t) => {
    const sockets = [];
    class FakeWebSocket {
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = FakeWebSocket.OPEN;
            this.sent = [];
            sockets.push(this);
        }
        send(message) {
            this.sent.push(JSON.parse(message));
        }
        close() {
            this.onclose?.();
        }
        receive(message) {
            this.onmessage({ data: JSON.stringify(message) });
        }
    }
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => { globalThis.WebSocket = originalWebSocket; });

    const client = new ListeningEar('app-key');
    const channel = client.subscribe('products');

    sockets[0].receive({ event: 'pusher:connection_established', data: { socket_id: 's1' } });
    sockets[0].receive({ event: 'pusher:subscription_succeeded', channel: 'products', data: {} });
    assert.equal(channel.subscribed, true);

    sockets[0].onclose(); // connection drops
    assert.equal(channel.subscribed, false);
    t.mock.timers.tick(10_000); // reconnect backoff

    assert.equal(sockets.length, 2);
    sockets[1].receive({ event: 'pusher:connection_established', data: { socket_id: 's2' } });
    assert.deepEqual(sockets[1].sent, [{ event: 'pusher:subscribe', data: { channel: 'products' } }]);

    client.disconnect();
});
