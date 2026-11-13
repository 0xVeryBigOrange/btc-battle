import { FeedManager, SOURCES, COINS, fetchMiniTickers, fetchBinance1s } from './feeds.js?v=11302efd';
import { Battle, fmtUsd } from './battle.js?v=11302efd';
import { AudioController } from './music.js?v=11302efd';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

// ---------- 币种配置（阈值按 USD 名义金额，ETH 成交量较小，按比例下调） ----------
const COIN_CFG = {
  btc: { dp: 2, qdp: 3, th: { small: 4000, shell: 50000, heavy: 250000, whale: 1e6 }, chips: [20000, 50000, 100000, 500000], defChip: 50000 },
  eth: { dp: 2, qdp: 2, th: { small: 2000, shell: 25000, heavy: 100000, whale: 500000 }, chips: [10000, 25000, 50000, 200000], defChip: 25000 },
};
const params = new URLSearchParams(location.search);
let coin = (params.get('coin') || localStorage.getItem('cw_coin') || 'btc').toLowerCase();
if (!COINS[coin]) coin = 'btc';
const cfg = () => COIN_CFG[coin];
const fmtP = (p) => p.toLocaleString('en-US', { minimumFractionDigits: cfg().dp, maximumFractionDigits: cfg().dp });
const fmtQ = (q) => q >= 1000 ? q.toFixed(0) : q >= 100 ? q.toFixed(1) : q >= 10 ? q.toFixed(2) : q.toFixed(cfg().qdp);
const wan = (v) => v >= 1e4 ? +(v / 1e4).toFixed(1) + '万' : Math.round(v).toLocaleString();

// ---------- 开场 ----------
const intro = $('intro'), introBar = $('introBar'), introMsg = $('introMsg');
const introStart = performance.now(); let introDone = false;
intro.classList.add('js'); // JS 已接管：取消 CSS 兜底自动隐藏，改为“点击进入战场”
function introStep(pct, msg) { if (introDone) return; introBar.style.width = pct + '%'; if (msg) introMsg.textContent = msg; }
function finishIntro() {
  if (introDone) return;
  const wait = Math.max(0, 1900 - (performance.now() - introStart));
  introStep(100, '⚔️ 战斗开始！');
  introDone = true;
  setTimeout(() => {
    // 浏览器已允许播放 / 用户关了声音 → 直接进入；否则显示“点击进入战场”按钮（点击即解锁音频）
    if (!audio.locked) return closeIntro();
    intro.classList.add('ready'); introMsg.textContent = '战鼓已备好 · 点击开战';
  }, wait + 350);
}
function closeIntro() {
  if (!intro.isConnected || intro.classList.contains('done')) return;
  intro.classList.add('done'); setTimeout(() => intro.remove(), 900);
}
introStep(15, '集结部队中…');
setTimeout(finishIntro, 7000); // 最长等待

// ---------- 战场 ----------
const battle = new Battle($('battle'));
battle.start();
window.__battle = battle; // 调试用
window.__cw = () => S.dbg;

// ---------- 状态 ----------
const S = {
  src: null, last: 0, shownStr: '', open24h: 0, tradesThisSec: 0,
  buckets: new Array(300).fill(null).map(() => ({ sec: 0, b: 0, s: 0, bu: 0, su: 0, n: 0 })),
  px: new Array(120).fill(null).map(() => ({ sec: 0, p: 0 })), tickDir: 0,
  book: null, threshold: 0, surge: null, surgeSince: 0, wonFor: null,
  since: 0, liveSec: null, bfGen: 0, // since: 统计窗口最早的完整秒；liveSec: 本次连接首笔实时成交所在秒
};
function resetStats() {
  for (const b of S.buckets) { b.sec = 0; b.b = b.s = b.bu = b.su = b.n = 0; }
  for (const x of S.px) { x.sec = 0; x.p = 0; } S.tickDir = 0;
  S.book = null; S.last = 0; S.shownStr = ''; S.open24h = 0; S.hi = 0;
  S.surge = null; S.wonFor = null; smoothS = 0;
  S.since = 0; S.liveSec = null; S.bfGen++;
  $('price').textContent = '--'; $('chg').textContent = '--'; $('chg').className = 'chg';
  ['hi', 'lo', 'vol'].forEach(id => $(id).textContent = '--');
  $('trades').innerHTML = '<li class="empty">等待大单出现…</li>';
}
function bucket(sec) {
  const b = S.buckets[sec % 300];
  if (b.sec !== sec) { b.sec = sec; b.b = b.s = b.bu = b.su = b.n = 0; }
  return b;
}
// N 秒涨跌幅（%）：用 N 秒前（或最早可用的）每秒收盘价
function priceChange(secs) {
  if (!S.last) return 0;
  const now = Math.floor(Date.now() / 1000);
  // 先找 N 秒前那一秒；那一秒没成交则往更早找（价格沿用上一笔），历史不足时才退到较近的秒
  for (let k = secs; k < Math.min(secs + 30, 120); k++) {
    const x = S.px[(now - k) % 120];
    if (x.sec === now - k && x.p) return (S.last / x.p - 1) * 100;
  }
  for (let k = secs - 1; k >= Math.min(5, secs); k--) {
    const x = S.px[(now - k) % 120];
    if (x.sec === now - k && x.p) return (S.last / x.p - 1) * 100;
  }
  return 0;
}
function windowSum(secs) {
  const now = Math.floor(Date.now() / 1000); let b = 0, s = 0, bu = 0, su = 0, n = 0;
  for (let i = 0; i < secs; i++) { const k = S.buckets[(now - i) % 300]; if (k.sec === now - i) { b += k.b; s += k.s; bu += k.bu; su += k.su; n += k.n; } }
  return { b, s, bu, su, n };
}

// ---------- 成交合并 ----------
let pend = null, pendTimer = null;
function flushPend() { if (!pend) return; const t = pend; pend = null; clearTimeout(pendTimer); onMergedTrade(t); }
function onTrade(t, src) {
  S.tradesThisSec++;
  const sec = Math.floor(Date.now() / 1000), bk = bucket(sec), usd = t.price * t.qty;
  if (!S.since) S.since = sec;
  if (S.liveSec == null) { S.liveSec = sec; if (src === 'binance') setTimeout(backfill, 1500, S.bfGen, t.ts, Date.now() - t.ts, sec); }
  if (t.side === 'buy') { bk.b += t.qty; bk.bu += usd; } else { bk.s += t.qty; bk.su += usd; }
  bk.n++;
  if (S.last && t.price !== S.last) { S.tickDir = t.price > S.last ? 1 : -1; audio.tick(S.tickDir); } // 价格每跳一下 → 旋律走一步
  S.last = t.price;
  const ph = S.px[sec % 120]; ph.sec = sec; ph.p = t.price; // 每秒最后成交价
  if (pend && pend.side === t.side && Math.abs(pend.ts - t.ts) <= 5) { pend.qty += t.qty; pend.usd += usd; pend.price = t.price; }
  else { flushPend(); pend = { ...t, usd }; pendTimer = setTimeout(flushPend, 80); }
}
function onMergedTrade(t) {
  battle.fire(t.side, t.usd, t.qty);
  if (t.usd >= S.threshold) addTradeRow(t);
  if (t.usd >= cfg().th.shell) audio.impact(t.usd * 50000 / cfg().th.shell, t.side === 'buy' ? 'blue' : 'red');
}
function addTradeRow(t) {
  const ul = $('trades');
  const empty = ul.querySelector('.empty'); if (empty) empty.remove();
  const li = document.createElement('li'), d = new Date(), whale = t.usd >= cfg().th.whale;
  li.className = (t.side === 'buy' ? 'buy' : 'sell') + (whale ? ' whale' : '');
  li.style.setProperty('--a', Math.min(0.08 + Math.log10(t.usd / S.threshold + 1) * 0.25, 0.45).toFixed(2));
  li.innerHTML = `<span>${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span>` +
    `<span class="s">${t.side === 'buy' ? '多 买' : '空 卖'}</span><span>${fmtP(t.price)}</span>` +
    `<span>${fmtQ(t.qty)}</span><span>${whale ? '🐋 ' : ''}${fmtUsd(t.usd)}</span>`;
  ul.prepend(li);
  while (ul.children.length > 60) ul.lastChild.remove();
}

// 开页/重连时用 Binance 1 秒 K 线回填之前的成交（主动买卖量与每秒收盘价），
// 这样 10 秒 / 1 分钟 / 5 分钟 一打开就是完整窗口，而不是“从打开网页起累计”
async function backfill(gen, firstTs, skew, liveSec) {
  const k = await fetchBinance1s(coin, fm.binanceHost || 0, 300);
  if (!k || gen !== S.bfGen) return;
  const now = Math.floor(Date.now() / 1000);
  for (const x of k) {
    if (x.t + 1000 > firstTs) continue; // 只回填首笔实时成交之前的完整秒，避免重复计算
    const ls = Math.floor((x.t + skew) / 1000);
    if (ls >= liveSec || ls <= now - 300) continue;
    const b = S.buckets[ls % 300];
    if (b.sec !== ls) { b.sec = ls; b.b = x.tb; b.s = x.v - x.tb; b.bu = x.tbq; b.su = x.q - x.tbq; b.n = x.n; }
    if (ls > now - 120 && x.v > 0) { const ph = S.px[ls % 120]; if (ph.sec !== ls) { ph.sec = ls; ph.p = x.c; } }
    if (!S.since || ls < S.since) S.since = ls;
  }
}

// ---------- 数据源 ----------
const statusEl = $('status');
const fm = new FeedManager({
  onStatus(state, label, src) {
    statusEl.className = 'status ' + state;
    const txt = { connecting: `正在连接 ${label}…`, open: `已连接 ${label}，等待数据…`, live: `实时 · ${label}`, error: `${SOURCES[src].name} ${label}，重试/切换中…` }[state];
    $('statusText').textContent = txt; statusEl.title = txt;
    if (state === 'connecting' || state === 'open') S.liveSec = null; // 新连接 → 首笔成交后重新回填断线期间
    if (state === 'connecting') introStep(40, `连接战场情报 · ${label}…`);
    if (state === 'open') introStep(65, '侦察敌情中…');
    if (state === 'live') { introStep(90, '部队就位'); finishIntro(); }
    if (src !== S.src) { if (S.src) resetStats(); S.src = src; }
    $('pair').textContent = `${COINS[coin]}/${SOURCES[src].quote} · ${SOURCES[src].name}`;
  },
  onTrade,
  onTicker(t) { S.open24h = t.open24h; S.hi = t.high24h; S.lo = t.low24h; S.vol = t.vol24h; if (!S.last) S.last = t.last; },
  onBook(b) { S.book = b; },
});
const sel = $('sourceSel');
sel.value = params.get('source') || localStorage.getItem('bb_source') || 'auto';
if (!sel.value) sel.value = 'auto';
sel.onchange = () => { localStorage.setItem('bb_source', sel.value); resetStats(); fm.start(sel.value, coin); };

// ---------- 币种切换 ----------
const tabs = [...document.querySelectorAll('#coinTabs button')];
function moveInd() {
  const on = tabs.find(b => b.dataset.coin === coin), ind = $('tabInd');
  if (on) { ind.style.left = on.offsetLeft + 'px'; ind.style.width = on.offsetWidth + 'px'; }
}
function renderChips() {
  const saved = +localStorage.getItem('cw_th_' + coin);
  S.threshold = cfg().chips.includes(saved) ? saved : cfg().defChip;
  $('chips').innerHTML = cfg().chips.map(v => `<button data-v="${v}" class="${v === S.threshold ? 'on' : ''}">${wan(v)}</button>`).join('');
  for (const b of document.querySelectorAll('#chips button')) b.onclick = () => {
    S.threshold = +b.dataset.v; localStorage.setItem('cw_th_' + coin, S.threshold);
    document.querySelectorAll('#chips button').forEach(x => x.classList.toggle('on', x === b));
  };
  const th = cfg().th;
  $('legend').textContent = `小兵 = 成交 · 炮弹 ≥ $${wan(th.shell)} · 重炮 ≥ $${wan(th.heavy)} · 🐋 空袭 ≥ $${wan(th.whale)}`;
}
function setCoin(c, first = false) {
  if (!first && c === coin) return;
  coin = c; localStorage.setItem('cw_coin', c);
  const u = new URL(location.href); u.searchParams.set('coin', c); history.replaceState(null, '', u);
  tabs.forEach(b => { b.classList.toggle('on', b.dataset.coin === c); b.setAttribute('aria-selected', b.dataset.coin === c); });
  moveInd();
  battle.setThresholds(cfg().th);
  if (!first) { battle.reset(); showBanner(`⚔️ 转战 ${COINS[c]} 战场`, 'gold', 1600, true); }
  renderChips(); resetStats(); S.src = null;
  fm.start(sel.value, c);
}
tabs.forEach(b => b.onclick = () => setCoin(b.dataset.coin));
window.addEventListener('resize', moveInd);
if (window.ResizeObserver) { const ro = new ResizeObserver(moveInd); tabs.forEach(b => ro.observe(b)); }
document.fonts && document.fonts.ready.then(moveInd);

// ---------- 双币迷你行情 ----------
const miniPrev = {};
function setMini(c, last, chg) {
  const el = $('mini-' + c), ch = $('minich-' + c);
  const dp = COIN_CFG[c].dp;
  el.textContent = last.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (miniPrev[c] && last !== miniPrev[c]) { el.className = 'ct-px ' + (last > miniPrev[c] ? 'up' : 'down'); }
  miniPrev[c] = last;
  if (chg != null && isFinite(chg)) { ch.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%'; ch.className = 'ct-ch ' + (chg >= 0 ? 'pos' : 'neg'); }
}
async function pollMini() {
  const o = await fetchMiniTickers();
  if (o) for (const c of Object.keys(o)) if (c !== coin || !S.last) setMini(c, o[c].last, o[c].chg);
}
pollMini(); setInterval(pollMini, 4000);

// ---------- 价格（逐位滚动） ----------
const priceEl = $('price'); let flashT, lastShown = 0;
function renderPrice(str, prevStr) {
  let html = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i], changed = prevStr.length !== str.length || prevStr[i] !== ch;
    html += /\d/.test(ch) ? `<span class="dg${changed ? ' ch' : ''}">${ch}</span>` : ch;
  }
  priceEl.innerHTML = html;
}
setInterval(() => {
  if (!S.last || S.last === lastShown) return;
  const up = S.last > lastShown, str = '$' + fmtP(S.last);
  if (lastShown) {
    priceEl.classList.remove('up', 'down'); void priceEl.offsetWidth; priceEl.classList.add(up ? 'up' : 'down');
    clearTimeout(flashT); flashT = setTimeout(() => priceEl.classList.remove('up', 'down'), 650);
  }
  renderPrice(str, S.shownStr); S.shownStr = str; lastShown = S.last;
  document.title = `${str} ${COINS[coin]} · Crypto War 多空战场`;
  let ch = null;
  if (S.open24h) {
    ch = (S.last / S.open24h - 1) * 100; const el = $('chg');
    el.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; el.className = 'chg ' + (ch >= 0 ? 'pos' : 'neg');
  }
  setMini(coin, S.last, ch);
  if (S.hi) { $('hi').textContent = fmtP(S.hi); $('lo').textContent = fmtP(S.lo); $('vol').textContent = Math.round(S.vol).toLocaleString() + ' ' + COINS[coin]; }
}, 100);
setInterval(() => { $('tps').textContent = S.tradesThisSec + ' 笔/秒'; S.tradesThisSec = 0; }, 1000);

// ---------- 数字补间 ----------
const tweens = new Map();
function tweenNum(el, to, fmt = (v) => Math.round(v)) {
  const cur = tweens.get(el) ?? to; tweens.set(el, cur);
  const t0 = performance.now(), from = cur;
  el._tw = t0;
  const step = (now) => {
    if (el._tw !== t0) return;
    const k = Math.min((now - t0) / 500, 1), e = 1 - Math.pow(1 - k, 3), v = from + (to - from) * e;
    tweens.set(el, v); el.textContent = fmt(v);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- 比例条 ----------
function setRatio(prefix, a, b, la, lb, fmtA, fmtB, note = '') {
  const tot = a + b, pa = tot ? a / tot : 0.5;
  $(prefix + 'b').style.width = (pa * 100).toFixed(1) + '%';
  $(prefix + 'r').style.width = ((1 - pa) * 100).toFixed(1) + '%';
  $(prefix + 'pct').innerHTML = (note ? `<small class="rb-note">${note}</small> ` : '') + (tot ? `<span class="c-blue">${(pa * 100).toFixed(0)}%</span> : <span class="c-red">${((1 - pa) * 100).toFixed(0)}%</span>` : '--');
  $(prefix + la).textContent = fmtA; $(prefix + lb).textContent = fmtB;
  return tot ? pa * 2 - 1 : 0;
}

// ---------- 盘口深度 ----------
function computeDepth() {
  const b = S.book; if (!b || !b.ready) return null;
  const bb = b.bestBid(), ba = b.bestAsk(); if (!isFinite(bb) || !isFinite(ba) || bb >= ba * 1.01) return null;
  const mid = (bb + ba) / 2, NB = 50, bins = { bid: new Float64Array(NB), ask: new Float64Array(NB) };
  let b05 = 0, a05 = 0, b1 = 0, a1 = 0, minB = Infinity, maxA = 0;
  for (const [p, q] of b.bids) {
    const d = (mid - p) / mid; if (d < 0 || d > 0.01) continue;
    const u = p * q; b1 += u; if (d <= 0.005) b05 += u; bins.bid[Math.min(NB - 1, (d / 0.01 * NB) | 0)] += u; if (p < minB) minB = p;
  }
  for (const [p, q] of b.asks) {
    const d = (p - mid) / mid; if (d < 0 || d > 0.01) continue;
    const u = p * q; a1 += u; if (d <= 0.005) a05 += u; bins.ask[Math.min(NB - 1, (d / 0.01 * NB) | 0)] += u; if (p > maxA) maxA = p;
  }
  return { bb, ba, mid, b05, a05, b1, a1, bins, cover: Math.min((mid - minB) / mid, (maxA - mid) / mid) };
}

// ---------- 小图表 ----------
function prepCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
  return [x, r.width, r.height];
}
function drawFlow() {
  const [x, W, H] = prepCanvas($('flowChart'));
  const now = Math.floor(Date.now() / 1000), N = 60, step = 2, bars = [];
  let mx = 1;
  for (let i = N - 1; i >= 0; i--) {
    let bu = 0, su = 0;
    for (let j = 0; j < step; j++) { const s = now - i * step - j, k = S.buckets[((s % 300) + 300) % 300]; if (k.sec === s) { bu += k.bu; su += k.su; } }
    bars.push([bu, su]); mx = Math.max(mx, bu, su);
  }
  const mid = H / 2, bw = W / N;
  x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(0, mid, W, 1);
  let cum = 0; const cumPts = [];
  bars.forEach(([bu, su], i) => {
    const hb = Math.sqrt(bu / mx) * (mid - 4), hs = Math.sqrt(su / mx) * (mid - 4);
    let g = x.createLinearGradient(0, mid - hb, 0, mid); g.addColorStop(0, '#93c5fd'); g.addColorStop(1, '#1d4ed8');
    x.fillStyle = g; x.fillRect(i * bw + 1, mid - hb, bw - 2, hb);
    g = x.createLinearGradient(0, mid, 0, mid + hs); g.addColorStop(0, '#b91c1c'); g.addColorStop(1, '#fca5a5');
    x.fillStyle = g; x.fillRect(i * bw + 1, mid + 1, bw - 2, hs);
    cum += bu - su; cumPts.push(cum);
  });
  const cm = Math.max(1, ...cumPts.map(Math.abs));
  x.strokeStyle = '#fbbf24'; x.lineWidth = 1.8; x.shadowColor = '#fbbf24'; x.shadowBlur = 6; x.beginPath();
  cumPts.forEach((c, i) => { const y = mid - (c / cm) * (mid - 6); i ? x.lineTo(i * bw + bw / 2, y) : x.moveTo(bw / 2, y); });
  x.stroke(); x.shadowBlur = 0;
  x.fillStyle = 'rgba(230,235,255,.5)'; x.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif'; x.fillText('近 2 分钟 主动买(上) / 卖(下) · 黄线=累计净额', 6, 12);
}
function drawDepth(d) {
  const [x, W, H] = prepCanvas($('depthChart'));
  if (!d) { x.fillStyle = 'rgba(230,235,255,.5)'; x.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif'; x.fillText('等待盘口数据…', 10, 20); return; }
  const NB = d.bins.bid.length; let cb = 0, ca = 0; const cbA = [], caA = [];
  for (let i = 0; i < NB; i++) { cb += d.bins.bid[i]; ca += d.bins.ask[i]; cbA.push(cb); caA.push(ca); }
  const mx = Math.max(cb, ca, 1), mid = W / 2, base = H - 14;
  const area = (arr, dir, c1, c2, stroke) => {
    const g = x.createLinearGradient(0, 0, 0, base); g.addColorStop(0, c1); g.addColorStop(1, c2);
    x.fillStyle = g; x.beginPath(); x.moveTo(mid, base);
    arr.forEach((v, i) => x.lineTo(mid + dir * (i + 1) / NB * (mid - 2), base - v / mx * (base - 16)));
    x.lineTo(mid + dir * (mid - 2), base); x.closePath(); x.fill();
    x.strokeStyle = stroke; x.lineWidth = 1.5; x.beginPath(); x.moveTo(mid, base);
    arr.forEach((v, i) => x.lineTo(mid + dir * (i + 1) / NB * (mid - 2), base - v / mx * (base - 16))); x.stroke();
  };
  area(cbA, -1, 'rgba(59,130,246,.7)', 'rgba(59,130,246,.05)', '#93c5fd');
  area(caA, 1, 'rgba(239,68,68,.7)', 'rgba(239,68,68,.05)', '#fca5a5');
  x.fillStyle = 'rgba(255,255,255,.4)'; x.fillRect(mid, 10, 1, base - 10);
  x.fillStyle = 'rgba(230,235,255,.55)'; x.font = '10px "JetBrains Mono", monospace';
  x.textAlign = 'left'; x.fillText('-1%', 2, H - 3); x.textAlign = 'right'; x.fillText('+1%', W - 2, H - 3);
  x.textAlign = 'center'; x.fillText(fmtP(d.mid), mid, H - 3);
  x.textAlign = 'left'; x.fillText('买盘城墙 ' + fmtUsd(cb), 4, 11); x.textAlign = 'right'; x.fillText('卖盘城墙 ' + fmtUsd(ca), W - 4, 11);
  if (d.cover < 0.0099) { x.textAlign = 'center'; x.fillStyle = 'rgba(251,191,36,.7)'; x.fillText(`该数据源深度覆盖约 ±${(d.cover * 100).toFixed(2)}%`, mid, 24); }
}

// ---------- 横幅 ----------
const banner = $('banner'); let bannerT, bannerBusyUntil = 0;
function showBanner(html, cls, ms = 2200, force = false) {
  const now = Date.now(); if (!force && now < bannerBusyUntil) return;
  bannerBusyUntil = now + ms;
  banner.innerHTML = html; banner.className = 'banner ' + cls;
  void banner.offsetWidth; banner.classList.add('show');
  clearTimeout(bannerT); bannerT = setTimeout(() => banner.classList.remove('show'), ms);
}
battle.onWhale = (side, usd) => (audio.whale(side), showBanner(`🐋 ${side === 'blue' ? '蓝军' : '红军'}巨鲸空袭<small>${side === 'blue' ? '主动买入' : '主动卖出'} ${fmtUsd(usd)}</small>`, side, 2600, true));

// ---------- 战力 & 刷新 ----------
let smoothS = 0, musicI = 0.15, musicBpm = 80, musicMood = 0;
const VICTORY_SEC = 20;
function refresh() {
  const C = COINS[coin];
  const w10 = windowSum(10), w60 = windowSum(60), w300 = windowSum(300);
  const f = (q, u) => `${fmtQ(q)} ${C} · ${fmtUsd(u)}`;
  // 窗口还没攒满（非 Binance 源无法回填历史 / 回填未完成）时如实标注已统计的秒数
  const cov = S.since ? Math.floor(Date.now() / 1000) - S.since + 1 : 0;
  const nt = (n) => cov < n ? `仅${cov}秒` : '';
  const i10 = setRatio('tk10', w10.bu, w10.su, 'buy', 'sell', '买 ' + f(w10.b, w10.bu), '卖 ' + f(w10.s, w10.su), nt(10));
  const i60 = setRatio('tk60', w60.bu, w60.su, 'buy', 'sell', '买 ' + f(w60.b, w60.bu), '卖 ' + f(w60.s, w60.su), nt(60));
  setRatio('tk300', w300.bu, w300.su, 'buy', 'sell', '买 ' + f(w300.b, w300.bu), '卖 ' + f(w300.s, w300.su), nt(300));
  const dl = w300.bu - w300.su, de = $('delta');
  const dq = w300.b - w300.s;
  de.textContent = (dl >= 0 ? '+' : '-') + fmtUsd(Math.abs(dl)) + ` (${dq >= 0 ? '+' : '-'}${fmtQ(Math.abs(dq))} ${C})`;
  de.className = dl >= 0 ? 'c-blue' : 'c-red';

  const d = computeDepth(); let ib = 0;
  if (d) {
    const cv = (r) => d.cover < r ? `仅覆盖±${(d.cover * 100).toFixed(2)}%` : ''; // 如 Coinbase 公共频道只给前 50 档
    ib = setRatio('bk05', d.b05, d.a05, 'bid', 'ask', '买盘 ' + fmtUsd(d.b05), '卖盘 ' + fmtUsd(d.a05), cv(0.0049));
    setRatio('bk1', d.b1, d.a1, 'bid', 'ask', '买盘 ' + fmtUsd(d.b1), '卖盘 ' + fmtUsd(d.a1), cv(0.0099));
    $('bb').textContent = fmtP(d.bb); $('ba').textContent = fmtP(d.ba); $('spr').textContent = (d.ba - d.bb).toFixed(2);
  }
  drawDepth(d); drawFlow();

  // ===== 战力模型（全部来自实时行情，无随机）=====
  // 价格涨跌占 50%：10 秒 25% + 1 分钟 25%；吃单 30%；挂单 20%
  const ch10 = priceChange(10), ch60 = priceChange(60);
  const k = coin === 'eth' ? 1.5 : 1; // ETH 波动更大，归一化尺度放宽
  const p10 = Math.tanh(ch10 / (0.03 * k)), p60 = Math.tanh(ch60 / (0.10 * k));
  const raw = 0.25 * p10 + 0.25 * p60 + 0.15 * i10 + 0.15 * i60 + 0.2 * ib;
  smoothS = smoothS * 0.6 + raw * 0.4;
  // 待机射击频率 ∝ 每方近 10 秒主动成交额
  const ref = cfg().th.shell * 4;
  battle.setActivity(w10.bu / ref, w10.su / ref);
  // ===== 配乐参数（与战场同一套实时输入，无随机）=====
  // 速度 ← 近 10 秒成交额 + 成交笔数；情绪 ← 价格涨跌方向（10 秒/1 分钟）为主；强度 ← 活跃度 + 战力偏向
  const actUsd = Math.tanh((w10.bu + w10.su) / ref / 1.5);
  const actN = Math.tanh(w10.n / 10 / (coin === 'eth' ? 8 : 15));
  const act = 0.6 * actUsd + 0.4 * actN;
  musicI = musicI * 0.7 + Math.min(1, 0.15 + 0.4 * act + 0.45 * Math.abs(smoothS)) * 0.3;
  musicBpm = musicBpm * 0.75 + (70 + 56 * act + 14 * Math.abs(smoothS)) * 0.25;
  musicMood = 0.7 * (0.5 * p10 + 0.5 * p60) + 0.3 * smoothS;
  audio.update({ intensity: S.surge ? Math.max(musicI, 0.85) : musicI, bias: musicMood, surge: S.surge, bpm: S.surge ? Math.max(124, musicBpm) : musicBpm });
  updateMusicInd();
  S.dbg = { musicI, musicBpm, musicMood, t: Date.now(), price: S.last, ch10, ch60, p10, p60, i10, i60, ib, raw, s: smoothS, front: battle.front, target: battle.frontTarget, actB: w10.bu / ref, actR: w10.su / ref };
  const pc = (v) => `<b class="${v >= 0 ? 'c-blue' : 'c-red'}">${v >= 0 ? '+' : ''}${v.toFixed(3)}%</b>`;
  const rt = (v) => { const b = Math.round((v + 1) * 50); return `<b><span class="c-blue">${b}</span>:<span class="c-red">${100 - b}</span></b>`; };
  const bi = (x) => `<span class="bi">${x}</span>`;
  $('basis').innerHTML = '战况依据：' + [
    `10秒 ${pc(ch10)}`, `1分钟${cov < 60 ? `(仅${cov}秒)` : ''} ${pc(ch60)}`,
    `最新 ${S.tickDir > 0 ? '<b class="c-blue">↑</b>' : S.tickDir < 0 ? '<b class="c-red">↓</b>' : '–'}`,
    `吃单买:卖 ${rt(i60)}`, `挂单买:卖 ${rt(ib)}`].map(bi).join(' · ');
  const s = smoothS, blueShare = 0.5 + 0.5 * s;
  battle.setFront(0.5 + Math.tanh(s * 1.6) * 0.5);
  const bp = Math.round(blueShare * 100);
  tweenNum($('bluePow'), bp); tweenNum($('redPow'), 100 - bp);
  $('pbBlue').style.width = bp + '%'; $('pbRed').style.width = (100 - bp) + '%';
  $('pbClash').style.left = bp + '%';

  // 总攻判定（带迟滞）
  let surge = S.surge;
  if (!surge && s > 0.3) surge = 'blue'; else if (!surge && s < -0.3) surge = 'red';
  else if (surge === 'blue' && s < 0.2) surge = null; else if (surge === 'red' && s > -0.2) surge = null;
  if (surge !== S.surge) {
    S.surge = surge; S.surgeSince = Date.now(); S.wonFor = null; battle.setSurge(surge);
    if (surge) audio.surge(surge);
    if (surge) showBanner(surge === 'blue' ? '⚔️ 蓝军发起总攻！<small>多头主动出击</small>' : '⚔️ 红军发起总攻！<small>空头主动出击</small>', surge, 2400, true);
  }
  // 胜利：持续压制
  const held = surge ? (Date.now() - S.surgeSince) / 1000 : 0;
  if (surge && held >= VICTORY_SEC && S.wonFor !== surge) {
    S.wonFor = surge; battle.celebrate(surge); audio.fanfare(surge);
    showBanner(surge === 'blue' ? '🏆 蓝军大获全胜！<small>多头压制 ' + VICTORY_SEC + ' 秒 · 红军溃退</small>' : '🏆 红军大获全胜！<small>空头压制 ' + VICTORY_SEC + ' 秒 · 蓝军溃退</small>', surge + ' victory', 3200, true);
  }
  $('streak').textContent = surge ? `${surge === 'blue' ? '蓝军' : '红军'}已压制 ${Math.floor(held)} 秒${held < VICTORY_SEC ? '' : ' 🏆'}` : '';
  const st = $('battleState');
  if (surge) { st.textContent = surge === 'blue' ? '🔥 蓝军总攻' : '🔥 红军总攻'; st.className = 'state surge ' + surge; }
  else if (s > 0.08) { st.textContent = '🔵 蓝军推进'; st.className = 'state blue'; }
  else if (s < -0.08) { st.textContent = '🔴 红军压制'; st.className = 'state red'; }
  else { st.textContent = '⚖️ 两军对峙'; st.className = 'state'; }
}
setInterval(refresh, 400);

// ---------- 战争配乐 / 音效（默认开启；浏览器禁止无点击自动播放，首次点击/触摸/按键即解锁） ----------
const audio = new AudioController();
window.__audio = audio; // 调试用
const AKEY = 'cw_audio2'; // v2：默认开启（忽略旧版“默认关闭”时存下的设置）
const AP = Object.assign({ music: true, sfx: true, vol: 75 }, JSON.parse(localStorage.getItem(AKEY) || '{}'));
const audioBtn = $('audioBtn'), pop = $('audioPop'), mInd = $('musicInd');
$('musicTog').checked = AP.music; $('sfxTog').checked = AP.sfx; $('volRange').value = AP.vol;
function moodLabel() {
  if (S.surge) return S.surge === 'blue' ? '蓝军总攻' : '红军总攻';
  return musicMood > 0.15 ? '蓝军上扬' : musicMood < -0.15 ? '红军下压' : '两军对峙';
}
function updateMusicInd() {
  const want = AP.music || AP.sfx, locked = audio.locked;
  audioBtn.textContent = !want ? '🔇' : AP.music ? '🎵' : '🔊';
  audioBtn.classList.toggle('on', want && audio.running);
  audioBtn.classList.toggle('pending', locked);
  mInd.className = 'music-ind' + (locked ? ' locked' : !want ? ' off' : '') + (!locked && want ? ' ' + (S.surge || (musicMood > 0.15 ? 'blue' : musicMood < -0.15 ? 'red' : '')) : '');
  mInd.textContent = locked ? '🔊 点击开启战歌' : !want ? '配乐已关' : AP.music ? `♪ ${audio.bpm()} BPM · ${moodLabel()}` : `💥 音效 · ${moodLabel()}`;
}
function saveAudio() {
  localStorage.setItem(AKEY, JSON.stringify(AP));
  audio.apply({ music: AP.music, sfx: AP.sfx, volume: AP.vol / 100 });
  if ((AP.music || AP.sfx) && !audio.running) audio.unlock().then(updateMusicInd); // 开关本身就是一次点击
  updateMusicInd();
}
audio.onstate = updateMusicInd;
audio.apply({ music: AP.music, sfx: AP.sfx, volume: AP.vol / 100 });
// 任意首次交互即解锁（iOS 需在手势回调里同步 resume）
const GEST = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'];
function onGesture() {
  if (!(AP.music || AP.sfx)) return;
  if (!audio.running) audio.unlock().then((ok) => { updateMusicInd(); if (ok) GEST.forEach(ev => document.removeEventListener(ev, onGesture, true)); });
  else GEST.forEach(ev => document.removeEventListener(ev, onGesture, true));
}
GEST.forEach(ev => document.addEventListener(ev, onGesture, true));
if (AP.music || AP.sfx) audio.tryAutoStart().then(updateMusicInd);
// 开场“点击进入战场”
$('introGo').onclick = (e) => { e.stopPropagation(); onGesture(); closeIntro(); };
intro.addEventListener('click', () => { if (intro.classList.contains('ready')) { onGesture(); closeIntro(); } });
document.addEventListener('keydown', (e) => { if (intro.classList.contains('ready') && (e.key === 'Enter' || e.key === ' ')) closeIntro(); });
mInd.onclick = (e) => { e.stopPropagation(); if (audio.locked) onGesture(); else pop.hidden = !pop.hidden; };
audioBtn.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('.audio-wrap')) pop.hidden = true; });
$('musicTog').onchange = (e) => { AP.music = e.target.checked; saveAudio(); };
$('sfxTog').onchange = (e) => { AP.sfx = e.target.checked; saveAudio(); };
$('volRange').oninput = (e) => { AP.vol = +e.target.value; saveAudio(); };
updateMusicInd();

// ---------- 启动 ----------
setCoin(coin, true);
