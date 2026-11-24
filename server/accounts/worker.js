// Koumakan Digital accounts: email + password logins, "My Plugins", Paddle purchase webhook.
// Cloudflare Worker + D1. Tables in schema.sql. Tokens go in the Authorization header (no cookies,
// so it works cross-site from GitHub Pages without third-party-cookie problems).

const PRICES = { // Paddle price id -> product slug (live + sandbox)
  pri_01m8302mqfw0qcw3vemcqbftax: 'youkai808', pri_01m8304kea64hve92h7v29e5f7: 'melodyveil',
  pri_01m82xta4pgfvfc27v7n5neg08: 'youkai808', pri_01m82xv97bqjybf8gyg7b489cv: 'melodyveil',
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

async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERS }, key, 256));
}
function safeEq(a, b) { // constant-time string compare
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function cors(env, req) {
  const o = req.headers.get('Origin') || '';
  const ok = o === env.SITE_ORIGIN || o === 'https://www.koumakandigital.xyz' || /^http:\/\/localhost(:\d+)?$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : env.SITE_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin' };
}
const json = (h, status, body) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });

// Rate limit by key (email or IP). Returns true if blocked.
async function limited(env, key) {
  const r = await env.DB.prepare('SELECT count, window_start FROM attempts WHERE key=?').bind(key).first();
  return !!r && now() - r.window_start < FAIL_WINDOW && r.count >= MAX_FAILS;
}
async function fail(env, key) {
  await env.DB.prepare(`INSERT INTO attempts(key,count,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ?-window_start >= ? THEN 1 ELSE count+1 END,
    window_start = CASE WHEN ?-window_start >= ? THEN ? ELSE window_start END`)
    .bind(key, now(), now(), FAIL_WINDOW, now(), FAIL_WINDOW, now()).run();
}

async function newSession(env, userId) {
  const token = rand();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)')
    .bind(await sha256(token), userId, now() + SESSION_DAYS * 86400).run();
  return token;
}
async function currentUser(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  return env.DB.prepare('SELECT u.id, u.email, u.created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?')
    .bind(await sha256(t), now()).first();
}

async function readBody(req) { try { return await req.json(); } catch { return {}; } }

async function signup(env, h, req) {
  const b = await readBody(req), email = normEmail(b.email), pw = String(b.password || '');
  if (!validEmail(email)) return json(h, 400, { error: 'Enter A Real Email Address.' });
  if (pw.length < 8 || pw.length > 200) return json(h, 400, { error: 'Password Needs At Least 8 Characters.' });
  const ip = 'su:' + (req.headers.get('CF-Connecting-IP') || '');
  if (await limited(env, ip)) return json(h, 429, { error: 'Too Many Tries. Wait 15 Minutes.' });
  await fail(env, ip); // caps sign-ups per IP so nobody can mass-create accounts
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first())
    return json(h, 409, { error: 'That Email Already Has An Account. Log In Instead.' });
  const id = crypto.randomUUID(), salt = rand(16);
  await env.DB.prepare('INSERT INTO users(id,email,pw_hash,salt,created) VALUES(?,?,?,?,?)')
    .bind(id, email, await hashPw(pw, salt), salt, now()).run();
  await env.DB.prepare('UPDATE purchases SET user_id=? WHERE email=? AND user_id IS NULL').bind(id, email).run();
  return json(h, 200, { token: await newSession(env, id) });
}

async function login(env, h, req) {
  const b = await readBody(req), email = normEmail(b.email), pw = String(b.password || '');
  const ip = 'ip:' + (req.headers.get('CF-Connecting-IP') || '');
  if (await limited(env, 'em:' + email) || await limited(env, ip)) return json(h, 429, { error: 'Too Many Tries. Wait 15 Minutes.' });
  const u = await env.DB.prepare('SELECT id, pw_hash, salt FROM users WHERE email=?').bind(email).first();
  const hash = await hashPw(pw, u ? u.salt : 'no-user-' + email); // same work either way, no user enumeration by timing
  if (!u || !safeEq(hash, u.pw_hash)) { await fail(env, 'em:' + email); await fail(env, ip); return json(h, 401, { error: 'Wrong Email Or Password.' }); }
  return json(h, 200, { token: await newSession(env, u.id) });
}

async function me(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const { results } = await env.DB.prepare(`SELECT p.product, p.created, p.license_key, p.status,
      (SELECT COUNT(*) FROM instances i WHERE i.license_key=p.license_key) AS used
    FROM purchases p WHERE p.user_id=? OR p.email=? ORDER BY p.created DESC`).bind(u.id, u.email).all();
  results.forEach((r) => { r.limit = ACTIVATION_LIMIT; });
  return json(h, 200, { id: u.id, email: u.email, created: u.created, purchases: results });
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
  if (!safeEq(await hashPw(String(b.current || ''), row.salt), row.pw_hash)) return json(h, 401, { error: 'Current Password Is Wrong.' });
  return setPassword(env, h, u.id, String(b.password || ''));
}
async function setPassword(env, h, userId, pw) {
  if (pw.length < 8 || pw.length > 200) return json(h, 400, { error: 'Password Needs At Least 8 Characters.' });
  const salt = rand(16);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash=?, salt=? WHERE id=?').bind(await hashPw(pw, salt), salt, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId), // log out everywhere
  ]);
  return json(h, 200, { token: await newSession(env, userId) });
}

// Buyer frees every computer on one of their keys (lost / reset PC). Once per RESET_DAYS so a shared key can't rotate freely.
async function freeComputers(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const key = String((await readBody(req)).license_key || '');
  const p = await env.DB.prepare('SELECT reset_at FROM purchases WHERE license_key=? AND (user_id=? OR email=?)').bind(key, u.id, u.email).first();
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
  const h = { 'Content-Type': 'application/json' }, out = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: h });
  let f; try { f = await req.formData(); } catch { return out({ error: 'Bad request.' }, 400); }
  const key = String(f.get('license_key') || '').trim().toUpperCase();
  const p = await env.DB.prepare('SELECT product, status FROM purchases WHERE license_key=?').bind(key).first();
  const meta = p ? { product_id: PRODUCT_IDS[p.product], product_name: NAMES[p.product], customer_name: '' } : null;
  const lk = (used) => ({ key, status: p.status === 'active' ? 'active' : 'disabled', activation_limit: ACTIVATION_LIMIT, activation_usage: used });
  const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM instances WHERE license_key=?').bind(key).first()).n;

  if (action === 'activate') {
    if (!p) return out({ activated: false, error: "That key isn't valid." }, 404);
    if (p.status !== 'active') return out({ activated: false, error: 'This key was refunded or disabled.' }, 400);
    const name = String(f.get('instance_name') || '').slice(0, 100);
    let inst = await env.DB.prepare('SELECT id, name FROM instances WHERE license_key=? AND name=?').bind(key, name).first();
    if (!inst) { // re-activating the same computer reuses its slot
      if (await count() >= ACTIVATION_LIMIT) return out({ activated: false, error: 'This license key has reached the activation limit.' }, 400);
      inst = { id: crypto.randomUUID(), name };
      await env.DB.prepare('INSERT INTO instances(id,license_key,name,created) VALUES(?,?,?,?)').bind(inst.id, key, name, now()).run();
    }
    return out({ activated: true, error: null, license_key: lk(await count()), instance: inst, meta });
  }
  const id = String(f.get('instance_id') || '');
  const inst = p && await env.DB.prepare('SELECT id, name FROM instances WHERE license_key=? AND id=?').bind(key, id).first();
  if (action === 'validate')
    return out({ valid: !!inst && p.status === 'active', error: inst ? null : 'License or instance not found.',
      license_key: p ? lk(await count()) : null, instance: inst || null, meta });
  if (action === 'deactivate') {
    if (!inst) return out({ deactivated: false, error: 'License or instance not found.' }, 404);
    await env.DB.prepare('DELETE FROM instances WHERE id=?').bind(id).run();
    return out({ deactivated: true, error: null, license_key: lk(await count()), meta });
  }
  return out({ error: 'Not found.' }, 404);
}

async function forgot(env, h, req) {
  const email = normEmail((await readBody(req)).email);
  if (!env.RESEND_API_KEY) return json(h, 501, { error: 'Password Reset Emails Are Not Set Up Yet. Email Support And We Got You.' });
  if (await limited(env, 'rs:' + email)) return json(h, 200, { ok: true });
  await fail(env, 'rs:' + email);
  const u = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (u) {
    const token = rand();
    await env.DB.prepare('INSERT INTO resets(token_hash,user_id,expires) VALUES(?,?,?)').bind(await sha256(token), u.id, now() + 3600).run();
    const link = `${env.SITE_ORIGIN}/account/#reset=${token}`;
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'Koumakan Digital <no-reply@koumakandigital.xyz>', to: email,
        subject: 'Reset Your Koumakan Digital Password',
        html: `<p>Someone Asked To Reset Your Password. If That Was You, Click Below (Link Works For 1 Hour).</p><p><a href="${link}">Reset My Password</a></p><p>Not You? Ignore This Email.</p>` }) });
  }
  return json(h, 200, { ok: true }); // same answer either way
}
async function reset(env, h, req) {
  const b = await readBody(req), th = await sha256(String(b.token || ''));
  const r = await env.DB.prepare('SELECT user_id FROM resets WHERE token_hash=? AND expires>?').bind(th, now()).first();
  if (!r) return json(h, 400, { error: 'That Reset Link Expired. Ask For A New One.' });
  await env.DB.prepare('DELETE FROM resets WHERE user_id=?').bind(r.user_id).run();
  return setPassword(env, h, r.user_id, String(b.password || ''));
}

// Paddle -> us. Verifies Paddle-Signature (ts=..;h1=HMAC-SHA256(secret, ts + ':' + body)).
async function paddleWebhook(env, req) {
  const raw = await req.text(), sig = req.headers.get('Paddle-Signature') || '';
  const parts = Object.fromEntries(sig.split(';').map((p) => p.split('=')));
  if (!env.PADDLE_WEBHOOK_SECRET || !parts.ts || !parts.h1 || Math.abs(now() - Number(parts.ts)) > 300) return new Response('bad sig', { status: 401 });
  const key = await crypto.subtle.importKey('raw', enc.encode(env.PADDLE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expect = hex(await crypto.subtle.sign('HMAC', key, enc.encode(parts.ts + ':' + raw)));
  if (!safeEq(expect, parts.h1)) return new Response('bad sig', { status: 401 });

  const ev = JSON.parse(raw);
  if (/^adjustment\./.test(ev.event_type)) { // approved refund / chargeback -> key stops working
    const a = ev.data;
    if (a.status === 'approved' && /refund|chargeback/.test(a.action) && a.transaction_id)
      await env.DB.prepare("UPDATE purchases SET status='disabled' WHERE txn_id=?").bind(a.transaction_id).run();
    return new Response('ok');
  }
  if (ev.event_type !== 'transaction.completed') return new Response('ignored');
  const t = ev.data, uid = t.custom_data && typeof t.custom_data.uid === 'string' ? t.custom_data.uid : null;
  let email = '';
  if (uid) { const u = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(uid).first(); if (u) email = u.email; }
  if (!email && t.customer_id && env.PADDLE_API_KEY) {
    const api = env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    const r = await fetch(`${api}/customers/${t.customer_id}`, { headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}` } });
    if (r.ok) email = normEmail((await r.json()).data.email);
  }
  if (!email) return new Response('no email', { status: 500 }); // Paddle retries later
  const owner = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  const stmts = (t.items || []).map((i) => PRICES[i.price && i.price.id]).filter(Boolean).map((p) =>
    env.DB.prepare('INSERT OR IGNORE INTO purchases(txn_id,product,email,user_id,created,license_key) VALUES(?,?,?,?,?,?)')
      .bind(t.id, p, email, owner ? owner.id : null, now(), newKey())); // OR IGNORE = Paddle retries don't mint a second key
  if (stmts.length) await env.DB.batch(stmts);
  return new Response('ok');
}

const ROUTES = { '/signup': signup, '/login': login, '/logout': logout, '/me': me,
  '/password': changePassword, '/free-computers': freeComputers, '/forgot': forgot, '/reset': reset };

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname, h = cors(env, req);
    if (path === '/paddle-webhook' && req.method === 'POST') return paddleWebhook(env, req);
    const lic = path.match(/^\/v1\/licenses\/(activate|validate|deactivate)$/);
    if (lic && req.method === 'POST') return licenseApi(env, req, lic[1]);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const fn = ROUTES[path];
    if (!fn) return json(h, 404, { error: 'Not Found' });
    if ((path === '/me') !== (req.method === 'GET')) return json(h, 405, { error: 'Wrong Method' });
    try { return await fn(env, h, req); } catch (e) { console.error(e); return json(h, 500, { error: 'Something Broke On Our End. Try Again.' }); }
  },
  async scheduled(_, env) { // daily cleanup of expired rows
    await env.DB.batch(['sessions', 'resets'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE expires<?`).bind(now())));
  },
};
