const test = require('node:test');
const assert = require('node:assert/strict');

const ChannelManager = require('../src/channelManager');

function socket(id) {
    return { id };
}

test('presence membership tracks the first and last connection', () => {
    const manager = new ChannelManager();
    const firstSocket = socket('socket-1');
    const secondSocket = socket('socket-2');

    assert.deepEqual(
        manager.joinPresence('presence-room', firstSocket, 'user-1', { name: 'Ada' }),
        { isNew: true, userInfo: { name: 'Ada' } }
    );
    assert.deepEqual(
        manager.joinPresence('presence-room', secondSocket, 'user-1', { name: 'Ada' }),
        { isNew: false, userInfo: { name: 'Ada' } }
    );
    assert.deepEqual(manager.presenceMemberList('presence-room'), {
        count: 1,
        hash: { 'user-1': { name: 'Ada' } },
    });

    assert.equal(manager.leavePresence('presence-room', firstSocket), null);
    assert.deepEqual(manager.leavePresence('presence-room', secondSocket), {
        userId: 'user-1',
        userInfo: { name: 'Ada' },
    });
    assert.deepEqual(manager.presenceMemberList('presence-room'), { count: 0, hash: {} });
});

test('channel membership is removed when a socket leaves', () => {
    const manager = new ChannelManager();
    const connection = socket('socket-1');

    manager.subscribe('private-orders', connection);
    assert.equal(manager.channelExists('private-orders'), true);
    assert.equal(manager.socketsIn('private-orders').has(connection), true);

    manager.removeSocketEverywhere(connection);
    assert.equal(manager.channelExists('private-orders'), false);
});