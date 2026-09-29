const crypto = require('crypto');

/**
 * HMAC-SHA256 signing, the same scheme Pusher uses:
 *   signature = hex( HMAC_SHA256( appSecret, stringToSign ) )
 */
function sign(secret, stringToSign) {
  return crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
}

/**
 * Verifies the `auth` string a client sends when subscribing to a
 * private-* or presence-* channel.
 *
 * The client is expected to have obtained `auth` (and, for presence
 * channels, `channel_data`) from its own backend's auth endpoint, which
 * in turn should have called `signChannelAuth` below.
 *
 * auth string format: "<appKey>:<signature>"
 */
function verifyChannelAuth({ appKey, appSecret, socketId, channel, auth, channelData }) {
  if (!auth || typeof auth !== 'string' || !auth.includes(':')) return false;

  const [providedKey, providedSignature] = auth.split(':');
  if (providedKey !== appKey) return false;

  const stringToSign = channelData
    ? `${socketId}:${channel}:${channelData}`
    : `${socketId}:${channel}`;

  const expected = sign(appSecret, stringToSign);
  return timingSafeEqual(expected, providedSignature);
}

/**
 * What a client's OWN backend (the "auth endpoint") should call to produce
 * the `auth` (and optional `channel_data`) fields it returns to the client.
 * Exposed here mainly for the example app / documentation.
 */
function signChannelAuth({ appKey, appSecret, socketId, channel, presenceData }) {
  const channelData = presenceData ? JSON.stringify(presenceData) : undefined;
  const stringToSign = channelData
    ? `${socketId}:${channel}:${channelData}`
    : `${socketId}:${channel}`;

  const signature = sign(appSecret, stringToSign);
  const result = { auth: `${appKey}:${signature}` };
  if (channelData) result.channel_data = channelData;
  return result;
}

const MAX_TIMESTAMP_SKEW_SECONDS = 600;

/**
 * Verifies REST API requests (POST /apps/:appId/events) using a simplified
 * version of Pusher's REST auth scheme: HMAC over method+path+sorted-query+body.
 *
 * Requests whose auth_timestamp is more than 10 minutes from the server clock
 * are rejected, so a captured signed request can't be replayed indefinitely.
 */
function verifyApiRequest({ appSecret, method, path, query, body, now = Date.now() }) {
  const { auth_signature, body_md5: providedBodyHash, ...rest } = query;
  const timestamp = Number(rest.auth_timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const bodyHash = crypto.createHash('md5').update(body || '').digest('hex');
  if (providedBodyHash && providedBodyHash !== bodyHash) return false;
  const sortedQuery = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');

  const stringToSign = [method.toUpperCase(), path, `${sortedQuery}&body_md5=${bodyHash}`].join('\n');

  const expected = sign(appSecret, stringToSign);
  return timingSafeEqual(expected, auth_signature || '');
}

/**
 * Builds the query string params needed to call POST /apps/:appId/events.
 * Mirrors verifyApiRequest's string-to-sign construction.
 */
function signApiRequest({ appKey, appSecret, method, path, body }) {
  const auth_timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = crypto.createHash('md5').update(body || '').digest('hex');
  const query = { auth_key: appKey, auth_timestamp, auth_version: '1.0', body_md5: bodyHash };

  const sortedQuery = Object.keys(query)
    .filter((key) => key !== 'body_md5')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');

  const stringToSign = [method.toUpperCase(), path, `${sortedQuery}&body_md5=${bodyHash}`].join('\n');

  query.auth_signature = sign(appSecret, stringToSign);
  return query;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { sign, verifyChannelAuth, signChannelAuth, verifyApiRequest, signApiRequest, MAX_TIMESTAMP_SKEW_SECONDS };
