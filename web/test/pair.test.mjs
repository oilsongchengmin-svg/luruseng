// 手机传图：配对、加密、电脑那头收图凑齐一趟（pair.js、inbox.js）
// 跑：node --test web/test/pair.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../pair.js';
import { Inbox } from '../inbox.js';

globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };   // 测试里不真连

test('pairing: room and key are random, the link carries them after #, parse reads them back', () => {
  const a = P.newPair(), b = P.newPair();
  assert.ok(P.valid(a) && a.room !== b.room && a.key !== b.key);
  assert.equal(a.room.length, 24);
  assert.equal(a.key.length, 43);
  const href = P.link('https://qianshoulab.github.io/luruseng/web/?x=1#old', a);
  assert.equal(href, `https://qianshoulab.github.io/luruseng/web/send.html#r=${a.room}&k=${a.key}`);
  assert.deepEqual(P.parse(new URL(href).hash), { room: a.room, key: a.key });
  assert.equal(P.parse('#r=short&k=abc'), null);
  assert.equal(P.parse(''), null);
});

test('sealed photo opens only with the right key, header and bytes come back exact', async () => {
  const p = P.newPair();
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
  const head = { v: 1, name: 'IMG_0001.jpg', shot: 1730000000000, type: 'image/jpeg' };
  const sealed = await P.seal(p.key, head, bytes);
  assert.equal(sealed.length, 12 + 4 + JSON.stringify(head).length + bytes.length + 16);   // IV + 头 + 照片 + 校验
  const back = await P.open(p.key, sealed);
  assert.deepEqual(back.head, head);
  assert.deepEqual(back.bytes, bytes);
  await assert.rejects(P.open(P.newPair().key, sealed));                           // 换把钥匙：解不开
  sealed[40] ^= 1;
  await assert.rejects(P.open(p.key, sealed));                                    // 中途被改一个字节：解不开
  assert.equal(await P.openText(p.key, await P.sealText(p.key, '干完了：成功 3 · 失败 0')), '干完了：成功 3 · 失败 0');
  const big = new Uint8Array(70_000).map((_, i) => i % 256);
  assert.deepEqual(P.unb64u(P.b64u(big)), big);
});

function fakeRelay(p) {                         // 中转站：GET 取照片、DELETE 删掉、PUT status 记下来
  const store = new Map(), deleted = [], said = [];
  globalThis.fetch = async (url, init = {}) => {
    const m = String(url).match(/\/r\/[^/]+\/(item|status)(?:\/(\d+))?/);
    const method = init.method || 'GET';
    if (m[1] === 'status') { said.push(JSON.parse(await P.openText(p.key, init.body)).text); return new Response('{}'); }
    const id = Number(m[2]);
    if (method === 'DELETE') { deleted.push(id); store.delete(id); return new Response('{}'); }
    if (!store.has(id)) return new Response('{"error":"gone"}', { status: 404 });
    return new Response(store.get(id));
  };
  return { store, deleted, said };
}

test('inbox: takes each photo, deletes it only after the app saved it, starts when the trip is complete', async () => {
  const p = P.newPair();
  const relay = fakeRelay(p);
  for (let i = 1; i <= 3; i++) relay.store.set(i, await P.seal(p.key, { name: `IMG_${i}.jpg`, shot: 1730000000000 + i, type: 'image/jpeg' }, new Uint8Array([i, i])));
  const files = [], batches = [];
  const ib = new Inbox(p, {
    onFile: async (f, info) => { assert.ok(!relay.deleted.includes(info.seq), '存好之前不许删'); files.push([f.name, f.lastModified, f.size, info.seq]); },
    onBatch: (b, got, total) => batches.push([b, got, total]),
  });
  ib.message({ t: 'hello', items: [{ id: 1, batch: 'trip_a', seq: 1, total: 3 }, { id: 2, batch: 'trip_a', seq: 2, total: 3 }] });
  ib.message({ t: 'new', item: { id: 2, batch: 'trip_a', seq: 2, total: 3 } });            // 同一张报两回：只取一次
  await ib.chain;
  assert.deepEqual(batches, []);                                                     // 还差一张：不开工
  ib.message({ t: 'new', item: { id: 3, batch: 'trip_a', seq: 3, total: 3 } });
  await ib.chain;
  assert.deepEqual(files, [['IMG_1.jpg', 1730000000001, 2, 1], ['IMG_2.jpg', 1730000000002, 2, 2], ['IMG_3.jpg', 1730000000003, 2, 3]]);
  assert.deepEqual(relay.deleted, [1, 2, 3]);
  assert.deepEqual(batches, [['trip_a', 3, 3]]);
  ib.close();
});

test('inbox: a trip that stalls halfway still gets worked after the wait; garbage is thrown away', async () => {
  const p = P.newPair();
  const relay = fakeRelay(p);
  relay.store.set(7, await P.seal(p.key, { name: 'a.jpg' }, new Uint8Array([1])));
  relay.store.set(8, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
  const batches = [], logs = [];
  const ib = new Inbox(p, { onFile: async () => {}, onBatch: (b, got, total) => batches.push([b, got, total]), log: (m) => logs.push(m), stall: 50 });
  ib.message({ t: 'new', item: { id: 7, batch: 'trip_b', seq: 1, total: 4 } });
  ib.message({ t: 'new', item: { id: 8, batch: 'trip_b', seq: 2, total: 4 } });
  await ib.chain;
  assert.ok(logs.some((m) => m.includes('解不开')), logs);
  assert.ok(relay.deleted.includes(8));                                              // 解不开的也删掉，免得一直卡着
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(batches, [['trip_b', 1, 4]]);
  ib.close();
});

test('inbox: tells the phone how it is going, at most every 1.5 s, the last word always gets out', async () => {
  const p = P.newPair();
  const relay = fakeRelay(p);
  const ib = new Inbox(p, { onFile: async () => {}, onBatch: () => {} });
  ib.say('开工了 0/3', true);
  ib.say('干着呢 1/3');
  ib.say('干着呢 2/3');
  ib.say('干完了：成功 3 · 失败 0', true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(relay.said, ['开工了 0/3', '干完了：成功 3 · 失败 0']);
  ib.close();
});

test('pages load every module through the versioned import map (a new module cannot be left out)', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../', import.meta.url);
  const deps = (entry, seen = new Set()) => {                     // entry 能牵出来的所有模块
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const src = readFileSync(new URL(`${entry}.js`, dir), 'utf8');
    for (const m of src.matchAll(/from '\.\/([\w-]+)\.js'/g)) deps(m[1], seen);
    return seen;
  };
  for (const [page, entry] of [['index.html', 'app'], ['send.html', 'send']]) {
    const html = readFileSync(new URL(page, dir), 'utf8');
    const listed = new Set(JSON.parse(html.match(/const mods = (\[[^\]]*\])/)[1].replace(/'/g, '"')));
    assert.deepEqual([...deps(entry)].sort(), [...listed].sort(), page);
    assert.ok(html.includes(`s.src = \`${entry}.js?v=\${v}\``) && !html.includes(`src="${entry}.js"`), page);
  }
});
