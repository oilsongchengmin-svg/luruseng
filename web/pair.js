// 手机传图：配对、加密、跟中转站说话（电脑页、手机页共用）
// 电脑上生成一个通道（room）和一把钥匙（key），放进二维码；手机一扫就配上了。
// 照片在手机上用这把钥匙加密（AES-GCM）才发出去，中转站只见乱码；钥匙在网址 # 后面，从来不发给任何服务器。

export const RELAY = 'https://luruseng-relay.lunzigeju.workers.dev';   // 中转站（Cloudflare，仓库 QIANSHOULAB/luruseng-relay；推上去自己部署）
export const MAX_SEALED = 1_990_000;           // 中转站一张最多收这么多字节
const ROOM_RE = /^[A-Za-z0-9_-]{20,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder(), dec = new TextDecoder();

export function relayBase() { return (globalThis.LURUSENG_RELAY || RELAY).replace(/\/$/, ''); }   // 测试时换成本地的

export function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  const t = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
}
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export function newPair() { return { room: b64u(rand(18)), key: b64u(rand(32)), at: Date.now() }; }
export function newBatch() { return b64u(rand(9)); }
export function valid(p) { return !!p && ROOM_RE.test(p.room || '') && KEY_RE.test(p.key || ''); }

// 二维码里装的网址：手机打开就是传图页，通道和钥匙在 # 后面（不发给服务器）
export function link(page, p) {
  const u = new URL('send.html', page);
  u.search = '';
  u.hash = `r=${p.room}&k=${p.key}`;
  return u.href;
}
export function parse(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const p = { room: q.get('r') || '', key: q.get('k') || '' };
  return valid(p) ? p : null;
}

const keys = new Map();
function aes(k) {
  if (!keys.has(k)) keys.set(k, crypto.subtle.importKey('raw', unb64u(k), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return keys.get(k);
}

// 封一张：[头的长度 4 字节][头（JSON：名字、拍摄时间…）][照片] → 随机 12 字节 IV + 密文
export async function seal(k, head, bytes) {
  const h = enc.encode(JSON.stringify(head));
  const plain = new Uint8Array(4 + h.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, h.length);
  plain.set(h, 4);
  plain.set(bytes, 4 + h.length);
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(k), plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}
export async function open(k, sealed) {
  const b = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, await aes(k), b.subarray(12)));
  const n = new DataView(plain.buffer).getUint32(0);
  return { head: JSON.parse(dec.decode(plain.subarray(4, 4 + n))), bytes: plain.subarray(4 + n) };
}
export async function sealText(k, text) { return b64u(await seal(k, {}, enc.encode(text))); }
export async function openText(k, s) { return dec.decode((await open(k, unb64u(s))).bytes); }

// 跟中转站说话
const url = (p, path) => `${relayBase()}/r/${p.room}/${path}`;
export function wsUrl(p, role) { return url(p, `ws?as=${role}`).replace(/^http/, 'ws'); }

async function call(input, init) {
  const res = await fetch(input, { cache: 'no-store', ...init });
  if (!res.ok) {
    let why = '';
    try { why = (await res.json()).error || ''; } catch (e) { /* 不是 JSON */ }
    const e = new Error(`中转站 HTTP ${res.status}${why ? '：' + why : ''}`);
    e.status = res.status;
    throw e;
  }
  return res;
}
export async function putItem(p, batch, seq, total, sealed) {
  return (await call(url(p, `item?batch=${batch}&seq=${seq}&total=${total}`), { method: 'PUT', body: sealed })).json();
}
export async function getItem(p, id) { return new Uint8Array(await (await call(url(p, `item/${id}`))).arrayBuffer()); }
export async function delItem(p, id) { await call(url(p, `item/${id}`), { method: 'DELETE' }); }
export async function items(p) { return (await call(url(p, 'items'))).json(); }
export async function putStatus(p, sealedText) { await call(url(p, 'status'), { method: 'PUT', body: sealedText }); }
export async function ping() { return (await fetch(`${relayBase()}/ping`, { cache: 'no-store' })).ok; }

// 一根不断的长连接：断了自己重连（1 秒、2 秒、5 秒……最多 30 秒一回），每 25 秒心跳一下
export class Line {
  constructor(p, role, { onMessage = () => {}, onState = () => {} } = {}) {
    Object.assign(this, { p, role, onMessage, onState, ws: null, tries: 0, closed: false, beat: null, again: null });
  }
  open() {
    this.closed = false;
    clearTimeout(this.again);
    let ws;
    try { ws = new WebSocket(wsUrl(this.p, this.role)); } catch (e) { this.retry(e.message); return; }
    this.ws = ws;
    this.onState('connecting');
    ws.onopen = () => {
      this.tries = 0;
      this.onState('on');
      clearInterval(this.beat);
      this.beat = setInterval(() => { try { ws.send('ping'); } catch (e) { /* 断了等 onclose */ } }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      this.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.beat);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.closed) this.retry();
    };
    ws.onerror = () => { /* 接着就是 onclose */ };
  }
  retry(why = '') {
    const wait = [1, 2, 5, 10, 30][Math.min(this.tries++, 4)];
    this.onState('off', why);
    this.again = setTimeout(() => this.open(), wait * 1000);
  }
  now() { if (!this.closed && !this.ws) { clearTimeout(this.again); this.open(); } }   // 手机切回来：马上连，别等
  close() {
    this.closed = true;
    clearTimeout(this.again);
    clearInterval(this.beat);
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch (e) { /* 已经关了 */ }
  }
}
