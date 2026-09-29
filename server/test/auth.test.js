const test = require('node:test');
const assert = require('node:assert/strict');

const {
    signChannelAuth,
    verifyChannelAuth,
    signApiRequest,
    verifyApiRequest,
} = require('../src/auth');

test('channel auth accepts a valid presence signature', () => {
    const input = {
        appKey: 'public-key',
        appSecret: 'private-secret',
        socketId: 'socket-123',
        channel: 'presence-room',
        presenceData: { user_id: 'user-1', user_info: { name: 'Ada' } },
    };
    const result = signChannelAuth(input);

    assert.equal(
        verifyChannelAuth({
            ...input,
            auth: result.auth,
            channelData: result.channel_data,
        }),
        true
    );
});

test('channel auth rejects a changed channel', () => {
    const input = {
        appKey: 'public-key',
        appSecret: 'private-secret',
        socketId: 'socket-123',
        channel: 'private-orders',
    };
    const result = signChannelAuth(input);

    assert.equal(
        verifyChannelAuth({ ...input, channel: 'private-admin', auth: result.auth }),
        false
    );
});

test('REST auth accepts the original request and rejects a changed body', () => {
    const input = {
        appKey: 'public-key',
        appSecret: 'private-secret',
        method: 'POST',
        path: '/apps/app-1/events',
        body: JSON.stringify({ name: 'updated', channels: ['orders'], data: { id: 1 } }),
    };
    const query = signApiRequest(input);

    assert.equal(verifyApiRequest({ ...input, query }), true);
    assert.equal(verifyApiRequest({ ...input, body: `${input.body} `, query }), false);
});
test('REST auth rejects requests with a stale or missing timestamp', () => {
    const input = {
        appKey: 'public-key',
        appSecret: 'private-secret',
        method: 'POST',
        path: '/apps/app-1/events',
        body: JSON.stringify({ name: 'updated', channels: ['orders'], data: { id: 1 } }),
    };
    const query = signApiRequest(input);
    const signedAtMs = Number(query.auth_timestamp) * 1000;

    assert.equal(verifyApiRequest({ ...input, query, now: signedAtMs + 5 * 60 * 1000 }), true);
    assert.equal(verifyApiRequest({ ...input, query, now: signedAtMs + 11 * 60 * 1000 }), false);
    assert.equal(verifyApiRequest({ ...input, query, now: signedAtMs - 11 * 60 * 1000 }), false);

    const { auth_timestamp, ...withoutTimestamp } = query;
    assert.equal(verifyApiRequest({ ...input, query: withoutTimestamp }), false);
});
