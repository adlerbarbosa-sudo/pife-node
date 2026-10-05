/* Service worker do Clube do Pife.
 * Estratégia "rede primeiro": sempre tenta a versão nova e só usa o cache se estiver offline.
 * (Antes era "cache primeiro" com versão fixa: depois do 1º acesso o jogador ficava preso numa versão antiga.)
 * Mude VERSION para descartar caches antigos. Nunca intercepta /socket.io nem requisições que não sejam GET. */
const VERSION = 'pife-v2';
const CORE = ['/', '/index.html', '/style.css', '/client.js', '/rules.js', '/manifest.json', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/socket.io')) return;
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(VERSION).then((cache) => cache.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html'))),
    );
});
