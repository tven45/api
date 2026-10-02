// bridge.mjs — local job runner: polls the API's bridge queue, runs CDP clients, posts results
// Usage: WORKER_URL=https://<render-url> BRIDGE_KEY=<key> node bridge.mjs
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const DIR = dirname(fileURLToPath(import.meta.url));

const WORKER = process.env.WORKER_URL || 'http://127.0.0.1:10000';
const KEY = process.env.BRIDGE_KEY;
if (!KEY) { console.error('[bridge] BRIDGE_KEY env var is required'); process.exit(1); }
const TEMP = process.env.TEMP;
const CLIENTS = { qwen: 'qwenchat.mjs', pi: 'pichat.mjs', pplx: 'pplxchat.mjs' };
const JOB_MAX_AGE_MS = 600000;
const RUN_TIMEOUT_MS = 480000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPending() {
  const r = await fetch(WORKER + '/bridge/pending', { headers: { 'x-bridge-key': KEY }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('pending ' + r.status);
  return (await r.json()).jobs || [];
}

async function postResult(id, payload) {
  const r = await fetch(WORKER + '/bridge/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-key': KEY },
    body: JSON.stringify({ id, ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('result ' + r.status);
}

function runClient(script, prompt, model) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env);
    if (model && /^qwen3[\w.-]*$/.test(String(model))) env.QWEN_MODEL = String(model);
    env.QW_JSON = '1';
    const local = join(DIR, script);
    const path = existsSync(local) ? local : (TEMP ? join(TEMP, script) : local);
    execFile(process.execPath, [path, prompt], { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const ts = () => new Date().toISOString().slice(11, 19);

async function main() {
  console.log(`[bridge] started → ${WORKER} | clients: ${Object.keys(CLIENTS).join(', ')}`);
  let offlineLogged = false;
  for (;;) {
    let jobs = [];
    try {
      jobs = await getPending();
      if (offlineLogged) { console.log(`[${ts()}] api reachable again`); offlineLogged = false; }
    } catch (e) {
      if (!offlineLogged) { console.log(`[${ts()}] api unreachable (${e.message}) — retrying every 5s`); offlineLogged = true; }
      await sleep(5000);
      continue;
    }
    if (!jobs.length) { await sleep(2000); continue; }

    const job = jobs[jobs.length - 1];
    const age = Date.now() - (job.ts || 0);
    if (!CLIENTS[job.backend]) {
      console.log(`[${ts()}] drop ${job.id}: unknown backend ${job.backend}`);
      await postResult(job.id, { error: 'unknown backend: ' + job.backend }).catch(() => {});
      continue;
    }
    if (age > JOB_MAX_AGE_MS) {
      console.log(`[${ts()}] drop ${job.id}: expired (${Math.round(age / 1000)}s old)`);
      await postResult(job.id, { error: 'expired (bridge offline when enqueued?)' }).catch(() => {});
      continue;
    }

    console.log(`[${ts()}] job ${job.id} [${job.backend}] "${String(job.prompt).slice(0, 90)}"`);
    const t0 = Date.now();
    const res = await runClient(CLIENTS[job.backend], String(job.prompt), job.model);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.err && res.stdout.trim()) {
      let reply = res.stdout.trim(), reasoning = '';
      try {
        const j = JSON.parse(res.stdout);
        if (j && typeof j.reply === 'string' && j.reply) { reply = j.reply; reasoning = typeof j.reasoning === 'string' ? j.reasoning : ''; }
      } catch {}
      console.log(`[${ts()}] job ${job.id} ok in ${secs}s (${reply.length} chars${reasoning ? ', thinking ' + reasoning.length : ''}): ${reply.slice(0, 100).replace(/\n/g, ' ')}`);
      await postResult(job.id, reasoning ? { reply, reasoning } : { reply }).catch(e => console.log(`[${ts()}] result post failed: ${e.message}`));
    } else {
      const msg = (res.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400) || (res.err ? String(res.err.message || res.err) : 'empty output');
      console.log(`[${ts()}] job ${job.id} FAIL in ${secs}s: ${msg}`);
      await postResult(job.id, { error: msg }).catch(() => {});
    }
    // re-poll immediately for next queued job
  }
}

main().catch(e => { console.error('bridge fatal:', e); process.exit(1); });
