import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logEvent } from './logger.js';

export class DatabaseService {
  constructor({
    dbPath = process.env.DB_PATH || 'data/syncspace.db',
    allowMemoryFallback = process.env.NODE_ENV !== 'production',
  } = {}) {
    this.dbPath = dbPath;
    this.allowMemoryFallback = allowMemoryFallback;
    this.db = null;
    this.lastError = null;
    this.init();
  }

  init() {
    try {
      if (this.dbPath !== ':memory:') {
        const dir = path.dirname(path.resolve(this.dbPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          video_id TEXT,
          current_time REAL DEFAULT 0,
          is_playing INTEGER DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          room_id TEXT,
          username TEXT,
          role TEXT,
          session_token TEXT,
          joined_at INTEGER,
          connected INTEGER DEFAULT 0,
          disconnected_at INTEGER,
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
      `);
      const participantColumns = this.db.prepare('PRAGMA table_info(participants)').all();
      if (!participantColumns.some((column) => column.name === 'joined_at')) {
        this.db.exec('ALTER TABLE participants ADD COLUMN joined_at INTEGER');
        this.db.exec('UPDATE participants SET joined_at = 0 WHERE joined_at IS NULL');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_participants_room_joined ON participants(room_id, joined_at)');
    } catch (err) {
      this.lastError = err;
      if (!this.allowMemoryFallback) {
        throw new Error('SQLite persistence is required but could not be initialized.', { cause: err });
      }
      logEvent('warn', 'sqlite_memory_fallback', { message: err?.message });
      this.db = null;
    }
  }

  saveRoom(room) {
    if (!this.db) return;
    try {
      const state = room.getState ? room.getState() : room.state;
      const stmt = this.db.prepare(`
        INSERT INTO rooms (id, video_id, current_time, is_playing, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          video_id = excluded.video_id,
          current_time = excluded.current_time,
          is_playing = excluded.is_playing,
          updated_at = excluded.updated_at
      `);
      stmt.run(
        room.id,
        state.videoId || '',
        state.currentTime || 0,
        state.isPlaying ? 1 : 0,
        room.createdAt || Date.now(),
        state.updatedAt || Date.now()
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err;
      logEvent('error', 'sqlite_save_room_failed', { message: err?.message });
    }
  }

  saveParticipant(roomId, participant) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO participants (id, room_id, username, role, session_token, joined_at, connected, disconnected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          role = excluded.role,
          joined_at = excluded.joined_at,
          connected = excluded.connected,
          disconnected_at = excluded.disconnected_at
      `);
      stmt.run(
        participant.id,
        roomId,
        participant.username,
        participant.role,
        participant.sessionToken,
        participant.joinedAt ?? Date.now(),
        participant.connected ? 1 : 0,
        participant.disconnectedAt || null
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err;
      logEvent('error', 'sqlite_save_participant_failed', { message: err?.message });
    }
  }

  removeParticipant(participantId) {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM participants WHERE id = ?').run(participantId);
      this.lastError = null;
    } catch (err) {
      this.lastError = err;
      logEvent('error', 'sqlite_remove_participant_failed', { message: err?.message });
    }
  }

  deleteRoom(roomId) {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
      this.lastError = null;
    } catch (err) {
      this.lastError = err;
      logEvent('error', 'sqlite_delete_room_failed', { message: err?.message });
    }
  }

  loadAllRooms() {
    if (!this.db) return [];
    try {
      const rooms = this.db.prepare('SELECT * FROM rooms').all();
      return rooms.map((r) => {
        const parts = this.db.prepare(
          'SELECT * FROM participants WHERE room_id = ? ORDER BY joined_at ASC, rowid ASC'
        ).all(r.id);
        return {
          id: r.id,
          videoId: r.video_id,
          currentTime: r.current_time,
          isPlaying: Boolean(r.is_playing),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          participants: parts.map((p) => ({
            id: p.id,
            username: p.username,
            role: p.role,
            sessionToken: p.session_token,
            joinedAt: p.joined_at ?? p.disconnected_at ?? Date.now(),
            connected: false,
            disconnectedAt: p.disconnected_at || Date.now(),
          })),
        };
      });
    } catch (err) {
      this.lastError = err;
      logEvent('error', 'sqlite_load_rooms_failed', { message: err?.message });
      return [];
    }
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }
}
