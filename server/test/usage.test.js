const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDatabase, getUsage, initializeControlPlane, recordUsage } = require('../src/controlPlane');

test('usage counters record the first and subsequent increments', async () => {
    const filename = path.join(os.tmpdir(), `listening-ear-${Date.now()}.sqlite`);
    const database = await createDatabase(filename);
    try {
        await initializeControlPlane(database);
        await database.query(
            'INSERT INTO applications (id, user_id, name, app_id, app_key, app_secret) VALUES ($1, $2, $3, $4, $5, $6)',
            ['app-id', 'user-id', 'Test app', 'app-test', 'le-test', 'secret-test']
        );

        await recordUsage(database, 'app-id', { requests: 1, events_sent: 2 });
        await recordUsage(database, 'app-id', { requests: 3, events_sent: 4 });

        assert.deepEqual(await getUsage(database, 'app-id'), {
            requests: 4,
            events_sent: 6,
            connections_total: 0,
            active_connections: 0,
        });
    } finally {
        database.close();
        fs.rmSync(filename, { force: true });
    }
});