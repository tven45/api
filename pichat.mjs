// pichat.mjs "<prompt>" — pi.ai via CDP in-page fetch (anonymous session)
import { readFileSync, writeFileSync } from 'node:fs';

const prompt = process.argv.slice(2).join(' ');
if (!prompt) { console.error('usage: node pichat.mjs "<prompt>"'); process.exit(1); }

const CDP = 'http://127.0.0.1:9445';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PACE = 60000;
const stamp = process.env.TEMP + '\\pichat.last';

try { const last = Number(readFileSync(stamp, 'utf8')); const wait = PACE - (Date.now() - last); if (wait > 0) { console.error(`pacing: waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); } } catch {}

async function newTab(url) { let r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => null); if (!r || !r.ok) r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`); return r.ok ? await r.json() : null; }
function rpc(ws, method, params = {}, timeout = 20000) { const id = Math.floor(Math.random() * 1e9); ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('rpc timeout: ' + method)), timeout); const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', on); resolve(m.result); } }; ws.addEventListener('message', on); }); }
const ev = (ws, e, t) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, t || 30000);

const tab = await newTab('https://pi.ai/');
if (!tab) { console.error('CDP_FAIL no tab — is chrome on :9445 running?'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws connect')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', rej); });
await rpc(ws, 'Page.enable'); await rpc(ws, 'Runtime.enable');

let ready = false;
for (let i = 0; i < 25; i++) {
  await sleep(1500);
  const st = await rpc(ws, 'Runtime.evaluate', { expression: 'document.readyState + "|" + location.host', returnByValue: true }).catch(() => null);
  const v = st?.result?.value || '';
  if (v.startsWith('complete') && v.includes('pi.ai')) { ready = true; break; }
}
if (!ready) { console.error('PAGE_NOT_READY'); ws.close(); await fetch(`${CDP}/json/close/${tab.id}`); process.exit(1); }
await sleep(3500);

// defensive: replay name+age gates if they re-appeared (profile usually skips them)
await ev(ws, `(() => {
  const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && /name/i.test(x.placeholder || ''));
  if (i) { i.focus(); }
  return i ? 1 : 0;
})()`).then(async r => {
  if (r?.result?.value === 1) {
    await rpc(ws, 'Input.insertText', { text: 'Sam' });
    await rpc(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await rpc(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(3000);
    for (let g = 0; g < 6; g++) {
      const act = await ev(ws, `(() => {
        const ms = [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(e => (e.innerText||'').length > 3 && e.offsetParent !== null);
        if (!ms.length) return 'GONE';
        const m = ms[ms.length-1];
        const r18 = m.querySelector('input[name="tbs-age-verification-18-or-over"]');
        if (r18 && !r18.checked) { r18.click(); return 'RADIO'; }
        const b = [...m.querySelectorAll('button')].find(x => /continue/i.test(x.textContent||''));
        if (b && !b.disabled) { const q = b.getBoundingClientRect(); return JSON.stringify({ op:'CONT', x: Math.round(q.x + q.width/2), y: Math.round(q.y + q.height/2) }); }
        return 'WAIT';
      })()`);
      const v = act?.result?.value || '';
      if (v === 'GONE') break;
      if (v === 'RADIO') { await sleep(900); continue; }
      try { const o = JSON.parse(v); if (o.op === 'CONT') { await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: o.x, y: o.y, button: 'left', clickCount: 1 }); await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.x, y: o.y, button: 'left', clickCount: 1 }); await sleep(1800); } } catch {}
    }
  }
}).catch(() => {});

const expr = `(() => {
  const P = ${JSON.stringify(prompt)};
  const race = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + label)), ms))]);
  return (async () => {
    let stage = 'conversations';
    try {
      const post = async (url, body, hdrs) => {
        const r = await race(fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, hdrs || {}), body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }), 25000, 'post ' + url);
        const txt = await r.text();
        return { status: r.status, txt };
      };
      const c = await post('/api/conversations', { aiOpener: 'Hey there!' });
      if (c.status !== 200 || c.txt.trim().startsWith('<')) return { stage, err: 'conversations ' + c.status + ': ' + c.txt.slice(0, 140) };
      let cj = null; try { cj = JSON.parse(c.txt); } catch {}
      const sid = cj && cj.sid;
      if (!sid) return { stage, err: 'no sid: ' + c.txt.slice(0, 200) };

      stage = 'chat';
      const body = {
        text: P, conversation: sid,
        eqDistinctId: crypto.randomUUID(), eqSessionId: crypto.randomUUID(),
        clientId: crypto.randomUUID(), tempChat: true,
      };
      const sr = await race(fetch('/api/v2/chat', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) }), 30000, 'chat');
      if (sr.status !== 200) return { stage, err: 'chat ' + sr.status + ': ' + (await sr.text()).slice(0, 180) };

      stage = 'stream';
      const reader = sr.body.getReader();
      const dec = new TextDecoder();
      let buf = '', out = '', ended = false;
      const t0 = Date.now();
      const handleLine = line => {
        const m = line.match(/^data:\\s*(.+)$/); if (!m) return;
        try {
          const j = JSON.parse(m[1].trim());
          if (typeof j.text === 'string' && j.text && !j.title) out += j.text;
        } catch {}
        if (/^(final|done|completed|finish|end|stop)\\b/i.test(line.replace(/^event:\\s*/i, ''))) ended = true;
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

      stage = 'history';
      if (!out) {
        try {
          const hr = await race(fetch('/api/chat/history?conversation=' + sid, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }), 15000, 'history');
          const hj = await hr.json();
          const msgs = (hj.messages || []).filter(x => x.direction === 'outbound');
          if (msgs.length) out = msgs[0].text;
        } catch {}
      }
      return { stage: 'done', sid, out };
    } catch (e) {
      return { stage, err: String((e && e.message) || e) };
    }
  })();
})()`;

try {
  const res = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 115000);
  const val = res?.result?.value;
  if (!val) { console.error('NO_VALUE', JSON.stringify(res?.exceptionDetails || {}).slice(0, 300)); process.exitCode = 1; }
  else if (val.err) { console.error('ERR@' + val.stage, val.err); process.exitCode = 1; }
  else { console.log(val.out || ''); if (!val.out) { console.error('EMPTY@done'); process.exitCode = 1; } }
} finally {
  writeFileSync(stamp, String(Date.now()));
  ws.close(); await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
}
