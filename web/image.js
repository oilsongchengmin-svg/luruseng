// 照片：读进来、缩小、第二遍拉对比度锐化、算指纹、按标题转正、印编号（跟电脑版 engine.prepare_image / stamp_number 一个意思）
import { MAX_SIDE, JPEG_Q, exifTime } from './core.js';

export const STAMP_SIDE = 2560;            // 编号照片最长边（够放大看手写）
export const IMG_RE = /\.(jpe?g|png|webp|heic|heif|bmp|gif|tiff?|avif)$/i;
const HEIC_LIB = new URL('./vendor/heic2any.min.js', import.meta.url).href;

export function isImage(file) {
  return (file.type && file.type.startsWith('image/')) || IMG_RE.test(file.name || '');
}
function looksHeic(file, head) {
  if (/\.(heic|heif)$/i.test(file.name || '') || /heic|heif/i.test(file.type || '')) return true;
  const brand = String.fromCharCode(...head.slice(8, 12));
  return String.fromCharCode(...head.slice(4, 8)) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand);
}

let libs = {};
export function loadScript(src, global) {
  if (globalThis[global]) return Promise.resolve(globalThis[global]);
  if (!libs[src]) {
    libs[src] = new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (globalThis[global] ? ok(globalThis[global]) : bad(new Error(`${global} 没加载上`)));
      s.onerror = () => { delete libs[src]; bad(new Error(`${src.split('/').pop()} 没加载上（网络断了？）`)); };
      document.head.appendChild(s);
    });
  }
  return libs[src];
}

async function imgFrom(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('这张照片打不开')); });
    img.src = url;
    // 页面看不见的时候（锁屏、窗口最小化、切到后台）decode() 可能一直不回来：等到 load 就行，画的时候浏览器自己会解码
    const decoded = img.decode();
    for (const p of [loaded, decoded]) p.catch(() => {});   // 输的那个后来再出错，别冒成没人接的报错
    await Promise.race([loaded, decoded]);       // <img> 按 EXIF 方向转正（跟电脑版 exif_transpose 一样）
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// 打开一张照片 -> 能画的东西（<img>）。HEIC 浏览器自己不认（除了苹果的 Safari），就现借个解码器转成 JPG
export async function openImage(file) {
  try {
    return await imgFrom(file);
  } catch (e) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!looksHeic(file, head)) throw new Error('这张照片打不开（坏了，或者不是照片）');
    let heic2any;
    try { heic2any = await loadScript(HEIC_LIB, 'heic2any'); } catch (err) { throw new Error('HEIC 照片要先加载解码器，没加载上：网络好了再试，或者在手机相册里另存为 JPG'); }
    let out;
    try { out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 }); } catch (err) { throw new Error('这张 HEIC 照片解不开：在手机相册里另存为 JPG 再放'); }
    return imgFrom(Array.isArray(out) ? out[0] : out);
  }
}

function sizeOf(img) { return [img.naturalWidth || img.width, img.naturalHeight || img.height]; }

export function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && !globalThis.__noOffscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function draw(img, side) {           // 缩到最长边 side，透明的地方垫白底
  const [w, h] = sizeOf(img);
  const s = Math.min(1, side / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  return c;
}

export async function toBlob(c, q) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality: q });
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('照片存不了'))), 'image/jpeg', q));
}

export function b64(blob) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- 第二遍用的图：拉对比度（掐掉两头各 1%）+ 锐化一点
export function autocontrast(d) {
  const n = d.length / 4, cut = Math.floor(n * 0.01);
  for (let ch = 0; ch < 3; ch++) {
    const h = new Uint32Array(256);
    for (let i = ch; i < d.length; i += 4) h[d[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += h[lo]; if (acc > cut) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += h[hi]; if (acc > cut) break; }
    if (hi <= lo) continue;
    const lut = new Uint8ClampedArray(256), sc = 255 / (hi - lo);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) * sc;
    for (let i = ch; i < d.length; i += 4) d[i] = lut[d[i]];
  }
}

function boxBlur(src, dst, w, h, r, horizontal) {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4, span = 2 * r + 1;
  for (let ln = 0; ln < lines; ln++) {
    const base = horizontal ? ln * w * 4 : ln * 4;
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * step + ch];
      for (let i = 0; i < len; i++) {
        dst[base + i * step + ch] = sum / span;
        const out = Math.max(0, i - r), inn = Math.min(len - 1, i + r + 1);
        sum += src[base + inn * step + ch] - src[base + out * step + ch];
      }
    }
  }
}

export function unsharp(d, w, h, percent = 80, threshold = 3) {   // 高斯模糊半径 2 ≈ 三次方框模糊（1、1、2）
  let a = new Float32Array(d), b = new Float32Array(d.length);
  for (const r of [1, 1, 2]) {
    boxBlur(a, b, w, h, r, true);
    boxBlur(b, a, w, h, r, false);
  }
  const k = percent / 100;
  for (let i = 0; i < d.length; i++) {
    if ((i & 3) === 3) continue;
    const diff = d[i] - a[i];
    if (Math.abs(diff) > threshold) d[i] = d[i] + diff * k;
  }
}

// 送去认的那份：最长边 2048 的 JPG（base64）。enhance=true 是第二遍用的，让两遍看到的不完全一样，错不到一块去
export async function prepare(img, enhance = false) {
  const c = draw(img, MAX_SIDE);
  if (enhance) {
    const ctx = c.getContext('2d');
    const im = ctx.getImageData(0, 0, c.width, c.height);
    autocontrast(im.data);
    unsharp(im.data, c.width, c.height);
    ctx.putImageData(im, 0, 0);
  }
  return b64(await toBlob(c, JPEG_Q));
}

// ---------------------------------------------------------------- 指纹、拍摄时间
export async function sha256(file) {             // 照片，或者已经读出来的 ArrayBuffer
  const buf = await crypto.subtle.digest('SHA-256', file instanceof ArrayBuffer ? file : await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function shotTime(file) {       // 先看照片里的 EXIF（拍照那一刻），没有就用文件时间
  try {
    const t = exifTime(await file.slice(0, 512 * 1024).arrayBuffer());
    if (t) return t;
  } catch (e) { /* 读不到 */ }
  return file.lastModified || 0;
}

// ---------------------------------------------------------------- 转正、印编号（只给人看：送去认的永远是原图）
export function upright(src, side) {         // 标题在右边就逆时针转 90°，在左边顺时针 90°，在下边转 180°
  if (!['right', 'left', 'bottom'].includes(side)) return src;
  const w = src.width, h = src.height;
  const c = side === 'bottom' ? canvas(w, h) : canvas(h, w);
  const ctx = c.getContext('2d');
  if (side === 'right') { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  else if (side === 'left') { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  else { ctx.translate(w, h); ctx.rotate(Math.PI); }
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);         // 转完复位：后面印编号要按正的坐标画
  return c;
}

function busy(ctx, x, y, w, h) {             // 这一块有多乱（灰度的标准差）
  const d = ctx.getImageData(x, y, w, h).data;
  let s = 0, s2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    s += g; s2 += g * g;
  }
  const m = s / n;
  return Math.round(Math.sqrt(Math.max(0, s2 / n - m * m)));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 在照片最空的那个角写上大红编号（白底红框）；四个角都有字就在顶上加一条白边写
export async function stamp(img, no, side = '') {
  let c = upright(draw(img, STAMP_SIDE), side);
  let ctx = c.getContext('2d');
  const w = c.width, h = c.height, short = Math.min(w, h);
  const text = String(no);
  const size = Math.max(28, Math.floor(short * 0.11));
  const font = `bold ${size}px Arial, "Helvetica Neue", "DejaVu Sans", sans-serif`;
  ctx.font = font;
  const mt = ctx.measureText(text);
  const l = mt.actualBoundingBoxLeft || 0, asc = mt.actualBoundingBoxAscent || size * 0.72;
  const tw = (mt.actualBoundingBoxRight || mt.width) + l, th = asc + (mt.actualBoundingBoxDescent || 0);
  const pad = Math.max(8, Math.floor(th * 0.35));
  const bw = Math.ceil(tw + 2 * pad), bh = Math.ceil(th + 2 * pad);
  const m = Math.max(6, Math.floor(short * 0.02));
  const spots = [[w - bw - m, m], [m, m], [w - bw - m, h - bh - m], [m, h - bh - m]];   // 右上、左上、右下、左下
  let best = null;
  spots.forEach(([x, y], i) => {
    if (x < 0 || y < 0) return;
    const sc = busy(ctx, x, y, bw, bh);
    if (!best || sc < best[0]) best = [sc, i, x, y];
  });
  if (!best) best = [999, 0, m, m];
  let [score, , x, y] = best;
  if (score > 30) {                          // 四个角都不空：顶上加一条白边
    const band = bh + 2 * m;
    const c2 = canvas(w, h + band);
    const x2 = c2.getContext('2d');
    x2.fillStyle = '#fff';
    x2.fillRect(0, 0, w, h + band);
    x2.drawImage(c, 0, band);
    c = c2; ctx = x2; x = m; y = m;
    ctx.font = font;
  }
  roundRect(ctx, x, y, bw, bh, Math.max(4, Math.floor(pad / 2)));
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = Math.max(3, Math.floor(short / 250));
  ctx.strokeStyle = 'rgb(200,0,0)';
  ctx.stroke();
  ctx.fillStyle = 'rgb(200,0,0)';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + pad + l, y + pad + asc);
  return toBlob(c, 0.88);
}

// 核对时自动转正转错了：编号照片转 90°（原图不动）
export async function rotate(blob, clockwise) {
  const img = await imgFrom(blob);
  const [w, h] = sizeOf(img);
  const c = canvas(h, w);
  const ctx = c.getContext('2d');
  if (clockwise) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); } else { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return toBlob(c, 0.9);
}
