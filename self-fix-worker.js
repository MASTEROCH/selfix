/**
 * SELF-FIX backend — single Cloudflare Worker (free tier).
 *
 * HTTP endpoints:
 *   POST /track        — anonymous analytics events
 *   POST /feedback     — user feedback → your Telegram
 *   POST /clone/chat   — live AI clone↔clone dialogue (Claude Haiku)
 *   POST /pay/invoice  — create a Telegram Stars (XTR) invoice link
 *   POST /pay/webhook  — Telegram bot webhook (messages + payments)
 *   POST /state        — client reports user lifecycle stage (for smart re-engagement)
 *   GET  /setup?secret=<OWNER_CHAT_ID>  — one-time: set bot menu button, commands, description
 *   GET  /health
 *
 * scheduled() — Cron trigger → smart, capped re-engagement push notifications.
 *
 * SETUP IN CLOUDFLARE:
 *   Secrets:  BOT_TOKEN, OWNER_CHAT_ID, ANTHROPIC_API_KEY
 *   KV bindings:  USERS  (re-engagement), optional EVENTS (analytics)
 *   Cron Trigger: e.g.  0 * * * *   (hourly)  — Settings → Triggers → Cron Triggers
 *   Webhook:  https://api.telegram.org/bot<TOKEN>/setWebhook?url=<worker>/pay/webhook
 *
 * ⛔ BOT_TOKEN / ANTHROPIC_API_KEY live ONLY here. Never in the client.
 */

const APP_URL = 'https://masteroch.github.io/selfix/';
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
    if (url.pathname === '/setup' && request.method === 'GET') {
      if (url.searchParams.get('secret') !== String(env.OWNER_CHAT_ID)) return json({ ok: false, err: 'bad secret' });
      return json(await setupBot(env, url.origin));
    }
    // ---- private owner admin (gated by OWNER_CHAT_ID secret) ----
    if (url.pathname === '/admin' && request.method === 'GET') {
      if (url.searchParams.get('secret') !== String(env.OWNER_CHAT_ID)) return new Response('forbidden', { status: 403, headers: CORS });
      return new Response(adminHTML(), { headers: { 'content-type': 'text/html;charset=utf-8', ...CORS } });
    }
    if (url.pathname === '/admin/data' && request.method === 'GET') {
      if (url.searchParams.get('secret') !== String(env.OWNER_CHAT_ID)) return json({ ok: false, err: 'forbidden' });
      return json(await adminData(env));
    }
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const ip = request.headers.get('cf-connecting-ip') || '0';
      if (url.pathname === '/track')       return await onTrack(env, body);
      if (url.pathname === '/feedback')    return await onFeedback(env, body);
      if (url.pathname === '/clone/chat')  return json(await onClone(env, body, ip));
      if (url.pathname === '/clone/talk')  return json(await onTalk(env, body, ip));
      if (url.pathname === '/pay/invoice') return json(await onInvoice(env, body));
      if (url.pathname === '/pay/webhook') return await onWebhook(env, body);
      if (url.pathname === '/state')       return await onState(env, body);
      if (url.pathname === '/entitlements')return json(await onEntitlements(env, body));
      if (url.pathname === '/match')       return json(await onMatch(env, body));
      if (url.pathname === '/admin/broadcast') {
        if ((body.secret || '') !== String(env.OWNER_CHAT_ID)) return json({ ok: false, err: 'forbidden' });
        return json(await adminBroadcast(env, body));
      }
    }
    return new Response('not found', { status: 404, headers: CORS });
  },

  // Cron → smart re-engagement
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReengagement(env));
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
      await tg(env, 'sendMessage', { chat_id: env.OWNER_CHAT_ID, text: `💬 SELF-FIX feedback${body.typeName ? ' [' + body.typeName + ']' : ''}\n${text}\n— aid:${body.aid} ${body.tg ? 'TG' : 'web'} ${body.lang}` });
  } catch (e) {}
  return new Response(null, { status: 204, headers: CORS });
}

/* ---------- cost-control: per-identity daily rate-limit (KV) ----------
   Backstop so the Claude endpoints can't be hammered into a big bill / abused.
   Keyed by validated Telegram user id when present, else by IP. Fails OPEN if no KV. */
async function rateLimit(env, scope, id, limit) {
  if (!env.USERS) return { ok: true };                       // no KV bound → don't block
  const day = Math.floor(Date.now() / 86400000);
  const key = `rl:${scope}:${day}:${id}`;
  let n = 0; try { n = parseInt(await env.USERS.get(key), 10) || 0; } catch (e) {}
  if (n >= limit) return { ok: false, n };
  try { await env.USERS.put(key, String(n + 1), { expirationTtl: 90000 }); } catch (e) {} // ~25h
  return { ok: true, n: n + 1 };
}
// resolve a rate-limit identity: prefer verified TG user, else IP
async function rlIdentity(env, body, ip) {
  try { const u = await validateInit(body.initData || '', env.BOT_TOKEN); if (u && u.id) return 'u' + u.id; } catch (e) {}
  return 'ip' + (ip || '0');
}

/* ---------- live AI clone↔clone dialogue (Claude Haiku) ---------- */
async function onClone(env, body, ip) {
  if (!env.ANTHROPIC_API_KEY) return { lines: [], verdict: '', fallback: true };
  const rl = await rateLimit(env, 'clone', await rlIdentity(env, body, ip), 60);
  if (!rl.ok) return { lines: [], verdict: '', fallback: true, err: 'rate_limited' };
  const me = body.me || {}, peer = body.peer || {}, lang = body.lang === 'en' ? 'en' : 'ru';
  const sys = lang === 'en'
    ? `You write a short, vivid first-meeting dialogue between two people's personality "clones", grounded in their Big Five profiles. Return STRICT JSON only: {"lines":[{"s":"me"|"peer","t":"..."}],"verdict":"one warm sentence: should they connect and why"}. 6-8 alternating lines starting with "me", natural and specific to the traits, no emojis, each line <=120 chars.`
    : `Ты пишешь короткий живой диалог первого знакомства между «клонами» двух людей на основе их профилей Big Five. Верни ТОЛЬКО строгий JSON: {"lines":[{"s":"me"|"peer","t":"..."}],"verdict":"одно тёплое предложение: стоит ли им познакомиться и почему"}. 6-8 реплик по очереди, начиная с "me", естественно и конкретно по чертам, без эмодзи, каждая <=120 символов.`;
  const usr = `me: name=${me.name || 'I'}, type=${me.type}, big=${JSON.stringify(me.big || {})}. peer: name=${peer.name}, type=${peer.type}, big=${JSON.stringify(peer.big || {})}. matchScore=${body.score}.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, system: sys, messages: [{ role: 'user', content: usr }] }),
    });
    const j = await r.json();
    if (j.error) return { lines: [], verdict: '', fallback: true, err: (j.error.type || '') + ': ' + String(j.error.message || '').slice(0, 180) };
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return { lines: [], verdict: '', fallback: true, err: 'parse_fail: ' + text.slice(0, 140) };
  } catch (e) { return { lines: [], verdict: '', fallback: true, err: 'fetch_fail: ' + String((e && e.message) || e).slice(0, 140) }; }
}

/* ---------- interactive clone chat (talk to YOUR clone, or a match's clone) ---------- */
async function onTalk(env, body, ip) {
  if (!env.ANTHROPIC_API_KEY) return { reply: '', fallback: true };
  const rl = await rateLimit(env, 'talk', await rlIdentity(env, body, ip), 100);
  if (!rl.ok) return { reply: '', fallback: true, err: 'rate_limited' };
  const lang = body.lang === 'en' ? 'en' : 'ru';
  const mode = body.mode === 'peer' ? 'peer' : 'self';
  const me = body.me || {}, peer = body.peer || {};
  const persona = mode === 'peer' ? peer : me;
  const sys = lang === 'en'
    ? `You ARE a person's personality "clone", grounded in their Big Five profile. Speak first-person AS them — warm, specific, self-aware, concise (1-3 sentences). ${mode === 'peer' ? 'You are ' + (peer.name || 'this person') + ', chatting with someone getting to know you.' : "You are the user's own digital double — reflect them, help them understand themselves."} No emojis. Stay fully in character.`
    : `Ты — «клон» личности человека на основе его профиля Big Five. Говори от первого лица КАК он — тепло, конкретно, осознанно, коротко (1-3 предложения). ${mode === 'peer' ? 'Ты — ' + (peer.name || 'этот человек') + ', общаешься с тем, кто хочет тебя узнать.' : 'Ты — цифровой двойник самого пользователя: отражай его, помогай понять себя.'} Без эмодзи. Полностью в образе.`;
  const msgs = [
    { role: 'user', content: `Profile: name=${persona.name || ''}, type=${persona.type || ''}, big=${JSON.stringify(persona.big || {})}.` },
    { role: 'assistant', content: lang === 'en' ? 'Got it. I am ready.' : 'Понял. Я готов.' },
  ];
  (body.history || []).slice(-12).forEach(h => { if (h && h.content) msgs.push({ role: h.role === 'clone' ? 'assistant' : 'user', content: String(h.content).slice(0, 500) }); });
  if (msgs[msgs.length - 1].role !== 'user') return { reply: '', fallback: true, err: 'no user turn' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 320, system: sys, messages: msgs }),
    });
    const j = await r.json();
    if (j.error) return { reply: '', fallback: true, err: (j.error.type || '') + ': ' + String(j.error.message || '').slice(0, 160) };
    return { reply: ((j.content && j.content[0] && j.content[0].text) || '').trim() };
  } catch (e) { return { reply: '', fallback: true, err: 'fetch_fail' }; }
}

/* ---------- entitlements (server-truth purchases) ---------- */
async function onEntitlements(env, body) {
  if (!env.USERS) return { skus: [] };
  const u = await validateInit(body.initData || '', env.BOT_TOKEN);
  if (!u || !u.id) return { skus: [] };
  let list = []; try { list = JSON.parse(await env.USERS.get('ent:' + u.id)) || []; } catch (e) {}
  return { skus: list };
}

/* ---------- real matching: return other real users with profiles ---------- */
async function onMatch(env, body) {
  if (!env.USERS) return { users: [] };
  const u = await validateInit(body.initData || '', env.BOT_TOKEN);
  if (!u || !u.id) return { users: [] };
  await upsertUser(env, u, { type: body.type, big: body.big, hasResult: true, username: u.username || body.username, touch: true });
  const out = []; let cursor;
  do {
    const list = await env.USERS.list({ prefix: 'user:', cursor });
    cursor = list.list_complete ? null : list.cursor;
    for (const k of list.keys) {
      if (out.length >= 20) break;
      if (k.name === 'user:' + u.id) continue;
      let rec; try { rec = JSON.parse(await env.USERS.get(k.name)); } catch (e) { continue; }
      if (!rec || !rec.type || !rec.big || rec.optOutMatch) continue;
      out.push({ id: rec.id, name: rec.name || '', type: rec.type, big: rec.big, username: rec.username || '' });
    }
  } while (cursor && out.length < 20);
  return { users: out };
}

/* ---------- Telegram Stars invoice ---------- */
async function onInvoice(env, body) {
  if (!env.BOT_TOKEN) return { ok: false, link: null };
  const amount = Math.max(1, parseInt(body.amount, 10) || 1);
  const r = await tg(env, 'createInvoiceLink', {
    title: (body.title || 'SELF-FIX').slice(0, 32),
    description: (body.desc || body.title || 'SELF-FIX unlock').slice(0, 255),
    payload: (body.sku || 'sku') + ':' + (body.aid || ''),
    currency: 'XTR',
    prices: [{ label: (body.title || 'Unlock').slice(0, 32), amount: amount }],
  });
  const j = await r.json();
  return { ok: !!j.ok, link: j.result || null };
}

/* ---------- bot webhook: messages (/start /stop /help) + payments ---------- */
async function onWebhook(env, update) {
  try {
    if (update.pre_checkout_query) {
      await tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
      return new Response('ok', { headers: CORS });
    }
    const m = update.message;
    if (m && m.successful_payment) {
      const sp = m.successful_payment;
      // grant entitlement server-side (source of truth) by telegram user id
      try {
        if (env.USERS && m.from && m.from.id) {
          const sku = String(sp.invoice_payload || '').split(':')[0];
          const ek = 'ent:' + m.from.id;
          let list = []; try { list = JSON.parse(await env.USERS.get(ek)) || []; } catch (e) {}
          if (sku && list.indexOf(sku) < 0) { list.push(sku); await env.USERS.put(ek, JSON.stringify(list)); }
        }
      } catch (e) {}
      if (env.OWNER_CHAT_ID) await tg(env, 'sendMessage', { chat_id: env.OWNER_CHAT_ID, text: `⭐ Payment: ${sp.total_amount} XTR · ${sp.invoice_payload}` });
      return new Response('ok', { headers: CORS });
    }
    if (m && m.from && m.chat) {
      const chatId = m.chat.id;
      const text = (m.text || '').trim();
      const lang = m.from.language_code;
      if (text === '/start' || text.startsWith('/start ')) {
        await upsertUser(env, m.from, { stage: 'start', optOut: false });
        await tg(env, 'sendMessage', { chat_id: chatId, text: welcomeText(lang), reply_markup: openKb(lang) });
      } else if (text === '/stop' || text === '/unsubscribe') {
        await upsertUser(env, m.from, { optOut: true });
        await tg(env, 'sendMessage', { chat_id: chatId, text: lang === 'en' ? 'Okay — no more reminders. Come back anytime with /start.' : 'Ок, больше не напоминаю. Вернуться можно в любой момент — /start.' });
      } else if (text === '/help') {
        await tg(env, 'sendMessage', { chat_id: chatId, text: welcomeText(lang), reply_markup: openKb(lang) });
      }
    }
  } catch (e) {}
  return new Response('ok', { headers: CORS });
}

/* ---------- client reports lifecycle stage (validated via initData) ---------- */
async function onState(env, body) {
  try {
    if (!env.USERS || !env.BOT_TOKEN) return new Response(null, { status: 204, headers: CORS });
    const u = await validateInit(body.initData || '', env.BOT_TOKEN);
    if (!u || !u.id) return new Response(null, { status: 204, headers: CORS }); // web / invalid → can't notify anyway
    await upsertUser(env, u, {
      stage: body.stage, lang: body.lang,
      facets: typeof body.facets === 'number' ? body.facets : undefined,
      hasResult: !!body.hasResult, avatarFull: !!body.avatarFull, touch: true,
      type: body.type, big: body.big, username: u.username || body.username,
      name: body.name, gender: body.gender, day: body.day, month: body.month, year: body.year, tests: body.tests,
    });
  } catch (e) {}
  return new Response(null, { status: 204, headers: CORS });
}

/* ---------- user record helpers ---------- */
async function upsertUser(env, from, patch) {
  if (!env.USERS || !from || !from.id) return;
  const key = 'user:' + from.id;
  let rec = {};
  try { rec = JSON.parse(await env.USERS.get(key)) || {}; } catch (e) {}
  const now = Date.now();
  rec.id = from.id;
  rec.name = patch.name || rec.name || from.first_name || '';        // prefer the name the user typed in-app
  rec.lang = patch.lang || from.language_code || rec.lang || 'ru';
  rec.firstSeen = rec.firstSeen || now;
  rec.lastActive = now;
  rec.reminders = rec.reminders || [];
  if (patch.stage) rec.stage = patch.stage;
  if (typeof patch.facets === 'number') rec.facets = Math.max(rec.facets || 0, patch.facets);
  if (patch.hasResult) rec.hasResult = true;
  if (patch.avatarFull) rec.avatarFull = true;
  if (patch.optOut === true) rec.optOut = true;
  if (patch.optOut === false) rec.optOut = false;
  if (patch.type) rec.type = patch.type;
  if (patch.big) rec.big = patch.big;
  if (patch.username) rec.username = patch.username;
  if (patch.gender) rec.gender = patch.gender;
  if (patch.day) rec.day = patch.day;
  if (patch.month) rec.month = patch.month;
  if (patch.year) rec.year = patch.year;
  if (patch.tests && patch.tests.length) rec.tests = patch.tests;
  await env.USERS.put(key, JSON.stringify(rec));
}

/* ---------- smart, capped re-engagement (Cron) ---------- */
async function runReengagement(env) {
  if (!env.USERS || !env.BOT_TOKEN) return;
  // quiet hours: no pings 22:00–09:00 local (Batumi = UTC+4)
  const localH = (new Date().getUTCHours() + 4) % 24;
  if (localH >= 22 || localH < 9) return;
  const now = Date.now(), H = 3600e3;
  let cursor;
  do {
    const list = await env.USERS.list({ prefix: 'user:', cursor });
    cursor = list.list_complete ? null : list.cursor;
    for (const k of list.keys) {
      let rec; try { rec = JSON.parse(await env.USERS.get(k.name)); } catch (e) { continue; }
      if (!rec || rec.optOut || !rec.id) continue;
      const reminders = rec.reminders || [];
      if (reminders.length >= 4) continue;                              // lifetime cap
      const lastRem = reminders.length ? reminders[reminders.length - 1].t : 0;
      if (now - lastRem < 40 * H) continue;                            // min 40h between pings
      const idleH = (now - (rec.lastActive || 0)) / H;
      const n = pickNudge(rec, idleH);
      if (!n) continue;
      if (reminders.filter(r => r.type === n.type).length >= 2) continue; // max 2 of same type
      try {
        await tg(env, 'sendMessage', { chat_id: rec.id, text: n.text, reply_markup: openKb(rec.lang) });
        reminders.push({ type: n.type, t: now });
        rec.reminders = reminders;
        await env.USERS.put(k.name, JSON.stringify(rec));
      } catch (e) {}
    }
  } while (cursor);
}

function pickNudge(rec, idleH) {
  const en = rec.lang === 'en';
  const facets = rec.facets || 0;
  // 1) started but no result yet → finish the first test (after ~20h idle)
  if (!rec.hasResult && idleH >= 20)
    return { type: 'finish_first', text: en ? 'You’re one step from your portrait 🌀 Answer a few quick questions and meet your type.' : 'Ты в шаге от своего портрета 🌀 Ответь на пару вопросов — и узнаешь свой тип.' };
  // 2) has a result but passport not full → next facet (after ~44h idle)
  if (rec.hasResult && facets < 5 && idleH >= 44)
    return { type: 'more_facets', text: en ? `Your passport is ${facets}/5. Open the next facet — see yourself deeper ✨` : `Твой паспорт собран на ${facets}/5. Открой следующую грань — узнаешь себя глубже ✨` };
  // 3) avatar fully assembled → the clone brought matches (after ~44h idle)
  if ((rec.avatarFull || facets >= 5) && idleH >= 44)
    return { type: 'clone_matches', text: en ? 'Your clone met new people 💫 Come see who resonates with you — and why.' : 'Твой клон познакомился с новыми людьми 💫 Загляни — кто тебе резонирует и почему.' };
  return null;
}

/* ---------- private owner admin: users overview + funnel + targeted broadcast ---------- */
async function adminData(env) {
  if (!env.USERS) return { ok: true, users: [], funnel: {}, now: Date.now() };
  const users = []; let cursor;
  do {
    const list = await env.USERS.list({ prefix: 'user:', cursor });
    cursor = list.list_complete ? null : list.cursor;
    for (const k of list.keys) {
      let rec; try { rec = JSON.parse(await env.USERS.get(k.name)); } catch (e) { continue; }
      if (!rec || !rec.id) continue;
      let ent = []; try { ent = JSON.parse(await env.USERS.get('ent:' + rec.id)) || []; } catch (e) {}
      users.push({
        id: rec.id, name: rec.name || '', username: rec.username || '', lang: rec.lang || '', gender: rec.gender || '',
        day: rec.day || 0, month: rec.month || 0, year: rec.year || 0,
        type: rec.type || '', big: rec.big || null, facets: rec.facets || 0, tests: rec.tests || [],
        stage: rec.stage || '', hasResult: !!rec.hasResult, avatarFull: !!(rec.avatarFull || (rec.facets || 0) >= 5),
        purchases: ent, reminders: (rec.reminders || []).length, optOut: !!rec.optOut,
        firstSeen: rec.firstSeen || 0, lastActive: rec.lastActive || 0,
      });
    }
  } while (cursor);
  users.sort((a, b) => b.lastActive - a.lastActive);
  const funnel = {
    total: users.length,
    result: users.filter(u => u.hasResult).length,
    full: users.filter(u => u.avatarFull).length,
    paid: users.filter(u => u.purchases && u.purchases.length).length,
  };
  return { ok: true, users, funnel, now: Date.now() };
}
function segMatch(seg, rec, paid, full) {
  if (seg === 'all') return true;
  if (seg === 'no_result') return !rec.hasResult;
  if (seg === 'incomplete') return rec.hasResult && !full;
  if (seg === 'no_purchase') return rec.hasResult && !paid;
  if (seg === 'full_no_purchase') return full && !paid;
  return false;
}
async function adminBroadcast(env, body) {
  if (!env.USERS || !env.BOT_TOKEN) return { ok: false, err: 'no kv/token' };
  const text = String(body.text || '').slice(0, 3000);
  const seg = body.segment || 'all';
  const dry = !!body.dry;
  if (!dry && !text) return { ok: false, err: 'empty text' };
  let cursor, targets = [];
  do {
    const list = await env.USERS.list({ prefix: 'user:', cursor });
    cursor = list.list_complete ? null : list.cursor;
    for (const k of list.keys) {
      let rec; try { rec = JSON.parse(await env.USERS.get(k.name)); } catch (e) { continue; }
      if (!rec || !rec.id || rec.optOut) continue;
      let ent = []; try { ent = JSON.parse(await env.USERS.get('ent:' + rec.id)) || []; } catch (e) {}
      const full = rec.avatarFull || (rec.facets || 0) >= 5;
      if (segMatch(seg, rec, ent.length > 0, full)) targets.push(rec);
    }
  } while (cursor);
  if (dry) return { ok: true, count: targets.length, dry: true };
  let sent = 0, failed = 0;
  for (const rec of targets) {
    try {
      const r = await tg(env, 'sendMessage', { chat_id: rec.id, text, reply_markup: openKb(rec.lang) });
      const j = await r.json(); if (j.ok) sent++; else failed++;
    } catch (e) { failed++; }
  }
  return { ok: true, sent, failed, count: targets.length };
}
function adminHTML() {
  // self-contained dashboard; reads ?secret= from its own URL to call /admin/data + /admin/broadcast.
  // NOTE: kept free of backticks and ${...} so it survives inside the worker's template string.
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SELF-FIX · admin</title>'
  + '<style>'
  + ':root{--vio:#7C3AFF;--cy:#00E0C7;--lime:#D4FF4F;--bg:#0a0814;--card:rgba(28,24,46,.6)}'
  + '*{box-sizing:border-box}body{margin:0;background:radial-gradient(120% 80% at 50% 0,#19132e,#0a0814);color:#e9e6f7;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;padding:18px}'
  + 'h1{font-size:18px;margin:0 0 14px;letter-spacing:2px}h1 b{color:var(--lime)}'
  + '.funnel{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}'
  + '.kpi{background:var(--card);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:10px 16px;min-width:96px}'
  + '.kpi .n{font-size:22px;font-weight:800}.kpi .l{font-size:11px;color:#a39ccb;text-transform:uppercase;letter-spacing:.5px}'
  + '.kpi .p{font-size:11px;color:var(--cy);font-weight:700}'
  + '.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}'
  + '.seg{background:rgba(124,58,255,.15);border:1px solid rgba(124,58,255,.4);color:#cbb8ff;border-radius:20px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer}'
  + '.seg.on{background:var(--vio);color:#fff}'
  + 'input,textarea,select{background:rgba(10,8,20,.6);border:1px solid rgba(255,255,255,.16);color:#fff;border-radius:10px;padding:8px 11px;font:inherit;outline:none}'
  + 'table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:8px 9px;border-bottom:1px solid rgba(255,255,255,.07);white-space:nowrap}'
  + 'th{color:#a39ccb;font-size:11px;text-transform:uppercase;letter-spacing:.4px;position:sticky;top:0;background:#120e22}'
  + 'tr:hover td{background:rgba(124,58,255,.07)}'
  + '.tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:10.5px;font-weight:800}'
  + '.paid{background:rgba(82,230,164,.16);color:#52e6a4}.nopaid{color:#6b6690}'
  + '.wrap{overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:14px;max-height:54vh}'
  + '.bc{margin-top:18px;background:var(--card);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:14px}'
  + '.bc h2{font-size:14px;margin:0 0 10px}.bc textarea{width:100%;min-height:80px;resize:vertical}'
  + '.btn{background:var(--lime);color:#10240a;border:none;border-radius:10px;padding:9px 16px;font-weight:800;cursor:pointer}'
  + '.btn.ghost{background:rgba(255,255,255,.08);color:#cbb8ff}'
  + '.muted{color:#a39ccb;font-size:12px}'
  + '</style></head><body>'
  + '<h1>SELF-FIX · <b>admin</b></h1>'
  + '<div class="funnel" id="funnel"></div>'
  + '<div class="bar"><span class="muted">сегмент:</span><span class="seg on" data-s="all">все</span><span class="seg" data-s="no_result">не прошли тест</span><span class="seg" data-s="incomplete">не собрали 5/5</span><span class="seg" data-s="no_purchase">не купили</span><span class="seg" data-s="full_no_purchase">5/5, но не купили</span><input id="q" placeholder="поиск по имени/типу" style="margin-left:auto;min-width:180px"></div>'
  + '<div class="wrap"><table><thead><tr><th>Имя</th><th>@</th><th>Тип</th><th>Сильное</th><th>Слабое</th><th>ДР</th><th>Пол</th><th>Тесты</th><th>Стадия</th><th>Купил</th><th>Был</th><th>Яз</th></tr></thead><tbody id="rows"></tbody></table></div>'
  + '<div class="bc"><h2>📣 Точечная рассылка <span class="muted" id="bcseg"></span></h2><textarea id="bctext" placeholder="Текст сообщения (уйдёт в бота этим юзерам; кто нажал /stop — пропускаются)"></textarea><div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn ghost" id="bcprev">Сколько получат?</button><button class="btn" id="bcsend">Отправить сегменту</button><span class="muted" id="bcres"></span></div></div>'
  + '<script>'
  + 'var SECRET=new URLSearchParams(location.search).get("secret")||"";'
  + 'var TYPES={red:"Огонь",blue:"Лёд",orange:"Сталь",green:"Тепло",yellow:"Поток"};'
  + 'var BIGN={O:"открытость",C:"собранность",E:"энергия",A:"мягкость",N:"чувствит."};'
  + 'var DATA=[],SEG="all";'
  + 'function rel(t){if(!t)return "—";var d=Date.now()-t,h=d/3600000;if(h<1)return Math.round(d/60000)+"м";if(h<24)return Math.round(h)+"ч";return Math.round(h/24)+"д";}'
  + 'function strongWeak(big){if(!big)return["—","—"];var ks=Object.keys(BIGN),hi=ks[0],lo=ks[0];ks.forEach(function(k){if((big[k]||0)>(big[hi]||0))hi=k;if((big[k]||0)<(big[lo]==null?100:big[lo]||0))lo=k;});return[BIGN[hi],BIGN[lo]];}'
  + 'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}'
  + 'function paidText(p){return (p&&p.length)?("<span class=\\"tag paid\\">"+p.length+" ⭐</span>"):"<span class=\\"nopaid\\">—</span>";}'
  + 'function render(){'
  + 'var f=window.FUN||{};document.getElementById("funnel").innerHTML='
  + '"<div class=\\"kpi\\"><div class=\\"n\\">"+(f.total||0)+"</div><div class=\\"l\\">всего</div></div>"'
  + '+"<div class=\\"kpi\\"><div class=\\"n\\">"+(f.result||0)+"</div><div class=\\"l\\">прошли тест</div><div class=\\"p\\">"+pct(f.result,f.total)+"</div></div>"'
  + '+"<div class=\\"kpi\\"><div class=\\"n\\">"+(f.full||0)+"</div><div class=\\"l\\">5/5</div><div class=\\"p\\">"+pct(f.full,f.total)+"</div></div>"'
  + '+"<div class=\\"kpi\\"><div class=\\"n\\">"+(f.paid||0)+"</div><div class=\\"l\\">купили</div><div class=\\"p\\">"+pct(f.paid,f.total)+"</div></div>";'
  + 'var q=(document.getElementById("q").value||"").toLowerCase();'
  + 'var rows=DATA.filter(function(u){if(q){var hay=((u.name||"")+" "+(TYPES[u.type]||u.type||"")+" "+(u.username||"")).toLowerCase();if(hay.indexOf(q)<0)return false;}return inSeg(u);});'
  + 'document.getElementById("rows").innerHTML=rows.map(function(u){var sw=strongWeak(u.big);var dob=u.day?(u.day+"."+(u.month||"")+(u.year?"."+u.year:"")):"—";'
  + 'return "<tr><td>"+esc(u.name||"—")+"</td><td>"+(u.username?("@"+esc(u.username)):"—")+"</td><td>"+esc(TYPES[u.type]||u.type||"—")+"</td><td>"+sw[0]+"</td><td>"+sw[1]+"</td><td>"+dob+"</td><td>"+(u.gender==="m"?"М":u.gender==="f"?"Ж":"—")+"</td><td>"+(u.facets||0)+"/5</td><td>"+esc(u.stage||"—")+"</td><td>"+paidText(u.purchases)+"</td><td>"+rel(u.lastActive)+"</td><td>"+esc(u.lang||"")+"</td></tr>";}).join("")||"<tr><td colspan=12 class=muted style=padding:20px>пусто</td></tr>";'
  + 'document.getElementById("bcseg").textContent="— сегмент: "+SEG+" ("+rows.length+" видно)";}'
  + 'function pct(a,b){if(!b)return"";return Math.round(100*(a||0)/b)+"%";}'
  + 'function inSeg(u){var paid=u.purchases&&u.purchases.length>0,full=u.avatarFull;if(SEG==="all")return true;if(SEG==="no_result")return !u.hasResult;if(SEG==="incomplete")return u.hasResult&&!full;if(SEG==="no_purchase")return u.hasResult&&!paid;if(SEG==="full_no_purchase")return full&&!paid;return true;}'
  + 'Array.prototype.forEach.call(document.querySelectorAll(".seg"),function(el){el.onclick=function(){SEG=el.dataset.s;Array.prototype.forEach.call(document.querySelectorAll(".seg"),function(e){e.classList.remove("on");});el.classList.add("on");render();};});'
  + 'document.getElementById("q").oninput=render;'
  + 'function load(){fetch("/admin/data?secret="+encodeURIComponent(SECRET)).then(function(r){return r.json();}).then(function(d){if(!d.ok){document.body.innerHTML="<h1>403 — bad secret</h1>";return;}DATA=d.users||[];window.FUN=d.funnel||{};render();});}'
  + 'document.getElementById("bcprev").onclick=function(){bc(true);};document.getElementById("bcsend").onclick=function(){if(confirm("Отправить сообщение сегменту \\""+SEG+"\\"?"))bc(false);};'
  + 'function bc(dry){var t=document.getElementById("bctext").value;var res=document.getElementById("bcres");res.textContent="…";'
  + 'fetch("/admin/broadcast",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret:SECRET,segment:SEG,text:t,dry:dry})}).then(function(r){return r.json();}).then(function(d){'
  + 'if(!d.ok){res.textContent="ошибка: "+(d.err||"?");return;}if(d.dry){res.textContent="получат: "+d.count;}else{res.textContent="отправлено: "+d.sent+" / "+d.count+(d.failed?(" · ошибок "+d.failed):"");load();}});}'
  + 'load();'
  + '</scr'+'ipt></body></html>';
}

/* ---------- bot self-setup (menu button, commands, description) ---------- */
async function setupBot(env, origin) {
  // NB: intentionally does NOT touch description / short description — those are owned manually in @BotFather.
  const out = {};
  out.menu = await (await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: APP_URL } } })).json();
  out.cmds = await (await tg(env, 'setMyCommands', { commands: [
    { command: 'start', description: 'Открыть SELF-FIX' },
    { command: 'help', description: 'Что это и как работает' },
    { command: 'stop', description: 'Отключить напоминания' },
  ] })).json();
  // webhook → so Stars pre_checkout + successful_payment (and /start) reach this worker
  if (origin) {
    out.webhook = await (await tg(env, 'setWebhook', {
      url: origin + '/pay/webhook',
      allowed_updates: ['message', 'pre_checkout_query'],
      drop_pending_updates: false,
    })).json();
  }
  out.webhookInfo = await (await tg(env, 'getWebhookInfo', {})).json();
  return { ok: true, out };
}
function welcomeText(lang) {
  return lang === 'en'
    ? 'Welcome to SELF-FIX 🌀\nDiscover who you really are in 2 minutes — by science (Big Five). Assemble your living AI-clone, and it finds your people.\nTap “Open SELF-FIX”.'
    : 'Добро пожаловать в SELF-FIX 🌀\nЗа 2 минуты узнай, кто ты на самом деле — по науке (Big Five). Собери живого ИИ-двойника, и он найдёт твоих людей.\nЖми «Открыть SELF-FIX».';
}
function openKb(lang) {
  return { inline_keyboard: [[{ text: lang === 'en' ? 'Open SELF-FIX' : 'Открыть SELF-FIX', web_app: { url: APP_URL } }]] };
}

/* ---------- Telegram WebApp initData validation (HMAC) ---------- */
async function validateInit(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dcs = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const enc = new TextEncoder();
    const kdKey = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', kdKey, enc.encode(botToken));
    const hKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', hKey, enc.encode(dcs));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    const userJson = params.get('user');
    return userJson ? JSON.parse(userJson) : null;
  } catch (e) { return null; }
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
