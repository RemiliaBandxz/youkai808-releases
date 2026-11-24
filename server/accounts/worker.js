// Koumakan Digital accounts: email + password logins, "My Plugins", Paddle purchase webhook.
// Cloudflare Worker + D1. Tables in schema.sql. Tokens go in the Authorization header (no cookies,
// so it works cross-site from GitHub Pages without third-party-cookie problems).

const PRICES = { // Paddle price id -> product slug. Only the map matching PADDLE_ENV counts, so test-card buys can't mint live keys.
  live:    { pri_01m8302mqfw0qcw3vemcqbftax: 'youkai808', pri_01m8304kea64hve92h7v29e5f7: 'melodyveil' },
  sandbox: { pri_01m82xta4pgfvfc27v7n5neg08: 'youkai808', pri_01m82xv97bqjybf8gyg7b489cv: 'melodyveil' },
};
// Numeric ids the Hub matches in catalog.json store_product_ids (Y8Store.h reads meta.product_id).
const PRODUCT_IDS = { youkai808: 808001, melodyveil: 808002 };
const NAMES = { youkai808: 'Youkai808', melodyveil: 'Melody Veil' };
const ACTIVATION_LIMIT = 3, RESET_DAYS = 7;
const SESSION_DAYS = 30, PBKDF2_ITERS = 100000, MAX_FAILS = 8, FAIL_WINDOW = 15 * 60;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const normEmail = (e) => String(e || '').trim().toLowerCase();
const newKey = () => 'KD-' + hex(crypto.getRandomValues(new Uint8Array(16))).toUpperCase().match(/.{8}/g).join('-');
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

// PBKDF2 at 100k is the Workers WebCrypto max, so a secret pepper (HMAC) is layered on top:
// a stolen database alone can't be brute-forced without PW_PEPPER, which only lives in Worker secrets.
async function hashPw(env, pw, salt) {
  if (!env.PW_PEPPER) throw new Error('PW_PEPPER secret missing');
  const pk = await crypto.subtle.importKey('raw', enc.encode(env.PW_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const peppered = await crypto.subtle.sign('HMAC', pk, enc.encode(pw));
  const key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERS }, key, 256));
}
function safeEq(a, b) { // constant-time string compare
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const SECURE = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
function cors(env, req) {
  const o = req.headers.get('Origin') || '';
  const ok = o === env.SITE_ORIGIN || o === 'https://www.koumakandigital.xyz' || (env.DEV === '1' && /^http:\/\/localhost(:\d+)?$/.test(o));
  return { ...SECURE, 'Access-Control-Allow-Origin': ok ? o : env.SITE_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
}

// Cloudflare Turnstile (bot check) on signup / login / forgot. Skipped only if TURNSTILE_SECRET isn't set.
async function human(env, req, b) {
  if (!env.TURNSTILE_SECRET) return env.DEV === '1'; // production refuses to run without the bot check
  const f = new FormData();
  f.append('secret', env.TURNSTILE_SECRET); f.append('response', String(b.turnstile || ''));
  f.append('remoteip', req.headers.get('CF-Connecting-IP') || '');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: f });
  return r.ok && (await r.json()).success === true;
}
const BOT = 'Bot Check Failed. Refresh The Page And Try Again.';

// Reject passwords that showed up in known data breaches (Have I Been Pwned, k-anonymity: only 5 hash chars leave us).
async function weakPassword(pw) {
  if (pw.length < 10) return 'Password Needs At Least 10 Characters.';
  if (pw.length > 200) return 'Password Is Too Long.';
  try {
    const h = hex(await crypto.subtle.digest('SHA-1', enc.encode(pw))).toUpperCase();
    const r = await fetch('https://api.pwnedpasswords.com/range/' + h.slice(0, 5), { headers: { 'Add-Padding': 'true' } });
    if (r.ok && (await r.text()).split('\n').some((l) => l.startsWith(h.slice(5) + ':') && !l.trim().endsWith(':0')))
      return 'That Password Showed Up In A Data Leak Somewhere. Pick A Different One.';
  } catch { /* HIBP down: don't block sign-ups */ }
  return null;
}

async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'Koumakan Digital <no-reply@koumakandigital.xyz>', to, subject, html }) });
  return r.ok;
}
async function emailLink(env, userId, email, kind) {
  const token = rand();
  await env.DB.prepare('INSERT INTO tokens(token_hash,user_id,kind,expires) VALUES(?,?,?,?)').bind(await sha256(token), userId, kind, now() + 3600).run();
  const link = `${env.SITE_ORIGIN}/account/#${kind}=${token}`;
  return kind === 'verify'
    ? sendMail(env, email, 'Confirm Your Koumakan Digital Email', `<p>Click To Confirm Your Email And Set Your Password (Link Works For 1 Hour). Plugins You Bought With This Email Will Show Up In Your Account.</p><p><a href="${link}">Confirm My Email</a></p><p>Didn't Sign Up? Ignore This Email.</p>`)
    : sendMail(env, email, 'Reset Your Koumakan Digital Password', `<p>Someone Asked To Reset Your Password. If That Was You, Click Below (Link Works For 1 Hour).</p><p><a href="${link}">Reset My Password</a></p><p>Not You? Ignore This Email.</p>`);
}
async function useToken(env, token, kind) {
  const th = await sha256(String(token || ''));
  const r = await env.DB.prepare('SELECT user_id FROM tokens WHERE token_hash=? AND kind=? AND expires>?').bind(th, kind, now()).first();
  if (r) await env.DB.prepare('DELETE FROM tokens WHERE user_id=? AND kind=?').bind(r.user_id, kind).run();
  return r && r.user_id;
}
// Purchases a user may see: ones made while logged in (user_id), plus ones under their email once that email is verified.
const OWNS = '(p.user_id=?1 OR (p.email=?2 AND (SELECT verified FROM users WHERE id=?1)=1))';
const json = (h, status, body) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });

// Rate limit: count the attempt FIRST in one atomic upsert, then decide, so parallel bursts can't slip past.
// Returns true if this attempt is over the limit.
async function hit(env, key, max = MAX_FAILS) {
  const t = now();
  const r = await env.DB.prepare(`INSERT INTO attempts(key,count,window_start) VALUES(?1,1,?2)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ?2-window_start >= ?3 THEN 1 ELSE count+1 END,
    window_start = CASE WHEN ?2-window_start >= ?3 THEN ?2 ELSE window_start END RETURNING count`)
    .bind(key, t, FAIL_WINDOW).first();
  return r.count > max;
}
const clearHits = (env, key) => env.DB.prepare('DELETE FROM attempts WHERE key=?').bind(key).run();
const TOO_MANY = 'Too Many Tries. Wait 15 Minutes.';

async function newSession(env, userId) {
  const token = rand();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)')
    .bind(await sha256(token), userId, now() + SESSION_DAYS * 86400).run();
  return token;
}
async function currentUser(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  return env.DB.prepare('SELECT u.id, u.email, u.created, u.verified FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?')
    .bind(await sha256(t), now()).first();
}

async function readBody(req) { try { return await req.json(); } catch { return {}; } }

async function signup(env, h, req) {
  const b = await readBody(req), email = normEmail(b.email), pw = String(b.password || '');
  if (!validEmail(email)) return json(h, 400, { error: 'Enter A Real Email Address.' });
  if (!(await human(env, req, b))) return json(h, 403, { error: BOT });
  if (await hit(env, 'su:' + (req.headers.get('CF-Connecting-IP') || ''), 5)) return json(h, 429, { error: TOO_MANY }); // caps sign-ups per IP
  const weak = await weakPassword(pw);
  if (weak) return json(h, 400, { error: weak });
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first())
    return json(h, 409, { error: 'That Email Already Has An Account. Log In Instead.' });
  const id = crypto.randomUUID(), salt = rand(16);
  await env.DB.prepare('INSERT INTO users(id,email,pw_hash,salt,created) VALUES(?,?,?,?,?)')
    .bind(id, email, await hashPw(env, pw, salt), salt, now()).run();
  await emailLink(env, id, email, 'verify'); // purchases under this email stay hidden until it's confirmed
  return json(h, 200, { token: await newSession(env, id) });
}

async function login(env, h, req) {
  const b = await readBody(req), email = normEmail(b.email), pw = String(b.password || '');
  if (!validEmail(email)) return json(h, 401, { error: 'Wrong Email Or Password.' });
  if (!(await human(env, req, b))) return json(h, 403, { error: BOT }); // before counting, so bots can't lock real users out
  const ip = 'ip:' + (req.headers.get('CF-Connecting-IP') || '');
  if ((await hit(env, 'em:' + email)) | (await hit(env, ip, 30))) return json(h, 429, { error: TOO_MANY });
  const u = await env.DB.prepare('SELECT id, pw_hash, salt FROM users WHERE email=?').bind(email).first();
  const hash = await hashPw(env, pw, u ? u.salt : 'no-user-' + email); // same work either way, no user enumeration by timing
  if (!u || !safeEq(hash, u.pw_hash)) return json(h, 401, { error: 'Wrong Email Or Password.' });
  await clearHits(env, 'em:' + email);
  return json(h, 200, { token: await newSession(env, u.id) });
}

async function me(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const { results } = await env.DB.prepare(`SELECT p.product, p.created, p.license_key, p.status,
      (SELECT COUNT(*) FROM instances i WHERE i.license_key=p.license_key) AS used
    FROM purchases p WHERE ${OWNS} ORDER BY p.created DESC`).bind(u.id, u.email).all();
  results.forEach((r) => { r.limit = ACTIVATION_LIMIT; });
  return json(h, 200, { id: u.id, email: u.email, created: u.created, verified: !!u.verified, mail: !!env.RESEND_API_KEY, purchases: results });
}

async function logout(env, h, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(t)).run();
  return json(h, 200, { ok: true });
}

async function changePassword(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const b = await readBody(req), row = await env.DB.prepare('SELECT pw_hash, salt FROM users WHERE id=?').bind(u.id).first();
  if (await hit(env, 'pw:' + u.id)) return json(h, 429, { error: TOO_MANY });
  if (!safeEq(await hashPw(env, String(b.current || ''), row.salt), row.pw_hash)) return json(h, 401, { error: 'Current Password Is Wrong.' });
  return setPassword(env, h, u.id, String(b.password || ''));
}
async function setPassword(env, h, userId, pw) {
  const weak = await weakPassword(pw);
  if (weak) return json(h, 400, { error: weak });
  const salt = rand(16);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash=?, salt=? WHERE id=?').bind(await hashPw(env, pw, salt), salt, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId), // log out everywhere
  ]);
  return json(h, 200, { token: await newSession(env, userId) });
}

// Buyer frees every computer on one of their keys (lost / reset PC). Once per RESET_DAYS so a shared key can't rotate freely.
async function freeComputers(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const key = String((await readBody(req)).license_key || '');
  const p = await env.DB.prepare(`SELECT reset_at FROM purchases p WHERE ${OWNS} AND p.license_key=?3`).bind(u.id, u.email, key).first();
  if (!p) return json(h, 404, { error: 'That Key Is Not On Your Account.' });
  const wait = p.reset_at + RESET_DAYS * 86400 - now();
  if (wait > 0) return json(h, 429, { error: `You Can Do This Again In ${Math.ceil(wait / 86400)} Day(s). Email Support If You're Stuck.` });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM instances WHERE license_key=?').bind(key),
    env.DB.prepare('UPDATE purchases SET reset_at=? WHERE license_key=?').bind(now(), key),
  ]);
  return json(h, 200, { ok: true });
}

// Lemon-Squeezy-compatible license API, so the Hub's Y8Store.h only needs its apiHost pointed here.
// Form-encoded POSTs: activate(license_key, instance_name), validate(license_key, instance_id), deactivate(license_key, instance_id).
async function licenseApi(env, req, action) {
  const h = { ...SECURE, 'Content-Type': 'application/json' }, out = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: h });
  let f; try { f = await req.formData(); } catch { return out({ error: 'Bad request.' }, 400); }
  const key = String(f.get('license_key') || '').trim().toUpperCase();
  const p = await env.DB.prepare('SELECT product, status FROM purchases WHERE license_key=?').bind(key).first();
  const meta = p ? { product_id: PRODUCT_IDS[p.product], product_name: NAMES[p.product], customer_name: '' } : null;
  const lk = (used) => ({ key, status: p.status === 'active' ? 'active' : 'disabled', activation_limit: ACTIVATION_LIMIT, activation_usage: used });
  const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM instances WHERE license_key=?').bind(key).first()).n;

  if (action === 'activate') {
    if (!p) return out({ activated: false, error: "That key isn't valid." }, 404);
    if (p.status !== 'active') return out({ activated: false, error: 'This key was refunded or disabled.' }, 400);
    // Always a fresh secret instance id (never hand back another machine's id); the limit check + insert is one statement.
    const inst = { id: crypto.randomUUID(), name: String(f.get('instance_name') || '').slice(0, 100) };
    const r = await env.DB.prepare(`INSERT INTO instances(id,license_key,name,created) SELECT ?1,?2,?3,?4
      WHERE (SELECT COUNT(*) FROM instances WHERE license_key=?2) < ?5`).bind(inst.id, key, inst.name, now(), ACTIVATION_LIMIT).run();
    if (!r.meta.changes) return out({ activated: false, error: 'This license key has reached the activation limit.' }, 400);
    return out({ activated: true, error: null, license_key: lk(await count()), instance: inst, meta });
  }
  const id = String(f.get('instance_id') || '');
  const inst = p && await env.DB.prepare('SELECT id, name FROM instances WHERE license_key=? AND id=?').bind(key, id).first();
  if (action === 'validate')
    return inst ? out({ valid: p.status === 'active', error: null, license_key: lk(await count()), instance: inst, meta })
      : out({ valid: false, error: 'License or instance not found.', license_key: null, instance: null, meta: null });
  if (action === 'deactivate') {
    if (!inst) return out({ deactivated: false, error: 'License or instance not found.' }, 404);
    await env.DB.prepare('DELETE FROM instances WHERE id=?').bind(id).run();
    return out({ deactivated: true, error: null, license_key: lk(await count()), meta });
  }
  return out({ error: 'Not found.' }, 404);
}

async function forgot(env, h, req) {
  const b = await readBody(req), email = normEmail(b.email);
  if (!env.RESEND_API_KEY) return json(h, 501, { error: 'Password Reset Emails Are Not Set Up Yet. Email Support And We Got You.' });
  if (!validEmail(email)) return json(h, 400, { error: 'Enter A Real Email Address.' });
  if (!(await human(env, req, b))) return json(h, 403, { error: BOT });
  if (await hit(env, 'rs:' + email, 3)) return json(h, 200, { ok: true });
  const u = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (u) await emailLink(env, u.id, email, 'reset');
  return json(h, 200, { ok: true }); // same answer either way, so nobody can test which emails have accounts
}
async function reset(env, h, req) {
  const b = await readBody(req), weak = await weakPassword(String(b.password || ''));
  if (weak) return json(h, 400, { error: weak }); // check before burning the one-time link
  const uid = await useToken(env, b.token, 'reset');
  if (!uid) return json(h, 400, { error: 'That Reset Link Expired. Ask For A New One.' });
  await env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(uid).run(); // they proved they own the inbox
  return setPassword(env, h, uid, String(b.password || ''));
}
// Confirming the email ALSO sets the password and logs out every other session. So if someone pre-registered a
// buyer's email, the real inbox owner takes the account over by clicking the link, instead of handing them their keys.
async function verify(env, h, req) {
  const b = await readBody(req), weak = await weakPassword(String(b.password || ''));
  if (weak) return json(h, 400, { error: weak });
  const uid = await useToken(env, b.token, 'verify');
  if (!uid) return json(h, 400, { error: 'That Link Expired. Log In And Hit Resend.' });
  await env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(uid).run();
  return setPassword(env, h, uid, String(b.password || ''));
}
async function resendVerify(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  if (u.verified) return json(h, 200, { ok: true });
  if (await hit(env, 'rv:' + u.id, 3)) return json(h, 429, { error: TOO_MANY });
  if (!(await emailLink(env, u.id, u.email, 'verify'))) return json(h, 501, { error: 'Emails Are Not Set Up Yet. Email Support And We Got You.' });
  return json(h, 200, { ok: true });
}

// Paddle -> us. Verifies Paddle-Signature (ts=..;h1=HMAC-SHA256(secret, ts + ':' + body)).
async function paddleWebhook(env, req) {
  const raw = await req.text(), sig = req.headers.get('Paddle-Signature') || '';
  const parts = Object.fromEntries(sig.split(';').map((p) => p.split('=')));
  if (!env.PADDLE_WEBHOOK_SECRET || !parts.ts || !parts.h1 || Math.abs(now() - Number(parts.ts)) > 300) return new Response('bad sig', { status: 401 });
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PADDLE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expect = hex(await crypto.subtle.sign('HMAC', key, enc.encode(parts.ts + ':' + raw)));
  if (!safeEq(expect, parts.h1)) return new Response('bad sig', { status: 401 });

  let ev; try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (/^adjustment\./.test(ev.event_type)) { // approved refund / chargeback -> key stops working
    const a = ev.data;
    const full = (a.items || []).length > 0 && a.items.every((i) => i.type === 'full'); // partial refunds keep the keys
    if (a.status === 'approved' && a.transaction_id && (a.action === 'chargeback' || (a.action === 'refund' && full)))
      await env.DB.prepare("UPDATE purchases SET status='disabled' WHERE txn_id=?").bind(a.transaction_id).run();
    if (a.status === 'approved' && a.transaction_id && a.action === 'chargeback_reverse')
      await env.DB.prepare("UPDATE purchases SET status='active' WHERE txn_id=?").bind(a.transaction_id).run();
    return new Response('ok');
  }
  if (ev.event_type !== 'transaction.completed') return new Response('ignored');
  const t = ev.data, uid = t.custom_data && typeof t.custom_data.uid === 'string' ? t.custom_data.uid : null;
  let email = '', uid2 = null, acctEmail = '';
  if (uid) { const u = await env.DB.prepare('SELECT id, email FROM users WHERE id=?').bind(uid).first(); if (u) { acctEmail = u.email; uid2 = u.id; } }
  if (t.customer_id && env.PADDLE_API_KEY) { // the payer's real email, so a stale login on a shared PC can't keep them from claiming it
    const api = env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    const r = await fetch(`${api}/customers/${t.customer_id}`, { headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}` } });
    if (r.ok) email = normEmail((await r.json()).data.email);
  }
  if (!email) email = acctEmail;
  if (!email) return new Response('no email', { status: 500 }); // Paddle retries later
  const owner = uid2 ? { id: uid2 } : null; // guest checkouts link by email later, once that email is verified
  const stmts = (t.items || []).map((i) => (PRICES[env.PADDLE_ENV] || {})[i.price && i.price.id]).filter(Boolean).map((p) =>
    env.DB.prepare('INSERT OR IGNORE INTO purchases(txn_id,product,email,user_id,created,license_key) VALUES(?,?,?,?,?,?)')
      .bind(t.id, p, email, owner ? owner.id : null, now(), newKey())); // OR IGNORE = Paddle retries don't mint a second key
  if (stmts.length) await env.DB.batch(stmts);
  return new Response('ok');
}

const ROUTES = { '/signup': signup, '/login': login, '/logout': logout, '/me': me,
  '/password': changePassword, '/free-computers': freeComputers, '/forgot': forgot, '/reset': reset,
  '/verify': verify, '/resend-verify': resendVerify };

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname, h = cors(env, req);
    try {
      if (path === '/paddle-webhook' && req.method === 'POST') return await paddleWebhook(env, req);
      const lic = path.match(/^\/v1\/licenses\/(activate|validate|deactivate)$/);
      if (lic && req.method === 'POST') return await licenseApi(env, req, lic[1]);
    } catch (e) { console.error(e); return new Response('error', { status: 500, headers: SECURE }); }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const fn = ROUTES[path];
    if (!fn) return json(h, 404, { error: 'Not Found' });
    if ((path === '/me') !== (req.method === 'GET')) return json(h, 405, { error: 'Wrong Method' });
    try { return await fn(env, h, req); } catch (e) { console.error(e); return json(h, 500, { error: 'Something Broke On Our End. Try Again.' }); }
  },
  async scheduled(_, env) { // daily cleanup of expired rows
    await env.DB.batch([...['sessions', 'tokens'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE expires<?`).bind(now())),
      env.DB.prepare('DELETE FROM attempts WHERE window_start<?').bind(now() - FAIL_WINDOW)]);
  },
};
