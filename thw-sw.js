/* Service Worker der THW-Jugendverwaltung: App offline verfügbar machen.
   Seiten: zuerst Netz (neue Version), ohne Netz aus dem Zwischenspeicher. Symbole/Manifest: aus dem Zwischenspeicher.
   Fremde Adressen (z.B. Wetter) werden nicht zwischengespeichert. Die App-Daten selbst liegen im Browser (localStorage/IndexedDB), nicht hier. */
const CACHE='thw-jv-v1';
const CORE=['./THW_Jugendverwaltung.html','./thw-manifest.webmanifest','./thw-icon-192.png','./thw-icon-512.png','./thw-icon-512-maskable.png','./thw-icon-180.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(CORE.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('thw-jv-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',e=>{if(e.data==='cache-page'&&e.source&&e.source.url){caches.open(CACHE).then(c=>c.add(new Request(e.source.url,{cache:'reload'}))).catch(()=>{});}});
function timeout(ms){return new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms));}
async function pageFromNet(req){
  const c=await caches.open(CACHE);
  try{const res=await Promise.race([fetch(req),timeout(5000)]);if(res&&res.ok)c.put(req,res.clone());return res;}
  catch(err){const m=await c.match(req,{ignoreSearch:true})||await c.match('./THW_Jugendverwaltung.html');
    return m||new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:sans-serif;padding:24px"><h1>Offline</h1><p>Die App wurde auf diesem Gerät noch nicht online geöffnet. Bitte einmal mit Internet öffnen.</p></body>',{headers:{'Content-Type':'text/html;charset=utf-8'}});}
}
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==self.location.origin)return;
  if(r.mode==='navigate'||r.destination==='document'){e.respondWith(pageFromNet(r));return;}
  e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{if(res&&res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put(r,cp));}return res;})));
});
