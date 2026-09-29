const test = require('node:test');
const assert = require('node:assert/strict');

const ListeningEar = require('../listening-ear');

test('exports the ListeningEar client and compatibility aliases', () => {
    assert.equal(ListeningEar.name, 'ListeningEar');
    assert.deepEqual(ListeningEar.CONNECTION_STATES, [
        'initialized',
        'connecting',
        'connected',
        'unavailable',
        'disconnected',
    ]);
});