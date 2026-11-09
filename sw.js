// Offline-Cache: eigene Dateien zuerst aus dem Netz (damit Updates ankommen), Bibliotheken aus dem Cache
const CACHE="l17-v3";
const OWN=["./","index.html","app.js","vorlage.pdf","manifest.webmanifest","icon.svg","icon-180.png","icon-512.png"];
const LIBS=["https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js","https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(OWN).then(()=>Promise.all(LIBS.map(u=>c.add(u).catch(()=>{}))))));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET")return;
  if(u.hostname.includes("open-meteo")||u.hostname.includes("nominatim"))return; // Live-Daten nie cachen
  if(u.origin===location.origin){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)));
  }else{
    e.respondWith(caches.match(e.request).then(m=>m||fetch(e.request).then(r=>{if(r.ok||r.type==="opaque"){const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c))}return r})));
  }
});
