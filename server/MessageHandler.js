const ALLOWED_REACTIONS = new Set(['🔥', '❤️', '😂', '👏', '🎉', '😮']);

export class MessageHandler {
  constructor({ maxLen = 500, maxPerWindow = 5, windowMs = 2000 } = {}) {
    this.maxLen = maxLen;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.rateMap = new Map(); // socketId -> array of timestamps
  }

  checkRateLimit(
    socketId,
    { event = 'chat', maxPerWindow = this.maxPerWindow, windowMs = this.windowMs, now = Date.now() } = {}
  ) {
    let socketLimits = this.rateMap.get(socketId);
    if (!socketLimits) {
      socketLimits = new Map();
      this.rateMap.set(socketId, socketLimits);
    }
    const timestamps = (socketLimits.get(event) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxPerWindow) {
      socketLimits.set(event, timestamps);
      return false;
    }
    timestamps.push(now);
    socketLimits.set(event, timestamps);
    return true;
  }

  cleanupSocket(socketId) {
    this.rateMap.delete(socketId);
  }

  validateAndSanitize(rawText) {
    if (typeof rawText !== 'string') return '';
    const trimmed = rawText.trim();
    if (!trimmed) return '';
    return trimmed.slice(0, this.maxLen);
  }

  createMessage({ socketId, username, text }) {
    const sanitized = this.validateAndSanitize(text);
    if (!sanitized) return null;
    const now = Date.now();
    return {
      id: `${socketId}-${now}-${Math.random().toString(36).slice(2, 6)}`,
      username,
      text: sanitized,
      message: sanitized,
      time: now,
      timestamp: now,
    };
  }

  createReaction({ socketId, username, emoji }) {
    if (typeof emoji !== 'string' || !ALLOWED_REACTIONS.has(emoji)) return null;
    const cleanEmoji = emoji;
    const now = Date.now();
    return {
      id: `rx-${socketId}-${now}-${Math.random().toString(36).slice(2, 6)}`,
      username,
      emoji: cleanEmoji,
      time: now,
    };
  }
}
