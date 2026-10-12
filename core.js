// core.js — ที่เก็บข้อมูลในเครื่อง (IndexedDB), ซิงก์เข้า Supabase, ส่งออก CSV
// ไม่ผูกกับ DOM จึงใช้ร่วมกันทั้งหน้าแอปและ service worker (Background Sync)
(function (g) {
  const DB_NAME = 'moo-prio-pos';
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        const s = db.createObjectStore('bills', { keyPath: 'id' });
        s.createIndex('date', 'business_date');
        s.createIndex('synced', 'synced'); // 0 = รอส่ง, 1 = ส่งแล้ว
        db.createObjectStore('kv');
      };
      r.onsuccess = () => { _db = r.result; resolve(_db); };
      r.onerror = () => reject(r.error);
    });
  }
  function tx(store, mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const kvGet = k => openDB().then(db => req(db.transaction('kv').objectStore('kv').get(k)));
  const kvSet = (k, v) => tx('kv', 'readwrite', s => { s.put(v, k); });

  async function getSettings() {
    const saved = (await kvGet('settings')) || {};
    return Object.assign({}, g.POS_CONFIG, saved);
  }
  async function saveSettings(patch) {
    const cur = (await kvGet('settings')) || {};
    await kvSet('settings', Object.assign(cur, patch));
  }
  async function getMenu() {
    const m = await kvGet('menu');
    return Array.isArray(m) && m.length ? m : g.POS_DEFAULT_MENU;
  }
  const saveMenu = m => kvSet('menu', m);

  // ---------- เวลา (เขตเวลาไทย) ----------
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false });
  const bkkDate = d => fmtDate.format(d || new Date());               // YYYY-MM-DD
  const bkkHour = d => parseInt(fmtHour.format(d || new Date()), 10) % 24;
  const bkkTime = d => new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

  const uuid = () => (g.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });

  // ---------- บิล ----------
  // lines: [{keypad, code, name, price, qty}]
  async function saveBill({ lines, pay, device }) {
    const now = new Date();
    const date = bkkDate(now);
    const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const todays = await billsByDate(date);
    const bill = {
      id: uuid(), seq: todays.length + 1, device: device || '',
      business_date: date, created_at: now.toISOString(), updated_at: now.toISOString(),
      payment_code: pay.n, payment_name: pay.name,
      total, status: 'ok', synced: 0, lines
    };
    await tx('bills', 'readwrite', s => { s.put(bill); });
    return bill;
  }
  const getBill = id => openDB().then(db => req(db.transaction('bills').objectStore('bills').get(id)));
  async function voidBill(id) {
    const b = await getBill(id);
    if (!b || b.status === 'void') return b;
    b.status = 'void'; b.updated_at = new Date().toISOString(); b.synced = 0;
    await tx('bills', 'readwrite', s => { s.put(b); });
    return b;
  }
  const billsByDate = date => openDB().then(db => req(db.transaction('bills').objectStore('bills').index('date').getAll(date)));
  const allBills = () => openDB().then(db => req(db.transaction('bills').objectStore('bills').getAll()));
  const unsynced = () => openDB().then(db => req(db.transaction('bills').objectStore('bills').index('synced').getAll(0)));

  // ---------- ซิงก์ ----------
  const toWire = b => ({
    id: b.id, device: b.device, business_date: b.business_date, created_at: b.created_at, updated_at: b.updated_at,
    payment_code: b.payment_code, payment_name: b.payment_name, total: b.total, status: b.status,
    lines: b.lines.map((l, i) => ({ line_no: i + 1, item_code: l.code, keypad_code: l.keypad, item_name: l.name, price: l.price, qty: l.qty }))
  });

  async function _sync() {
    const s = await getSettings();
    if (!s.supabaseUrl || !s.apiKey || !s.branchId || !s.token) return { ok: false, sent: 0, reason: 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์' };
    const pending = await unsynced();
    if (!pending.length) { await kvSet('lastOk', Date.now()); return { ok: true, sent: 0 }; }
    pending.sort((a, b) => a.created_at < b.created_at ? -1 : 1);
    const url = s.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/submit_bills';
    const headers = { 'Content-Type': 'application/json', apikey: s.apiKey };
    if (s.apiKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + s.apiKey; // คีย์แบบ JWT เดิม
    let sent = 0;
    for (let i = 0; i < pending.length; i += 50) {
      const chunk = pending.slice(i, i + 50);
      let resp;
      try {
        resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ p_branch: s.branchId, p_token: s.token, p_bills: chunk.map(toWire) }) });
      } catch (e) { return { ok: false, sent, reason: 'ออฟไลน์/เชื่อมต่อไม่ได้' }; }
      if (!resp.ok) {
        let t = ''; try { t = (await resp.text()).slice(0, 160); } catch (e) {}
        return { ok: false, sent, reason: 'เซิร์ฟเวอร์ตอบ ' + resp.status + ' ' + t };
      }
      // ทำเครื่องหมายว่าส่งแล้ว เฉพาะบิลที่ไม่ถูกแก้ระหว่างส่ง (เช่น ยกเลิกทันที)
      for (const b of chunk) {
        const cur = await getBill(b.id);
        if (cur && cur.updated_at === b.updated_at) { cur.synced = 1; await tx('bills', 'readwrite', st => { st.put(cur); }); }
      }
      sent += chunk.length;
    }
    await kvSet('lastOk', Date.now());
    return { ok: true, sent };
  }
  // กันซิงก์ซ้อนกัน (หน้าแอป + service worker)
  async function syncNow() {
    await kvSet('lastAttempt', Date.now());
    const run = () => _sync().catch(e => ({ ok: false, sent: 0, reason: String(e && e.message || e) }));
    const r = (g.navigator && navigator.locks) ? await navigator.locks.request('pos-sync', run) : await run();
    await kvSet('nextAttempt', Date.now() + (r.ok ? 60 : 5) * 60000); // สำเร็จ: ชั่วโมงหน้า / ไม่สำเร็จ: ลองใหม่ใน 5 นาที
    await kvSet('lastResult', { at: Date.now(), ok: r.ok, sent: r.sent, reason: r.reason || '' });
    return r;
  }


  // ดึงเมนู/ราคาจากหลังบ้าน (ตั้งที่เว็บหลังบ้าน) — เปลี่ยนแปลงเมื่อมีรายการและต่างจากที่เก็บไว้ คืนค่า true ถ้าเมนูเปลี่ยน
  async function fetchMenu() {
    try {
      const s = await getSettings();
      if (!s.supabaseUrl || !s.apiKey || !s.branchId || !s.token || (g.navigator && navigator.onLine === false)) return false;
      const headers = { 'Content-Type': 'application/json', apikey: s.apiKey };
      if (s.apiKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + s.apiKey;
      const resp = await fetch(s.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/device_get_menu',
        { method: 'POST', headers, body: JSON.stringify({ p_branch: s.branchId, p_token: s.token }) });
      if (!resp.ok) return false;
      const d = await resp.json();
      const items = d && Array.isArray(d.items) ? d.items.filter(x => x && x.keypad && x.name && isFinite(+x.price)) : [];
      if (!items.length) return false;
      const norm = items.map(x => ({ keypad: String(x.keypad), code: x.code || '', name: String(x.name), price: +x.price, group: x.group || 'เมนู' }));
      const cur = await kvGet('menu');
      const changed = JSON.stringify(cur || null) !== JSON.stringify(norm);
      if (changed) { await saveMenu(norm); await saveSettings({ menuIsDummy: false }); }
      await kvSet('menuFetchedAt', Date.now());
      return changed;
    } catch (e) { return false; }
  }

  // ---------- CSV ----------
  const csvCell = v => { const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  // รูปแบบเดียวกับแท็บ Data: date,branch,item_code,item_name,price,qty,amount (นับเฉพาะบิลที่ไม่ยกเลิก)
  function summarizeItems(bills) {
    const m = new Map();
    for (const b of bills) {
      if (b.status !== 'ok') continue;
      for (const l of b.lines) {
        const k = l.code + '|' + l.price;
        const x = m.get(k) || { code: l.code, name: l.name, price: l.price, qty: 0 };
        x.qty += l.qty; m.set(k, x);
      }
    }
    return [...m.values()].sort((a, b) => b.qty - a.qty);
  }
  function buildCsv(date, branchName, bills) {
    const rows = [['date', 'branch', 'item_code', 'item_name', 'price', 'qty', 'amount']];
    for (const x of summarizeItems(bills)) rows.push([date, branchName, x.code, x.name, x.price, x.qty, x.price * x.qty]);
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  // แปลงข้อความเมนู (CSV/แท็บ): keypad,item_code,name,price[,group]
  function parseMenuText(text) {
    const out = [], errors = [];
    text.split(/\r?\n/).forEach((line, i) => {
      line = line.trim(); if (!line) return;
      const p = line.split(/\t|,/).map(x => x.trim());
      if (/^keypad$/i.test(p[0]) || /^เลข/.test(p[0])) return; // แถวหัวตาราง
      const price = Number(p[3]);
      if (p.length < 4 || !p[0] || !p[2] || !isFinite(price)) { errors.push('บรรทัด ' + (i + 1) + ': ' + line); return; }
      out.push({ keypad: p[0], code: p[1] || '', name: p[2], price, group: p[4] || 'เมนู' });
    });
    return { items: out, errors };
  }

  g.POS = { openDB, kvGet, kvSet, getSettings, saveSettings, getMenu, saveMenu, fetchMenu, bkkDate, bkkHour, bkkTime, uuid,
            saveBill, getBill, voidBill, billsByDate, allBills, unsynced, syncNow, toWire,
            summarizeItems, buildCsv, parseMenuText };
})(typeof self !== 'undefined' ? self : window);
