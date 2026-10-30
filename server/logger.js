export function logEvent(level, event, details = {}) {
  const output = {
    timestamp: new Date().toISOString(),
    level,
    service: 'syncspace-watch-party',
    event,
    ...details,
  };
  console[level](JSON.stringify(output));
}
