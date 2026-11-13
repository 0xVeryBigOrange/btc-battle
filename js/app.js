import { FeedManager, SOURCES } from './feeds.js';
import { Battle, fmtUsd } from './battle.js';

const $ = (id) => document.getElementById(id);
const fmtP = (p) => p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = (q) => q >= 100 ? q.toFixed(0) : q >= 10 ? q.toFixed(1) : q.toFixed(3);
const pad = (n) => String(n).padStart(2, '0');

// ---------- 战场 ----------
const battle = new Battle($('battle'));
battle.start();
window.__battle = battle; // 调试用

// ---------- 状态 ----------
const S = {
  src: 'binance', last: 0, shownPrice: 0, open24h: 0, tradesThisSec: 0, tps: 0,
  buckets: new Array(300).fill(null).map(() => ({ sec: 0, b: 0, s: 0, bu: 0, su: 0 })),
  book: null, threshold: +(localStorage.getItem('bb_threshold') || 50000),
  surge: null, sound: false, depth: null,
};

function resetStats() {
  for (const b of S.buckets) { b.sec = 0; b.b = b.s = b.bu = b.su = 0; }
  S.book = null; S.depth = null; S.last = 0; S.shownPrice = 0;
  $('trades').innerHTML = '<li class="empty">等待大单出现…</li>';
}

function bucket(sec) {
  const b = S.buckets[sec % 300];
  if (b.sec !== sec) { b.sec = sec; b.b = b.s = b.bu = b.su = 0; }
  return b;
}
function windowSum(secs) {
  const now = Math.floor(Date.now() / 1000); let b = 0, s = 0, bu = 0, su = 0;
  for (let i = 0; i < secs; i++) { const k = S.buckets[(now - i) % 300]; if (k.sec === now - i) { b += k.b; s += k.s; bu += k.bu; su += k.su; } }
  return { b, s, bu, su };
}

// ---------- 成交合并（同一笔市价单拆成多笔成交 → 合并） ----------
let pend = null, pendTimer = null;
function flushPend() {
  if (!pend) return; const t = pend; pend = null; clearTimeout(pendTimer);
  onMergedTrade(t);
}
function onTrade(t) {
  S.tradesThisSec++;
  const sec = Math.floor(Date.now() / 1000), bk = bucket(sec), usd = t.price * t.qty;
  if (t.side === 'buy') { bk.b += t.qty; bk.bu += usd; } else { bk.s += t.qty; bk.su += usd; }
  S.last = t.price;
  if (pend && pend.side === t.side && Math.abs(pend.ts - t.ts) <= 5) {
    pend.qty += t.qty; pend.usd += usd; pend.price = t.price;
  } else {
    flushPend();
    pend = { ...t, usd };
    pendTimer = setTimeout(flushPend, 80);
  }
}
function onMergedTrade(t) {
  battle.fire(t.side, t.usd, t.qty);
  if (t.usd >= S.threshold) addTradeRow(t);
  if (S.sound && t.usd >= 50000) boom(t.usd);
}

function addTradeRow(t) {
  const ul = $('trades');
  const empty = ul.querySelector('.empty'); if (empty) empty.remove();
  const li = document.createElement('li');
  const d = new Date();
  li.className = (t.side === 'buy' ? 'buy' : 'sell') + (t.usd >= 1e6 ? ' whale' : '');
  li.style.setProperty('--a', Math.min(0.08 + Math.log10(t.usd / S.threshold + 1) * 0.25, 0.45).toFixed(2));
  li.innerHTML = `<span>${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span>` +
    `<span class="s">${t.side === 'buy' ? '多 买' : '空 卖'}</span><span>${fmtP(t.price)}</span>` +
    `<span>${fmtQ(t.qty)}</span><span>${t.usd >= 1e6 ? '🐋 ' : ''}${fmtUsd(t.usd)}</span>`;
  ul.prepend(li);
  while (ul.children.length > 60) ul.lastChild.remove();
}

// ---------- 数据源 ----------
const statusEl = $('status');
const fm = new FeedManager({
  onStatus(state, label, src) {
    statusEl.className = 'status ' + state;
    const txt = { connecting: `正在连接 ${label}…`, open: `已连接 ${label}，等待数据…`, live: `实时 · ${label}`, error: `${SOURCES[src].name} ${label}，正在重试/切换…` }[state];
    $('statusText').textContent = txt;
    if (src !== S.src) { S.src = src; resetStats(); }
    $('pair').textContent = SOURCES[src].symbol + ' · ' + SOURCES[src].name;
  },
  onTrade,
  onTicker(t) { S.open24h = t.open24h; S.hi = t.high24h; S.lo = t.low24h; S.vol = t.vol24h; if (!S.last) S.last = t.last; },
  onBook(b) { S.book = b; },
});
const sel = $('sourceSel');
const urlSrc = new URLSearchParams(location.search).get('source');
sel.value = urlSrc || localStorage.getItem('bb_source') || 'auto';
if (!sel.value) sel.value = 'auto';
sel.onchange = () => { localStorage.setItem('bb_source', sel.value); resetStats(); fm.start(sel.value); };
resetStats();
fm.start(sel.value);

// ---------- 大单阈值 ----------
for (const b of document.querySelectorAll('#chips button')) {
  b.classList.toggle('on', +b.dataset.v === S.threshold);
  b.onclick = () => {
    S.threshold = +b.dataset.v; localStorage.setItem('bb_threshold', S.threshold);
    document.querySelectorAll('#chips button').forEach(x => x.classList.toggle('on', x === b));
  };
}

// ---------- 价格（~10fps） ----------
const priceEl = $('price'); let flashT;
setInterval(() => {
  if (!S.last || S.last === S.shownPrice) return;
  const up = S.last > S.shownPrice;
  if (S.shownPrice) {
    priceEl.classList.remove('up', 'down'); void priceEl.offsetWidth; priceEl.classList.add(up ? 'up' : 'down');
    clearTimeout(flashT); flashT = setTimeout(() => priceEl.classList.remove('up', 'down'), 600);
  }
  S.shownPrice = S.last;
  priceEl.textContent = '$' + fmtP(S.last);
  document.title = `$${fmtP(S.last)} · BTC 多空战场`;
  if (S.open24h) {
    const ch = (S.last / S.open24h - 1) * 100, el = $('chg');
    el.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; el.className = 'chg ' + (ch >= 0 ? 'pos' : 'neg');
  }
  if (S.hi) { $('hi').textContent = fmtP(S.hi); $('lo').textContent = fmtP(S.lo); $('vol').textContent = Math.round(S.vol).toLocaleString() + ' BTC'; }
}, 100);
setInterval(() => { S.tps = S.tradesThisSec; S.tradesThisSec = 0; $('tps').textContent = S.tps + ' 笔/秒'; }, 1000);

// ---------- 比例条 ----------
function setRatio(prefix, a, b, la, lb, fmtA, fmtB) {
  const tot = a + b, pa = tot ? a / tot : 0.5;
  $(prefix + 'b').style.width = (pa * 100).toFixed(1) + '%';
  $(prefix + 'r').style.width = ((1 - pa) * 100).toFixed(1) + '%';
  $(prefix + 'pct').innerHTML = tot ? `<span class="c-blue">${(pa * 100).toFixed(0)}%</span> : <span class="c-red">${((1 - pa) * 100).toFixed(0)}%</span>` : '--';
  $(prefix + la).textContent = fmtA; $(prefix + lb).textContent = fmtB;
  return tot ? pa * 2 - 1 : 0;
}

// ---------- 盘口深度计算 ----------
function computeDepth() {
  const b = S.book; if (!b || !b.ready) return null;
  const bb = b.bestBid(), ba = b.bestAsk(); if (!isFinite(bb) || !isFinite(ba)) return null;
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
  // 数据覆盖范围（有些交易所只给部分深度）
  const cover = Math.min((mid - minB) / mid, (maxA - mid) / mid);
  return { bb, ba, mid, b05, a05, b1, a1, bins, cover };
}

// ---------- 小图表 ----------
function prepCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
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
    x.fillStyle = '#3b82f6'; x.fillRect(i * bw + 1, mid - hb, bw - 2, hb);
    x.fillStyle = '#ef4444'; x.fillRect(i * bw + 1, mid + 1, bw - 2, hs);
    cum += bu - su; cumPts.push(cum);
  });
  const cm = Math.max(1, ...cumPts.map(Math.abs));
  x.strokeStyle = '#fbbf24'; x.lineWidth = 1.5; x.beginPath();
  cumPts.forEach((c, i) => { const y = mid - (c / cm) * (mid - 6); i ? x.lineTo(i * bw + bw / 2, y) : x.moveTo(bw / 2, y); });
  x.stroke();
  x.fillStyle = 'rgba(230,235,255,.5)'; x.font = '10px Noto Sans SC'; x.fillText('近 2 分钟 主动买(上) / 卖(下) · 黄线=累计净额', 6, 12);
}
function drawDepth(d) {
  const [x, W, H] = prepCanvas($('depthChart'));
  if (!d) { x.fillStyle = 'rgba(230,235,255,.5)'; x.font = '12px Noto Sans SC'; x.fillText('等待盘口数据…', 10, 20); return; }
  const NB = d.bins.bid.length; let cb = 0, ca = 0; const cbA = [], caA = [];
  for (let i = 0; i < NB; i++) { cb += d.bins.bid[i]; ca += d.bins.ask[i]; cbA.push(cb); caA.push(ca); }
  const mx = Math.max(cb, ca, 1), mid = W / 2, base = H - 14;
  const area = (arr, dir, c1, c2) => {
    const g = x.createLinearGradient(0, 0, 0, base); g.addColorStop(0, c1); g.addColorStop(1, c2);
    x.fillStyle = g; x.beginPath(); x.moveTo(mid, base);
    arr.forEach((v, i) => { const px = mid + dir * (i + 1) / NB * (mid - 2), py = base - v / mx * (base - 16); x.lineTo(px, py); });
    x.lineTo(mid + dir * (mid - 2), base); x.closePath(); x.fill();
  };
  area(cbA, -1, 'rgba(59,130,246,.75)', 'rgba(59,130,246,.08)');
  area(caA, 1, 'rgba(239,68,68,.75)', 'rgba(239,68,68,.08)');
  x.fillStyle = 'rgba(255,255,255,.4)'; x.fillRect(mid, 10, 1, base - 10);
  x.fillStyle = 'rgba(230,235,255,.55)'; x.font = '10px JetBrains Mono';
  x.textAlign = 'left'; x.fillText('-1%', 2, H - 3); x.textAlign = 'right'; x.fillText('+1%', W - 2, H - 3);
  x.textAlign = 'center'; x.fillText(fmtP(d.mid), mid, H - 3);
  x.textAlign = 'left'; x.fillText('买盘城墙 ' + fmtUsd(cb), 4, 11); x.textAlign = 'right'; x.fillText('卖盘城墙 ' + fmtUsd(ca), W - 4, 11);
  if (d.cover < 0.0099) { x.textAlign = 'center'; x.fillStyle = 'rgba(251,191,36,.7)'; x.fillText(`该数据源深度覆盖约 ±${(d.cover * 100).toFixed(2)}%`, mid, 24); }
}

// ---------- 战力 & 面板刷新 ----------
const banner = $('banner'); let bannerT, bannerBusyUntil = 0;
function showBanner(text, cls, ms = 2200, force = false) {
  const now = Date.now(); if (!force && now < bannerBusyUntil) return;
  bannerBusyUntil = now + ms;
  banner.textContent = text; banner.className = 'banner ' + cls;
  void banner.offsetWidth; banner.classList.add('show');
  clearTimeout(bannerT); bannerT = setTimeout(() => banner.classList.remove('show'), ms);
}
battle.onWhale = (side, usd) => showBanner(`🐋 ${side === 'blue' ? '蓝军' : '红军'}巨鲸空袭 ${fmtUsd(usd)}`, side, 2600, true);

let smoothS = 0;
function refresh() {
  const w10 = windowSum(10), w60 = windowSum(60), w300 = windowSum(300);
  const f = (q, u) => `${fmtQ(q)} BTC · ${fmtUsd(u)}`;
  const i10 = setRatio('tk10', w10.bu, w10.su, 'buy', 'sell', '买 ' + f(w10.b, w10.bu), '卖 ' + f(w10.s, w10.su));
  const i60 = setRatio('tk60', w60.bu, w60.su, 'buy', 'sell', '买 ' + f(w60.b, w60.bu), '卖 ' + f(w60.s, w60.su));
  setRatio('tk300', w300.bu, w300.su, 'buy', 'sell', '买 ' + f(w300.b, w300.bu), '卖 ' + f(w300.s, w300.su));
  const dl = w300.bu - w300.su, de = $('delta');
  de.textContent = (dl >= 0 ? '+' : '-') + fmtUsd(Math.abs(dl)) + ` (${(w300.b - w300.s >= 0 ? '+' : '')}${(w300.b - w300.s).toFixed(2)} BTC)`;
  de.className = dl >= 0 ? 'c-blue' : 'c-red';

  const d = computeDepth(); S.depth = d; let ib = 0;
  if (d) {
    ib = setRatio('bk05', d.b05, d.a05, 'bid', 'ask', '买盘 ' + fmtUsd(d.b05), '卖盘 ' + fmtUsd(d.a05));
    setRatio('bk1', d.b1, d.a1, 'bid', 'ask', '买盘 ' + fmtUsd(d.b1), '卖盘 ' + fmtUsd(d.a1));
    $('bb').textContent = fmtP(d.bb); $('ba').textContent = fmtP(d.ba); $('spr').textContent = (d.ba - d.bb).toFixed(2);
  }
  drawDepth(d); drawFlow();

  // 综合战力：短期吃单 + 1分钟吃单 + 盘口厚度
  const raw = 0.35 * i10 + 0.35 * i60 + 0.3 * ib;
  smoothS = smoothS * 0.6 + raw * 0.4;
  const s = smoothS, blueShare = 0.5 + 0.5 * s;
  battle.setFront(0.5 + Math.tanh(s * 1.6) * 0.5);
  const bp = Math.round(blueShare * 100);
  $('bluePow').textContent = bp; $('redPow').textContent = 100 - bp;
  $('pbBlue').style.width = bp + '%'; $('pbRed').style.width = (100 - bp) + '%';

  // 冲锋判定（带迟滞）
  let surge = S.surge;
  if (!surge && s > 0.3) surge = 'blue'; else if (!surge && s < -0.3) surge = 'red';
  else if (surge === 'blue' && s < 0.2) surge = null; else if (surge === 'red' && s > -0.2) surge = null;
  if (surge !== S.surge) {
    S.surge = surge; battle.setSurge(surge);
    if (surge) showBanner(surge === 'blue' ? '⚔️ 蓝军发起总攻！' : '⚔️ 红军发起总攻！', surge, 2400, true);
  }
  const st = $('battleState');
  if (surge) { st.textContent = surge === 'blue' ? '🔥 蓝军总攻' : '🔥 红军总攻'; st.className = 'state ' + surge; }
  else if (s > 0.08) { st.textContent = '🔵 蓝军推进'; st.className = 'state blue'; }
  else if (s < -0.08) { st.textContent = '🔴 红军压制'; st.className = 'state red'; }
  else { st.textContent = '⚖️ 两军对峙'; st.className = 'state'; }
}
setInterval(refresh, 400);

// ---------- 音效（默认关闭） ----------
let actx;
$('soundBtn').onclick = () => {
  S.sound = !S.sound; $('soundBtn').textContent = S.sound ? '🔊' : '🔇';
  if (S.sound && !actx) actx = new (window.AudioContext || window.webkitAudioContext)();
};
let lastBoom = 0;
function boom(usd) {
  if (!actx) return; const now = actx.currentTime; if (now - lastBoom < 0.08) return; lastBoom = now;
  const k = Math.min(Math.log10(usd / 50000) / 2, 1.2), len = 0.25 + k * 0.6;
  const buf = actx.createBuffer(1, actx.sampleRate * len, actx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.5);
  const src = actx.createBufferSource(); src.buffer = buf;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500 - k * 250;
  const g = actx.createGain(); g.gain.value = 0.25 + k * 0.35;
  src.connect(lp).connect(g).connect(actx.destination); src.start();
}
