export function clientAddress(socket) {
  const forwardedFor =
    process.env.TRUST_PROXY === 'true'
      ? socket.handshake.headers['x-forwarded-for']
      : null;
  const forwardedAddress = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === 'string'
    ? forwardedFor.split(',')[0].trim()
    : null;
  return forwardedAddress || socket.handshake.address || socket.id;
}
