import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { DatabaseService } from './db.js';
import { ServerMetrics } from './Metrics.js';
import { RoomManager } from './RoomManager.js';
import { MessageHandler } from './MessageHandler.js';
import { SocketEventHandler } from './SocketEventHandler.js';
import { clientAddress } from './clientAddress.js';
import { logEvent } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const allowedOrigins = (value) => {
  if (value && value.trim() !== '*') {
    const list = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return null;
};

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function createPartyServer({
  clientOrigin = process.env.CLIENT_ORIGIN,
  serveClient = true,
  dbPath = process.env.DB_PATH || (process.env.NODE_ENV === 'test' ? ':memory:' : 'data/syncspace.db'),
  limits = {},
} = {}) {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  const httpServer = createServer(app);
  const originAllowlist = allowedOrigins(clientOrigin);
  const corsOrigin = originAllowlist || (process.env.NODE_ENV === 'production' ? false : true);
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    allowRequest: (request, callback) => {
      const requestOrigin = request.headers.origin;
      const requestProtocol = request.headers['x-forwarded-proto']?.split(',')[0] || 'http';
      const sameOrigin = requestOrigin === `${requestProtocol}://${request.headers.host}`;
      const isAllowed =
        !requestOrigin ||
        originAllowlist?.includes(requestOrigin) ||
        (!originAllowlist && (process.env.NODE_ENV !== 'production' || sameOrigin));
      callback(null, isAllowed);
    },
    maxHttpBufferSize: 16 * 1024,
    // WebSocket upgrade settings for production proxies and low latency
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  const db = new DatabaseService({ dbPath });
  const roomManager = new RoomManager({
    db,
    maxRooms: limits.maxRooms,
    maxParticipants: limits.maxParticipants,
  });
  const messageHandler = new MessageHandler();
  const metrics = new ServerMetrics();
  const socketHandler = new SocketEventHandler({ io, roomManager, messageHandler, metrics });
  const connectionsByAddress = new Map();
  const maxConnections = limits.maxConnections || positiveInteger(process.env.MAX_CONNECTIONS, 5000);
  const maxConnectionsPerAddress =
    limits.maxConnectionsPerAddress || positiveInteger(process.env.MAX_CONNECTIONS_PER_IP, 100);

  const pruneTimer = setInterval(() => {
    roomManager.prune(io);
    socketHandler.prunePlaybackRequests();
  }, 60_000);
  pruneTimer.unref();

  app.disable('x-powered-by');
  app.use((_, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_, res) => {
    const persistence = !db.db
      ? 'memory'
      : db.dbPath === ':memory:'
      ? 'sqlite-memory'
      : 'sqlite';
    const persistenceDegraded =
      !db.db || db.dbPath === ':memory:' || Boolean(db.lastError);
    const ok = !persistenceDegraded || process.env.NODE_ENV !== 'production';
    return res.status(ok ? 200 : 503).json({
      ok,
      service: 'syncspace-watch-party',
      rooms: roomManager.rooms.size,
      activeConnections: io.engine.clientsCount,
      persistence,
      persistenceDegraded,
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now(),
    });
  });

  app.get('/api/metrics', (req, res) => {
    const token = process.env.METRICS_TOKEN;
    if (process.env.NODE_ENV === 'production' && !token) {
      return res.sendStatus(404);
    }
    if (token) {
      const match = req.get('authorization')?.match(/^Bearer\s+(.+)$/i);
      const provided = Buffer.from(match?.[1] || '');
      const expected = Buffer.from(token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return res.sendStatus(401);
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(metrics.snapshot({
      activeConnections: io.engine.clientsCount,
      activeRooms: roomManager.rooms.size,
    }));
  });

  if (serveClient) {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get(/.*/, (_, res) => res.sendFile(path.join(__dirname, '../dist/index.html')));
  }

  io.on('connection', (socket) => {
    const address = clientAddress(socket);
    const addressCount = connectionsByAddress.get(address) || 0;
    if (
      io.engine.clientsCount > maxConnections ||
      addressCount >= maxConnectionsPerAddress
    ) {
      metrics.increment('connectionsRejected');
      socket.disconnect(true);
      return;
    }
    metrics.increment('connectionsAccepted');
    connectionsByAddress.set(address, addressCount + 1);
    socket.once('disconnect', () => {
      const remaining = (connectionsByAddress.get(address) || 1) - 1;
      if (remaining > 0) connectionsByAddress.set(address, remaining);
      else connectionsByAddress.delete(address);
    });
    socketHandler.register(socket);
  });

  const close = async () => {
    clearInterval(pruneTimer);
    socketHandler.close();
    io.close();
    db.close();
    await new Promise((resolve) => httpServer.close(resolve));
  };

  return {
    app,
    httpServer,
    io,
    rooms: roomManager.rooms,
    roomManager,
    db,
    metrics,
    messageHandler,
    socketHandler,
    pruneTimer,
    close,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { httpServer, close } = createPartyServer();
  const port = process.env.PORT || 3005;
  const server = httpServer.listen(port, () =>
    logEvent('info', 'server_listening', { port: Number(port), pid: process.pid })
  );

  const shutdown = async (signal) => {
    logEvent('info', 'server_shutdown_started', { signal });
    await close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
