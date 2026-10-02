// server.js — OpenAI-compatible API hosted on Render
// Port of the ucchat Cloudflare Worker: the uncensored.chat edge backend runs
// directly here; qwen/pplx jobs go through an in-memory queue polled by bridge.mjs.
import http from 'node:http';

const PORT = Number(process.env.PORT) || 10000;
const BRIDGE_KEY = process.env.BRIDGE_KEY;
if (!BRIDGE_KEY) {
  console.error('[server] BRIDGE_KEY env var is required (same value the bridge uses)');
  process.exit(1);
}

const BASE = 'https://uncensored.chat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const PACE_MS = Number(process.env.UC_PACE_MS) || 75000;
const MAX_POLLS = 30;
let lastRun = 0;

const JOB_TTL_S = 900;
const POLL_MS = 2000;
const JOB_TIMEOUT_MS = 360000;
const QUEUE_MAX_AGE_MS = 600000;

// verified models only (README lists verification status)
const MODELS = ['uncensored-v3', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-nano', 'deepseek-chat', 'kimi-k2', 'qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-omni-flash', 'perplexity'];
const BRIDGE_BACKENDS = ['qwen', 'pplx'];

// ---------- in-memory job store (single instance) ----------
let queue = [];
const results = new Map();
setInterval(() => {
  const now = Date.now();
  queue = queue.filter(x => now - (x.ts || 0) < QUEUE_MAX_AGE_MS);
  for (const [k, v] of results) if (now - v.at > JOB_TTL_S * 1000) results.delete(k);
}, 60000).unref();

// ---------- helpers ----------
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const estTokens = (s) => Math.max(1, Math.ceil(String(s).length / 4));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const lastUser = [...messages].reverse().find(m => m?.role === 'user');
  const msg = lastUser || messages[messages.length - 1];
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p?.text ?? p?.content ?? ''))).join('\n').trim();
  return c == null ? null : String(c);
}

function backendFor(model, forced) {
  if (forced && BRIDGE_BACKENDS.includes(forced)) return forced;
  const m = String(model || '').toLowerCase();
  if (m.includes('qwen')) return 'qwen';
  if (m === 'pi' || m.startsWith('pi-') || m.startsWith('pi.')) return 'pi';
  if (m.includes('perplexity') || m.includes('sonar') || m.includes('pplx')) return 'pplx';
  return 'uc';
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendOaiError(res, message, status, type = 'server_error', code = null) {
  sendJson(res, { error: { message, type, param: null, code } }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 2e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- uc edge backend ----------
async function pace() {
  const wait = PACE_MS - (Date.now() - lastRun);
  if (wait > 0) await sleep(wait);
}

async function chat(prompt) {
  const jar = new Map();
  const absorb = res => { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookieHdr = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const H = (extra = {}) => Object.assign({ 'user-agent': UA, 'accept': 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest', 'origin': BASE, 'referer': BASE + '/free-ai-chat', 'cookie': cookieHdr() }, extra);

  let r = await fetch(BASE + '/free-ai-chat', { headers: { 'user-agent': UA, 'accept': 'text/html' } });
  if (r.status !== 200) throw new Error(`upstream page ${r.status}`);
  absorb(r);
  const html = await r.text();
  const cm = html.match(/name="csrf-token" content="([^"]+)"/);
  if (!cm) throw new Error('no csrf token (upstream challenge?)');
  const csrf = cm[1];

  r = await fetch(BASE + '/chats/start', {
    method: 'POST',
    headers: H({ 'content-type': 'application/json', 'x-csrf-token': csrf }),
    body: JSON.stringify({ character_id: 87, message: prompt, think_mode: false, api_version: 'v3' }),
  });
  absorb(r);
  const startTxt = await r.text();
  if (!r.ok) throw new Error(`upstream start ${r.status}: ${startTxt.slice(0, 200)}`);
  const uuid = (startTxt.match(/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1];
  if (!uuid) throw new Error('no chat id in start response');

  const doStream = async (budgetMs) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budgetMs);
    try {
      const sr = await fetch(`${BASE}/chats/${uuid}/stream`, {
        method: 'POST',
        headers: H({ 'content-type': 'application/json', 'x-csrf-token': csrf, 'accept': 'text/event-stream' }),
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt, type: 'text', action: null, image_prompt: null }], api_version: 'v3' }),
        signal: ctl.signal,
      });
      const reader = sr.body.getReader();
      const dec = new TextDecoder();
      let raw = '';
      const t0 = Date.now();
      while (Date.now() - t0 < budgetMs - 5000) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        raw += dec.decode(value, { stream: true });
        if (/data:\s*\[DONE\]|event:\s*done/i.test(raw)) break;
        if (raw.length > 400000) break;
      }
      return raw;
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  };
  let sraw = '';
  let streamTries = 0;
  for (let a = 0; a < 3 && !sraw.trim(); a++) {
    if (a > 0) await sleep(40000);
    streamTries++;
    sraw = await doStream(35000);
  }
  const streamInfo = sraw.trim() ? 'ok' : `hung(${streamTries} tries)`;

  const decode = s => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let page = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    const pr = await fetch(`${BASE}/chat/${uuid}`, { headers: { 'user-agent': UA, 'accept': 'text/html', 'cookie': cookieHdr() } });
    const htmlPage = await pr.text();
    const dm = htmlPage.match(/data-page="([^"]+)"/);
    if (pr.status === 200 && dm) {
      page = JSON.parse(decode(dm[1]));
      const ms = page?.props?.messages || [];
      if (ms.some(x => x.role === 'assistant')) break;
    }
    await sleep(5000);
  }
  if (page) {
    const msgs = page.props.messages || [];
    const last = [...msgs].reverse().find(x => x.role === 'assistant');
    if (last) return { reply: last.content, chatId: uuid };
  }
  // fallback: assemble reply from the stream payload itself
  const streamText = [...sraw.matchAll(/data:\s*(\{[^}]*\})/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(o => o && typeof o.content === 'string')
    .map(o => o.content)
    .join('');
  if (streamText.trim()) return { reply: streamText, chatId: uuid };
  throw new Error(`no reply after polling (stream: ${streamInfo})`);
}

// ---------- bridge job queue ----------
function enqueue(backend, prompt, model) {
  const id = rand();
  const now = Date.now();
  queue = queue.filter(x => x && now - (x.ts || 0) < QUEUE_MAX_AGE_MS);
  queue.push({ id, backend, model: model || '', prompt, ts: now });
  return id;
}

function pollJob(id, timeoutMs) {
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = results.get(id);
      if (v) return v.value;
      await sleep(POLL_MS);
    }
    return null;
  })();
}

async function getViaBridge(backend, prompt, model) {
  const id = enqueue(backend, prompt, model);
  const v = await pollJob(id, JOB_TIMEOUT_MS);
  if (!v) throw new Error('bridge timeout — is bridge.mjs running?');
  if (v.error) throw new Error('bridge: ' + v.error);
  return { reply: String(v.reply || ''), reasoning: String(v.reasoning || '') };
}

async function replyVia(prompt, model, forced) {
  const backend = backendFor(model, forced);
  if (backend === 'uc') {
    await pace();
    try {
      const out = await chat(prompt);
      lastRun = Date.now();
      return out;
    } catch (e) {
      lastRun = Date.now();
      throw e;
    }
  }
  return getViaBridge(backend, prompt, backend === 'qwen' ? model : '');
}

// ---------- OpenAI surface ----------
function completionBody(model, content, prompt, reasoning) {
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: 'chatcmpl-' + rand(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: estTokens(prompt), completion_tokens: estTokens(content), total_tokens: estTokens(prompt) + estTokens(content) },
  };
}

async function handleCompletions(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { body = null; }
  if (!body) return sendOaiError(res, 'invalid JSON body', 400, 'invalid_request_error', 'invalid_json');
  const model = body.model || 'uncensored-v3';
  const prompt = extractPrompt(body.messages);
  if (!prompt) return sendOaiError(res, 'messages must contain at least one message with string content', 400, 'invalid_request_error', 'invalid_messages');

  if (!body.stream) {
    try {
      const out = await replyVia(prompt, model, null);
      return sendJson(res, completionBody(model, out.reply, prompt, out.reasoning));
    } catch (e) {
      const msg = String(e.message || e);
      return sendOaiError(res, msg, /bridge timeout/.test(msg) ? 504 : 502);
    }
  }

  const id = 'chatcmpl-' + rand();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
    connection: 'keep-alive',
  });
  try {
    res.write(chunk({ role: 'assistant', content: '' }));
    const out = await replyVia(prompt, model, null);
    const text = out.reply;
    if (out.reasoning) res.write(chunk({ reasoning_content: out.reasoning }));
    const step = Math.max(1, Math.ceil(text.length / 24));
    for (let i = 0; i < text.length; i += step) res.write(chunk({ content: text.slice(i, i + step) }));
    res.write(chunk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: estTokens(prompt), completion_tokens: estTokens(text), total_tokens: estTokens(prompt) + estTokens(text) } })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: { message: String(e.message || e), type: 'server_error', param: null, code: null } })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleBridge(req, res, pathname) {
  if (req.headers['x-bridge-key'] !== BRIDGE_KEY) return sendJson(res, { error: 'bad key' }, 403);

  if (pathname === '/bridge/pending' && req.method === 'GET') {
    return sendJson(res, { jobs: queue });
  }

  if (pathname === '/bridge/result' && req.method === 'POST') {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch { b = null; }
    if (!b || !b.id) return sendJson(res, { error: 'need {id, reply|error}' }, 400);
    queue = queue.filter(x => x.id !== b.id);
    const val = b.error ? { error: String(b.error).slice(0, 500) } : { reply: String(b.reply || ''), at: Date.now() };
    results.set(b.id, { value: val, at: Date.now() });
    return sendJson(res, { ok: true });
  }

  return sendJson(res, { error: 'unknown bridge route' }, 404);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-bridge-key',
    });
    return res.end();
  }

  if (pathname === '/health') return sendJson(res, { ok: true, uptime: process.uptime() });
  if (pathname.startsWith('/bridge/')) return handleBridge(req, res, pathname);

  if (pathname === '/v1/models' && req.method === 'GET') {
    const created = Math.floor(Date.now() / 1000);
    return sendJson(res, { object: 'list', data: MODELS.map(id => ({ id, object: 'model', created, owned_by: BRIDGE_BACKENDS.includes(backendFor(id)) ? 'local-bridge' : 'uncensored.chat' })) });
  }

  if (pathname === '/v1/chat/completions' && req.method === 'POST') return handleCompletions(req, res);

  // legacy: GET /?prompt=...&backend=qwen|pi|pplx|uc or POST {"prompt","backend"}
  let prompt = url.searchParams.get('prompt');
  let backend = url.searchParams.get('backend');
  let modelParam = url.searchParams.get('model');
  if (!prompt && req.method === 'POST') {
    let body = null;
    try { body = JSON.parse(await readBody(req)); } catch {}
    prompt = body?.prompt;
    backend = body?.backend || backend;
    modelParam = body?.model || modelParam;
  }
  if (!prompt) {
    if (pathname === '/') return sendJson(res, { ok: false, error: 'GET /?prompt=...&backend=qwen|pi|pplx|uc | POST {"prompt"} | POST /v1/chat/completions (OpenAI) | GET /v1/models' }, 400);
    return sendOaiError(res, `Unknown route: ${pathname}`, 404, 'invalid_request_error', 'unknown_route');
  }
  try {
    const legacyModel = modelParam || (backend === 'qwen' ? 'qwen3.7-plus' : 'uncensored-v3');
    const out = await replyVia(prompt, legacyModel, backend);
    return sendJson(res, { ok: true, reply: out.reply, chatId: out.chatId || null });
  } catch (e) {
    const msg = String(e.message || e);
    return sendJson(res, { ok: false, error: msg }, /bridge timeout/.test(msg) ? 504 : 502);
  }
}

http.createServer((req, res) => {
  handler(req, res).catch(e => {
    try { sendOaiError(res, String(e.message || e), 500); } catch {}
  });
}).listen(PORT, () => {
  console.log(`[server] listening on :${PORT} | models: ${MODELS.length} | pace ${PACE_MS}ms | queue in-memory`);
});
