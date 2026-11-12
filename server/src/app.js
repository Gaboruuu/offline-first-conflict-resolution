import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { validateSubscription } from './validation.js';

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const notFound = (id) => new HttpError(404, 'NOT_FOUND', `Subscription ${id} does not exist`);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'TOO_LARGE', 'Request body is too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseId(text) {
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'BAD_ID', `"${text}" is not a valid id`);
  return id;
}

/**
 * The SubTrack REST API plus a WebSocket at `/ws` that pushes every change to the connected apps:
 *
 *   GET    /subscriptions        every subscription, sorted by next payment date
 *   GET    /subscriptions/:id    one subscription
 *   POST   /subscriptions        body = the new element without id → 201 + stored element (id assigned here)
 *   PUT    /subscriptions/:id    body = every field → 200 + the same element, updated in place
 *   DELETE /subscriptions/:id    only the id, in the URL → 204
 *
 * Errors are `{ "error": { "code", "message", "fields"? } }`. Clients send `X-Client-Id`; it is
 * echoed as `origin` in the WebSocket messages so an app can skip the echo of its own changes.
 */
export function createApp({ store, logger, delayMs = 0 }) {
  const server = createServer((req, res) => handle(req, res));
  const wss = new WebSocketServer({ server, path: '/ws' });
  let nextConnection = 1;

  wss.on('connection', (socket, req) => {
    const connection = nextConnection++;
    logger.info(`WS  #${connection} connected from ${req.socket.remoteAddress} (${wss.clients.size} open)`);
    socket.on('close', () => logger.info(`WS  #${connection} disconnected (${wss.clients.size} open)`));
    socket.on('error', (error) => logger.error(`WS  #${connection} error`, error.message));
  });

  function broadcast(message) {
    const data = JSON.stringify(message);
    let sent = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        sent++;
      }
    });
    logger.debug(`WS  broadcast ${message.type} to ${sent} client(s)`, data);
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  async function route(req, res, origin) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const parts = pathname.split('/').filter(Boolean);

    if (pathname === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });
    if (parts[0] !== 'subscriptions' || parts.length > 2) {
      throw new HttpError(404, 'NO_ROUTE', `No route for ${req.method} ${pathname}`);
    }

    if (parts.length === 1) {
      if (req.method === 'GET') {
        const items = store.all();
        logger.debug(`READ all → ${items.length} subscription(s)`);
        return send(res, 200, items);
      }
      if (req.method === 'POST') {
        const { value, errors } = validateSubscription(await readJson(req));
        if (errors) throw new HttpError(400, 'VALIDATION_FAILED', 'Some fields are not valid', errors);
        const created = await store.create(value);
        logger.debug(`CREATE id=${created.id} "${created.name}"`);
        send(res, 201, created);
        return broadcast({ type: 'created', subscription: created, origin });
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on /subscriptions`);
    }

    const id = parseId(parts[1]);
    if (req.method === 'GET') {
      const item = store.get(id);
      if (!item) throw notFound(id);
      logger.debug(`READ id=${id}`);
      return send(res, 200, item);
    }
    if (req.method === 'PUT') {
      const { value, errors } = validateSubscription(await readJson(req));
      if (errors) throw new HttpError(400, 'VALIDATION_FAILED', 'Some fields are not valid', errors);
      const updated = await store.update(id, value);
      if (!updated) throw notFound(id);
      logger.debug(`UPDATE id=${id} "${updated.name}"`);
      send(res, 200, updated);
      return broadcast({ type: 'updated', subscription: updated, origin });
    }
    if (req.method === 'DELETE') {
      if (!(await store.delete(id))) throw notFound(id);
      logger.debug(`DELETE id=${id}`);
      send(res, 204);
      return broadcast({ type: 'deleted', id, origin });
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on /subscriptions/${id}`);
  }

  async function handle(req, res) {
    const started = Date.now();
    const origin = req.headers['x-client-id'] || null;
    logger.info(`--> ${req.method} ${req.url}${origin ? ` (client ${origin})` : ''}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Client-Id',
      });
      res.end();
    } else {
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        await route(req, res, origin);
      } catch (error) {
        if (error instanceof HttpError) {
          logger.warn(`${req.method} ${req.url} rejected: ${error.code} ${error.message}`, error.fields);
          send(res, error.status, { error: { code: error.code, message: error.message, fields: error.fields } });
        } else {
          logger.error(`${req.method} ${req.url} failed`, error);
          send(res, 500, { error: { code: 'INTERNAL', message: 'Internal server error' } });
        }
      }
    }
    logger.info(`<-- ${req.method} ${req.url} ${res.statusCode} (${Date.now() - started} ms)`);
  }

  return {
    server,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      wss.clients.forEach((client) => client.terminate());
      return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    },
  };
}
