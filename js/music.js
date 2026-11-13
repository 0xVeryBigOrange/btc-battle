// Crypto War 战争配乐：Web Audio API 实时合成（无外部音频文件，无版权问题）
// 太鼓/定音鼓 + 低音铜管/弦乐铺底（D 小调），速度与层次随实时战况变化。
// 同一套代码既可用于实时 AudioContext，也可用于 OfflineAudioContext 渲染演示。

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 和弦（MIDI）
const CH = {
  Dm: [50, 53, 57], Bb: [46, 50, 53], C: [48, 52, 55], A: [45, 49, 52], Gm: [43, 46, 50], F: [41, 45, 48], D: [50, 54, 57],
};
const PROG = {
  blue: ['Dm', 'Bb', 'C', 'Dm'],   // 上行、明亮
  neutral: ['Dm', 'Dm', 'Bb', 'A'],
  red: ['Dm', 'C', 'Bb', 'A'],     // 下行、阴暗
};
// 太鼓节奏（16 分音符位置 → 力度），按强度等级
const TAIKO = [
  { 0: 1, 8: 0.65 },
  { 0: 1, 6: 0.6, 8: 0.85, 12: 0.6 },
  { 0: 1, 3: 0.55, 6: 0.75, 8: 0.95, 10: 0.55, 12: 0.8, 14: 0.6 },
  { 0: 1, 2: 0.5, 3: 0.6, 4: 0.8, 6: 0.7, 8: 1, 10: 0.6, 11: 0.55, 12: 0.85, 13: 0.6, 14: 0.75, 15: 0.85 },
];
const OSTINATO = [0, 0, 12, 0, 0, 0, 12, 7]; // 8 分音符弦乐顿弓

export class WarMusic {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = { intensity: 0.15, bias: 0, surge: null };
    this.volume = 0.7; this.musicOn = false; this.sfxOn = false;
    this._build();
    this.step = 0; this.bar = 0; this.nextT = 0; this.stepDur = 0.2;
  }

  // ---------- 音频图 ----------
  _build() {
    const c = this.ctx;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.knee.value = 8; this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.008; this.comp.release.value = 0.25;
    this.master = c.createGain(); this.master.gain.value = this.volume * 0.9;
    this.comp.connect(this.master).connect(c.destination);
    this.mix = c.createGain(); this.mix.connect(this.comp);
    this.music = c.createGain(); this.music.gain.value = 0; this.music.connect(this.mix);
    this.sfx = c.createGain(); this.sfx.gain.value = 0; this.sfx.connect(this.mix);
    // 混响（程序生成脉冲响应）
    this.verb = c.createConvolver(); this.verb.buffer = this._impulse(3.2, 2.6);
    this.verbRet = c.createGain(); this.verbRet.gain.value = 0.55;
    this.verb.connect(this.verbRet).connect(this.mix);
    this.verbSendM = c.createGain(); this.verbSendM.gain.value = 1; this.verbSendM.connect(this.verb);
    this.verbSendS = c.createGain(); this.verbSendS.gain.value = 1; this.verbSendS.connect(this.verb);
    // 白噪声
    const n = c.sampleRate * 2, nb = c.createBuffer(1, n, c.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
  }
  _impulse(sec, decay) {
    const c = this.ctx, len = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len; lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45; // 轻微低通，更温暖
        d[i] = lp * Math.pow(1 - t, decay) * (i < c.sampleRate * 0.012 ? i / (c.sampleRate * 0.012) : 1);
      }
    }
    return b;
  }
  // 输出到 音乐/音效 总线，并按比例送混响
  _out(node, bus, send) {
    const dry = bus === 'sfx' ? this.sfx : this.music;
    node.connect(dry);
    if (send > 0) { const g = this.ctx.createGain(); g.gain.value = send; node.connect(g); g.connect(bus === 'sfx' ? this.verbSendS : this.verbSendM); }
  }
  _noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource(); s.buffer = this.noise;
    s.start(t, Math.random() * 1.5, dur + 0.05); return s;
  }

  // ---------- 乐器 ----------
  taiko(t, vel = 1, bus = 'music', big = 1) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150 * big, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.22);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * vel, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g); o.start(t); o.stop(t + 1.2);
    // 鼓皮击打噪声
    const nz = this._noiseSrc(t, 0.12), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
    const ng = c.createGain(); ng.gain.setValueAtTime(0.5 * vel, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    nz.connect(lp).connect(ng);
    // 共鸣泛音
    const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.setValueAtTime(95, t); o2.frequency.exponentialRampToValueAtTime(70, t + 0.4);
    const g2 = c.createGain(); g2.gain.setValueAtTime(0.0001, t); g2.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.01); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o2.connect(g2); o2.start(t); o2.stop(t + 0.7);
    this._out(g, bus, 0.35); this._out(ng, bus, 0.3); this._out(g2, bus, 0.3);
  }
  tom(t, vel = 1) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.15);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * vel, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); o.start(t); o.stop(t + 0.4);
    const nz = this._noiseSrc(t, 0.15), bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
    const ng = c.createGain(); ng.gain.setValueAtTime(0.3 * vel, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    nz.connect(bp).connect(ng);
    this._out(g, 'music', 0.3); this._out(ng, 'music', 0.35);
  }
  shaker(t, vel = 1) {
    const c = this.ctx, nz = this._noiseSrc(t, 0.06), hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = c.createGain(); g.gain.setValueAtTime(0.06 * vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    nz.connect(hp).connect(g); this._out(g, 'music', 0.1);
  }
  cymbal(t, dur = 2.5, vel = 1, swell = false, bus = 'music') {
    const c = this.ctx, nz = this._noiseSrc(t, dur), hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200;
    const g = c.createGain();
    if (swell) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09 * vel, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.03); }
    else { g.gain.setValueAtTime(0.12 * vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
    nz.connect(hp).connect(g); this._out(g, bus, 0.45);
  }
  // 弦乐铺底（多锯齿波失谐 + 低通）
  pad(t, notes, dur, bright) {
    const c = this.ctx, lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500 + 1600 * bright; lp.Q.value = 0.5;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); const pv = 0.025 + 0.03 * bright; g.gain.linearRampToValueAtTime(pv, t + 0.5);
    g.gain.setValueAtTime(pv, t + dur - 0.2); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.9);
    lp.connect(g);
    for (const m of notes) for (const det of [-9, 0, 8]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + dur + 1);
    }
    this._out(g, 'music', 0.6);
  }
  drone(t, root, dur, amt) {
    const c = this.ctx, lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180 + 120 * amt;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); const dv = 0.07 + 0.08 * amt; g.gain.linearRampToValueAtTime(dv, t + 0.3);
    g.gain.setValueAtTime(dv, t + dur - 0.1); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.5);
    lp.connect(g);
    for (const [type, m, det] of [['sawtooth', root - 12, -5], ['sawtooth', root - 12, 6], ['sine', root - 24, 0]]) {
      const o = c.createOscillator(); o.type = type; o.frequency.value = mtof(m); o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.6);
    }
    this._out(g, 'music', 0.15);
  }
  // 顿弓
  stab(t, m, vel = 1, len = 0.13) {
    const c = this.ctx, lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1700;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07 * vel, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    lp.connect(g);
    for (const det of [-6, 6]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + len + 0.05); }
    this._out(g, 'music', 0.3);
  }
  // 铜管（滤波包络 + 颤音）
  brass(t, m, dur, vel = 1, glideTo = null, bus = 'music') {
    const c = this.ctx, lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(350, t); lp.frequency.linearRampToValueAtTime(900 + 2300 * vel, t + 0.09); lp.frequency.linearRampToValueAtTime(1100 + 900 * vel, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.085 * vel, t + 0.06);
    g.gain.setValueAtTime(0.075 * vel, t + dur - 0.05); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
    lp.connect(g);
    const lfo = c.createOscillator(); lfo.frequency.value = 5.2; const lg = c.createGain(); lg.gain.value = 9; lfo.connect(lg); lfo.start(t + 0.15); lfo.stop(t + dur + 0.3);
    for (const [type, det, oct] of [['sawtooth', -7, 0], ['sawtooth', 7, 0], ['square', 0, -12]]) {
      const o = c.createOscillator(); o.type = type; o.detune.value = det; lg.connect(o.detune);
      o.frequency.setValueAtTime(mtof(m + oct), t);
      if (glideTo != null) o.frequency.exponentialRampToValueAtTime(mtof(glideTo + oct), t + dur);
      const og = c.createGain(); og.gain.value = type === 'square' ? 0.35 : 1;
      o.connect(og).connect(lp); o.start(t); o.stop(t + dur + 0.3);
    }
    this._out(g, bus, 0.45);
  }

  // ---------- 特殊事件 ----------
  whale(t = this.ctx.currentTime + 0.02, side = 'blue') { // 巨鲸空袭爆炸
    const c = this.ctx;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(24, t + 1.6);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1.0, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    o.connect(g); o.start(t); o.stop(t + 1.9);
    const nz = this._noiseSrc(t, 1.6), lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(180, t + 1.4);
    const ng = c.createGain(); ng.gain.setValueAtTime(0.7, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    nz.connect(lp).connect(ng);
    const bus = this.sfxOn ? 'sfx' : 'music';
    this._out(g, bus, 0.4); this._out(ng, bus, 0.6);
    this.taiko(t, 1, bus, 1.2); this.cymbal(t + 0.02, 3, 0.8, false, bus);
    if (this.musicOn) this.brass(t + 0.05, side === 'blue' ? 50 : 45, 0.9, 1, side === 'blue' ? 57 : 38);
  }
  impact(usd, side, t = this.ctx.currentTime + 0.01) { // 大单炮弹音效
    const c = this.ctx, k = clamp(Math.log10(usd / 50000) / 2, 0, 1.2);
    const nz = this._noiseSrc(t, 0.3 + k * 0.5), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700 - k * 300;
    const g = c.createGain(); g.gain.setValueAtTime(0.35 + k * 0.4, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3 + k * 0.5);
    nz.connect(lp).connect(g); this._out(g, 'sfx', 0.3);
    const o = c.createOscillator(); o.frequency.setValueAtTime(side === 'blue' ? 120 : 100, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const og = c.createGain(); og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.4 + k * 0.3, t + 0.005); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(og); o.start(t); o.stop(t + 0.45); this._out(og, 'sfx', 0.2);
  }
  fanfare(side, t = this.ctx.currentTime + 0.05) { // 胜利号角
    const third = side === 'blue' ? 66 : 65; // 蓝军 D 大调（光明），红军 D 小调（肃杀）
    const seq = [[62, 0, 0.16], [62, 0.18, 0.16], [62, 0.36, 0.16], [third, 0.54, 0.4], [69, 0.98, 0.4], [74, 1.42, 1.6]];
    for (const [m, dt, d] of seq) this.brass(t + dt, m, d, 1);
    for (const m of [62, third, 69]) this.brass(t + 1.42, m, 1.6, 0.7);
    for (let i = 0; i < 10; i++) this.taiko(t + i * 0.06, 0.35 + i * 0.05, 'music', 0.9);
    this.taiko(t + 1.42, 1, 'music', 1.1); this.cymbal(t + 1.42, 3, 1);
  }
  surgeHit(side, t = this.ctx.currentTime + 0.05) { // 总攻开始：上行铜管 + 镲
    this.cymbal(t - 0.6 < 0 ? t : t - 0.6, 0.6, 0.9, true);
    this.brass(t, side === 'blue' ? 50 : 57, 0.7, 1, side === 'blue' ? 62 : 45);
    this.taiko(t, 1, 'music', 1.1);
  }

  // ---------- 编曲调度 ----------
  _bar(t) {
    const s = this.state, I = clamp(s.intensity, 0, 1);
    const L = s.surge ? 3 : Math.min(3, Math.floor(I * 3.2));
    const bpm = s.surge ? 124 : 66 + 52 * I;
    this.stepDur = 60 / bpm / 4;
    const dur = this.stepDur * 16;
    const side = s.bias > 0.15 ? 'blue' : s.bias < -0.15 ? 'red' : 'neutral';
    const chord = CH[PROG[side][this.bar % 4]];
    this.cur = { L, I, side, chord, root: chord[0] };
    this.drone(t, chord[0], dur, I);
    this.pad(t, side === 'red' ? chord.map(m => m) : chord.map(m => m + 12), dur, (side === 'blue' ? 0.35 : 0) + I * 0.6);
    // 铜管动机：蓝军上行、红军下行
    if (I > 0.5 || s.surge) {
      if (this.bar % 2 === 0 || s.surge) {
        const r = chord[0] + 12, q = this.stepDur * 4;
        const mot = side === 'red' ? [r + 7, r + 5, r + 3, r] : side === 'blue' ? [r, r + 3, r + 7, r + 12] : [r, r + 3, r + 2, r];
        mot.forEach((m, i) => this.brass(t + i * q, m, q * (i === 3 ? 1.8 : 0.9), 0.55 + 0.35 * I));
      }
    }
    if (s.surge) {
      if (this.bar % 2 === 0) this.cymbal(t, 1.6, 0.6);
      for (const m of chord) this.stab(t, m + 12, 1.3, 0.35);
      this.brass(t + this.stepDur * 12, chord[0] + 12, this.stepDur * 4, 0.9, chord[0] + 24);
    }
  }
  _step(t, i) {
    const { L, I, chord } = this.cur;
    const v = TAIKO[L][i];
    if (v) this.taiko(t, v * (0.55 + 0.45 * I));
    if (L >= 1 && (i === 4 || i === 12)) this.tom(t, 0.7);
    if (L >= 2 && (i === 14 || i === 15)) this.tom(t, 0.5);
    if (L >= 1 && i % 2 === 0) this.stab(t, chord[0] + OSTINATO[i / 2] , 0.6 + 0.4 * I);
    if (L >= 2 && i % 2 === 1) this.shaker(t, 0.6 + 0.4 * I);
    if (L >= 3 && i % 2 === 1) this.stab(t, chord[2] + 12, 0.45);
  }
  /** 调度到 tEnd 为止的所有音符 */
  scheduleUntil(tEnd) {
    if (this.nextT < this.ctx.currentTime) this.nextT = this.ctx.currentTime + 0.05;
    while (this.nextT < tEnd) {
      if (this.step === 0) this._bar(this.nextT);
      this._step(this.nextT, this.step);
      this.nextT += this.stepDur;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }
  setState(st) { Object.assign(this.state, st); }
  setVolume(v) { this.volume = v; this.master.gain.setTargetAtTime(v * 0.9, this.ctx.currentTime, 0.05); }
  setMusic(on) {
    this.musicOn = on;
    this.music.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, on ? 0.3 : 0.15);
    if (on) { this.step = 0; this.nextT = this.ctx.currentTime + 0.1; }
  }
  setSfx(on) { this.sfxOn = on; this.sfx.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05); }
}

/** 浏览器端控制器：AudioContext 生命周期、iOS 解锁、后台暂停 */
export class AudioController {
  constructor() { this.ctx = null; this.engine = null; this.timer = null; }
  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    this.engine = new WarMusic(this.ctx);
    // iOS 解锁：在点击手势中播放一段静音
    const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    document.addEventListener('visibilitychange', () => this._vis());
  }
  _vis() {
    if (!this.ctx) return;
    if (document.hidden) this.ctx.suspend();
    else if (this.engine.musicOn || this.engine.sfxOn) this.ctx.resume().then(() => { this.engine.nextT = this.ctx.currentTime + 0.1; });
  }
  /** 必须在用户点击事件内调用 */
  apply({ music, sfx, volume }) {
    if (!music && !sfx && !this.ctx) return;
    this._ensure();
    if (this.ctx.state !== 'running' && !document.hidden) this.ctx.resume();
    this.engine.setVolume(volume);
    if (music !== this.engine.musicOn) this.engine.setMusic(music);
    this.engine.setSfx(sfx);
    if (music && !this.timer) this.timer = setInterval(() => { if (this.ctx.state === 'running') this.engine.scheduleUntil(this.ctx.currentTime + 0.35); }, 60);
    if (!music && this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!music && !sfx) setTimeout(() => { if (!this.engine.musicOn && !this.engine.sfxOn) this.ctx.suspend(); }, 400);
  }
  get on() { return !!(this.engine && (this.engine.musicOn || this.engine.sfxOn) && this.ctx.state === 'running'); }
  update(st) { if (this.engine) this.engine.setState(st); }
  whale(side) { if (this.on) this.engine.whale(undefined, side); }
  impact(usd, side) { if (this.engine && this.engine.sfxOn && this.ctx.state === 'running') this.engine.impact(usd, side); }
  fanfare(side) { if (this.engine && this.engine.musicOn && this.ctx.state === 'running') this.engine.fanfare(side); }
  surge(side) { if (this.engine && this.engine.musicOn && this.ctx.state === 'running') this.engine.surgeHit(side); }
}
