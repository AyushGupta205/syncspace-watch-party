export class Participant {
  constructor({
    id,
    username,
    role = 'participant',
    socketId = null,
    sessionToken,
    joinedAt = Date.now(),
    connected = true,
    disconnectedAt = null,
  }) {
    this.id = id;
    this.username = username;
    this.role = role;
    this.socketId = socketId;
    this.sessionToken = sessionToken;
    this.joinedAt = joinedAt;
    this.connected = connected;
    this.disconnectedAt = disconnectedAt;
  }

  setConnected(socketId) {
    this.connected = true;
    this.socketId = socketId;
    this.disconnectedAt = null;
  }

  setDisconnected() {
    this.connected = false;
    this.socketId = null;
    this.disconnectedAt = Date.now();
  }

  isStale(graceMs = 15 * 60 * 1000, now = Date.now()) {
    return !this.connected && this.disconnectedAt && now - this.disconnectedAt > graceMs;
  }

  toJSON(includePrivate = false) {
    const data = {
      id: this.id,
      username: this.username,
      role: this.role,
      joinedAt: this.joinedAt,
      connected: this.connected,
    };
    if (includePrivate) {
      data.sessionToken = this.sessionToken;
    }
    return data;
  }
}
