import { randomInt } from 'node:crypto';
import { Room } from './Room.js';
import { logEvent } from './logger.js';

const ROOM_CODE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export class RoomManager {
  constructor({
    db = null,
    maxRooms = Number(process.env.MAX_ROOMS) || 500,
    maxParticipants = Number(process.env.MAX_PARTICIPANTS_PER_ROOM) || 100,
  } = {}) {
    this.rooms = new Map(); // roomId -> Room
    this.db = db;
    this.maxRooms = maxRooms;
    this.maxParticipants = maxParticipants;
    this.createRateMap = new Map(); // ip or socketId -> timestamps
    this.joinRateMap = new Map();
    this.restoreFromDb();
  }

  generateCode() {
    let id;
    do {
      id = Array.from({ length: 6 }, () =>
        ROOM_CODE_CHARACTERS[randomInt(ROOM_CODE_CHARACTERS.length)]
      ).join('');
    } while (this.rooms.has(id));
    return id;
  }

  createRoom(videoId = '') {
    if (this.rooms.size >= this.maxRooms) return null;
    const id = this.generateCode();
    const room = new Room(id, videoId, { db: this.db });
    this.rooms.set(id, room);
    this.db?.saveRoom(room);
    return room;
  }

  getRoom(roomId) {
    if (!roomId || typeof roomId !== 'string') return null;
    return this.rooms.get(roomId.trim().toUpperCase()) || null;
  }

  deleteRoom(roomId) {
    this.rooms.delete(roomId);
    this.db?.deleteRoom(roomId);
  }

  prune(io) {
    this.cleanupCreateRateMap();
    for (const [roomId, room] of this.rooms) {
      const changed = room.pruneDisconnected();
      if (!room.participants.size) {
        this.deleteRoom(roomId);
      } else if (changed && io) {
        io.to(roomId).emit('participants_updated', room.listParticipants());
      }
    }
  }

  restoreFromDb() {
    if (!this.db) return;
    try {
      const savedRooms = this.db.loadAllRooms();
      for (const r of savedRooms) {
        const room = new Room(r.id, r.videoId, {
          db: this.db,
          createdAt: r.createdAt,
          currentTime: r.currentTime,
          isPlaying: r.isPlaying,
        });
        for (const p of r.participants) {
          room.loadParticipant(p);
        }
        // If room has participants or is fresh, retain it
        if (room.participants.size > 0) {
          this.rooms.set(room.id, room);
        } else {
          this.db.deleteRoom(r.id);
        }
      }
      if (savedRooms.length > 0) {
        logEvent('info', 'rooms_restored', { activeRooms: this.rooms.size });
      }
    } catch (err) {
      logEvent('error', 'room_restore_failed', { message: err?.message });
    }
  }

  checkCreateRateLimit(identifier, limit = 5, windowMs = 60000, now = Date.now()) {
    return this.checkLimit(this.createRateMap, identifier, limit, windowMs, now);
  }

  checkJoinRateLimit(identifier, limit = 20, windowMs = 60000, now = Date.now()) {
    return this.checkLimit(this.joinRateMap, identifier, limit, windowMs, now);
  }

  checkLimit(rateMap, identifier, limit, windowMs, now) {
    if (!rateMap.has(identifier) && rateMap.size >= 10000) return false;
    const timestamps = (rateMap.get(identifier) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      rateMap.set(identifier, timestamps);
      return false;
    }
    timestamps.push(now);
    rateMap.set(identifier, timestamps);
    return true;
  }

  cleanupCreateRateMap(now = Date.now(), windowMs = 60000) {
    for (const rateMap of [this.createRateMap, this.joinRateMap]) {
      for (const [identifier, timestamps] of rateMap) {
        const recent = timestamps.filter((timestamp) => now - timestamp < windowMs);
        if (recent.length) rateMap.set(identifier, recent);
        else rateMap.delete(identifier);
      }
    }
  }
}
