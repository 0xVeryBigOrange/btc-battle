# ⚔️ Crypto War · 多空战场

BTC / ETH 实时价格 + 多空对决可视化（顶部标签切换，或 `?coin=eth`）：**蓝军 = 多（买方）**，**红军 = 空（卖方）**。

- **吃单**：主动买入 vs 主动卖出成交额（10 秒 / 1 分钟 / 5 分钟滚动）
- **挂单**：盘口 ±0.5% / ±1% 范围内买盘 vs 卖盘深度 + 深度图
- **战场动画**：前线位置由综合战力（短期吃单 + 1 分钟吃单 + 盘口厚度）决定；每笔大额主动成交化作炮弹 / 重炮 / 巨鲸空袭；单边强势时触发「总攻」
- **数据源**：交易所公共 WebSocket，无需 API Key，纯前端。自动顺序 Binance → OKX → Coinbase，失败自动切换；也可在右上角手动选择，或用 `?source=okx` 参数

纯静态网页（HTML/CSS/JS ES Modules，无构建步骤），部署在 GitHub Pages。

> 仅供娱乐参考，不构成投资建议。

作者：大橙子 (Big Orange) · X [@0xVeryBigOrange](https://x.com/0xVeryBigOrange)
