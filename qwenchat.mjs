// qwenchat.mjs "<prompt>" [--model qwen3.8-max] — qwen.ai via CDP in-page fetch
// v2: account rotation (qwen_accounts.json) + guest fallback; rotates on RateLimited/auth expiry
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
let model = process.env.QWEN_MODEL || 'qwen3.7-plus';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model' && argv[i + 1]) { model = argv[i + 1]; argv.splice(i, 2); break; }
  if (argv[i].startsWith('--model=')) { model = argv[i].slice(8); argv.splice(i, 1); break; }
}
if (!/^qwen3[\w.-]*$/.test(model)) model = 'qwen3.7-plus';
const prompt = argv.join(' ');
if (!prompt) { console.error('usage: node qwenchat.mjs "<prompt>" [--model qwen3.8-max]'); process.exit(1); }

const CDP = process.env.QWEN_CDP || 'http://127.0.0.1:9445';
const TEMP = process.env.TEMP;
const ACC_FILE = TEMP + '\\qwen_accounts.json';
const STATE_FILE = TEMP + '\\qwen_rotation.json';
const bxFile = process.env.QWEN_BX || (TEMP + '\\qwen_bx.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const PACE = 60000;
const stamp = TEMP + '\\qwenchat.last';
const MAX_ACCT_TRIES = 3;
const BUDGET_MS = 200000;

try { const last = Number(readFileSync(stamp, 'utf8')); const wait = PACE - (Date.now() - last); if (wait > 0) { log(`pacing: waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); } } catch {}

const accounts = existsSync(ACC_FILE) ? JSON.parse(readFileSync(ACC_FILE, 'utf8')) : [];
let state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { lastIdx: -1, acct: {}, stats: { ok: 0, rate: 0, auth: 0, err: 0, guest: 0 } };
if (!state.acct) state.acct = {};
if (!state.stats) state.stats = { ok: 0, rate: 0, auth: 0, err: 0, guest: 0 };
const st = i => state.acct[i] || (state.acct[i] = { cool: 0, dead: false, reason: '', errs: 0 });
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

async function newTab(url) { let r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => null); if (!r || !r.ok) r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`); return r.ok ? await r.json() : null; }
function rpc(ws, method, params = {}, timeout = 20000) { const id = Math.floor(Math.random() * 1e9); ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('rpc timeout: ' + method)), timeout); const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', on); resolve(m.result); } }; ws.addEventListener('message', on); }); }
const ev = async (ws, e, t) => { const r = await rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, t || 30000); if (r.exceptionDetails) return undefined; return r.result && r.result.value; };

const tab = await newTab('https://chat.qwen.ai/');
if (!tab) { log('CDP_FAIL no tab — is chrome on :9445 running?'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws connect')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', rej); });
await rpc(ws, 'Page.enable'); await rpc(ws, 'Runtime.enable'); await rpc(ws, 'Network.enable');

async function waitReady(settle = 1500) {
  let ok = false;
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    const st2 = await rpc(ws, 'Runtime.evaluate', { expression: 'document.readyState + "|" + location.host', returnByValue: true }).catch(() => null);
    if ((st2?.result?.value || '').startsWith('complete') && (st2?.result?.value || '').includes('qwen.ai')) { ok = true; break; }
  }
  if (settle) await sleep(settle);
  return ok;
}
if (!(await waitReady())) { log('PAGE_NOT_READY'); ws.close(); await fetch(`${CDP}/json/close/${tab.id}`); process.exit(1); }

async function dismissAgeGate() {
  await ev(ws, `(() => {
    const m = [...document.querySelectorAll('.ant-modal-content')].find(e => /age/i.test(e.innerText || ''));
    if (m) { const b = [...m.querySelectorAll('button')].find(x => /continue/i.test(x.textContent || '') && !x.disabled); if (b) b.click(); }
    return 1;
  })()`).catch(() => {});
  await sleep(500);
}
await dismissAgeGate();

// live bx capture from the app's own requests (freshest fingerprint per run)
const bxHits = [];
const bxListener = m => {
  const j = JSON.parse(m.data);
  if (j.method === 'Network.requestWillBeSent') {
    const h = (j.params.request && j.params.request.headers) || {};
    if (h['bx-ua'] && h['bx-umidtoken']) bxHits.push({ ua: h['bx-ua'], umid: h['bx-umidtoken'], v: h['bx-v'] || '2.5.37', ver: h['Version'] || '0.3.12', tz: h['Timezone'] || '', at: Date.now() });
  }
};
ws.addEventListener('message', bxListener);

// ---------- account session install ----------
async function wipeQwen() {
  const ck = await rpc(ws, 'Network.getAllCookies', {});
  for (const c of ck.cookies || []) if (/qwen\.ai/.test(c.domain)) await rpc(ws, 'Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' }).catch(() => {});
  const host = await ev(ws, 'location.host');
  if (host && /qwen\.ai/.test(host)) await ev(ws, 'try{localStorage.clear();sessionStorage.clear()}catch(e){}');
  await sleep(500);
}
async function installCookies(cookies) {
  for (const c of cookies || []) {
    const p = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure };
    if (c.expires && c.expires > 0) p.expires = c.expires;
    if (/^(strict|lax|none)$/i.test(c.sameSite || '')) p.sameSite = c.sameSite[0].toUpperCase() + c.sameSite.slice(1).toLowerCase();
    await rpc(ws, 'Network.setCookie', p).catch(() => {});
  }
}
async function goto(url) { await rpc(ws, 'Page.navigate', { url }); await waitReady(1000); }

async function installSession(acct) {
  await wipeQwen();
  await installCookies(acct.cookies);
  await goto('https://chat.qwen.ai/');
  const kv = Object.entries(acct.ls || {}).filter(([, v]) => v != null && v !== 'null');
  const setItems = kv.map(([k, v]) => `try{localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v))})}catch(e){}`).join('');
  const r0 = await ev(ws, `try{localStorage.clear();${setItems};'set'}catch(e){'E:'+e.message}`);
  if (typeof r0 === 'string' && r0.startsWith('E:')) log('ls warn', r0);
  await ev(ws, 'location.reload()').catch(() => {});
  await dismissAgeGate();
  // wait for a stable post-reload page (retry through destroyed-context races)
  let j = null;
  for (let i = 0; i < 14; i++) {
    await sleep(1000);
    const s = await ev(ws, 'JSON.stringify({href:location.href,rs:document.readyState,token:!!localStorage.getItem("token"),user:(document.body?(document.body.innerText.match(/QwenUser\\d+/)||[])[0]:null)})').catch(() => null);
    let k = null; try { k = JSON.parse(s || ''); } catch {}
    if (k && k.href && k.rs === 'complete') { j = k; break; }
  }
  if (!j) { log('install', acct.username || acct.email, 'FAIL no stable page'); return false; }
  const ok = !!j.token && !/\/auth/.test(j.href || '');
  log('install', acct.username || acct.email, ok ? 'OK' : 'FAIL', 'href=' + String(j.href || '').slice(0, 60), 'user=' + (j.user || '-'));
  return ok;
}
function pickBx(acct) {
  if (bxHits.length) return bxHits[bxHits.length - 1];
  if (acct.bx && acct.bx.ua) return acct.bx;
  try { return JSON.parse(readFileSync(TEMP + '\\qwen_bx_visible.json', 'utf8')); } catch {}
  try { return JSON.parse(readFileSync(bxFile, 'utf8')); } catch {}
  return null;
}

// ---------- request expr ----------
function makeExpr(BX, MODE) {
  return `(() => {
    const P = ${JSON.stringify(prompt)};
    const MODEL = ${JSON.stringify(model)};
    const MODE = ${JSON.stringify(MODE)};
    const race = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + label)), ms))]);
    const nf = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }));
    const H = ${JSON.stringify({ ua: BX.ua, umid: BX.umid, v: BX.v, ver: BX.ver, tz: BX.tz })};
    const TK = (() => { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } })();
    const mk = (ref, accept) => {
      const h = {
        'bx-ua': H.ua, 'bx-umidtoken': H.umid, 'bx-v': H.v, 'Version': H.ver, 'source': 'web', 'Timezone': H.tz,
        'content-type': 'application/json', 'Accept': accept, 'X-Request-Id': crypto.randomUUID(),
        'Referer': location.origin + ref, 'X-Accel-Buffering': 'no'
      };
      if (TK) h['Authorization'] = 'Bearer ' + TK;
      return h;
    };
    return (async () => {
      let stage = 'chats/new';
      try {
        const r1 = await race(fetch('/api/v2/chats/new', { method: 'POST', headers: mk('/c/new-chat', 'application/json, text/plain, */*'), body: JSON.stringify({ chatId: '', models: [MODEL], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: MODE }), signal: AbortSignal.timeout(20000) }), 25000, 'chats/new');
        const t1 = await r1.text();
        const rh1 = r1.headers.get('retry-after');
        if (r1.status !== 200 || t1.trim().startsWith('<')) return { stage, fail: true, status: r1.status, body: t1.slice(0, 250), rh: rh1 };
        let cj = null; try { cj = JSON.parse(t1); } catch {}
        const chatId = cj && cj.data && cj.data.id;
        if (!chatId) return { stage, fail: true, status: r1.status, body: t1.slice(0, 300), rh: rh1 };

        stage = 'completions';
        const body = { stream: true, version: '2.1', incremental_output: true, chatId, parentId: '', chat_id: chatId, chat_mode: MODE, model: MODEL, parent_id: null, messages: [{ fid: nf(), role: 'user', content: P, user_action: 'chat', files: [], timestamp: Math.floor(Date.now() / 1000), models: [MODEL], model: '', chat_type: 't2t', feature_config: { thinking_enabled: false, output_schema: 'phase', research_mode: 'normal', auto_thinking: false, thinking_mode: 'Auto', thinking_format: 'summary' } }] };
        const r2 = await race(fetch('/api/v2/chat/completions?chat_id=' + chatId, { method: 'POST', headers: mk('/c/guest', 'text/event-stream'), body: JSON.stringify(body), signal: AbortSignal.timeout(25000) }), 30000, 'completions');
        const rh = r2.headers.get('retry-after');
        if (r2.status !== 200) { const t2 = await r2.text(); return { stage, fail: true, status: r2.status, ct: r2.headers.get('content-type') || '', body: t2.slice(0, 350), rh }; }
        if (/json/.test(r2.headers.get('content-type') || '')) { const t2 = await r2.text(); return { stage, fail: true, json: true, status: 200, body: t2.slice(0, 450), rh }; }

        stage = 'stream';
        const reader = r2.body.getReader();
        const dec = new TextDecoder();
        let buf = '', out = '', ended = false, streamErr = null;
        const t0 = Date.now();
        const handleLine = line => {
          const m = line.match(/^data:\\s*(.+)$/); if (!m) return;
          const p = m[1].trim(); if (p === '[DONE]') { ended = true; return; }
          try {
            const j = JSON.parse(p);
            if (j.error) { streamErr = j.error; ended = true; return; }
            const ch = j.choices && j.choices[0];
            if (ch && ch.delta && typeof ch.delta.content === 'string' && ch.delta.content) {
              const ph = ch.delta.phase || '';
              if (ph === '' || ph === 'answer') out += ch.delta.content;
            }
            if (j.response && (j.response.completed || j.response.finished)) ended = true;
            if (ch && ch.finish_reason) ended = true;
          } catch {}
        };
        while (Date.now() - t0 < 75000 && !ended) {
          let chunk;
          try { chunk = await race(reader.read(), 25000, 'read'); } catch (e) { break; }
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          const lines = buf.split(/\\r?\\n/);
          buf = lines.pop();
          for (const l of lines) handleLine(l);
          if (out.length > 300000) break;
        }
        if (buf) handleLine(buf);
        try { reader.cancel(); } catch {}
        if (streamErr) return { stage, fail: true, errObj: streamErr, out: out.slice(0, 500) };
        return { stage: 'done', out };
      } catch (e) {
        return { stage, fail: true, err: String((e && e.message) || e) };
      }
    })();
  })()`;
}

async function runAttempt(BX, MODE) {
  const res = await rpc(ws, 'Runtime.evaluate', { expression: makeExpr(BX, MODE), returnByValue: true, awaitPromise: true }, 115000);
  return res?.result?.value;
}

function classify(v) {
  if (!v) return { kind: 'ERR', msg: 'no result' };
  if (!v.fail && v.out) return { kind: 'OK' };
  const s = JSON.stringify({ stage: v.stage, status: v.status, body: v.body, err: v.err, errObj: v.errObj, json: v.json });
  let rh = v.rh ? parseInt(v.rh, 10) : NaN;
  if (!isFinite(rh)) { const m2 = s.match(/retry[_-]?after["':\s]+(\d+)/i); if (m2) rh = parseInt(m2[1], 10); }
  if (v.status === 429) return { kind: 'RATE', retryAfter: isFinite(rh) ? Math.min(Math.max(rh, 60), 86400) : 900, msg: s.slice(0, 400) };
  if (v.status === 401 || v.status === 403) return { kind: 'AUTH', msg: s.slice(0, 400) };
  if (/unauthorized|invalid[\s_-]*token|login required|not logged in|token expired|401 Unauthorized/i.test(s)) return { kind: 'AUTH', msg: s.slice(0, 400) };
  if (/ratelimit|rate[\s_-]*limit|quota|too many requests|exceeded the.{0,30}limit/i.test(s)) return { kind: 'RATE', retryAfter: isFinite(rh) ? Math.min(Math.max(rh, 60), 86400) : 900, msg: s.slice(0, 400) };
  if (v.stage === 'completions' && /timeout/i.test(v.err || '')) return { kind: 'RATE', retryAfter: 3600, msg: 'completions stall → treated as quota gate: ' + String(v.err).slice(0, 120) };
  return { kind: 'ERR', msg: s.slice(0, 200) };
}

// ---------- guest helpers (v1) ----------
let bx = existsSync(bxFile) ? JSON.parse(readFileSync(bxFile, 'utf8')) : null;

async function harvest() {
  const hdrs = {};
  const listener = m2 => {
    const m = JSON.parse(m2.data);
    if (m.method === 'Network.requestWillBeSent' && m.params.request && m.params.request.method === 'POST' && /\/api\/v2\/chats\/new/.test(m.params.request.url)) hdrs.h = m.params.request.headers;
  };
  ws.addEventListener('message', listener);
  try {
    const doSend = async () => {
      const clicked = await ev(ws, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && !x.disabled && /send/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.innerText || ''))); if (b) { b.click(); return 1; } return 0; })()`);
      if (!clicked) {
        await rpc(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await sleep(120);
        await rpc(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
    };
    await ev(ws, `(() => { const t = document.querySelector('textarea'); if (t) { t.focus(); t.value = ''; } return 1; })()`);
    await rpc(ws, 'Input.insertText', { text: 'ping' });
    await sleep(800);
    await doSend();
    await sleep(900);
    const gate = await ev(ws, `(() => { const m = [...document.querySelectorAll('.ant-modal-content,[role=dialog]')].find(x => /year were you born|confirm your age/i.test(x.innerText || '')); if (m) { const b = [...m.querySelectorAll('button')].find(x => /continue/i.test(x.textContent || '') && !x.disabled); if (b) { b.click(); return 1; } } return 0; })()`);
    if (gate) { await sleep(800); await doSend(); }
    for (let i = 0; i < 10 && !hdrs.h; i++) await sleep(1000);
  } finally { ws.removeEventListener('message', listener); }
  const h = hdrs.h;
  if (!h || !h['bx-ua']) return null;
  const fresh = { ua: h['bx-ua'], umid: h['bx-umidtoken'], v: h['bx-v'] || '2.5.37', ver: h['Version'] || '0.3.12', tz: h['Timezone'] || '', at: Date.now() };
  writeFileSync(bxFile, JSON.stringify(fresh));
  log('bx harvested (ua len ' + String(fresh.ua).length + ')');
  return fresh;
}

// ---------- main ----------
const t0 = Date.now();
let out = null;
try {
  const now = Date.now();
  const order = [];
  for (let k = 0; k < accounts.length; k++) order.push((state.lastIdx + 1 + k) % accounts.length);
  const healthy = order.filter(i => { const a = state.acct[i]; return !(a && (a.dead || a.cool > now)); });
  log(`accounts=${accounts.length} healthy=${healthy.length} lastIdx=${state.lastIdx}`);

  for (const i of healthy.slice(0, MAX_ACCT_TRIES)) {
    if (Date.now() - t0 > BUDGET_MS) { log('budget exhausted, switching to guest'); break; }
    const acct = accounts[i];
    bxHits.length = 0;
    let ok = await installSession(acct).catch(e => { log('install ex', String(e).slice(0, 100)); return false; });
    if (!ok) {
      const s2 = st(i); s2.errs++;
      if (s2.errs >= 3) { s2.dead = true; s2.reason = 'install'; }
      saveState(); log(`acct[${i}] install failed (errs=${s2.errs})`); continue;
    }
    let bxv = pickBx(acct);
    if (!bxv) { const s2 = st(i); s2.dead = true; s2.reason = 'no bx'; saveState(); log(`acct[${i}] no bx available`); continue; }
    let v = await runAttempt(bxv, 'normal').catch(e => ({ fail: true, err: 'run ex: ' + String(e).slice(0, 120) }));
    let c = classify(v);
    log(`acct[${i}] ${acct.username || ''} → ${c.kind} ${c.msg ? '(' + String(c.msg).slice(0, 420) + ')' : ''}`);

    if (c.kind === 'AUTH') {
      log(`acct[${i}] auth fail → reload/retry once (refresh cookie)`);
      await ev(ws, 'location.reload()').catch(() => {});
      await waitReady(1500);
      v = await runAttempt(bxv, 'normal').catch(e => ({ fail: true, err: 'run ex: ' + String(e).slice(0, 120) }));
      c = classify(v);
      log(`acct[${i}] retry → ${c.kind}`);
    }

    if (c.kind === 'OK') {
      state.lastIdx = i; state.stats.ok++; saveState();
      out = v.out; log(`USED account[${i}] ${acct.username || acct.email}`); break;
    }
    const s2 = st(i);
    if (c.kind === 'RATE') { s2.cool = Date.now() + c.retryAfter * 1000; state.stats.rate++; saveState(); log(`acct[${i}] cooldown ${c.retryAfter}s`); continue; }
    if (c.kind === 'AUTH') { s2.dead = true; s2.reason = 'auth'; state.stats.auth++; saveState(); continue; }
    s2.errs++; state.stats.err++;
    if (s2.errs >= 3) { s2.dead = true; s2.reason = 'err'; }
    saveState();
  }

  if (!out && process.env.QWEN_NO_GUEST !== '1') {
    // guest fallback — clean session, proven v1 path
    log('guest fallback');
    await wipeQwen();
    await goto('https://chat.qwen.ai/');
    await dismissAgeGate();
    bx = existsSync(bxFile) ? JSON.parse(readFileSync(bxFile, 'utf8')) : null;
    if (!bx) bx = await harvest();
    if (bx) {
      let v = await runAttempt(bx, 'guest').catch(e => ({ fail: true, err: 'run ex: ' + String(e).slice(0, 120) }));
      let c = classify(v);
      if (v && !v.fail && (v.err || !v.out)) {
        log('guest attempt1 fail@' + v.stage + ': ' + String(v.err || 'empty').slice(0, 150) + ' → re-harvest');
        const fresh = await harvest();
        if (fresh) { bx = fresh; await sleep(2000); v = await runAttempt(bx, 'guest').catch(e => ({ fail: true, err: 'run ex' })); c = classify(v); }
      }
      if (c.kind === 'OK') { state.stats.guest++; saveState(); out = v.out; log('USED guest'); }
      else { state.stats.err++; saveState(); log('guest fail: ' + c.kind + ' ' + String(c.msg || '').slice(0, 180)); }
    } else log('guest harvest failed');
  }

  if (out) console.log(out);
  else { console.error('FAIL all accounts + guest — ' + JSON.stringify(state.stats)); process.exitCode = 1; }
} finally {
  writeFileSync(stamp, String(Date.now()));
  ws.removeEventListener('message', bxListener);
  ws.close(); await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
}
