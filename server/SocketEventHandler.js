import { randomUUID } from 'node:crypto';
import { clientAddress } from './clientAddress.js';

const VIDEO_ID = /^[\w-]{11}$/;
const ROOM_ID = /^[A-Z0-9]{6}$/;
const PLAYBACK_REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_PLAYBACK_REQUESTS_PER_ROOM = 20;
const objectPayload = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const playbackTime = (data) =>
  Object.hasOwn(data, 'time') ? data.time : data.currentTime;

const safeName = (value) =>
  (typeof value === 'string' ? value : '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);

export class SocketEventHandler {
  constructor({ io, roomManager, messageHandler, metrics }) {
    this.io = io;
    this.roomManager = roomManager;
    this.messageHandler = messageHandler;
    this.metrics = metrics;
    this.playbackRequests = new Map();
    this.playbackRequestTimers = new Map();
  }

  reject(socket, message) {
    this.metrics?.increment('rejectedActions');
    socket.emit('action_rejected', { message, error: message });
  }

  payload(room, member) {
    const result = {
      roomId: room.id,
      self: member.toJSON(true),
      participants: room.listParticipants(),
      state: room.getState ? room.getState() : room.state,
    };
    if (room.hasControl(member.socketId)) {
      result.pendingPlaybackRequests = this.getPendingPlaybackRequests(room.id);
    }
    return result;
  }

  broadcastPeople(room) {
    this.io.to(room.id).emit('participants_updated', room.listParticipants());
  }

  getPendingPlaybackRequests(roomId) {
    const requests = this.playbackRequests.get(roomId);
    if (!requests) return [];
    const now = Date.now();
    for (const [id, request] of requests) {
      if (now - request.createdAt > PLAYBACK_REQUEST_TTL_MS) {
        requests.delete(id);
        this.clearPlaybackRequestTimer(id);
      }
    }
    if (!requests.size) this.playbackRequests.delete(roomId);
    return [...requests.values()];
  }

  clearPlaybackRequestTimer(requestId) {
    const timer = this.playbackRequestTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.playbackRequestTimers.delete(requestId);
  }

  clearPlaybackRequests(roomId) {
    const requests = this.playbackRequests.get(roomId);
    if (requests) {
      for (const requestId of requests.keys()) this.clearPlaybackRequestTimer(requestId);
    }
    this.playbackRequests.delete(roomId);
  }

  prunePlaybackRequests() {
    for (const roomId of this.playbackRequests.keys()) {
      if (!this.roomManager.getRoom(roomId)) this.clearPlaybackRequests(roomId);
    }
  }

  expirePlaybackRequest(roomId, requestId) {
    const requests = this.playbackRequests.get(roomId);
    const request = requests?.get(requestId);
    if (!request) return;
    requests.delete(requestId);
    if (!requests.size) this.playbackRequests.delete(roomId);
    this.clearPlaybackRequestTimer(requestId);
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;
    this.notifyPlaybackRequestApprovers(room, 'playback_request_resolved', {
      requestId,
      decision: 'expired',
    });
    const requester = room.getParticipantById(request.requesterId);
    if (requester?.connected) {
      this.io.to(requester.socketId).emit('playback_request_result', {
        requestId,
        decision: 'expired',
      });
    }
  }

  notifyPlaybackRequestApprovers(room, event, data) {
    for (const participant of room.participants.values()) {
      if (participant.connected && room.hasControl(participant.socketId)) {
        this.io.to(participant.socketId).emit(event, data);
      }
    }
  }

  cancelPlaybackRequests(room, requesterId) {
    const requests = this.playbackRequests.get(room.id);
    if (!requests) return;
    for (const [id, request] of requests) {
      if (request.requesterId === requesterId) {
        requests.delete(id);
        this.clearPlaybackRequestTimer(id);
        this.notifyPlaybackRequestApprovers(room, 'playback_request_resolved', {
          requestId: id,
          decision: 'cancelled',
        });
      }
    }
    if (!requests.size) this.playbackRequests.delete(room.id);
  }

  validateRequestedPlayback(data, room) {
    if (!['play', 'pause', 'seek', 'video'].includes(data.type)) {
      return { error: 'Choose a valid playback change to request.' };
    }
    if (data.type === 'video') {
      if (typeof data.videoId !== 'string' || !VIDEO_ID.test(data.videoId)) {
        return { error: 'Enter a valid YouTube video ID or link.' };
      }
      return { action: { type: 'video', videoId: data.videoId } };
    }
    if (data.type === 'seek') {
      if (!Number.isFinite(data.time) || data.time < 0 || data.time > 86400) {
        return { error: 'Enter a playback position between 0 and 86400 seconds.' };
      }
      return { action: { type: 'seek', time: data.time } };
    }
    const time = data.time === undefined ? room.getState().currentTime : data.time;
    if (!Number.isFinite(time) || time < 0 || time > 86400) {
      return { error: 'Invalid playback position.' };
    }
    return { action: { type: data.type, time } };
  }

  applyPlayback(room, action) {
    const update =
      action.type === 'video'
        ? { videoId: action.videoId, currentTime: 0, isPlaying: false }
        : action.type === 'play'
        ? { isPlaying: true, currentTime: action.time }
        : action.type === 'pause'
        ? { isPlaying: false, currentTime: action.time }
        : { currentTime: action.time };
    const state = room.setState(update);
    this.metrics?.increment('playbackUpdates');
    this.io.to(room.id).emit('sync_state', state);
  }

  enter(socket, room, username, reply) {
    if (!username) {
      return reply?.({ error: 'Choose a display name to continue.' });
    }
    if (room.getParticipant(socket.id)) {
      return reply?.({ error: 'You are already in this room.' });
    }
    if (room.hasUsername(username)) {
      return reply?.({ error: 'That display name is already in this room.' });
    }

    const member = room.addParticipant(socket.id, username);
    this.metrics?.increment('participantsJoined');
    socket.join(room.id);
    const result = this.payload(room, member);
    reply?.(result);
    socket.emit('room_joined', result);
    socket.to(room.id).emit('user_joined', {
      username: member.username,
      userId: member.id,
      role: member.role,
      participant: member.toJSON(false),
    });
  }

  handlePlayback(socket, data = {}) {
    const room = this.roomManager.getRoom(data.roomId);
    if (!room?.getParticipant(socket.id)) {
      return this.reject(socket, 'You are not a member of this room.');
    }
    if (!room.hasControl(socket.id)) {
      return this.reject(socket, 'Only a host or moderator can control playback.');
    }
    if (!this.messageHandler.checkRateLimit(socket.id, {
      event: 'playback',
      maxPerWindow: 20,
      windowMs: 2000,
    })) {
      return this.reject(socket, 'Playback controls are being used too quickly.');
    }
    if (!['play', 'pause', 'seek', 'video'].includes(data.type)) {
      return this.reject(socket, 'Unknown playback action.');
    }
    if (data.type === 'video' && (typeof data.videoId !== 'string' || !VIDEO_ID.test(data.videoId))) {
      return this.reject(socket, 'Invalid YouTube video ID.');
    }

    const targetTime = playbackTime(data) ?? room.getState().currentTime;
    if (data.type !== 'video' && (!Number.isFinite(targetTime) || targetTime < 0 || targetTime > 86400)) {
      return this.reject(socket, 'Invalid playback position.');
    }

    this.applyPlayback(room, {
      type: data.type,
      time: targetTime,
      videoId: data.videoId,
    });
  }

  register(socket) {
    // 1. Room Creation
    socket.on('create_room', (rawData = {}, reply) => {
      const data = objectPayload(rawData);
      const clientIp = clientAddress(socket);
      if (!this.roomManager.checkCreateRateLimit(clientIp, 10, 60000)) {
        return reply?.({ error: 'Too many rooms created recently. Please wait a minute.' });
      }

      const username = safeName(data.username);
      if (!username) {
        return reply?.({ error: 'Choose a display name to continue.' });
      }
      const videoId = String(data.videoId || '');
      if (videoId && !VIDEO_ID.test(videoId)) {
        return reply?.({ error: 'Paste a valid YouTube link or video ID.' });
      }

      const room = this.roomManager.createRoom(videoId);
      if (!room) {
        return reply?.({ error: 'The server has reached its active room limit.' });
      }
      this.metrics?.increment('roomsCreated');
      this.enter(socket, room, username, reply);
    });

    // 2. Room Joining
    socket.on('join_room', (rawData = {}, reply) => {
      const data = objectPayload(rawData);
      const clientIp = clientAddress(socket);
      if (!this.roomManager.checkJoinRateLimit(clientIp)) {
        return reply?.({ error: 'Too many room join attempts. Please wait a minute.' });
      }
      const roomId = String(data.roomId || '').trim().toUpperCase();
      const room = this.roomManager.getRoom(roomId);
      if (!ROOM_ID.test(roomId) || !room) {
        return reply?.({ error: 'Room not found. Check the six-character room code.' });
      }
      if (room.participants.size >= this.roomManager.maxParticipants) {
        return reply?.({ error: 'This room has reached its participant limit.' });
      }
      this.enter(socket, room, safeName(data.username), reply);
    });

    // 3. Resume Session
    socket.on('resume_room', (rawData = {}, reply) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const member = room?.resumeParticipant(socket.id, String(data.sessionToken || ''));
      if (!member) {
        return reply?.({ error: 'Your previous room session has expired.' });
      }
      this.metrics?.increment('roomResumes');
      socket.join(room.id);
      const result = this.payload(room, member);
      reply?.(result);
      socket.emit('room_joined', result);
      this.broadcastPeople(room);
    });

    // 4. Leave Room
    socket.on('leave_room', (rawData = {}) => {
      const { roomId } = objectPayload(rawData);
      const room = this.roomManager.getRoom(roomId);
      const member = room?.getParticipant(socket.id);
      if (!member) return;
      const wasHost = member.role === 'host';
      this.cancelPlaybackRequests(room, member.id);
      room.removeParticipant(member.id);
      socket.leave(room.id);
      this.io.to(room.id).emit('user_left', {
        username: member.username,
        userId: member.id,
      });
      if (!room.participants.size) {
        this.clearPlaybackRequests(room.id);
        this.roomManager.deleteRoom(room.id);
      } else {
        const host = [...room.participants.values()].find((person) => person.role === 'host');
        if (wasHost && host) {
          this.broadcastPeople(room);
          this.notifyPlaybackRequestApprovers(
            room,
            'pending_playback_requests',
            this.getPendingPlaybackRequests(room.id)
          );
          this.io.to(room.id).emit('host_changed', {
            userId: host.id,
            username: host.username,
          });
        }
      }
    });

    // 5. Playback Handlers
    socket.on('playback', (rawData = {}) => this.handlePlayback(socket, objectPayload(rawData)));
    socket.on('play', (rawData = {}) => {
      const data = objectPayload(rawData);
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'play',
        time: playbackTime(data),
      });
    });
    socket.on('pause', (rawData = {}) => {
      const data = objectPayload(rawData);
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'pause',
        time: playbackTime(data),
      });
    });
    socket.on('seek', (rawData = {}) => {
      const data = objectPayload(rawData);
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'seek',
        time: playbackTime(data),
      });
    });
    socket.on('change_video', (rawData = {}) => {
      const data = objectPayload(rawData);
      this.handlePlayback(socket, {
        roomId: data.roomId,
        type: 'video',
        videoId: data.videoId,
      });
    });

    socket.on('request_playback_change', (rawData = {}, reply) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const requester = room?.getParticipant(socket.id);
      if (!room || !requester) {
        return reply?.({ error: 'You must be in this room to request a change.' });
      }
      if (requester.role !== 'participant') {
        return reply?.({ error: 'Hosts and moderators can control playback directly.' });
      }
      if (!this.messageHandler.checkRateLimit(socket.id, {
        event: 'playback_request',
        maxPerWindow: 3,
        windowMs: 60000,
      })) {
        return reply?.({ error: 'You have made too many requests. Please wait a minute.' });
      }

      const validated = this.validateRequestedPlayback(data, room);
      if (validated.error) return reply?.({ error: validated.error });
      const requests = this.getPendingPlaybackRequests(room.id);
      if (requests.length >= MAX_PLAYBACK_REQUESTS_PER_ROOM) {
        return reply?.({ error: 'This room already has too many pending requests.' });
      }

      const request = {
        id: randomUUID(),
        requesterId: requester.id,
        requesterName: requester.username,
        action: validated.action,
        createdAt: Date.now(),
      };
      const roomRequests = this.playbackRequests.get(room.id) || new Map();
      roomRequests.set(request.id, request);
      this.playbackRequests.set(room.id, roomRequests);
      const expiryTimer = setTimeout(
        () => this.expirePlaybackRequest(room.id, request.id),
        PLAYBACK_REQUEST_TTL_MS
      );
      expiryTimer.unref();
      this.playbackRequestTimers.set(request.id, expiryTimer);
      this.metrics?.increment('playbackRequestsCreated');
      const publicRequest = { ...request, action: { ...request.action } };
      this.notifyPlaybackRequestApprovers(room, 'playback_change_requested', publicRequest);
      reply?.({ requestId: request.id });
    });

    socket.on('resolve_playback_request', (rawData = {}) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const approver = room?.getParticipant(socket.id);
      if (!room || !approver || !room.hasControl(socket.id)) {
        return this.reject(socket, 'Only the host or a moderator can review playback requests.');
      }
      if (!this.messageHandler.checkRateLimit(socket.id, {
        event: 'playback_approval',
        maxPerWindow: 20,
        windowMs: 2000,
      })) {
        return this.reject(socket, 'Playback requests are being reviewed too quickly.');
      }
      if (typeof data.requestId !== 'string' || !['approve', 'reject'].includes(data.decision)) {
        return this.reject(socket, 'Invalid playback request decision.');
      }

      const requests = this.playbackRequests.get(room.id);
      const request = requests?.get(data.requestId);
      if (!request || Date.now() - request.createdAt > PLAYBACK_REQUEST_TTL_MS) {
        requests?.delete(data.requestId);
        this.clearPlaybackRequestTimer(data.requestId);
        if (requests && !requests.size) this.playbackRequests.delete(room.id);
        return this.reject(socket, 'That playback request has expired or was already handled.');
      }

      const requester = room.getParticipantById(request.requesterId);
      if (!requester || requester.role !== 'participant' || !requester.connected) {
        requests.delete(request.id);
        this.clearPlaybackRequestTimer(request.id);
        this.notifyPlaybackRequestApprovers(room, 'playback_request_resolved', {
          requestId: request.id,
          decision: 'expired',
        });
        if (!requests.size) this.playbackRequests.delete(room.id);
        return this.reject(socket, 'The requester is no longer available.');
      }

      requests.delete(request.id);
      this.clearPlaybackRequestTimer(request.id);
      if (!requests.size) this.playbackRequests.delete(room.id);
      this.notifyPlaybackRequestApprovers(room, 'playback_request_resolved', {
        requestId: request.id,
        decision: data.decision,
      });
      this.io.to(requester.socketId).emit('playback_request_result', {
        requestId: request.id,
        decision: data.decision,
      });
      if (data.decision === 'approve') {
        this.metrics?.increment('playbackRequestsApproved');
        this.applyPlayback(room, request.action);
      } else {
        this.metrics?.increment('playbackRequestsRejected');
      }
    });

    // 6. Role Assignment (Host only)
    socket.on('assign_role', (rawData = {}) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      if (!room?.isHost(socket.id)) {
        return this.reject(socket, 'Only the host can change roles.');
      }
      if (!this.messageHandler.checkRateLimit(socket.id, {
        event: 'room_management',
        maxPerWindow: 10,
        windowMs: 2000,
      })) {
        return this.reject(socket, 'Room management actions are being used too quickly.');
      }
      const targetId = data.userId || data.targetId;
      const member = room.getParticipantById(targetId);
      if (!member || member.id === room.getParticipant(socket.id).id ||
          !['moderator', 'participant'].includes(data.role)) {
        return this.reject(socket, 'Invalid role change.');
      }
      if (room.assignRole(member.id, data.role)) {
        this.cancelPlaybackRequests(room, member.id);
        this.broadcastPeople(room);
        this.notifyPlaybackRequestApprovers(
          room,
          'pending_playback_requests',
          this.getPendingPlaybackRequests(room.id)
        );
        this.io.to(room.id).emit('role_assigned', {
          userId: member.id,
          username: member.username,
          role: member.role,
          participants: room.listParticipants(),
        });
      }
    });

    // 7. Host Transfer (Host only)
    socket.on('transfer_host', (rawData = {}) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const actor = room?.getParticipant(socket.id);
      if (!room || actor?.role !== 'host') {
        return this.reject(socket, 'Only the host can transfer host ownership.');
      }
      const member = room.getParticipantById(data.userId);
      if (!member || !member.connected || member.id === actor.id) {
        return this.reject(socket, 'Invalid host transfer target.');
      }
      if (!this.messageHandler.checkRateLimit(socket.id, {
        event: 'room_management',
        maxPerWindow: 10,
        windowMs: 2000,
      })) {
        return this.reject(socket, 'Room management actions are being used too quickly.');
      }
      if (room.transferHost(member.id)) {
        this.cancelPlaybackRequests(room, member.id);
        this.broadcastPeople(room);
        this.notifyPlaybackRequestApprovers(
          room,
          'pending_playback_requests',
          this.getPendingPlaybackRequests(room.id)
        );
        this.io.to(room.id).emit('role_assigned', {
          userId: member.id,
          username: member.username,
          role: 'host',
          participants: room.listParticipants(),
        });
      }
    });

    // 8. Participant Removal (Host only)
    socket.on('remove_participant', (rawData = {}) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const actor = room?.getParticipant(socket.id);
      if (!room || !actor?.role || actor.role !== 'host') {
        return this.reject(socket, 'Only the host can remove other participants.');
      }
      if (!this.messageHandler.checkRateLimit(socket.id, {
        event: 'room_management',
        maxPerWindow: 10,
        windowMs: 2000,
      })) {
        return this.reject(socket, 'Room management actions are being used too quickly.');
      }
      const member = room.getParticipantById(data.userId);
      if (!member || member.id === actor.id) {
        return this.reject(socket, 'Only the host can remove other participants.');
      }

      this.cancelPlaybackRequests(room, member.id);
      room.removeParticipant(member.id);
      for (const connectedSocket of this.io.sockets.sockets.values()) {
        if (
          connectedSocket.rooms.has(room.id) &&
          !room.getParticipant(connectedSocket.id)
        ) {
          connectedSocket.emit('removed_from_room');
          connectedSocket.leave(room.id);
        }
      }
      this.io.to(room.id).emit('participant_removed', { userId: member.id });
    });

    // 9. Emoji Reactions
    socket.on('reaction', (rawData = {}) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const member = room?.getParticipant(socket.id);
      if (!room || !member) return;
      if (!this.messageHandler.checkRateLimit(socket.id, {
        event: 'reaction',
        maxPerWindow: 10,
        windowMs: 2000,
      })) {
        return this.reject(socket, 'Reactions are being sent too quickly.');
      }

      const reaction = this.messageHandler.createReaction({
        socketId: socket.id,
        username: member.username,
        emoji: data.emoji,
      });

      if (!reaction) return this.reject(socket, 'Invalid reaction.');
      this.io.to(room.id).emit('reaction', reaction);
    });

    // 10. Room Chat
    socket.on('chat', (rawData = {}) => {
      const data = objectPayload(rawData);
      const room = this.roomManager.getRoom(data.roomId);
      const member = room?.getParticipant(socket.id);
      if (!room || !member) return;

      if (!this.messageHandler.checkRateLimit(socket.id, { event: 'chat' })) {
        return socket.emit('chat_rate_limited', {
          error: 'You are sending messages too quickly. Please wait a moment.',
        });
      }

      const msg = this.messageHandler.createMessage({
        socketId: socket.id,
        username: member.username,
        text: data.text || data.message || '',
      });

      if (msg) {
        this.metrics?.increment('chatMessages');
        this.io.to(room.id).emit('chat_message', msg);
      }
    });

    // 11. Disconnect
    socket.on('disconnect', () => {
      this.messageHandler.cleanupSocket(socket.id);
      for (const room of this.roomManager.rooms.values()) {
        const wasHost = room.getParticipant(socket.id)?.role === 'host';
        const member = room.disconnect(socket.id);
        if (member) {
          this.io.to(room.id).emit('participant_disconnected', {
            userId: member.id,
            connected: false,
          });
          const host = [...room.participants.values()].find((member) => member.role === 'host');
          if (wasHost && host?.connected && host.socketId !== socket.id) {
            this.broadcastPeople(room);
            this.notifyPlaybackRequestApprovers(
              room,
              'pending_playback_requests',
              this.getPendingPlaybackRequests(room.id)
            );
            this.io.to(room.id).emit('host_changed', {
              userId: host.id,
              username: host.username,
            });
          }
        }
      }
    });
  }

  close() {
    for (const timer of this.playbackRequestTimers.values()) clearTimeout(timer);
    this.playbackRequestTimers.clear();
    this.playbackRequests.clear();
  }
}
