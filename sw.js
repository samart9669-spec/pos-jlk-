// service worker: เก็บตัวแอปไว้ในเครื่อง (ใช้ได้ออฟไลน์) + ซิงก์เบื้องหลังบน Android
importScripts('config.js', 'core.js');

const CACHE = 'moo-prio-pos-v9';
const SHELL = ['./', 'index.html', 'app.js', 'core.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return; // Supabase ผ่านตรง
  // ไฟล์ของแอป: ใช้ของในเครื่องก่อน แล้วอัปเดตเงียบๆ ในพื้นหลัง
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => {
    const net = fetch(r).then(res => { if (res.ok) caches.open(CACHE).then(c => c.put(r, res.clone())); return res; }).catch(() => hit);
    return hit || net;
  }));
});

// Android: ส่งอัตโนมัติเมื่อสัญญาณกลับมา / ตามรอบ (ถ้า Chrome อนุญาต)
self.addEventListener('sync', e => { if (e.tag === 'pos-sync') e.waitUntil(POS.syncNow()); });
self.addEventListener('periodicsync', e => { if (e.tag === 'pos-hourly') e.waitUntil(POS.syncNow()); });
