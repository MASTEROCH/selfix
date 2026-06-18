/**
 * SELFIX backend — single Cloudflare Worker (free tier).
 * Endpoints:
 *   POST /track       — anonymous analytics events
 *   POST /feedback    — user feedback → your Telegram
 *   POST /clone/chat  — live AI clone↔clone dialogue (Claude Haiku)   [Phase 2]
 *   POST /pay/invoice — create a Telegram Stars (XTR) invoice link     [Phase 2]
 *   POST /pay/webhook — Telegram bot webhook (pre_checkout + payment)  [Phase 2]
 *   GET  /health
 *
 * DEPLOY:
 *   1. dash.cloudflare.com → Workers & Pages → Create Worker → paste this.
 *   2. Settings → Variables → SECRETS (encrypted):
 *        BOT_TOKEN          = <token from @BotFather>
 *        OWNER_CHAT_ID      = <your chat id, via @userinfobot>
 *        ANTHROPIC_API_KEY  = <Anthropic key>   (only needed for /clone/chat)
 *      (optional) KV namespace "EVENTS" bound for analytics storage.
 *   3. Deploy → copy the URL https://selfix-xxx.workers.dev
 *   4. In SELFIX.html set:
 *        ANALYTICS_URL = '.../track'
 *        FEEDBACK_URL  = '.../feedback'
 *        CLONE_URL     = '.../clone/chat'
 *        PAY_URL       = '.../pay/invoice'
 *   5. Point the bot webhook at /pay/webhook:
 *        https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://selfix-xxx.workers.dev/pay/webhook
 *
 * ⛔ BOT_TOKEN / ANTHROPIC_API_KEY live ONLY here (Worker secrets). Never in the client.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/health') return json({ ok: true });

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}

      if (url.pathname === '/track')       return await onTrack(env, body);
      if (url.pathname === '/feedback')    return await onFeedback(env, body);
      if (url.pathname === '/clone/chat')  return json(await onClone(env, body));
      if (url.pathname === '/pay/invoice') return json(await onInvoice(env, body));
      if (url.pathname === '/pay/webhook') return await onWebhook(env, body);
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
};

/* ---------- analytics ---------- */
async function onTrack(env, body) {
  try {
    if (env.EVENTS) {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await env.EVENTS.put(key, JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 90 });
    }
    if (env.BOT_TOKEN && env.OWNER_CHAT_ID && body.event === 'test_finish') {
      await tg(env, 'sendMessage', { chat_id: env.OWNER_CHAT_ID, text: `✅ test_finish · ${body.props?.type || '?'} · ${body.tg ? 'TG' : 'web'} · ${body.lang}` });
    }
  } catch (e) {}
  return new Response(null, { status: 204, headers: CORS });
}

/* ---------- feedback → your Telegram ---------- */
async function onFeedback(env, body) {
  try {
    const text = (body.text || '').slice(0, 600);
    if (env.BOT_TOKEN && env.OWNER_CHAT_ID)
      await tg(env, 'sendMessage', { chat_id: env.OWNER_CHAT_ID, text: `💬 SELFIX feedback${body.typeName ? ' [' + body.typeName + ']' : ''}\n${text}\n— aid:${body.aid} ${body.tg ? 'TG' : 'web'} ${body.lang}` });
  } catch (e) {}
  return new Response(null, { status: 204, headers: CORS });
}

/* ---------- live AI clone↔clone dialogue (Claude Haiku) ---------- */
async function onClone(env, body) {
  if (!env.ANTHROPIC_API_KEY) return { lines: [], verdict: '', fallback: true };
  const me = body.me || {}, peer = body.peer || {}, lang = body.lang === 'en' ? 'en' : 'ru';
  const sys = lang === 'en'
    ? `You write a short, vivid first-meeting dialogue between two people's personality "clones", grounded in their Big Five profiles. Return STRICT JSON only: {"lines":[{"s":"me"|"peer","t":"..."}],"verdict":"one warm sentence: should they connect and why"}. 6-8 alternating lines starting with "me", natural and specific to the traits, no emojis, each line <=120 chars.`
    : `Ты пишешь короткий живой диалог первого знакомства между «клонами» двух людей на основе их профилей Big Five. Верни ТОЛЬКО строгий JSON: {"lines":[{"s":"me"|"peer","t":"..."}],"verdict":"одно тёплое предложение: стоит ли им познакомиться и почему"}. 6-8 реплик по очереди, начиная с "me", естественно и конкретно по чертам, без эмодзи, каждая <=120 символов.`;
  const usr = `me: name=${me.name || 'I'}, type=${me.type}, big=${JSON.stringify(me.big || {})}. peer: name=${peer.name}, type=${peer.type}, big=${JSON.stringify(peer.big || {})}. matchScore=${body.score}.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 700, system: sys, messages: [{ role: 'user', content: usr }] }),
    });
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  } catch (e) {}
  return { lines: [], verdict: '', fallback: true };
}

/* ---------- Telegram Stars invoice ---------- */
async function onInvoice(env, body) {
  if (!env.BOT_TOKEN) return { ok: false, link: null };
  const amount = Math.max(1, parseInt(body.amount, 10) || 1); // XTR amount = number of Stars
  const r = await tg(env, 'createInvoiceLink', {
    title: (body.title || 'SELFIX').slice(0, 32),
    description: (body.desc || body.title || 'SELFIX unlock').slice(0, 255),
    payload: (body.sku || 'sku') + ':' + (body.aid || ''),
    currency: 'XTR',
    prices: [{ label: (body.title || 'Unlock').slice(0, 32), amount: amount }],
  });
  const j = await r.json();
  return { ok: !!j.ok, link: j.result || null };
}

/* ---------- bot webhook: approve checkout + record payment ---------- */
async function onWebhook(env, update) {
  try {
    if (update.pre_checkout_query) {
      await tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    }
    if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      // TODO(hardening): persist entitlement by telegram user id in KV, and expose GET /entitlements
      if (env.OWNER_CHAT_ID) await tg(env, 'sendMessage', { chat_id: env.OWNER_CHAT_ID, text: `⭐ Payment: ${sp.total_amount} XTR · ${sp.invoice_payload}` });
    }
  } catch (e) {}
  return new Response('ok', { headers: CORS });
}

/* ---------- helpers ---------- */
function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}
function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}
