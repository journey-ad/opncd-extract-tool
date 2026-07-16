const vfsMap = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const { type, jobId } = e.data;
  if (type === 'set-vfs') {
    vfsMap.set(jobId, e.data.files);
    e.ports[0]?.postMessage({ ok: true });
  } else if (type === 'clear-vfs') {
    vfsMap.delete(jobId);
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const m = url.pathname.match(/^\/preview\/([^/]+)\/(.*)$/);
  if (!m) return;
  const [, jobId, path] = m;
  const fs = vfsMap.get(jobId);
  if (!fs) {
    e.respondWith(new Response('VFS not ready', { status: 503 }));
    return;
  }
  const entry = fs[path] || fs[path.replace(/\/$/, '') + 'index.html'];
  if (!entry) {
    e.respondWith(new Response('Not found: ' + path, { status: 404 }));
    return;
  }
  e.respondWith(new Response(entry.blob, {
    headers: { 'Content-Type': entry.mime },
  }));
});
