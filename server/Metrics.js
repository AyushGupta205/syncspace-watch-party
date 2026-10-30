export class ServerMetrics {
  constructor() {
    this.startedAt = Date.now();
    this.counters = {
      connectionsAccepted: 0,
      connectionsRejected: 0,
      roomsCreated: 0,
      participantsJoined: 0,
      roomResumes: 0,
      playbackUpdates: 0,
      playbackRequestsCreated: 0,
      playbackRequestsApproved: 0,
      playbackRequestsRejected: 0,
      rejectedActions: 0,
      chatMessages: 0,
    };
  }

  increment(name) {
    if (Object.hasOwn(this.counters, name)) {
      this.counters[name] += 1;
    }
  }

  snapshot({ activeConnections, activeRooms }) {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeConnections,
      activeRooms,
      counters: { ...this.counters },
    };
  }
}
