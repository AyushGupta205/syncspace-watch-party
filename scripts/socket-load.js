import { performance } from 'node:perf_hooks';
import { io as createClient } from 'socket.io-client';

process.env.NODE_ENV = 'test';
process.env.TRUST_PROXY = 'true';

const { createPartyServer } = await import('../server/index.js');
const requestedClients = Number.parseInt(process.argv[2] || '100', 10);
if (!Number.isSafeInteger(requestedClients) || requestedClients < 1 || requestedClients > 1000) {
  throw new Error('Provide a client count between 1 and 1000.');
}

const server = createPartyServer({
  serveClient: false,
  dbPath: ':memory:',
  limits: {
    maxRooms: 1,
    maxParticipants: requestedClients + 1,
    maxConnections: requestedClients + 1,
    maxConnectionsPerAddress: requestedClients + 1,
  },
});
const sockets = [];
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
};
const emitWithAck = (socket, event, data) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 5000);
    socket.emit(event, data, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
const connect = (url, index) =>
  new Promise((resolve, reject) => {
    const socket = createClient(url, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { 'x-forwarded-for': `198.51.100.${(index % 254) + 1}` },
      timeout: 5000,
    });
    sockets.push(socket);
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

try {
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const host = await connect(url, 0);
  const created = await emitWithAck(host, 'create_room', { username: 'LoadHost' });
  if (created.error) throw new Error(created.error);

  const joinLatencies = [];
  const started = performance.now();
  const joined = [];
  const connectionBatchSize = 25;
  for (let offset = 0; offset < requestedClients; offset += connectionBatchSize) {
    const batch = await Promise.all(
      Array.from(
        { length: Math.min(connectionBatchSize, requestedClients - offset) },
        async (_, batchIndex) => {
          const index = offset + batchIndex;
          const socket = await connect(url, index + 1);
          const joinStarted = performance.now();
          const response = await emitWithAck(socket, 'join_room', {
            roomId: created.roomId,
            username: `LoadUser${index}`,
          });
          if (response.error) throw new Error(response.error);
          joinLatencies.push(performance.now() - joinStarted);
          return socket;
        }
      )
    );
    joined.push(...batch);
  }
  const connectionDurationMs = performance.now() - started;

  const syncLatencies = [];
  let latestRevision = 0;
  for (let index = 0; index < 10; index += 1) {
    const updateStarted = performance.now();
    const received = joined.map((socket) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Playback broadcast timed out')), 5000);
      socket.once('sync_state', (state) => {
        clearTimeout(timeout);
        resolve({ state, elapsed: performance.now() - updateStarted });
      });
    }));
    host.emit('playback', { roomId: created.roomId, type: 'seek', time: index + 1 });
    const delivered = await Promise.all(received);
    syncLatencies.push(...delivered.map((item) => item.elapsed));
    if (delivered.some((item) => item.state.revision <= latestRevision)) {
      throw new Error('Playback state revision did not increase.');
    }
    latestRevision = delivered[0].state.revision;
  }

  console.log(JSON.stringify({
    clientCount: requestedClients,
    joinedClients: joined.length,
    joinDurationMs: Number(connectionDurationMs.toFixed(2)),
    joinLatencyMs: {
      p50: percentile(joinLatencies, 0.5),
      p95: percentile(joinLatencies, 0.95),
      max: Number(Math.max(...joinLatencies).toFixed(2)),
    },
    playbackBroadcastLatencyMs: {
      p50: percentile(syncLatencies, 0.5),
      p95: percentile(syncLatencies, 0.95),
      max: Number(Math.max(...syncLatencies).toFixed(2)),
    },
    serverMetrics: server.metrics.snapshot({
      activeConnections: server.io.engine.clientsCount,
      activeRooms: server.roomManager.rooms.size,
    }),
  }, null, 2));
} finally {
  sockets.forEach((socket) => socket.close());
  await server.close();
}
