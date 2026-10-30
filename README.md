# SyncSpace Watch Party

SyncSpace is a single-instance, real-time YouTube watch party application built with React, Node.js, Express, and Socket.IO. Users can create rooms with six-character codes, invite friends via shareable links, and coordinate YouTube playback with role-based access control, live chat, emoji reactions, and SQLite-backed session recovery.

---

## Table of Contents
- [Features](#features)
- [Technology Stack](#technology-stack)
- [System Architecture & OOP Design](#system-architecture--oop-design)
- [Role-Based Access Control (RBAC)](#role-based-access-control-rbac)
- [Real-Time Synchronization Strategy](#real-time-synchronization-strategy)
- [WebSocket Events Reference](#websocket-events-reference)
- [Storage & SQLite Architecture](#storage--sqlite-architecture)
- [Scalability & Redis Multi-Instance Roadmap](#scalability--redis-multi-instance-roadmap)
- [Security, Rate Limiting & Error Handling](#security-rate-limiting--error-handling)
- [Local Setup & Development](#local-setup--development)
- [Automated Testing & Concurrency Benchmarks](#automated-testing--concurrency-benchmarks)
- [Production Deployment (Render / Railway)](#production-deployment-render--railway)
- [Known Limitations](#known-limitations)

---

## Features

- **Room Management**: Instant 6-character room code generation (e.g. `M3RRBS`) with collision avoidance and deep linking via `?room=CODE`.
- **YouTube Player**: Embedded via the official YouTube IFrame Player API (16:9 responsive aspect ratio). Native player controls and keyboard shortcuts are disabled; Host and Moderator playback is driven by synchronized app controls, while Participants can request Host/Moderator approval for play, pause, seek, or video changes.
- **Server-Authoritative Playback**: The server tracks playback time from a state timestamp; clients periodically correct drift. Synchronization is best-effort and depends on network and YouTube player latency.
- **Custom Playback Toolbar**: Quick `−10s` rewind, `+10s` fast-forward, and expandable `Change Video` panel supporting standard URLs, Shorts, embeds, and raw 11-char IDs.
- **Role-Based Access Control (RBAC)**:
  - **Host**: Creator of the room; possesses full room control, video changing, role promotion/demotion, participant removal, and Host ownership transfer.
  - **Moderator**: Authorized by the Host to control playback and change videos.
  - **Participant**: Watch-only viewer with interactive chat and reaction capabilities.
  - **Participant playback requests**: Participants submit a play, pause, seek, or video-change request. Only connected Hosts and Moderators receive the request; an approval applies it to authoritative room state, while rejection or expiry leaves playback unchanged.
- **Live Room Chat**: Real-time group messaging with auto-scroll, formatted timestamps, rate limiting, and system lifecycle announcements (join, leave, promotion, removal).
- **Synchronized Floating Reactions**: Live emoji reaction bar (`🔥`, `❤️`, `😂`, `👏`, `🎉`, `😮`) rendering floating animated reactions across peer players.
- **SQLite Room Storage**: Embedded SQLite engine tracks room metadata, video timelines, and member roles during the application lifecycle.
- **Session Recovery**: 15-minute reconnect grace period using private session tokens. When a host disconnects, a connected moderator is promoted, otherwise the longest-standing connected participant becomes host.

---

## Technology Stack

- **Frontend**: React 19, Vite 7, Vanilla CSS3 (Custom Design System with Dark/Light theme toggle).
- **Backend**: Node.js 22.5+ (Node 25 tested), Express 5, Socket.IO 4.
- **Storage / Persistence**: Embedded SQLite via Node's native `node:sqlite` (`DatabaseSync`); in-memory fallback is limited to non-production environments.
- **Testing**: Node.js Native Test Runner (`node:test`, `node:assert/strict`), Socket.IO client multi-session integration suite.

---

## System Architecture & OOP Design

SyncSpace separates responsibilities cleanly across specialized Object-Oriented classes on the server:

```text
┌─────────────────────────────────────────────────────────────┐
│                       Express 5 Server                      │
│      - HTTP Security Headers (nosniff, referrer, permissions)│
│      - Health Check Endpoint (/api/health)                  │
│      - Static Client Delivery (dist/index.html)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
   ┌───────────────────────────┐ ┌───────────────────────────┐
   │     DatabaseService       │ │      Socket.IO Engine     │
   │  - SQLite (node:sqlite)   │ │  - WebSocket & Polling    │
   │  - Schema Initialization  │ │  - Ping / Pong Heartbeat  │
   │  - Persistent CRUD Ops    │ └─────────────┬─────────────┘
   └────────────▲──────────────┘               │
                │                              ▼
   ┌────────────┴──────────────┐ ┌───────────────────────────┐
   │        RoomManager        │ │    SocketEventHandler     │
   │  - Room Creation & Lookup │ │  - Event Registration     │
   │  - Code Generation        │ │  - RBAC Authorization     │
   │  - Inactivity Pruning     │ │  - Payload Normalization  │
   │  - DB State Restoration   │ └─────────────┬─────────────┘
   └────────────▲──────────────┘               │
                │                              │
         ┌──────┴──────┐                       ▼
         ▼             ▼         ┌───────────────────────────┐
   ┌───────────┐ ┌───────────┐   │      MessageHandler       │
   │   Room    │ │Participant│   │  - Chat Validation & XSS  │
   │ - Timeline│ │ - Identity│   │  - Rate Limit Checking    │
   │ - State   │ │ - Role    │   │  - Emoji Reactions Format │
   │ - Roster  │ │ - Session │   └───────────────────────────┘
   └───────────┘ └───────────┘
```

1. **`Participant` (`server/Participant.js`)**: Encapsulates participant identity, display name, role (`host`, `moderator`, `participant`), socket binding, session token, and connection status.
2. **`Room` (`server/Room.js`)**: Manages the authoritative video state (`videoId`, `currentTime`, `isPlaying`, `playState`, `updatedAt`), participant rosters, and role modifications.
3. **`RoomManager` (`server/RoomManager.js`)**: Handles room lifecycle, cryptographically generated room codes, host succession, inactive room garbage collection, resource limits, rate limiting, and persistence restoration.
4. **`MessageHandler` (`server/MessageHandler.js`)**: Handles message sanitization, length validation, emoji normalization, and chat frequency throttling.
5. **`SocketEventHandler` (`server/SocketEventHandler.js`)**: Registers and routes WebSocket events, enforces server-side RBAC guards, and handles payload delivery.
6. **`DatabaseService` (`server/db.js`)**: Provides persistent storage for room metadata and participant rosters using native SQLite.

---

## Role-Based Access Control (RBAC)

All permission checks are executed server-side. Unpermitted actions are rejected with an explicit `action_rejected` socket emission:

| Feature / Action | Host | Moderator | Participant |
| :--- | :---: | :---: | :---: |
| Play / Pause Video | ✅ | ✅ | ❌ *(Rejected)* |
| Seek Timestamp | ✅ | ✅ | ❌ *(Rejected)* |
| Change Video URL / ID | ✅ | ✅ | ❌ *(Rejected)* |
| Promote to Moderator | ✅ | ❌ | ❌ |
| Demote to Participant | ✅ | ❌ | ❌ |
| Transfer Host Ownership | ✅ | ❌ | ❌ |
| Remove (Kick) Participant| ✅ | ❌ | ❌ |
| Send Chat Messages | ✅ | ✅ | ✅ |
| Send Emoji Reactions | ✅ | ✅ | ✅ |

---

## Real-Time Synchronization Strategy

1. **Authoritative Timeline**: The server maintains the source of truth. Its current playback time advances from a server timestamp while playing. Playback mutations are broadcast as `sync_state`.
2. **Echo Prevention**: Player state callbacks are compared with the current authoritative play/pause state so commands applied from the server are not sent back as duplicate commands.
3. **Drift Correction**: Clients periodically compare player time with the authoritative timeline and seek when drift exceeds 1.5 seconds. This is best-effort rather than frame-accurate synchronization.
4. **Role-aware controls**: The embed disables native controls and keyboard shortcuts for every role. Host and Moderator use custom synchronized controls; Participant iframe interaction is disabled, and playback requests take effect only after a Host or Moderator approves them. Role changes update iframe interaction without remounting the player.

---

## WebSocket Events Reference

| Event Name | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `create_room` | Client → Server | `{ username, videoId? }` | Creates room; client becomes Host. |
| `join_room` | Client → Server | `{ roomId, username }` | Joins room; client becomes Participant. |
| `resume_room` | Client → Server | `{ roomId, sessionToken }` | Resumes session after disconnect. |
| `leave_room` | Client → Server | `{ roomId }` | Gracefully leaves room. |
| `sync_state` | Server → Client | `{ playState, currentTime, videoId, isPlaying, revision }` | Authoritative room playback broadcast; clients ignore stale or duplicate revisions. |
| `play` | Client → Server | `{ roomId, currentTime }` | Starts playback (Host/Mod only). |
| `pause` | Client → Server | `{ roomId, currentTime }` | Pauses playback (Host/Mod only). |
| `seek` | Client → Server | `{ roomId, currentTime }` | Seeks to timestamp (Host/Mod only). |
| `change_video` | Client → Server | `{ roomId, videoId }` | Changes video ID (Host/Mod only). |
| `playback` | Client → Server | `{ roomId, type, time, videoId? }` | Unified playback control route. |
| `request_playback_change` | Client → Server | `{ roomId, type, time?, videoId? }` | Participant requests play, pause, seek, or video change; validated and rate-limited. |
| `playback_change_requested` | Server → Host/Moderators | `{ id, requesterId, requesterName, action, createdAt }` | Notifies connected approvers of a pending request; requests expire after two minutes. |
| `resolve_playback_request` | Client → Server | `{ roomId, requestId, decision }` | Host/Moderator approves or rejects a pending request. |
| `playback_request_resolved` | Server → Host/Moderators | `{ requestId, decision }` | Removes the request from approver queues. |
| `playback_request_result` | Server → Requester | `{ requestId, decision }` | Reports approval, rejection, expiry, or cancellation to the requester. |
| `pending_playback_requests` | Server → Host/Moderators | `[ { id, requesterId, requesterName, action, createdAt } ]` | Refreshes the queue when an active participant gains an approver role. |
| `assign_role` | Client → Server | `{ roomId, userId, role }` | Promotes/demotes member (Host only). |
| `transfer_host` | Client → Server | `{ roomId, userId }` | Transfers Host ownership (Host only). |
| `remove_participant`| Client → Server | `{ roomId, userId }` | Removes disruptive user (Host only). |
| `user_joined` | Server → Client | `{ username, userId, role, participant }` | Incremental participant update when a user joins. |
| `user_left` | Server → Client | `{ username, userId }` | Incremental roster update when a user leaves. |
| `role_assigned` | Server → Client | `{ userId, username, role, participants }` | Broadcast on role change. |
| `participant_removed`| Server → Client | `{ userId }` | Incremental roster update when a user is removed. |
| `removed_from_room` | Server → Client | *(empty)* | Direct notification to removed user. |
| `participants_updated`| Server → Client | `[ { id, username, role, connected } ]` | Full roster broadcast. |
| `chat` | Client → Server | `{ roomId, text/message }` | Sends chat message. |
| `chat_message` | Server → Client | `{ id, username, text, time, timestamp }` | Live chat broadcast. |
| `reaction` | Bi-directional | `{ roomId, emoji, username?, id? }` | Broadcasts floating emoji reaction. |
| `chat_rate_limited` | Server → Client | `{ error }` | Warns user of message flooding. |
| `action_rejected` | Server → Client | `{ message, error }` | Explains permission/validation failure. |
| `host_changed` | Server → Client | `{ userId, username }` | Announces the new Host after ownership succession. |

---

## Storage & SQLite Architecture

SyncSpace integrates a lightweight SQLite storage layer (`server/db.js` using Node's native `DatabaseSync`):
- **Rooms Table**: Tracks `id`, `video_id`, `current_time`, `is_playing`, `created_at`, `updated_at`.
- **Participants Table**: Tracks `id`, `room_id`, `username`, `role`, `session_token`, `joined_at`, `connected`, and `disconnected_at`.
- **Local Storage**: SQLite runs at `DB_PATH`; configure a durable mounted volume in production.
- **Storage Durability**: The Render blueprint uses free-tier ephemeral storage, so its database is lost on sleep/redeployment. Production deployments requiring durable state must mount a persistent volume and point `DB_PATH` to it. The Docker image defaults to `/data/syncspace.db`; mount `/data` as a persistent volume. The health endpoint reports degraded persistence and returns HTTP 503 in production if SQLite cannot initialize, is in-memory, or has reported an error.
- **Schema Evolution**: Participant join-order data is added with an idempotent SQLite column migration at startup; future schema changes should use explicit versioned migrations.
- **Zero-Dependency**: Built on Node's native SQLite engine without requiring C++ node-gyp builds or external database servers.

---

## Scalability & Redis Multi-Instance Roadmap

`npm run load-test -- 100` runs a local, repeatable Socket.IO load check and reports connection/join latency, room-wide playback delivery latency, and server counters. In recorded runs on this workstation, a 250-client room joined in 1.13 seconds (121 ms p95 join acknowledgement) with 12.38 ms p95 room-wide playback delivery. A 1,000-client room joined in 13.18 seconds (572 ms p95 join acknowledgement) with 30.61 ms p95 room-wide playback delivery. These process-level in-memory results do not represent a Render deployment or multi-instance capacity. When scaling horizontally across multiple cloud instances or container replicas:

```text
               ┌─────────────────────────────────────┐
               │         Load Balancer / Proxy       │
               │ Cookie affinity (if polling enabled)│
               └───────────┬──────────────┬──────────┘
                           │              │
             ┌─────────────▼─┐          ┌─▼─────────────┐
             │ Node Instance │          │ Node Instance │
             │     (Pod 1)   │          │     (Pod 2)   │
             └───────┬───────┘          └───────┬───────┘
                     │                          │
                     └───────────┬──────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │   Redis Cluster / DB  │
                     │  - @socket.io/redis-  │
                     │    adapter (Pub/Sub)  │
                     │  - Shared Room Cache  │
                     └───────────────────────┘
```

### Steps to Enable Multi-Instance Redis Adapter:
1. Install the official adapter:
   ```bash
   npm install @socket.io/redis-adapter ioredis
   ```
2. In `server/index.js`, attach the adapter:
   ```javascript
   import { createAdapter } from '@socket.io/redis-adapter';
   import Redis from 'ioredis';

   if (process.env.REDIS_URL) {
     const pubClient = new Redis(process.env.REDIS_URL);
     const subClient = pubClient.duplicate();
     io.adapter(createAdapter(pubClient, subClient));
     console.log('Socket.IO Redis adapter enabled for multi-instance clustering.');
   }
   ```
3. When Socket.IO's HTTP long-polling transport is enabled, configure cookie-based session affinity on the load balancer so all requests for a connection reach the same instance; avoid relying on client-IP affinity where possible. WebSocket-only connections do not need polling request affinity, but reconnects can still land on another instance. In either case, shared room/session state and cross-instance event fanout are required for correct multi-instance behavior.

> This is a future scale-out design, not an implemented mode. The current app keeps room ownership and SQLite state in one process. A Redis Socket.IO adapter alone is insufficient: room state and session ownership must also move to shared storage before running multiple app instances.

Room joins and departures use incremental roster events instead of broadcasting the full participant list on every membership change. This removes repeated full-roster serialization and substantially reduces join-burst payload volume; Socket.IO still fans each join event out to the other room members. Full snapshots remain available for initial joins, role changes, and recovery.

---

## Security, Rate Limiting & Error Handling

- **XSS & Injection Protection**: Usernames and chat messages are strictly validated, sanitized, truncated, and rendered safely via React text nodes (no `dangerouslySetInnerHTML`).
- **Cryptographic Tokens**: Session tokens are generated using `node:crypto` (`randomUUID()`), stored securely in `sessionStorage`, and never broadcast to other room participants.
- **Rate Limiting**:
  - Room Creation: Max 10 attempts per minute per peer address.
  - Room Joining: Max 20 attempts per minute per peer address.
  - Chat: Max 5 messages per 2-second rolling window per socket.
  - Playback and room management: Max 20 / 10 actions per 2 seconds per socket, respectively.
  - Reactions: Max 10 per 2 seconds per socket.
  - Room size, active rooms, total connections, and per-address connections have configurable limits.
- **Origin and Payload Controls**: Production defaults to same-origin browser connections. Set `CLIENT_ORIGIN` to a comma-separated allowlist only when a separate client origin is required. Socket and JSON request payloads have explicit size limits.
- **HTTP Security Headers**: Strict HTTP headers enforced via custom Express middleware:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

## Local Setup & Development

### Prerequisites
- Node.js 22.5 or newer (tested and verified on Node.js 25.1.0; required for `node:sqlite`).

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/AyushGupta205/syncspace.git
cd syncspace
npm install
```

### 2. Start Development Environment
```bash
npm run dev
```
- Frontend starts at: `http://localhost:5173`
- Backend API & Socket server start at: `http://localhost:3005`

### 3. Build & Run Production Locally
```bash
npm run build
npm start
```
The server serves the already-built client at `http://localhost:3005`.

### Docker
```bash
docker build -t syncspace-watch-party .
docker run --rm -p 3005:3005 -v syncspace-data:/data syncspace-watch-party
```
The container runs as a non-root user and has an HTTP health check. Keep `/data` on persistent storage when room recovery across container restarts is required.

### CI
GitHub Actions runs `npm ci`, the Socket.IO test suite, and the production frontend build on pushes and pull requests.

---

## Automated Testing & Concurrency Benchmarks

### 1. Run Unit & Integration Test Suite
```bash
npm test
```
This runs the Socket.IO integration tests and YouTube URL parser tests, including role enforcement, malformed actions, state revisions, persistence recovery, and rate limiting.

### 2. Browser Regression Tests
```bash
npx playwright install chromium
npm run test:e2e
```
The browser suite starts isolated test server/client processes, stubs the third-party YouTube iframe API, and checks participant control restrictions, approval workflow, role transitions, synchronized video changes, player instance continuity, and session recovery after reload.

### 3. Repeatable Local Socket Load Test
```bash
npm run load-test -- 100
```
The optional argument sets the simulated participant count (1–1000). The harness reports p50/p95/max room-join and playback-broadcast latency plus aggregate server counters. It uses an in-memory database and an ephemeral local server; results are not production capacity guarantees.

### Operational Metrics
`GET /api/health` reports service health, persistence degradation, active rooms, and active connections. `GET /api/metrics` exposes aggregate runtime counters without room or participant identifiers. In production the metrics route is unavailable unless `METRICS_TOKEN` is configured; supply it using `Authorization: Bearer <token>` and restrict access at the deployment proxy as well.
Server lifecycle and SQLite failures are emitted as structured JSON log events with timestamps and severity.

---

## Production Deployment (Render / Railway)

SyncSpace requires a persistent Node process for WebSocket connections. Deploy as a **Web Service** (not a static site).

### Deploying to Render (Free Tier)
1. Push this repository to GitHub or GitLab.
2. In Render Dashboard, click **New +** → **Blueprint** and select your repository (`render.yaml` automatically sets `plan: free`).
   *(Or click **New +** → **Web Service** manually).*
3. Configuration settings (handled automatically by `render.yaml`):
   - **Environment**: `Node`
   - **Plan**: `Free`
   - **Build Command**: `npm ci --include=dev && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
4. Environment Variables:
   - `NODE_ENV`: `production`
   - `NODE_VERSION`: `22`
   - `DB_PATH`: `data/syncspace.db`
   - `CLIENT_ORIGIN`: *(Optional: comma-separated browser origins; leave empty to allow same-origin only)*
   - `TRUST_PROXY`: `true` only if a trusted reverse proxy overwrites `X-Forwarded-For`.
5. Click **Apply** / **Create Web Service**. Render will provision the free web service. Verify the health endpoint at `https://your-app-name.onrender.com/api/health`. *(Note: Render may occasionally prompt for standard account identity verification depending on your account standing).*

> **Note on Free-Tier Storage**: Render Free tier uses ephemeral container storage. Its SQLite file resets on sleep/redeployment. Use a paid persistent disk or another durable deployment target when room recovery across restarts is required.

### Deploying to Railway
1. Click **New Project** → **Deploy from GitHub repo**.
2. Railway detects the Node environment automatically.
3. In service **Settings** → **Variables**:
   - Add `CLIENT_ORIGIN` with your Railway generated domain.
   - Set `DB_PATH=data/syncspace.db`.

---

## Known Limitations

1. **Third-Party YouTube Embed Restrictions**: Certain commercial music videos and protected content owners disable embedding on external websites (YouTube error code 101/150). SyncSpace detects these error codes and displays a clear, helpful banner informing users that the owner disabled iframe embedding.
2. **Multi-Instance Redis Setup**: Single-instance deployment utilizes the native in-process room manager and embedded SQLite. Horizontally scaling across multiple server instances requires configuring Redis Pub/Sub adapter as documented in the [Scalability section](#scalability--redis-multi-instance-roadmap).
3. **Local Dev Network Port Binding**: In sandboxed virtualization environments on Windows, loopback network access requires elevated privileges or running commands unsandboxed.
