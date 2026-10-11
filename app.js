(async function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const baht = n => '฿' + Number(n).toLocaleString('en-US');
  const PAYS = self.POS_PAYMENTS;

  let S, MENU;
  const cart = new Map();           // index ในเมนู -> จำนวน
  let pay = PAYS[0];
  let view = 'order';
  let sumDate = POS.bkkDate();
  let wakeLock = null;
  const done = new Set();           // ขั้นตอนบนเครื่องที่ติ๊กแล้ว (ล้างเมื่อบิลเปลี่ยน)

  // ---------- เริ่มต้น ----------
  S = await POS.getSettings();
  MENU = await POS.getMenu();
  const lastPay = await POS.kvGet('lastPay');
  pay = PAYS.find(p => p.n === lastPay) || PAYS[0];
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(async reg => {
      try {
        if ('periodicSync' in reg) {
          const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (st.state === 'granted') await reg.periodicSync.register('pos-hourly', { minInterval: 60 * 60 * 1000 });
        }
      } catch (e) {}
    }).catch(() => {});
  }

  const todayPill = $('#todayLine');

  // ---------- หน้าสั่ง ----------
  function renderMenu() {
    $('#title').textContent = S.shopName + ' · ' + S.branchName;
    $('#dummy').style.display = S.menuIsDummy ? 'block' : 'none';
    const groups = [];
    MENU.forEach((m, i) => {
      let g = groups.find(x => x.name === m.group);
      if (!g) { g = { name: m.group, items: [] }; groups.push(g); }
      g.items.push(i);
    });
    $('#menuWrap').innerHTML = groups.map((g, gi) =>
      `<div class="grp g${gi % 4}">${esc(g.name)}</div><div class="grid">` +
      g.items.map(i => {
        const m = MENU[i];
        return `<button class="item g${gi % 4}" data-i="${i}" id="it${i}"><span class="kc">${esc(m.keypad || '?')}</span>` +
          `<span class="p">${baht(m.price)}</span><span class="n">${esc(m.name)}</span><span class="q"></span></button>`;
      }).join('') + `</div>`).join('');
    syncMenuBadges();
  }
  function syncMenuBadges() {
    MENU.forEach((m, i) => {
      const b = document.getElementById('it' + i); if (!b) return;
      const q = cart.get(i) || 0;
      b.classList.toggle('in', q > 0);
      b.querySelector('.q').textContent = q ? '×' + q : '';
    });
  }
  function cartEntries() { return [...cart.entries()].map(([i, qty]) => ({ m: MENU[i], i, qty })); }

  function renderCart() {
    const es = cartEntries();
    const has = es.length > 0;
    $('#cartEmpty').hidden = has;
    $('#cartBody').hidden = !has;
    $('#how').hidden = !has;
    let total = 0;
    $('#cartBody').innerHTML = es.map(e => {
      total += e.m.price * e.qty;
      return `<div class="crow"><span class="nm">${esc(e.m.name)}</span>` +
        `<button class="step" data-d="-1" data-i="${e.i}" aria-label="ลด">−</button><span class="qn">${e.qty}</span>` +
        `<button class="step" data-d="1" data-i="${e.i}" aria-label="เพิ่ม">+</button>` +
        `<span class="amt">${baht(e.m.price * e.qty)}</span></div>`;
    }).join('');
    const stp = (n, keys, label) =>
      `<li class="stp${done.has(n) ? ' done' : ''}" data-s="${n}"><span class="sn">${n}</span><span class="row2">${keys}</span><span class="sl">${esc(label)}</span></li>`;
    $('#steps').innerHTML = es.map((e, n) =>
      stp(n + 1, `<span class="kc sm">${esc(e.m.keypad || '?')}</span><span class="kc sm e">E</span>${e.qty > 1 ? '<span class="x">×' + e.qty + '</span>' : ''}`, e.m.name)).join('') +
      stp(es.length + 1, `<span class="kc sm d">D</span><span class="kc sm">${pay.n}</span>`, 'ชำระ ' + pay.name);
    $('#pays').innerHTML = PAYS.map(p =>
      `<button class="pay${p.n === pay.n ? ' on' : ''}" data-n="${p.n}"><b>${p.n}</b>${esc(p.name)}</button>`).join('');
    $('#total').textContent = baht(total);
    $('#save').disabled = !has;
    $('#clear').style.visibility = has ? 'visible' : 'hidden';
    syncMenuBadges();
  }
  function add(i, d) {
    done.clear();
    const q = (cart.get(i) || 0) + d;
    if (q <= 0) cart.delete(i); else cart.set(i, Math.min(q, 99));
    renderCart();
  }

  $('#menuWrap').addEventListener('click', e => {
    const b = e.target.closest('.item'); if (!b) return;
    add(+b.dataset.i, 1);
    if (navigator.vibrate) navigator.vibrate(12);
  });
  $('#cartBody').addEventListener('click', e => {
    const b = e.target.closest('.step'); if (!b) return;
    add(+b.dataset.i, +b.dataset.d);
  });
  $('#pays').addEventListener('click', e => {
    const b = e.target.closest('.pay'); if (!b) return;
    pay = PAYS.find(p => p.n === +b.dataset.n); done.clear(); renderCart();
  });
  $('#steps').addEventListener('click', e => {
    const li = e.target.closest('.stp'); if (!li) return;
    const n = +li.dataset.s; if (done.has(n)) done.delete(n); else done.add(n);
    li.classList.toggle('done', done.has(n));
  });
  $('#clear').addEventListener('click', () => { cart.clear(); done.clear(); renderCart(); });
  $('#save').addEventListener('click', async () => {
    const es = cartEntries(); if (!es.length) return;
    $('#save').disabled = true;
    const bill = await POS.saveBill({
      pay, device: S.deviceName,
      lines: es.map(e => ({ keypad: e.m.keypad, code: e.m.code, name: e.m.name, price: e.m.price, qty: e.qty }))
    });
    await POS.kvSet('lastPay', pay.n);
    cart.clear(); done.clear(); renderCart();
    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    toast(`บันทึกบิล #${bill.seq} · ${baht(bill.total)}`, 'ยกเลิกบิลนี้', async () => {
      await POS.voidBill(bill.id);
      toast('ยกเลิกในแอปแล้ว — บนเครื่องให้กด C 2 ครั้ง', '', null, 9000, [['c', 'C'], ['c', 'C']]);
      refreshAll();
    }, 8000);
    refreshAll();
  });

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, btn, fn, ms, keys) {
    clearTimeout(toastTimer);
    $('#toastMsg').innerHTML = esc(msg) + (keys ? ' ' + keys.map(k => `<span class="kc sm ${k[0]}">${k[1]}</span>`).join(' ') : '');
    const b = $('#toastBtn');
    b.style.display = btn ? '' : 'none'; b.textContent = btn || '';
    b.onclick = () => { $('#toast').classList.remove('on'); if (fn) fn(); };
    $('#toast').classList.add('on');
    toastTimer = setTimeout(() => $('#toast').classList.remove('on'), ms || 4000);
  }

  // ---------- สถานะ / ซิงก์ ----------
  const configured = () => !!(S.supabaseUrl && S.apiKey && S.branchId && S.token);
  async function updateStatus() {
    const online = navigator.onLine;
    const np = $('#netPill'); np.textContent = online ? 'ออนไลน์' : 'ออฟไลน์'; np.className = 'pill ' + (online ? 'ok' : 'warn');
    const pend = await POS.unsynced();
    const sp = $('#syncPill');
    if (!configured()) { sp.textContent = 'ยังไม่ตั้งค่าเซิร์ฟเวอร์'; sp.className = 'pill warn'; }
    else if (!pend.length) { sp.textContent = '✓ ส่งครบแล้ว'; sp.className = 'pill ok'; }
    else {
      const oldest = Math.min(...pend.map(b => Date.parse(b.updated_at)));
      const late = Date.now() - oldest > 70 * 60000;
      sp.textContent = 'รอส่ง ' + pend.length + (late ? ' · ค้างเกิน 1 ชม.' : '');
      sp.className = 'pill ' + (late ? 'bad' : 'warn');
    }
    const today = (await POS.billsByDate(POS.bkkDate())).filter(b => b.status === 'ok');
    todayPill.textContent = `วันนี้ ${today.length} บิล · ${baht(today.reduce((s, b) => s + b.total, 0))}`;
  }
  async function trySync(manual) {
    const r = await POS.syncNow();
    if (!r.ok && 'serviceWorker' in navigator) {
      try { const reg = await navigator.serviceWorker.ready; if (reg.sync) await reg.sync.register('pos-sync'); } catch (e) {}
    }
    if (manual) await refreshAll(); else await updateStatus();   // ซิงก์อัตโนมัติ: ไม่วาดหน้าที่ผู้ใช้กำลังพิมพ์ใหม่
    if (manual) toast(r.ok ? (r.sent ? 'ส่งแล้ว ' + r.sent + ' บิล' : 'ไม่มีบิลค้างส่ง') : 'ส่งไม่สำเร็จ: ' + r.reason, '', null, 5000);
    return r;
  }
  async function tick() {
    const next = (await POS.kvGet('nextAttempt')) || 0;
    if (Date.now() >= next && navigator.onLine) await trySync(false); else await updateStatus();
  }
  window.addEventListener('online', async () => { const lr = await POS.kvGet('lastResult'); if (!lr || !lr.ok) trySync(false); else updateStatus(); });
  window.addEventListener('offline', updateStatus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); applyWake(); } });
  setInterval(tick, 30000);

  // ---------- แท็บ ----------
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    view = b.dataset.v;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + view));
    switchView();
  });

  // ---------- บิลวันนี้ ----------
  async function renderBills() {
    const bills = (await POS.billsByDate(POS.bkkDate())).sort((a, b) => b.created_at < a.created_at ? -1 : 1);
    $('#billsList').innerHTML = bills.length ? bills.map(b => {
      const items = b.lines.map(l => esc(l.name) + (l.qty > 1 ? '×' + l.qty : '')).join(', ');
      return `<div class="card bill ${b.status === 'void' ? 'void' : ''}"><div class="t"><b>#${b.seq}</b><span class="mut">${POS.bkkTime(new Date(b.created_at))}</span>` +
        `<span class="tag">${esc(b.payment_name)}</span>` +
        (b.status === 'void' ? '<span class="tag v">ยกเลิก</span>' : '') +
        `<span class="tag ${b.synced ? 'ok' : 'w'}">${b.synced ? 'ส่งแล้ว' : 'รอส่ง'}</span><b style="margin-left:auto">${baht(b.total)}</b></div>` +
        `<div class="sum mut" style="margin:6px 0">${items}</div>` +
        (b.status === 'ok' ? `<button class="btn alt" data-void="${b.id}">ยกเลิกบิลนี้ (บนเครื่องกด C C)</button>` : '') + `</div>`;
    }).join('') : '<div class="card mut">ยังไม่มีบิลวันนี้</div>';
  }
  $('#billsList').addEventListener('click', async e => {
    const b = e.target.closest('[data-void]'); if (!b) return;
    if (!confirm('ยกเลิกบิลนี้?\nอย่าลืมกด C 2 ครั้งบนเครื่องคิดเงินด้วย')) return;
    await POS.voidBill(b.dataset.void);
    refreshAll();
  });

  // ---------- สรุป / ส่งออก ----------
  async function renderSum() {
    const bills = await POS.billsByDate(sumDate);
    const ok = bills.filter(b => b.status === 'ok');
    const voided = bills.length - ok.length;
    const total = ok.reduce((s, b) => s + b.total, 0);
    const byPay = {}; ok.forEach(b => { byPay[b.payment_name] = (byPay[b.payment_name] || 0) + b.total; });
    const items = POS.summarizeItems(ok);
    const byHour = {}; ok.forEach(b => { const h = POS.bkkHour(new Date(b.created_at)); byHour[h] = (byHour[h] || 0) + b.total; });
    const hs = Object.keys(byHour).map(Number);
    let hoursHtml = '<div class="mut">ยังไม่มีข้อมูล</div>';
    if (hs.length) {
      const lo = Math.min(...hs), hi = Math.max(...hs), mx = Math.max(...Object.values(byHour));
      hoursHtml = '<div class="hours">' + Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).map(h =>
        `<div style="height:${Math.max(3, (byHour[h] || 0) / mx * 100)}%" title="${baht(byHour[h] || 0)}"><small>${h}</small></div>`).join('') + '</div><div style="height:16px"></div>';
    }
    const pend = await POS.unsynced();
    const lr = await POS.kvGet('lastResult'); const lok = await POS.kvGet('lastOk');
    $('#sumBody').innerHTML =
      `<label>วันที่<input type="date" id="sumDate" value="${sumDate}"></label>` +
      `<div class="card"><h2>ยอดขาย ${baht(total)}</h2><div class="row"><span class="l">บิล</span><span class="r">${ok.length}${voided ? ' (ยกเลิก ' + voided + ')' : ''}</span></div>` +
      Object.entries(byPay).map(([k, v]) => `<div class="row"><span class="l">${esc(k)}</span><span class="r">${baht(v)}</span></div>`).join('') + '</div>' +
      `<div class="card"><h2>ยอดรายชั่วโมง</h2>${hoursHtml}</div>` +
      `<div class="card"><h2>รายเมนู</h2>` + (items.length ? items.map(x =>
        `<div class="row"><span class="l">${esc(x.name)}</span><span class="r">${x.qty} จาน · ${baht(x.qty * x.price)}</span></div>`).join('') : '<div class="mut">ยังไม่มีข้อมูล</div>') + '</div>' +
      `<div class="card"><h2>การส่งข้อมูล</h2><div class="mut">รอส่ง ${pend.length} บิล` +
      (lok ? ' · ส่งสำเร็จล่าสุด ' + POS.bkkTime(new Date(lok)) : '') +
      (lr && !lr.ok ? '<br>ครั้งล่าสุดไม่สำเร็จ: ' + esc(lr.reason) : '') + '</div>' +
      `<div style="display:grid;gap:8px;margin-top:10px"><button class="btn" id="syncBtn">ส่งตอนนี้</button>` +
      `<button class="btn alt" id="csvBtn">ดาวน์โหลด CSV ของวันนี้ที่เลือก</button>` +
      `<button class="btn alt" id="shareBtn" hidden>แชร์ไฟล์ CSV</button></div></div>` +
      `<div class="card"><h2>สำรองข้อมูล</h2><div class="mut" style="margin-bottom:8px">ใช้เมื่อเปลี่ยนเครื่อง หรือส่งเข้าเซิร์ฟเวอร์ไม่ได้นาน</div>` +
      `<div class="two"><button class="btn alt" id="bkBtn">สำรองไฟล์</button><button class="btn alt" id="rsBtn">นำเข้าไฟล์สำรอง</button></div>` +
      `<input type="file" id="rsFile" accept="application/json" hidden></div>`;
    $('#sumDate').onchange = e => { sumDate = e.target.value || POS.bkkDate(); renderSum(); };
    $('#syncBtn').onclick = () => trySync(true);
    const csvFile = async () => {
      const bs = await POS.billsByDate(sumDate);
      return new File(['' + POS.buildCsv(sumDate, S.branchName, bs)], `${S.branchId}_${sumDate}.csv`, { type: 'text/csv' });
    };
    $('#csvBtn').onclick = async () => download(await csvFile());
    try { if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] })) { $('#shareBtn').hidden = false; } } catch (e) {}
    $('#shareBtn').onclick = async () => { try { await navigator.share({ files: [await csvFile()], title: 'ยอดขาย ' + sumDate }); } catch (e) {} };
    $('#bkBtn').onclick = async () => download(new File([JSON.stringify({ v: 1, at: new Date().toISOString(), bills: await POS.allBills() })], `backup_${S.branchId}_${POS.bkkDate()}.json`, { type: 'application/json' }));
    $('#rsBtn').onclick = () => $('#rsFile').click();
    $('#rsFile').onchange = async e => {
      try {
        const j = JSON.parse(await e.target.files[0].text());
        const db = await POS.openDB(); const t = db.transaction('bills', 'readwrite');
        let n = 0; for (const b of j.bills) { b.synced = 0; t.objectStore('bills').put(b); n++; }
        t.oncomplete = () => { toast('นำเข้า ' + n + ' บิล (จะส่งใหม่อีกครั้ง ฝั่งเซิร์ฟเวอร์ตัดบิลซ้ำให้)'); refreshAll(); };
      } catch (err) { toast('ไฟล์ไม่ถูกต้อง'); }
    };
  }
  function download(file) {
    const url = URL.createObjectURL(file); const a = document.createElement('a');
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------- ตั้งค่า ----------
  function menuToText() { return MENU.map(m => [m.keypad, m.code, m.name, m.price, m.group].join(',')).join('\n'); }
  function renderSet() {
    $('#setBody').innerHTML =
      `<div class="card"><h2>ร้าน</h2><div class="two"><label>ชื่อร้าน<input id="sShop" value="${esc(S.shopName)}"></label>` +
      `<label>ชื่อเครื่องนี้<input id="sDev" value="${esc(S.deviceName)}"></label></div>` +
      `<div class="two" style="margin-top:8px"><label>ชื่อสาขา (ออกใน CSV)<input id="sBranch" value="${esc(S.branchName)}"></label>` +
      `<label>รหัสสาขา (Supabase)<input id="sBid" value="${esc(S.branchId)}"></label></div>` +
      `<label class="sw" style="margin-top:10px"><input type="checkbox" id="sWake" ${S.wake ? 'checked' : ''}> เปิดหน้าจอค้างไว้ตลอดตอนใช้แอป</label></div>` +
      `<div class="card"><h2>เซิร์ฟเวอร์ (Supabase)</h2>` +
      `<label>Project URL<input id="sUrl" inputmode="url" value="${esc(S.supabaseUrl)}" placeholder="https://xxxx.supabase.co"></label>` +
      `<label style="margin-top:8px">anon / publishable key<input id="sKey" value="${esc(S.apiKey)}"></label>` +
      `<label style="margin-top:8px">รหัสลับของสาขา<input id="sTok" value="${esc(S.token)}"></label></div>` +
      `<button class="btn" id="saveSet">บันทึกการตั้งค่า</button>` +
      `<div class="card"><h2>เมนู</h2><div class="mut" style="margin-bottom:8px">หนึ่งบรรทัดต่อหนึ่งเมนู: เลขที่กดบนเครื่อง, รหัสระบบ, ชื่อ, ราคา, กลุ่ม</div>` +
      `<textarea id="sMenu" spellcheck="false">${esc(menuToText())}</textarea>` +
      `<div class="two" style="margin-top:8px"><button class="btn" id="applyMenu">ใช้เมนูนี้</button><button class="btn alt" id="resetMenu">กลับเป็นเมนูตัวอย่าง</button></div>` +
      `<div class="mut" id="menuMsg" style="margin-top:6px"></div></div>`;
    $('#saveSet').onclick = async () => {
      await POS.saveSettings({
        shopName: $('#sShop').value.trim() || S.shopName, deviceName: $('#sDev').value.trim(),
        branchName: $('#sBranch').value.trim(), branchId: $('#sBid').value.trim(),
        supabaseUrl: $('#sUrl').value.trim(), apiKey: $('#sKey').value.trim(), token: $('#sTok').value.trim(),
        wake: $('#sWake').checked
      });
      S = await POS.getSettings(); renderMenu(); applyWake(); refreshAll(); toast('บันทึกแล้ว');
    };
    $('#applyMenu').onclick = async () => {
      const r = POS.parseMenuText($('#sMenu').value);
      if (r.errors.length || !r.items.length) { $('#menuMsg').textContent = 'อ่านไม่ได้: ' + (r.errors[0] || 'ไม่มีรายการ'); return; }
      await POS.saveMenu(r.items); await POS.saveSettings({ menuIsDummy: false });
      MENU = r.items; S = await POS.getSettings(); cart.clear(); renderMenu(); renderCart();
      $('#menuMsg').textContent = 'ใช้เมนู ' + r.items.length + ' รายการแล้ว';
    };
    $('#resetMenu').onclick = async () => {
      if (!confirm('กลับไปใช้เมนูตัวอย่าง?')) return;
      await POS.saveMenu(self.POS_DEFAULT_MENU); await POS.saveSettings({ menuIsDummy: true });
      MENU = self.POS_DEFAULT_MENU; S = await POS.getSettings(); cart.clear(); renderMenu(); renderCart(); renderSet();
    };
  }

  // ---------- กันจอดับ ----------
  async function applyWake() {
    try {
      if (S.wake && 'wakeLock' in navigator && !document.hidden && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!S.wake && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) {}
  }

  async function refreshAll() {
    await updateStatus();
    if (view === 'bills') await renderBills();
    if (view === 'sum') await renderSum();
  }
  async function switchView() { await refreshAll(); if (view === 'set') renderSet(); }

  renderMenu(); renderCart(); applyWake();
  await updateStatus();
  tick();
  window.__pos = { get cart() { return cart; }, trySync, refreshAll };
})();
