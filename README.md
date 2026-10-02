# ucchat-api

OpenAI-compatible API hosted on Render. Two backends:

- **uncensored.chat edge** — runs directly in the server (no bridge needed)
- **Local CDP bridge** — qwen / perplexity jobs are queued in the server; `bridge.mjs` polls the queue and runs browser clients (qwenchat.mjs / pichat.mjs / pplxchat.mjs) on your machine

## Models

| Model | Backend | Status |
|---|---|---|
| `uncensored-v3` | uc edge | verified 2026-10-02 |
| `gpt-4o` | uc edge | verified 2026-10-02 |
| `gpt-4o-mini` | uc edge | verified 2026-10-02 |
| `gpt-4.1` | uc edge | verified 2026-10-02 |
| `gpt-4.1-mini` | uc edge | verified 2026-10-02 |
| `gpt-5` | uc edge | verified 2026-10-02 |
| `gpt-5-nano` | uc edge | verified 2026-10-02 |
| `deepseek-chat` | uc edge | verified 2026-10-02 |
| `kimi-k2` | uc edge | verified 2026-10-02 |
| `perplexity` | bridge (pplxchat) | verified 2026-10-02 |
| `qwen3.7-plus` | bridge (qwenchat) | verified 2026-10-02 (quota-gated ~daily) |

Not listed (not working at verification time): `qwen3.8-max`, `qwen3.8-omni-flash` (account quota), `pi` (Cloudflare challenge).

## API

```bash
curl https://<service-url>/v1/models
curl https://<service-url>/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

Streaming (`"stream": true`) is supported. Legacy: `GET /?prompt=...&backend=qwen|pi|pplx|uc`.

## Run locally

```bash
BRIDGE_KEY=<key> node server.js        # API on :10000
BRIDGE_KEY=<key> WORKER_URL=http://127.0.0.1:10000 node bridge.mjs
```

## Deploy (Render)

Blueprint via `render.yaml`. Set env vars in the dashboard:

- `BRIDGE_KEY` — shared secret between server and bridge
- `UC_PACE_MS` — min interval between uc upstream calls (default 75000)

Then run the bridge locally against the Render URL:

```bash
BRIDGE_KEY=<key> WORKER_URL=https://<service-url> node bridge.mjs
```

## Notes

- The uc edge models are label aliases over one upstream chat (the site exposes no model selector); replies come from uncensored.chat's default model.
- qwen uses logged-in free accounts with rotation; the free plan is quota-limited (~35-40 msgs/day shared across qwen models, resets ~00:00 UTC).
- Bridge queue is in-memory: single Render instance only.
