// 行情数据层：Binance / OKX / Coinbase 公共 WebSocket（无需 API Key），自动故障切换
// 输出统一事件：trade / ticker / book / status

export const SOURCES = {
  binance: { name: 'Binance', quote: 'USDT' },
  okx: { name: 'OKX', quote: 'USDT' },
  coinbase: { name: 'Coinbase', quote: 'USD' },
};
export const COINS = { btc: 'BTC', eth: 'ETH' };
const sym = {
  binance: (c) => c + 'usdt', binanceRest: (c) => c.toUpperCase() + 'USDT',
  okx: (c) => c.toUpperCase() + '-USDT', coinbase: (c) => c.toUpperCase() + '-USD',
};
export const AUTO_ORDER = ['binance', 'okx', 'coinbase'];

const BINANCE_HOSTS = [
  { ws: 'wss://stream.binance.com:443', rest: 'https://api.binance.com' },
  { ws: 'wss://stream.binance.com:9443', rest: 'https://api.binance.com' },
  { ws: 'wss://data-stream.binance.vision', rest: 'https://data-api.binance.vision' },
];

export class OrderBook {
  constructor() { this.bids = new Map(); this.asks = new Map(); this.ready = false; }
  clear() { this.bids.clear(); this.asks.clear(); this.ready = false; }
  set(side, price, qty) {
    const m = side === 'bid' ? this.bids : this.asks;
    if (qty <= 0) m.delete(price); else m.set(price, qty);
  }
  bestBid() { let b = -Infinity; for (const p of this.bids.keys()) if (p > b) b = p; return b; }
  bestAsk() { let a = Infinity; for (const p of this.asks.keys()) if (p < a) a = p; return a; }
  // 删除交叉/过期价位（快照外的残留），保持盘口一致
  prune() {
    const bb = this.bestBid(), ba = this.bestAsk();
    if (bb >= ba && isFinite(bb) && isFinite(ba)) {
      // 交叉时以较新的成交价附近为准：简单移除交叉部分
      const mid = (bb + ba) / 2;
      for (const p of this.bids.keys()) if (p >= mid) this.bids.delete(p);
      for (const p of this.asks.keys()) if (p <= mid) this.asks.delete(p);
    }
  }
}

function fetchJson(url, ms = 8000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => ctl && ctl.abort(), ms);
  return fetch(url, ctl ? { signal: ctl.signal } : {}).then(r => {
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

// ---------------- Binance ----------------
function connectBinance(h, hostIdx = 0, coin = 'btc') {
  const S = sym.binance(coin);
  const host = BINANCE_HOSTS[hostIdx];
  const book = new OrderBook();
  let closed = false, ws, buffer = [], lastU = null, syncing = false, resyncTimer;
  const url = `${host.ws}/stream?streams=${S}@aggTrade/${S}@depth@100ms/${S}@miniTicker`;
  ws = new WebSocket(url);

  async function snapshot() {
    if (syncing || closed) return;
    syncing = true;
    try {
      const d = await fetchJson(`${host.rest}/api/v3/depth?symbol=${sym.binanceRest(coin)}&limit=5000`);
      if (closed) return;
      book.clear();
      for (const [p, q] of d.bids) book.set('bid', +p, +q);
      for (const [p, q] of d.asks) book.set('ask', +p, +q);
      lastU = d.lastUpdateId;
      const pending = buffer; buffer = [];
      for (const ev of pending) applyDiff(ev, true);
      book.ready = true;
      h.onBook(book);
    } catch (e) {
      h.onLog && h.onLog('Binance 深度快照失败: ' + e.message);
      setTimeout(() => { syncing = false; snapshot(); }, 3000);
      return;
    }
    syncing = false;
  }
  function applyDiff(ev, fromBuffer) {
    if (lastU == null) { buffer.push(ev); return; }
    if (ev.u <= lastU) return;
    if (ev.U > lastU + 1) { // 丢包，重新同步
      book.ready = false; lastU = null; buffer = [ev]; snapshot(); return;
    }
    for (const [p, q] of ev.b) book.set('bid', +p, +q);
    for (const [p, q] of ev.a) book.set('ask', +p, +q);
    lastU = ev.u;
    if (!fromBuffer) h.onBook(book);
  }

  ws.onopen = () => { h.onOpen(); snapshot(); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data); const s = m.stream, d = m.data;
    if (!d) return;
    if (s.endsWith('@aggTrade')) {
      h.onTrade({ price: +d.p, qty: +d.q, side: d.m ? 'sell' : 'buy', ts: d.T });
    } else if (s.endsWith('@depth@100ms')) {
      if (syncing || lastU == null) buffer.push(d); else applyDiff(d, false);
      if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000);
    } else if (s.endsWith('@miniTicker')) {
      h.onTicker({ last: +d.c, open24h: +d.o, high24h: +d.h, low24h: +d.l, vol24h: +d.v });
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => { if (!closed) h.onClose(); };
  // 定期刷新快照，补齐快照范围外的价位
  resyncTimer = setInterval(() => { if (!syncing && ws.readyState === 1) { lastU = null; snapshot(); } }, 120000);
  return { close() { closed = true; clearInterval(resyncTimer); try { ws.close(); } catch {} }, book };
}

// ---------------- OKX ----------------
function connectOKX(h, coin = 'btc') {
  const I = sym.okx(coin);
  const book = new OrderBook();
  let closed = false, pingT, bookT;
  const ws = new WebSocket('wss://ws.okx.com/ws/v5/public');
  async function pollBook() {
    try {
      const j = await fetchJson(`https://www.okx.com/api/v5/market/books-full?instId=${I}&sz=5000`);
      if (closed) return;
      const d = j.data && j.data[0]; if (!d) return;
      book.clear();
      for (const [p, q] of d.bids) book.set('bid', +p, +q);
      for (const [p, q] of d.asks) book.set('ask', +p, +q);
      book.ready = true; h.onBook(book);
    } catch (e) { h.onLog && h.onLog('OKX 深度获取失败: ' + e.message); }
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [
      { channel: 'trades', instId: I }, { channel: 'tickers', instId: I }] }));
    pingT = setInterval(() => ws.readyState === 1 && ws.send('ping'), 20000);
    h.onOpen(); pollBook(); bookT = setInterval(pollBook, 2500);
  };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data); if (!m.data || !m.arg) return;
    if (m.arg.channel === 'trades') {
      for (const t of m.data) h.onTrade({ price: +t.px, qty: +t.sz, side: t.side, ts: +t.ts });
    } else if (m.arg.channel === 'tickers') {
      const t = m.data[0];
      h.onTicker({ last: +t.last, open24h: +t.open24h, high24h: +t.high24h, low24h: +t.low24h, vol24h: +t.vol24h });
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => { clearInterval(pingT); clearInterval(bookT); if (!closed) h.onClose(); };
  return { close() { closed = true; clearInterval(pingT); clearInterval(bookT); try { ws.close(); } catch {} }, book };
}

// ---------------- Coinbase ----------------
function connectCoinbase(h, coin = 'btc') {
  const P = sym.coinbase(coin);
  const book = new OrderBook();
  let closed = false, lastEmit = 0;
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: [P], channels: ['matches', 'ticker', 'level2_batch'] }));
    h.onOpen();
  };
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    switch (d.type) {
      case 'match': // side 为挂单方方向，主动方相反
        h.onTrade({ price: +d.price, qty: +d.size, side: d.side === 'sell' ? 'buy' : 'sell', ts: Date.parse(d.time) });
        break;
      case 'ticker':
        h.onTicker({ last: +d.price, open24h: +d.open_24h, high24h: +d.high_24h, low24h: +d.low_24h, vol24h: +d.volume_24h });
        break;
      case 'snapshot':
        book.clear();
        for (const [p, q] of d.bids) book.set('bid', +p, +q);
        for (const [p, q] of d.asks) book.set('ask', +p, +q);
        book.ready = true; h.onBook(book); break;
      case 'l2update': {
        for (const [s, p, q] of d.changes) book.set(s === 'buy' ? 'bid' : 'ask', +p, +q);
        const now = Date.now(); if (now - lastEmit > 100) { lastEmit = now; h.onBook(book); }
        break;
      }
      case 'error': h.onLog && h.onLog('Coinbase: ' + d.message); break;
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => { if (!closed) h.onClose(); };
  return { close() { closed = true; try { ws.close(); } catch {} }, book };
}

const CONNECTORS = { binance: connectBinance, okx: connectOKX, coinbase: connectCoinbase };

/**
 * 带自动切换的行情管理器
 * mode: 'auto' | 'binance' | 'okx' | 'coinbase'
 */
export class FeedManager {
  constructor(handlers) {
    this.h = handlers; this.conn = null; this.mode = 'auto';
    this.order = AUTO_ORDER; this.idx = 0; this.binanceHost = 0;
    this.lastData = 0; this.fails = 0; this.gen = 0;
    this.watchdog = setInterval(() => this._check(), 2000);
  }
  start(mode = 'auto', coin = this.coin || 'btc') {
    this.mode = mode; this.coin = coin;
    this.order = mode === 'auto' ? AUTO_ORDER : [mode];
    this.idx = 0; this.binanceHost = 0; this.fails = 0;
    this._connect();
  }
  get source() { return this.order[this.idx]; }
  _connect() {
    if (this.conn) this.conn.close();
    const gen = ++this.gen;
    const src = this.source;
    this.openedAt = Date.now(); this.lastData = 0; this.gotData = false;
    const label = SOURCES[src].name + (src === 'binance' && this.binanceHost === 2 ? ' (vision)' : '');
    this.h.onStatus('connecting', label, src);
    const guard = (fn) => (...a) => { if (gen === this.gen) fn(...a); };
    const hh = {
      onOpen: guard(() => this.h.onStatus('open', label, src)),
      onClose: guard(() => this._fail('连接断开')),
      onTrade: guard((t) => { this._alive(label, src); this.h.onTrade(t, src); }),
      onTicker: guard((t) => { this._alive(label, src); this.h.onTicker(t, src); }),
      onBook: guard((b) => this.h.onBook(b, src)),
      onLog: (m) => console.warn(m),
    };
    try {
      this.conn = src === 'binance' ? CONNECTORS.binance(hh, this.binanceHost, this.coin) : CONNECTORS[src](hh, this.coin);
    } catch (e) { this._fail(e.message); }
  }
  _alive(label, src) {
    this.lastData = Date.now();
    if (!this.gotData) { this.gotData = true; this.fails = 0; this.h.onStatus('live', label, src); }
  }
  _check() {
    if (!this.conn) return;
    const now = Date.now();
    if (!this.gotData && now - this.openedAt > 9000) this._fail('超时无数据');
    else if (this.gotData && now - this.lastData > 20000) this._fail('数据中断');
  }
  _fail(reason) {
    const gen = this.gen;
    this.h.onStatus('error', reason, this.source);
    this.fails++;
    // Binance 先尝试备用域名
    if (this.source === 'binance' && this.binanceHost < BINANCE_HOSTS.length - 1 && !this.gotData) this.binanceHost++;
    else if (this.mode === 'auto' && (this.fails >= 2 || !this.gotData)) {
      this.idx = (this.idx + 1) % this.order.length; this.binanceHost = 0; this.fails = 0;
    }
    if (this.conn) { this.conn.close(); this.conn = null; }
    const delay = Math.min(1000 * Math.pow(1.6, this.fails), 10000);
    setTimeout(() => { if (gen === this.gen) this._connect(); }, delay);
  }
  stop() { clearInterval(this.watchdog); if (this.conn) this.conn.close(); this.conn = null; this.gen++; }
}

// 双币迷你行情（REST 轮询，独立于主连接）：返回 { btc:{last,chg}, eth:{last,chg} }
export async function fetchMiniTickers() {
  const tries = [
    async () => {
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try {
          const j = await fetchJson(`${host}/api/v3/ticker/24hr?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT"]')}&type=MINI`, 5000);
          const o = {};
          for (const t of j) o[t.symbol === 'BTCUSDT' ? 'btc' : 'eth'] = { last: +t.lastPrice, chg: (+t.lastPrice / +t.openPrice - 1) * 100 };
          return o;
        } catch {}
      }
      throw new Error('binance');
    },
    async () => {
      const o = {};
      for (const c of ['btc', 'eth']) {
        const j = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${c.toUpperCase()}-USDT`, 5000);
        const t = j.data[0]; o[c] = { last: +t.last, chg: (+t.last / +t.open24h - 1) * 100 };
      }
      return o;
    },
  ];
  for (const f of tries) { try { return await f(); } catch {} }
  return null;
}
