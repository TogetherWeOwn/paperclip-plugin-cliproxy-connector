export function permittedRequest(url, method, navigationPath) {
  const parsed = new URL(url);
  if (parsed.origin !== 'http://127.0.0.1:3100') return false;
  if (method === 'GET') return parsed.pathname === navigationPath
    || /^\/(api|assets|_plugins)\//.test(parsed.pathname)
    || ['/favicon.ico', '/favicon.svg'].includes(parsed.pathname);
  return method === 'POST' && /^\/api\/plugins\/[^/]+\/(bridge\/data|data\/[^/]+)$/.test(parsed.pathname);
}
