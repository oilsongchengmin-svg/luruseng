// 手机传图页：扫了电脑上的二维码打开这里。拍完全选一传，照片先在手机上缩小、加密，一张张送到中转站；
// 电脑那边取走一张，这里就记一张「电脑收到」；电脑开工、干完也报回来。
import * as P from './pair.js';
import * as I from './image.js';

const $ = (s) => document.querySelector(s);
const SIDE = 2560;                                 // 送多大：最长边 2560（认字只用 2048，核对放大看也够）
const LIMIT = 1_800_000;                           // 一张压到这么大以内（中转站一张最多 1.99MB）
const STORE = 'luruseng-pair';

const T = { batch: '', total: 0, sent: 0, got: new Set(), files: [], busy: false, line: null, pc: null, mine: new Set() };

function pairing() {                               // 先看网址 # 后面（刚扫的码），再看上回记下的
  let p = P.parse(location.hash);
  try {
    if (p) localStorage.setItem(STORE, JSON.stringify(p));
    else p = JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch (e) { /* 不让存就算了：网址里有就行 */ }
  if (!P.valid(p)) return null;
  if (!P.parse(location.hash)) history.replaceState(null, '', `#r=${p.room}&k=${p.key}`);   // 加到主屏幕时带上配对
  return p;
}

function pcState(on) {
  T.pc = on;
  $('#dot').classList.toggle('on', !!on);
  $('#pcstate').textContent = on === null ? '正在连中转站…'
    : on ? '电脑在线：送到就开工' : '电脑没开：照片先存着，电脑一打开录入僧就干';
}

function status(text) {                            // 数字蓝色大字（跟电脑上一个样）
  const el = $('#st');
  el.textContent = '';
  for (const part of String(text).split(/(\d+(?:\/\d+)?)/)) {
    if (!part) continue;
    if (/^\d+(?:\/\d+)?$/.test(part)) { const b = document.createElement('b'); b.textContent = part; el.appendChild(b); } else el.append(part);
  }
}

function draw() {
  if (!T.total) return;
  const got = T.got.size;
  $('#prog').hidden = false;
  status(got >= T.total ? `电脑收齐 ${T.total} 张` : `送出 ${T.sent}/${T.total} · 电脑收到 ${got}/${T.total}`);
  $('#bar').style.width = `${Math.round((100 * (T.sent + got)) / (2 * T.total))}%`;
}

async function shrink(file) {                      // 缩小、转 JPG；拍摄时间另外记着（转完 EXIF 就没了，电脑按它排编号）
  const shot = await I.shotTime(file);
  const img = await I.openImage(file);
  let side = SIDE, q = 0.86, blob;
  for (;;) {
    blob = await I.toBlob(I.draw(img, side), q);
    if (blob.size <= LIMIT || side <= 1400) break;
    if (q > 0.62) q -= 0.12; else { side = Math.round(side * 0.8); q = 0.8; }
  }
  const name = (file.name || 'photo').replace(/\.[^.]*$/, '') + '.jpg';
  return { bytes: new Uint8Array(await blob.arrayBuffer()), head: { v: 1, name, shot: shot || file.lastModified || Date.now(), type: 'image/jpeg' } };
}

async function sendOne(p, file, seq) {
  const { bytes, head } = await shrink(file);
  const sealed = await P.seal(p.key, head, bytes);
  if (sealed.length > P.MAX_SEALED) throw new Error('这张太大，压不下去');
  let last;
  for (const wait of [0, 1, 3, 6]) {               // 网不好就再送：中转站认得出是同一张，不会存两份
    if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
    try { return await P.putItem(p, T.batch, seq, T.total, sealed); } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) break;          // 太大、通道满了这些，再送也没用
    }
  }
  throw last;
}

let wake = null;
async function keepAwake(on) {                     // 送的时候屏幕别黑（一黑 Safari 就停）
  try {
    if (on && navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) { wake = null; }
}

async function send(p, files) {
  if (T.busy || !files.length) return;
  T.busy = true;
  $('#pick').disabled = true;
  $('#bad').textContent = '';
  $('#say').textContent = '';
  Object.assign(T, { batch: P.newBatch(), total: files.length, sent: 0, got: new Set(), files: [] });
  draw();
  keepAwake(true);
  const failed = [];
  for (let i = 0; i < files.length; i++) {         // 一张一张来：手机内存小
    try {
      await sendOne(p, files[i], i + 1);
      T.sent++;
      T.mine.add(`${T.batch}/${i + 1}`);
    } catch (e) {
      failed.push(`第 ${i + 1} 张（${files[i].name || '照片'}）：${e.message}`);
    }
    draw();
  }
  keepAwake(false);
  T.busy = false;
  $('#pick').disabled = false;
  if (failed.length) {
    $('#bad').textContent = `✗ 有 ${failed.length} 张没送出去：电脑等两分钟收不齐，就先干收到的。再选一次这几张就行：\n` + failed.join('\n');
  }
  if (T.sent && !T.pc) $('#say').textContent = '照片在中转站等着，电脑一打开录入僧网页版就收、就干（放 3 天）。';
}

function onMessage(m, p) {
  if (m.t === 'hello') { pcState(!!m.pc); if (m.status) showSay(m.status, p); }
  else if (m.t === 'pc') pcState(!!m.on);
  else if (m.t === 'gone' && T.mine.has(`${m.batch}/${m.seq}`) && !m.expired) { T.got.add(`${m.batch}/${m.seq}`); draw(); }
  else if (m.t === 'status' && m.status) showSay(m.status, p);
}

async function showSay(st, p) {                    // 电脑报来的进度（加密的，在这里解开）
  try {
    const { text, at } = JSON.parse(await P.openText(p.key, st.data));
    if (Date.now() - at > 12 * 3600e3) return;     // 半天前的旧话不提
    $('#prog').hidden = false;
    $('#say').textContent = `电脑：${text}`;
  } catch (e) { /* 解不开：别的配对的，不管 */ }
}

function boot() {
  const p = pairing();
  if (!p) { $('#nopair').hidden = false; return; }
  $('#paired').hidden = false;
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('#home').hidden = true;
  pcState(null);
  T.line = new P.Line(p, 'phone', {
    onMessage: (m) => onMessage(m, p),
    onState: (s) => { if (s !== 'on') pcState(null); },
  });
  T.line.open();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') T.line.now(); });
  $('#pick').onclick = () => $('#files').click();
  $('#files').onchange = (e) => { const files = [...e.target.files].filter((f) => f && f.size); e.target.value = ''; send(p, files); };
}

boot();
