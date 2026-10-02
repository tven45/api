// pplxchat.mjs "<prompt>" — perplexity.ai via CDP in-page fetch (anonymous)
import { readFileSync, writeFileSync } from 'node:fs';

const prompt = process.argv.slice(2).join(' ');
if (!prompt) { console.error('usage: node pplxchat.mjs "<prompt>"'); process.exit(1); }

const CDP = 'http://127.0.0.1:9445';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PACE = 60000;
const stamp = process.env.TEMP + '\\pplxchat.last';

try { const last = Number(readFileSync(stamp, 'utf8')); const wait = PACE - (Date.now() - last); if (wait > 0) { console.error(`pacing: waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); } } catch {}

async function newTab(url) { let r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => null); if (!r || !r.ok) r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`); return r.ok ? await r.json() : null; }
function rpc(ws, method, params = {}, timeout = 30000) { const id = Math.floor(Math.random() * 1e9); ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('rpc timeout: ' + method)), timeout); const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', on); resolve(m.result); } }; ws.addEventListener('message', on); }); }
const ev = (ws, e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, 30000);
const clickXY = async (ws, x, y) => { await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await sleep(60); await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };

const tab = await newTab('https://www.perplexity.ai/');
if (!tab) { console.error('CDP_FAIL no tab — is chrome on :9445 running?'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws connect')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', rej); });
await rpc(ws, 'Page.enable'); await rpc(ws, 'Runtime.enable');

let ready = false;
for (let i = 0; i < 30; i++) {
  await sleep(1500);
  const st = await rpc(ws, 'Runtime.evaluate', { expression: 'document.readyState + "|" + location.host', returnByValue: true }).catch(() => null);
  const v = st?.result?.value || '';
  if (v.startsWith('complete') && v.includes('perplexity.ai')) { ready = true; break; }
}
if (!ready) { console.error('PAGE_NOT_READY'); ws.close(); await fetch(`${CDP}/json/close/${tab.id}`); process.exit(1); }
await sleep(6000);

// clear consent banner if present (strict match)
const cs = await ev(ws, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&!x.disabled&&/decline optional/i.test((x.textContent||'').trim())); if(b){const q=b.getBoundingClientRect();return JSON.stringify({x:Math.round(q.x+q.width/2),y:Math.round(q.y+q.height/2)});} return 'NONE'; })()`).catch(() => null);
try { const o = JSON.parse(cs?.result?.value || 'null'); if (o && o.x) { await clickXY(ws, o.x, o.y); await sleep(1500); } } catch {}

const expr = `(() => {
  const P = ${JSON.stringify(prompt)};
  const uuid = () => crypto.randomUUID();
  const race = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + label)), ms))]);
  return (async () => {
    let stage = 'ask';
    try {
      const rid = uuid();
      const body = {
        params: {
          attachments: [], language: 'en-US', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          search_focus: 'internet', sources: ['web'], frontend_uuid: rid,
          mode: 'copilot', model_preference: 'turbo', is_related_query: false,
          is_sponsored: false, frontend_context_uuid: uuid(), prompt_source: 'user',
          query_source: 'home', is_incognito: false, time_from_first_type: 1230.3,
          local_search_enabled: false, use_schematized_api: true, send_back_text_in_streaming_api: false,
          supported_block_use_cases: ['answer_modes','media_items','inline_entity_cards','place_widgets','finance_widgets','sports_widgets','news_widgets','shopping_widgets','jobs_widgets','search_result_widgets','inline_images','inline_assets','placeholder_cards','diff_blocks','entity_group_v2','refinement_filters','canvas_mode','maps_preview','answer_tabs','price_comparison_widgets','preserve_latex','generic_onboarding_widgets','in_context_suggestions','pending_followups','inline_claims','unified_assets','workflow_steps','workflow_widgets','navigation_results','background_agents'],
          client_coordinates: null, mentions: [], dsl_query: P,
          skip_search_enabled: true, is_nav_suggestions_disabled: false,
          source: 'default', always_search_override: false, override_no_search: false,
          client_search_results_cache_key: uuid(),
          should_ask_for_mcp_tool_confirmation: true, supports_tool_approval_modal: true,
          experiment_assignments: { 'web-sidebar-view-plans-allocation-175710': 'control' },
          browser_agent_allow_once_from_toggle: false, force_enable_browser_agent: false,
          supported_features: ['browser_agent_permission_banner_v1.1'], extended_context: false,
          local_workspace_directories: [], version: '2.18', rum_session_id: uuid(),
        },
        query_str: P,
      };
      const r = await race(fetch('/rest/sse/perplexity_ask', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'x-perplexity-request-try-number': '1',
          'x-request-id': rid,
          'x-perplexity-request-endpoint': location.origin + '/rest/sse/perplexity_ask',
          'x-perplexity-request-reason': 'ask-query-state-provider',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      }), 30000, 'fetch');
      if (r.status !== 200) return { stage, err: 'http ' + r.status + ': ' + (await r.text()).slice(0, 200) };

      stage = 'stream';
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', absText = '', chunksMap = {}, done = false;
      const t0 = Date.now();
      const handle = line => {
        const m = line.match(/^data:\\s*(.+)$/);
        if (!m) { if (/end_of_stream/.test(line)) done = true; return; }
        let j; try { j = JSON.parse(m[1]); } catch { return; }
        const stack = [j];
        while (stack.length) {
          const o = stack.pop();
          if (!o || typeof o !== 'object') continue;
          if (Array.isArray(o)) { for (const x of o) stack.push(x); continue; }
          const tp = o.text_payload;
          if (tp && typeof tp === 'object') {
            if (typeof tp.text === 'string' && tp.text) absText = tp.text;
            if (Array.isArray(tp.chunks)) tp.chunks.forEach((c, i) => { if (typeof c === 'string') chunksMap[i] = c; });
          }
          const db = o.diff_block;
          if (db && Array.isArray(db.patches)) {
            for (const p of db.patches) {
              if (!p || typeof p.path !== 'string') continue;
              if (p.op === 'replace' && p.path.endsWith('/text') && typeof p.value === 'string' && p.value) absText = p.value;
              if ((p.op === 'replace' || p.op === 'add') && /\\/chunks\\/\\d+$/.test(p.path) && typeof p.value === 'string') {
                const idx = Number(p.path.split('/').pop());
                chunksMap[idx] = p.value;
              }
            }
          }
          for (const v of Object.values(o)) stack.push(v);
          if (o.final_sse_message === true || o.final === true) done = true;
        }
        if (/end_of_stream/.test(line)) done = true;
      };
      while (Date.now() - t0 < 85000 && !done) {
        let chunk;
        try { chunk = await race(reader.read(), 25000, 'read'); } catch (e) { break; }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        const lines = buf.split(/\\r?\\n/);
        buf = lines.pop();
        for (const l of lines) handle(l);
        if (buf.length > 0 && lines.length && /end_of_stream/.test(buf)) done = true;
      }
      if (buf) handle(buf);
      try { reader.cancel(); } catch {}

      stage = 'done';
      const joined = Object.keys(chunksMap).sort((a, b) => a - b).map(k => chunksMap[k]).join('');
      const out = absText || joined;
      if (!out) return { stage, err: 'empty answer (bytes read, no text payload)' };
      if (/Sign up and repeat/i.test(out) || (out.length < 80 && /[Ѐ-ӿ]/.test(out))) return { stage: 'throttled', err: 'THROTTLED: ' + out };
      return { stage: 'done', out };
    } catch (e) {
      return { stage, err: String((e && e.message) || e) };
    }
  })();
})()`;

try {
  const res = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 120000);
  const val = res?.result?.value;
  if (!val) { console.error('NO_VALUE', JSON.stringify(res?.exceptionDetails || {}).slice(0, 300)); process.exitCode = 1; }
  else if (val.err) { console.error('ERR@' + val.stage, val.err); process.exitCode = 1; }
  else { console.log(val.out); if (!val.out) process.exitCode = 1; }
} finally {
  writeFileSync(stamp, String(Date.now()));
  ws.close(); await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
}
