const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

async function createDatabase(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const SQL = await initSqlJs({
        locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
    });
    const database = fs.existsSync(filename)
        ? new SQL.Database(new Uint8Array(fs.readFileSync(filename)))
        : new SQL.Database();
    database.run('PRAGMA foreign_keys = ON');
    const persist = () => fs.writeFileSync(filename, Buffer.from(database.export()));
    return {
        kind: 'sqlite',
        query(sql, params = []) {
            const sqliteSql = sql
                .replace(/\$\d+/g, '?')
                .replace(/NOW\(\) \+ INTERVAL '30 days'/g, "datetime('now', '+30 days')")
                .replace(/NOW\(\)/g, "datetime('now')");
            try {
                const statement = database.prepare(sqliteSql);
                statement.bind(params);
                const rows = [];
                while (statement.step()) rows.push(statement.getAsObject());
                statement.free();
                if (!/^\s*(SELECT|WITH)/i.test(sqliteSql) && !/RETURNING/i.test(sqliteSql)) persist();
                return Promise.resolve({ rows, rowCount: rows.length });
            } catch (error) {
                if (String(error.message).includes('UNIQUE constraint failed')) error.code = '23505';
                return Promise.reject(error);
            }
        },
        exec(sql) {
            database.run(sql);
            persist();
        },
        close() {
            database.close();
        },
    };
}

function createPostgresDatabase(connectionString) {
    const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    return {
        kind: 'postgres',
        query(sql, params = []) {
            return pool.query(sql, params);
        },
        exec() {
            throw new Error('PostgreSQL schema initialization must use query');
        },
        close() {
            return pool.end();
        },
    };
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

async function hashPassword(password) {
    const salt = randomToken(16);
    const derivedKey = await scrypt(password, salt, 64);
    return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
    const [salt, expectedHex] = storedHash.split(':');
    if (!salt || !expectedHex) return false;
    const actual = await scrypt(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function publicUser(user) {
    return { id: user.id, email: user.email, created_at: user.created_at };
}

function publicApp(app) {
    return {
        id: app.id,
        name: app.name,
        app_id: app.app_id,
        app_key: app.app_key,
        created_at: app.created_at,
    };
}

async function recordUsage(pool, appId, changes) {
    const columns = ['requests', 'events_sent', 'connections_total', 'active_connections'];
    const entries = Object.entries(changes).filter(([column]) => columns.includes(column));
    if (!appId || entries.length === 0) return;

    const updates = entries.map(([column], index) => `${column} = ${column} + $${index + 1}`).join(', ');
    const values = entries.map(([, value]) => value);
    if (pool.kind === 'postgres') {
        await pool.query(
            'INSERT INTO application_usage (app_id) VALUES ($1) ON CONFLICT (app_id) DO NOTHING',
            [appId]
        );
    } else {
        await pool.query('INSERT OR IGNORE INTO application_usage (app_id) VALUES ($1)', [appId]);
    }
    await pool.query(
        `UPDATE application_usage SET ${updates} WHERE app_id = $${values.length + 1}`,
        [...values, appId]
    );
}

async function getUsage(pool, appId) {
    const result = await pool.query(
        `SELECT requests, events_sent, connections_total, active_connections
         FROM application_usage WHERE app_id = $1`,
        [appId]
    );
    return result.rows[0] || { requests: 0, events_sent: 0, connections_total: 0, active_connections: 0 };
}

function controlPlane({ pool }) {
    const router = express.Router();

    router.use(express.json());

    async function userFromRequest(req) {
        const header = req.get('authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!token) return null;

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const result = await pool.query(
            `SELECT users.* FROM users
       JOIN sessions ON sessions.user_id = users.id
       WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()`,
            [tokenHash]
        );
        return result.rows[0] || null;
    }

    async function requireUser(req, res, next) {
        try {
            req.user = await userFromRequest(req);
            if (!req.user) return res.status(401).json({ error: 'authentication required' });
            next();
        } catch (error) {
            next(error);
        }
    }

    router.post('/auth/register', async (req, res, next) => {
        try {
            const email = normalizeEmail(req.body.email);
            const password = String(req.body.password || '');
            if (!email || !email.includes('@') || password.length < 10) {
                return res.status(400).json({ error: 'valid email and 10-character password required' });
            }

            const passwordHash = await hashPassword(password);
            const result = await pool.query(
                'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
                [randomToken(16), email, passwordHash]
            );
            const token = randomToken();
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            await pool.query(
                `INSERT INTO sessions (id, user_id, token_hash, expires_at)
              VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
                [randomToken(16), result.rows[0].id, tokenHash]
            );
            res.status(201).json({ token, user: publicUser(result.rows[0]) });
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'email already registered' });
            next(error);
        }
    });

    router.post('/auth/login', async (req, res, next) => {
        try {
            const email = normalizeEmail(req.body.email);
            const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
            const user = result.rows[0];
            if (!user || !(await verifyPassword(String(req.body.password || ''), user.password_hash))) {
                return res.status(401).json({ error: 'invalid email or password' });
            }

            const token = randomToken();
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            await pool.query(
                `INSERT INTO sessions (id, user_id, token_hash, expires_at)
                 VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
                [randomToken(16), user.id, tokenHash]
            );
            res.json({ token, user: publicUser(user) });
        } catch (error) {
            next(error);
        }
    });

    router.get('/auth/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

    router.get('/apps', requireUser, async (req, res, next) => {
        try {
            const result = await pool.query(
                'SELECT * FROM applications WHERE user_id = $1 ORDER BY created_at DESC',
                [req.user.id]
            );
            const apps = [];
            for (const app of result.rows) {
                apps.push({ ...publicApp(app), usage: await getUsage(pool, app.id) });
            }
            res.json({ apps });
        } catch (error) {
            next(error);
        }
    });

    router.post('/apps', requireUser, async (req, res, next) => {
        try {
            const name = String(req.body.name || '').trim();
            if (!name || name.length > 80) return res.status(400).json({ error: 'app name is required' });

            const result = await pool.query(
                `INSERT INTO applications (id, user_id, name, app_id, app_key, app_secret)
              VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [randomToken(16), req.user.id, name, `app_${randomToken(10)}`, `le_${randomToken(16)}`, `le_secret_${randomToken(32)}`]
            );
            res.status(201).json({ app: publicApp(result.rows[0]), app_secret: result.rows[0].app_secret });
        } catch (error) {
            next(error);
        }
    });

    router.post('/apps/:id/rotate-secret', requireUser, async (req, res, next) => {
        try {
            const result = await pool.query(
                `UPDATE applications SET app_secret = $1
         WHERE id = $2 AND user_id = $3 RETURNING *`,
                [`le_secret_${randomToken(32)}`, req.params.id, req.user.id]
            );
            if (!result.rows[0]) return res.status(404).json({ error: 'app not found' });
            res.json({ app: publicApp(result.rows[0]), app_secret: result.rows[0].app_secret });
        } catch (error) {
            next(error);
        }
    });

    return router;
}

async function initializeControlPlane(pool) {
    const schema = pool.kind === 'postgres' ? `
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS applications (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            app_id TEXT UNIQUE NOT NULL,
            app_key TEXT UNIQUE NOT NULL,
            app_secret TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS application_usage (
            app_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
            requests INTEGER NOT NULL DEFAULT 0,
            events_sent INTEGER NOT NULL DEFAULT 0,
            connections_total INTEGER NOT NULL DEFAULT 0,
            active_connections INTEGER NOT NULL DEFAULT 0
        );
    ` : `
    CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS applications (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      app_id TEXT UNIQUE NOT NULL,
      app_key TEXT UNIQUE NOT NULL,
      app_secret TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
        CREATE TABLE IF NOT EXISTS application_usage (
            app_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
            requests INTEGER NOT NULL DEFAULT 0,
            events_sent INTEGER NOT NULL DEFAULT 0,
            connections_total INTEGER NOT NULL DEFAULT 0,
            active_connections INTEGER NOT NULL DEFAULT 0
        );
    `;
    if (pool.kind === 'postgres') {
        await pool.query(schema);
    } else {
        pool.exec(schema);
    }
}

async function findApplication(pool, field, value) {
    if (!['app_id', 'app_key'].includes(field)) throw new Error('invalid application lookup');
    const result = await pool.query(`SELECT * FROM applications WHERE ${field} = $1`, [value]);
    return result.rows[0] || null;
}

module.exports = { controlPlane, createDatabase, createPostgresDatabase, getUsage, initializeControlPlane, findApplication, recordUsage };