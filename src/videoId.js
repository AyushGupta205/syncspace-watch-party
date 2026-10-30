export function videoIdFrom(value) {
  let input = String(value || '').trim();
  if (!input) return '';
  if (/^[\w-]{11}$/.test(input)) return input;
  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    input = `https://${input}`;
  }
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      return url.pathname.split('/')[1]?.match(/^[\w-]{11}$/)?.[0] || '';
    }
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return '';
    const candidate =
      url.searchParams.get('v') ||
      url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1];
    return /^[\w-]{11}$/.test(candidate || '') ? candidate : '';
  } catch {
    return '';
  }
}
