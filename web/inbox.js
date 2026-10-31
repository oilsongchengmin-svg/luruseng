// 电脑这头：挂着一根长连接等手机传图。来一张取一张（取回来先存进浏览器，再让中转站删掉），
// 手机这一趟传齐了就喊一声开工；手机传到一半没了动静，等两分钟也开工，先干收到的。
import * as P from './pair.js';

export const STALL_MS = 120_000;                  // 一趟传到一半没动静多久，就先干收到的

export class Inbox {
  // onFile(file, info) -> Promise（照片存好了才 resolve）；onBatch(batch, got, total)；onState(state, why)；onPhone()：有手机连上了
  constructor(pair, { onFile, onBatch, onState = () => {}, onPhone = () => {}, log = () => {}, stall = STALL_MS }) {
    Object.assign(this, { pair, onFile, onBatch, onState, onPhone, log, stall });
    this.seen = new Set();                        // 取过的（hello 和 new 可能报同一张）
    this.batches = new Map();                     // batch -> {total, got:Set(seq), timer, done}
    this.chain = Promise.resolve();               // 一张一张取：电脑内存也省着用
    this.state = 'off';
    this.said = { text: '', at: 0, timer: null };
    this.line = new P.Line(pair, 'pc', {
      onMessage: (m) => this.message(m),
      onState: (s, why) => { this.state = s; this.onState(s, why); },
    });
  }

  open() { this.line.open(); }
  close() {
    this.line.close();
    for (const b of this.batches.values()) clearTimeout(b.timer);
    clearTimeout(this.said.timer);
  }

  message(m) {
    if (m.t === 'hello') for (const it of m.items || []) this.queue(it);
    else if (m.t === 'new' && m.item) this.queue(m.item);
    else if (m.t === 'phone' && m.on) this.onPhone();
  }

  queue(item) {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    const b = this.batchOf(item);
    b.want.add(item.seq);
    this.chain = this.chain.then(() => this.take(item)).catch((e) => this.log(`✗ 手机传来的一张没取到：${e.message}`));
  }

  batchOf(item) {
    let b = this.batches.get(item.batch);
    if (!b) { b = { total: item.total, got: new Set(), want: new Set(), timer: null, done: false }; this.batches.set(item.batch, b); }
    return b;
  }

  async take(item) {
    let sealed;
    try { sealed = await P.getItem(this.pair, item.id); } catch (e) {
      if (e.status === 404) return;               // 别的窗口先取走了
      this.seen.delete(item.id);                  // 网断了：下回连上 hello 里还有它，再取
      throw e;
    }
    let got;
    try { got = await P.open(this.pair.key, sealed); } catch (e) {
      this.log('✗ 手机传来的一张解不开（二维码换过了？让手机重新扫一下），扔掉了');
      await P.delItem(this.pair, item.id).catch(() => {});
      return;
    }
    const h = got.head || {};
    const name = String(h.name || `phone_${item.batch}_${item.seq}.jpg`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const file = new File([got.bytes], name, { type: h.type || 'image/jpeg', lastModified: Number(h.shot) || item.at || Date.now() });
    await this.onFile(file, { batch: item.batch, seq: item.seq, total: item.total });   // 存进浏览器了才让中转站删
    await P.delItem(this.pair, item.id).catch(() => {});
    const b = this.batchOf(item);
    b.got.add(item.seq);
    this.tick(item.batch, b);
  }

  tick(batch, b) {
    clearTimeout(b.timer);
    if (b.done) return;
    if (b.got.size >= b.total) { b.done = true; this.onBatch(batch, b.got.size, b.total); return; }
    b.timer = setTimeout(() => {                  // 传到一半没了动静：先干收到的，剩下的来了另算一趟
      if (b.done) return;
      b.done = true;
      this.onBatch(batch, b.got.size, b.total);
    }, this.stall);
  }

  // 跟手机报进度（加密了才发）：最多 1.5 秒一回，最后那句一定发出去
  say(text, now = false) {
    const s = this.said;
    s.text = text;
    clearTimeout(s.timer);
    const send = async () => {
      s.at = Date.now();
      try { await P.putStatus(this.pair, await P.sealText(this.pair.key, JSON.stringify({ text: s.text, at: s.at }))); } catch (e) { /* 报不出去不耽误干活 */ }
    };
    const wait = now ? 0 : Math.max(0, 1500 - (Date.now() - s.at));
    if (!wait) send();
    else s.timer = setTimeout(send, wait);
  }
}
