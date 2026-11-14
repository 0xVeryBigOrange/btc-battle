// 网络请求 + Binance REST 限流保护
// Binance 按 IP 计权重（6000/分钟），超限返回 429，屡次超限会 418 封 IP。浏览器读不到 x-mbx-used-weight 响应头，
// 所以这里在本地按官方权重估算：每分钟最多用 2400（给同一 IP 的其它标签页留余量），收到 429/418 后整体暂停。
export function fetchJson(url, ms = 8000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => ctl && ctl.abort(), ms);
  return fetch(url, ctl ? { signal: ctl.signal } : {}).then(r => {
    clearTimeout(t);
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }, (e) => { clearTimeout(t); throw e; });
}

const BUDGET = 2400, WIN = 60000;
const used = []; // [时间, 权重]
let bannedUntil = 0;
function usedNow(now) { while (used.length && now - used[0][0] > WIN) used.shift(); let s = 0; for (const x of used) s += x[1]; return s; }
/** 本地估算的剩余权重是否够用（不够就别发，避免触发 429/418） */
export function binCanSpend(w) { const now = Date.now(); return now >= bannedUntil && usedNow(now) + w <= BUDGET; }
export const binBlockedFor = () => Math.max(0, bannedUntil - Date.now());
/** 带权重记账的 Binance REST 请求；额度不够或处于暂停期直接抛错（调用方降级 / 稍后重试） */
export async function binFetch(url, weight, ms) {
  if (!binCanSpend(weight)) { const e = new Error('rate-budget'); e.rate = true; throw e; }
  used.push([Date.now(), weight]);
  try { return await fetchJson(url, ms); }
  catch (e) {
    if (e.status === 429 || e.status === 418) {
      bannedUntil = Date.now() + (e.status === 418 ? 300000 : 60000); e.rate = true;
      console.warn(`Binance REST ${e.status}，暂停 ${e.status === 418 ? 300 : 60} 秒`);
    }
    throw e;
  }
}
