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
      // rich admin UI lives on Pages (easy to iterate); data stays gated here by secret
      const s = url.searchParams.get('secret') || '';
      return Response.redirect('https://masteroch.github.io/selfix/admin.html?secret=' + encodeURIComponent(s), 302);
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
  // single-user direct message (owner-initiated reply; ignores optOut since it's not an automated nudge)
  if (body.userId) {
    if (dry) return { ok: true, count: 1, dry: true };
    try {
      const r = await tg(env, 'sendMessage', { chat_id: body.userId, text, reply_markup: openKb(body.lang || 'ru') });
      const j = await r.json();
      return j.ok ? { ok: true, sent: 1, count: 1 } : { ok: false, err: j.description || 'send failed' };
    } catch (e) { return { ok: false, err: 'send failed' }; }
  }
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
