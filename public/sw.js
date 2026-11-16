const VERSION='relay-shell-__BUILD__';
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(VERSION),response=await fetch('/'),html=await response.text();
 await cache.put('/',new Response(html,{headers:{'Content-Type':'text/html'}}));
 const assets=[...html.matchAll(/(?:src|href)="(\/(?:assets|fonts)\/[^"?]+)"/g)].map(m=>m[1]);
 await cache.addAll([...new Set([...assets,'/favicon.svg','/manifest.webmanifest'])]);
 self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('relay-shell-')&&key!==VERSION)await caches.delete(key);await self.clients.claim()})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 // Recordings, authenticated API responses and review pages are never cached.
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(async()=>await caches.match('/')||Response.error()));return}
 if(!/^\/(assets|fonts)\//.test(url.pathname)&&!['/favicon.svg','/manifest.webmanifest'].includes(url.pathname))return;
 event.respondWith((async()=>{const cache=await caches.open(VERSION),saved=await cache.match(event.request);if(saved)return saved;const response=await fetch(event.request);if(response.ok)await cache.put(event.request,response.clone());return response})());
});
