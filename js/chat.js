// 匿名喊单评论区 + 弹幕：Supabase REST（读/写）+ Realtime WebSocket（postgres_changes INSERT），不依赖 SDK
// 只使用公开的 publishable key；表开启 RLS，匿名只能读和发，数据库端限流（同 IP 3 秒 1 条 / 每分钟 10 条）
import { t as T, onLang } from './i18n.js?v=8a047a9b';

const SB_URL = 'https://gtdvykkdvpzsnhlqlgun.supabase.co';
const SB_KEY = 'sb_publishable_i5XDXdgwAMTA0PHFCWTeew_qDAv9-pU';
const COLS = 'id,created_at,coin,side,nick,body';
const MAX_LIST = 100, REPLAY = 20, MAX_LEN = 140;
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

const H = { apikey: SB_KEY, 'Content-Type': 'application/json' };
async function rest(path, opt = {}, ms = 8000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + path, { ...opt, headers: { ...H, ...(opt.headers || {}) }, signal: ac.signal });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!r.ok) { const e = new Error((j && j.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(to); }
}

// ---------- 弹幕 ----------
class Danmaku {
  constructor(host) {
    this.host = host; this.queue = []; this.live = 0; this.lanes = []; this.on = localStorage.getItem('cw_dm') !== '0';
    this.layer = document.createElement('div'); this.layer.className = 'danmaku'; this.layer.setAttribute('aria-hidden', 'true');
    host.appendChild(this.layer);
    this.timer = setInterval(() => this.pump(), 180);
  }
  setOn(v) { this.on = v; localStorage.setItem('cw_dm', v ? '1' : '0'); if (!v) { this.queue.length = 0; this.layer.replaceChildren(); this.live = 0; this.lanes = []; } }
  geom() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const small = w < 640, lh = small ? 26 : 32, top = small ? 46 : 52, bottom = small ? 34 : 40;
    const n = Math.max(2, Math.min(10, Math.floor((h - top - bottom) / lh)));
    return { w, h, lh, top, n, speed: Math.max(90, Math.min(190, w / 7.5)), cap: small ? 10 : 22 };
  }
  push(c, opt = {}) {
    if (!this.on || document.hidden) return;
    this.queue.push({ c, ...opt });
    if (this.queue.length > 40) this.queue.splice(0, this.queue.length - 40); // 太多就丢旧的，保证不卡
  }
  pump() {
    if (!this.on || document.hidden || !this.queue.length) return;
    const g = this.geom(); if (g.w < 50) return;
    const now = performance.now();
    while (this.queue.length && this.live < g.cap) {
      if (this.lanes.length !== g.n) this.lanes = Array.from({ length: g.n }, (_, i) => this.lanes[i] || 0);
      // 选最早空出来的车道（从上往下优先）
      let lane = -1; for (let i = 0; i < g.n; i++) if (this.lanes[i] <= now) { lane = i; break; }
      if (lane < 0) return;
      const it = this.queue.shift();
      this.fly(it, lane, g, now);
    }
  }
  fly({ c, mine, tag }, lane, g, now) {
    const el = document.createElement('div');
    el.className = 'dm ' + (c.side === 'bull' ? 'bull' : c.side === 'bear' ? 'bear' : 'neu') + (mine ? ' mine' : '');
    if (tag) { const s = document.createElement('span'); s.className = 'dm-tag'; s.textContent = tag; el.appendChild(s); }
    el.appendChild(document.createTextNode(c.body));
    el.style.top = (g.top + lane * g.lh) + 'px';
    el.style.transform = `translateX(${g.w}px)`;
    this.layer.appendChild(el); this.live++;
    const w = el.offsetWidth, dist = g.w + w + 20, dur = dist / g.speed * 1000;
    this.lanes[lane] = now + (w + 48) / g.speed * 1000; // 车头全部进场 + 间距后才放下一条（同速，不会追尾）
    const a = el.animate([{ transform: `translateX(${g.w}px)` }, { transform: `translateX(${-w - 20}px)` }], { duration: dur, easing: 'linear' });
    const done = () => { if (el.isConnected) { el.remove(); this.live--; } };
    a.onfinish = done; a.oncancel = done;
  }
}

// ---------- 评论区 ----------
export function initChat({ getCoin, battleHost }) {
  const list = $('chatList'), input = $('chatIn'), nickIn = $('chatNick'), msg = $('chatMsg'), cnt = $('chatCnt'), live = $('chatLive');
  const dm = new Danmaku(battleHost);
  const items = new Map(); // id → comment
  const mine = new Set(JSON.parse(sessionStorage.getItem('cw_mine') || '[]'));
  let lastId = 0, state = 'loading', ws = null, wsRef = 0, hb = null, backoff = 1000, cooldown = 0, msgTimer = null, retryT = null;

  // 昵称：本机固定一个随机昵称
  let defNick = localStorage.getItem('cw_nick_def');
  if (!defNick) { defNick = '韭菜#' + pad(Math.floor(Math.random() * 10000)).padStart(4, '0'); localStorage.setItem('cw_nick_def', defNick); }
  nickIn.value = localStorage.getItem('cw_nick') || '';
  nickIn.placeholder = defNick;
  nickIn.addEventListener('change', () => { nickIn.value = nickIn.value.trim().slice(0, 16); localStorage.setItem('cw_nick', nickIn.value); });

  function flash(text, bad = true) {
    msg.textContent = text; msg.className = 'chat-msg show' + (bad ? ' bad' : '');
    clearTimeout(msgTimer); msgTimer = setTimeout(() => { msg.className = 'chat-msg'; }, 3200);
  }
  function setState(s) {
    state = s; live.className = 'chat-live ' + s; live.textContent = s === 'live' ? '● ' + T('chatLive') : s === 'down' ? '' : '○ ' + T('chatOff');
    renderPlaceholder();
  }
  function renderPlaceholder() {
    const ph = list.querySelector('.chat-ph');
    const text = state === 'down' && !items.size ? T('chatDown') : state === 'loading' && !items.size ? T('chatLoading') : !items.size ? T('chatEmpty') : '';
    if (!text) { ph && ph.remove(); return; }
    if (ph) ph.textContent = text; else { const d = document.createElement('div'); d.className = 'chat-ph'; d.textContent = text; list.appendChild(d); }
  }
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function row(c) {
    const li = document.createElement('li'); li.className = 'cm ' + c.side + (mine.has(c.id) ? ' mine' : ''); li.dataset.id = c.id;
    const top = document.createElement('div'); top.className = 'cm-top';
    const nick = document.createElement('span'); nick.className = 'cm-nick'; nick.textContent = c.nick + (mine.has(c.id) ? ` (${T('chatMe')})` : '');
    const coin = document.createElement('span'); coin.className = 'cm-coin'; coin.textContent = c.coin;
    top.append(nick, coin);
    if (c.side !== 'neutral') { const sd = document.createElement('span'); sd.className = 'cm-side ' + c.side; sd.textContent = T(c.side === 'bull' ? 'chatSideBull' : 'chatSideBear'); top.append(sd); }
    const tm = document.createElement('span'); tm.className = 'cm-time'; tm.textContent = fmtTime(c.created_at); top.append(tm);
    const body = document.createElement('div'); body.className = 'cm-body'; body.textContent = c.body; // 纯文本：不解析 HTML，链接不可点
    li.append(top, body); return li;
  }
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  function add(cs, { danmaku = true } = {}) {
    const stick = nearBottom() || !items.size;
    let added = 0;
    for (const c of cs) {
      if (!c || items.has(c.id)) continue;
      items.set(c.id, c); lastId = Math.max(lastId, c.id); added++;
      list.appendChild(row(c));
      if (danmaku) dm.push(c, { mine: mine.has(c.id), tag: tagFor(c) });
    }
    while (items.size > MAX_LIST) { const k = items.keys().next().value; items.delete(k); list.querySelector(`li[data-id="${k}"]`)?.remove(); }
    if (added) { renderPlaceholder(); if (stick) list.scrollTop = list.scrollHeight; }
  }
  const tagFor = (c) => (c.coin && c.coin.toUpperCase() !== (getCoin() || '').toUpperCase()) ? c.coin : '';
  function rerender() { list.replaceChildren(); for (const c of items.values()) list.appendChild(row(c)); renderPlaceholder(); list.scrollTop = list.scrollHeight; setState(state); syncDmBtns(); }

  // 首次加载 + 断线补齐
  async function load() {
    try {
      const q = lastId ? `comments?select=${COLS}&id=gt.${lastId}&order=id.asc&limit=${MAX_LIST}` : `comments?select=${COLS}&order=id.desc&limit=${MAX_LIST}`;
      let rows = await rest(q); if (!lastId) rows.reverse();
      const first = !items.size && !lastId;
      add(rows, { danmaku: !first });
      if (first) { // 开场把最近 20 条错开飘一遍
        rows.slice(-REPLAY).forEach((c, i) => setTimeout(() => dm.push(c, { mine: mine.has(c.id), tag: tagFor(c) }), 2500 + i * 700));
      }
      if (state !== 'live') setState(ws && ws.readyState === 1 ? 'live' : 'reconnect');
      return true;
    } catch (e) {
      if (!items.size) setState('down');
      clearTimeout(retryT); retryT = setTimeout(load, 15000);
      return false;
    }
  }

  // Realtime（Phoenix 协议）
  function connect() {
    try { ws && ws.close(); } catch {}
    clearInterval(hb);
    const sock = ws = new WebSocket(`${SB_URL.replace('https', 'wss')}/realtime/v1/websocket?apikey=${SB_KEY}&vsn=1.0.0`);
    const topic = 'realtime:cw-comments';
    const send = (o) => { if (sock.readyState === 1) sock.send(JSON.stringify(o)); };
    sock.onopen = () => {
      const ref = String(++wsRef);
      send({ topic, event: 'phx_join', ref, join_ref: ref, payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '', enabled: false }, postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'comments' }], private: false } } });
      hb = setInterval(() => send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++wsRef) }), 25000);
    };
    sock.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.topic !== topic) return;
      if (m.event === 'phx_reply' && m.payload && m.payload.status === 'ok' && m.payload.response && m.payload.response.postgres_changes) {
        backoff = 1000; setState('live'); load(); // 补齐断线期间的留言
      } else if (m.event === 'postgres_changes') {
        const r = m.payload && m.payload.data && m.payload.data.record;
        if (r && r.id && typeof r.body === 'string') add([{ id: +r.id, created_at: r.created_at, coin: String(r.coin || ''), side: r.side, nick: String(r.nick || ''), body: r.body }]);
      } else if (m.event === 'phx_error' || m.event === 'phx_close' || (m.event === 'phx_reply' && m.payload && m.payload.status === 'error')) {
        try { sock.close(); } catch {}
      }
    };
    sock.onclose = () => {
      if (sock !== ws) return;
      clearInterval(hb); if (state === 'live') setState('reconnect');
      setTimeout(() => { if (sock === ws) connect(); }, backoff); backoff = Math.min(30000, backoff * 2);
    };
  }

  // 发送
  async function post(side) {
    let body = input.value.trim();
    if (!body) { if (side === 'bull') body = T('chatLongDef'); else if (side === 'bear') body = T('chatShortDef'); else { flash(T('chatEmptyBody')); input.focus(); return; } }
    body = Array.from(body).slice(0, MAX_LEN).join('');
    if (Date.now() < cooldown) { flash(T('chatRate')); return; }
    cooldown = Date.now() + 3000;
    const nick = (nickIn.value.trim() || defNick).slice(0, 16);
    const coin = (getCoin() || 'BTC').toUpperCase().slice(0, 20);
    setBusy(true);
    try {
      const r = await rest('comments?select=' + COLS, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ coin, side, nick, body }) });
      const c = r && r[0];
      if (c) { mine.add(c.id); sessionStorage.setItem('cw_mine', JSON.stringify([...mine].slice(-50))); add([c]); list.scrollTop = list.scrollHeight; }
      input.value = ''; updCnt();
    } catch (e) {
      const m = String(e.message || '');
      flash(m.includes('rate_limited_global') ? T('chatRateG') : m.includes('rate_limited') ? T('chatRate') : T('chatErr'));
      if (!m.includes('rate_limited')) cooldown = 0;
    } finally { setBusy(false); }
  }
  const btns = [...document.querySelectorAll('[data-chat-side]')];
  function setBusy(b) { btns.forEach(x => x.disabled = b); }
  btns.forEach(b => b.addEventListener('click', () => post(b.dataset.chatSide)));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); post('neutral'); } });
  function updCnt() { const n = Array.from(input.value).length; cnt.textContent = `${n}/${MAX_LEN}`; cnt.classList.toggle('warn', n > MAX_LEN - 20); }
  input.addEventListener('input', updCnt); updCnt();

  // 弹幕开关
  const dmBtns = [...document.querySelectorAll('[data-dm-tog]')];
  function syncDmBtns() { dmBtns.forEach(b => { b.textContent = '💬 ' + T(dm.on ? 'dmOn' : 'dmOff'); b.classList.toggle('off', !dm.on); b.setAttribute('aria-pressed', dm.on); }); }
  dmBtns.forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); dm.setOn(!dm.on); syncDmBtns(); }));
  syncDmBtns();

  onLang(rerender);
  setState('loading');
  load().then(() => connect());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (!ws || ws.readyState > 1)) { backoff = 1000; connect(); } });
  window.__chat = { dm, items, get state() { return state; } };
}
