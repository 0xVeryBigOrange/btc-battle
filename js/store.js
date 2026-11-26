// 安全的本地存储：浏览器禁用 Cookie/站点数据、部分 App 内置浏览器、隐私模式或存储已满时，
// 直接访问 localStorage 会抛错（甚至为 null），导致整页白屏。这里统一兜底：存储不可用时退回内存，功能照常。
function pick(name) {
  try { const s = window[name]; const k = '__cw_probe'; s.setItem(k, '1'); s.removeItem(k); return s; } catch { return null; }
}
function wrap(s) {
  const m = new Map(); // 本次会话内写入的值（存储写入失败时仍可读回）
  return {
    getItem(k) { if (m.has(k)) return m.get(k); try { return s ? s.getItem(k) : null; } catch { return null; } },
    setItem(k, v) { v = String(v); m.set(k, v); try { if (s) s.setItem(k, v); } catch {} },
    removeItem(k) { m.delete(k); try { if (s) s.removeItem(k); } catch {} },
  };
}
export const ls = wrap(pick('localStorage'));
export const ss = wrap(pick('sessionStorage'));
