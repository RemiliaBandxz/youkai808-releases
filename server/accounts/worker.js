// Koumakan Digital accounts: email + password logins, "My Plugins", Paddle purchase webhook.
// Cloudflare Worker + D1. Tables in schema.sql. Tokens go in the Authorization header (no cookies,
// so it works cross-site from GitHub Pages without third-party-cookie problems).

const PRICES = { // Paddle price id -> product slug. Only the map matching PADDLE_ENV counts, so test-card buys can't mint live keys.
  live:    { pri_01m8302mqfw0qcw3vemcqbftax: 'youkai808', pri_01m8304kea64hve92h7v29e5f7: 'melodyveil' },
  sandbox: { pri_01m82xta4pgfvfc27v7n5neg08: 'youkai808', pri_01m82xv97bqjybf8gyg7b489cv: 'melodyveil' },
};
// Numeric ids the Hub matches in catalog.json store_product_ids (Y8Store.h reads meta.product_id).
// all = one code that unlocks every plugin (website + Hub). The Hub treats 808000 as everything.
const PRODUCT_IDS = { youkai808: 808001, melodyveil: 808002, all: 808000 };
const NAMES = { youkai808: 'Youkai808', melodyveil: 'Melody Veil', all: 'All Plugins', beta: 'Beta Tester' };
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
// No email sender yet = nobody can verify, so the email match counts on its own until RESEND_API_KEY is set.
// shortcut: without a mailer, signing up first with a buyer's email shows their keys; set RESEND_API_KEY to turn verification back on.
const owns = (env) => env.RESEND_API_KEY ? '(p.user_id=?1 OR (p.email=?2 AND (SELECT verified FROM users WHERE id=?1)=1))' : '(p.user_id=?1 OR p.email=?2)';
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

async function newSession(env, userId, mfa = 0) {
  const token = rand();
  const days = mfa ? 1 : SESSION_DAYS; // owner sessions that passed 2FA expire after a day
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires,mfa) VALUES(?,?,?,?)')
    .bind(await sha256(token), userId, now() + days * 86400, mfa).run();
  return token;
}

// ---- 2FA (TOTP, RFC 6238: 6 digits, 30s, SHA-1, works with any authenticator app) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(str) {
  let bits = '', out = [];
  for (const c of str.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}
const newTotpSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => B32[b & 31]).join('');
async function totpAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', b32decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8); new DataView(msg.buffer).setUint32(4, step);
  const hm = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)), o = hm[19] & 15;
  return String((((hm[o] & 127) << 24) | (hm[o + 1] << 16) | (hm[o + 2] << 8) | hm[o + 3]) % 1e6).padStart(6, '0');
}
// Returns the matching step (±1 step for clock drift) or 0. Steps <= last are refused, so a code works once.
async function checkTotp(secret, code, last) {
  if (!/^\d{6}$/.test(String(code || ''))) return 0;
  const cur = Math.floor(Date.now() / 30000);
  for (const s of [cur - 1, cur, cur + 1]) if (s > last && safeEq(await totpAt(secret, s), String(code))) return s;
  return 0;
}
// 2FA secrets are encrypted at rest with a key derived from PW_PEPPER, so a database dump alone can't mint codes.
async function sealKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('totp|' + env.PW_PEPPER));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), enc.encode(text));
  return hex(iv) + ':' + hex(ct);
}
async function unseal(env, blob) {
  const [iv, ct] = blob.split(':').map((x) => new Uint8Array(x.match(/../g).map((b) => parseInt(b, 16))));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await sealKey(env), ct));
}
async function currentUser(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  return env.DB.prepare('SELECT u.id, u.email, u.created, u.verified, u.role, (u.totp_secret IS NOT NULL) AS has2fa, s.mfa FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?')
    .bind(await sha256(t), now()).first();
}

async function readBody(req) { // JSON or form-encoded, whatever the Content-Type says (JUCE apps label JSON bodies as form data)
  try {
    const t = await req.text();
    try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch {}
    return Object.fromEntries(new URLSearchParams(t));
  } catch { return {}; }
}

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
  const u = await env.DB.prepare('SELECT id, pw_hash, salt, totp_secret, totp_last FROM users WHERE email=?').bind(email).first();
  const hash = await hashPw(env, pw, u ? u.salt : 'no-user-' + email); // same work either way, no user enumeration by timing
  if (!u || !safeEq(hash, u.pw_hash)) return json(h, 401, { error: 'Wrong Email Or Password.' });
  let mfa = 0;
  if (u.totp_secret) { // 2FA on: the password alone never gets a session. Code guesses share the 8-per-15-min email limit.
    if (!b.code) return json(h, 401, { mfa: true, error: 'Enter The 6-Digit Code From Your Authenticator App.' });
    const step = await checkTotp(await unseal(env, u.totp_secret), b.code, u.totp_last);
    if (!step) return json(h, 401, { mfa: true, error: 'Wrong Or Expired Code.' });
    await env.DB.prepare('UPDATE users SET totp_last=? WHERE id=?').bind(step, u.id).run();
    mfa = 1;
  }
  await clearHits(env, 'em:' + email);
  return json(h, 200, { token: await newSession(env, u.id, mfa) });
}

async function me(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const { results } = await env.DB.prepare(`SELECT p.product, p.created, p.license_key, p.status,
      (SELECT COUNT(*) FROM instances i WHERE i.license_key=p.license_key) AS used
    FROM purchases p WHERE ${owns(env)} ORDER BY p.created DESC`).bind(u.id, u.email).all();
  results.forEach((r) => { r.limit = ACTIVATION_LIMIT; });
  return json(h, 200, { id: u.id, email: u.email, created: u.created, verified: !!u.verified || !env.RESEND_API_KEY, mail: !!env.RESEND_API_KEY,
    owner: u.role === 'owner', has2fa: !!u.has2fa, mfa: !!u.mfa, purchases: results });
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
  return setPassword(env, h, u.id, String(b.password || ''), u.mfa);
}
async function setPassword(env, h, userId, pw, mfa = 0) {
  const weak = await weakPassword(pw);
  if (weak) return json(h, 400, { error: weak });
  const salt = rand(16);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash=?, salt=? WHERE id=?').bind(await hashPw(env, pw, salt), salt, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId), // log out everywhere
  ]);
  return json(h, 200, { token: await newSession(env, userId, mfa) });
}

// Buyer frees every computer on one of their keys (lost / reset PC). Once per RESET_DAYS so a shared key can't rotate freely.
async function freeComputers(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const key = String((await readBody(req)).license_key || '');
  const p = await env.DB.prepare(`SELECT reset_at FROM purchases p WHERE ${owns(env)} AND p.license_key=?3`).bind(u.id, u.email, key).first();
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

// ---- Owner panel. Every route checks role='owner' in the DB AND a session that passed 2FA. ----
async function owner(env, req, needMfa = true) {
  const u = await currentUser(env, req);
  if (!u || u.role !== 'owner') return null; // normal users get a plain 404, the panel doesn't exist for them
  if (needMfa && !u.mfa) return 'mfa';
  return u;
}
const notFound = (h) => json(h, 404, { error: 'Not Found' });
const logAdmin = (env, u, action, detail) =>
  env.DB.prepare('INSERT INTO admin_log(at,user_id,action,detail) VALUES(?,?,?,?)').bind(now(), u.id, action, JSON.stringify(detail)).run();

async function admin2faStart(env, h, req) {
  const u = await owner(env, req, false);
  if (!u) return notFound(h);
  if (u.has2fa) return json(h, 409, { error: '2FA Is Already On.' });
  const secret = newTotpSecret();
  await env.DB.prepare('UPDATE users SET totp_pending=? WHERE id=?').bind(await seal(env, secret), u.id).run();
  const uri = `otpauth://totp/Koumakan%20Digital:Owner?secret=${secret}&issuer=Koumakan%20Digital&digits=6&period=30`;
  return json(h, 200, { secret, uri });
}
async function admin2faConfirm(env, h, req) {
  const u = await owner(env, req, false);
  if (!u) return notFound(h);
  if (await hit(env, 'mfa:' + u.id, 5)) return json(h, 429, { error: TOO_MANY });
  const row = await env.DB.prepare('SELECT totp_pending FROM users WHERE id=?').bind(u.id).first();
  if (!row.totp_pending) return json(h, 400, { error: 'Start 2FA Setup First.' });
  const step = await checkTotp(await unseal(env, row.totp_pending), (await readBody(req)).code, 0);
  if (!step) return json(h, 400, { error: 'Wrong Code. Check Your Phone Clock And Try Again.' });
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET totp_secret=totp_pending, totp_pending=NULL, totp_last=? WHERE id=?').bind(step, u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id), // every old password-only login dies
  ]);
  await logAdmin(env, u, '2fa_on', {});
  return json(h, 200, { token: await newSession(env, u.id, 1) });
}
async function adminList(env, h, req) {
  const u = await owner(env, req);
  if (u === 'mfa') return json(h, 403, { error: 'Turn On 2FA To Use The Owner Panel.' });
  if (!u) return notFound(h);
  const q = normEmail(new URL(req.url).searchParams.get('q')).slice(0, 200);
  const { results } = await env.DB.prepare(`SELECT p.email, p.product, p.txn_id, p.license_key, p.status, p.created,
      (SELECT COUNT(*) FROM instances i WHERE i.license_key=p.license_key) AS used
    FROM purchases p WHERE ?1='' OR p.email LIKE '%'||?1||'%' OR p.license_key=UPPER(?1) ORDER BY p.created DESC LIMIT 200`).bind(q).all();
  const stats = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM purchases WHERE txn_id NOT LIKE 'comp_%') AS sales,
      (SELECT COUNT(*) FROM purchases WHERE txn_id LIKE 'comp_%') AS comps,
      (SELECT COUNT(*) FROM purchases WHERE status!='active') AS disabled`).first();
  return json(h, 200, { purchases: results, stats });
}
// Free key ("comp"). With an email it shows up in that person's account; blank email = an unclaimed code
// she hands out (Cash App sales) that works in the Hub right away or gets attached to an account via /redeem.
// Free key ("comp") for any email; shows up in that person's account once their email is verified.
async function adminGrant(env, h, req) {
  const u = await owner(env, req);
  if (u === 'mfa') return json(h, 403, { error: 'Turn On 2FA To Use The Owner Panel.' });
  if (!u) return notFound(h);
  const b = await readBody(req), email = normEmail(b.email), product = String(b.product || '');
  if (email && !validEmail(email)) return json(h, 400, { error: 'Enter A Real Email Address, Or Leave It Blank For A Code.' });
  if (!PRODUCT_IDS[product]) return json(h, 400, { error: 'Pick A Plugin.' });
  const key = newKey(), txn = 'comp_' + rand(8);
  await env.DB.prepare('INSERT INTO purchases(txn_id,product,email,user_id,created,license_key) VALUES(?,?,?,NULL,?,?)')
    .bind(txn, product, email, now(), key).run();
  await logAdmin(env, u, 'grant', { email, product, txn });
  return json(h, 200, { license_key: key });
}
async function adminSetStatus(env, h, req) {
  const u = await owner(env, req);
  if (u === 'mfa') return json(h, 403, { error: 'Turn On 2FA To Use The Owner Panel.' });
  if (!u) return notFound(h);
  const b = await readBody(req), key = String(b.license_key || '').toUpperCase(), status = b.active ? 'active' : 'disabled';
  const r = await env.DB.prepare('UPDATE purchases SET status=? WHERE license_key=?').bind(status, key).run();
  if (!r.meta.changes) return json(h, 404, { error: 'No Such Key.' });
  if (status === 'disabled') await env.DB.prepare('DELETE FROM instances WHERE license_key=?').bind(key).run();
  await logAdmin(env, u, status === 'active' ? 'restore' : 'revoke', { key });
  return json(h, 200, { ok: true });
}

// Buyer attaches an unclaimed code (made in the owner panel) to their account. Each code can be claimed once.
// ---- Keygen codes (Y8ALL- homie, YBETA- beta) also redeem on the website: one code box everywhere. ----
// Same check as the plugins / keygen.ps1: RSA public key (e=3), 7 chained SHA-256 blocks read little-endian.
const Y8_N = BigInt('0x8014b08faf51d07e88168b92645658897cf37076e7ca6f9f0137cbdd4c9034549e3c0792c508bb1f5615dd90b5820748c8bffe695068052bee174c158f6ed409658b176f9af91e3709fa9497b28ec299c8dac6ad82919b97d8b3cae79afa80aa324f562aadc6c4120e560d630fcfc4ce3bee92792863c872ca99539d51fd0360d796e90d9cf3367ab0abc3f080c06707ad65ce5862437c0cf13998ad8af138443e79324e861571d0bcd0ffdb15549ca03516d25f379e6fddb3e58b1d3aaefdddf4c0e254a45e883c597d437754e4ec6fa7db15a84da8211775ac351233c3d1ed386ea5391caaf87e6216894e4eac642ae4d747e10dbdc692b924ebed537230bf');
const Y8_KINDS = { 'Y8ALL-': { tag: 'Y8ALLv1', product: 'all', list: 'hub/codes.txt' }, 'YBETA-': { tag: 'YBETAv1', product: 'beta', list: 'hub/beta.txt' } };
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
async function y8Hash(payload) {
  const all = [];
  for (let i = 0; i < 7; i++) all.push(...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(i + '#y808#' + payload))));
  let v = 0n; for (let i = all.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(all[i]); // little-endian (the extra 0 byte keeps it positive)
  return v;
}
function y8Rsa(v) { let res = 0n; while (v > 0n) { res = res * Y8_N + modPow(v % Y8_N, 3n, Y8_N); v /= Y8_N; } return res; }
async function y8Verify(code) { // -> {kind, id, anyPc} or null
  const prefix = Object.keys(Y8_KINDS).find((p) => code.startsWith(p)); if (!prefix) return null;
  const body = code.slice(prefix.length), dot = body.lastIndexOf('.'); if (dot < 1) return null;
  let payload; try { payload = new TextDecoder().decode(Uint8Array.from(atob(body.slice(0, dot)), (c) => c.charCodeAt(0))); } catch { return null; }
  let sig; try { sig = BigInt('0x' + body.slice(dot + 1)); } catch { return null; }
  const f = payload.split('|'); if (f[0] !== Y8_KINDS[prefix].tag || y8Rsa(sig) !== await y8Hash(payload)) return null;
  const id = ((f[1] || '').match(/#([A-Z0-9]{6})\s*$/) || [])[1];
  return { kind: Y8_KINDS[prefix], id, anyPc: (f[3] || '').split(',').includes('*') };
}
async function y8Live(list, id) { // the keygen turns codes off by deleting their ID from these lists
  const r = await fetch('https://raw.githubusercontent.com/RemiliaBandxz/youkai808-releases/main/' + list, { cf: { cacheTtl: 60 } });
  return r.ok && (await r.text()).split(/\r?\n/).includes(id);
}

async function redeem(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  if (await hit(env, 'rd:' + u.id, 10)) return json(h, 429, { error: TOO_MANY });
  const raw = String((await readBody(req)).code || '').replace(/\s/g, '');
  if (/^(Y8ALL|YBETA)-/i.test(raw)) {
    const y = await y8Verify(raw.replace(/^[a-z0-9]+-/i, (m) => m.toUpperCase()));
    if (!y || !y.id) return json(h, 400, { error: 'That Code Is Wrong.' });
    if (!y.anyPc) return json(h, 400, { error: 'That Code Is Locked To One Computer. Paste It In The Hub On That Computer.' });
    if (!await y8Live(y.kind.list, y.id)) return json(h, 400, { error: 'That Code Was Turned Off.' });
    const txn = 'y8_' + y.id; // one account per code
    await env.DB.prepare('INSERT OR IGNORE INTO purchases(txn_id,product,email,user_id,created,license_key) VALUES(?,?,?,?,?,?)')
      .bind(txn, y.kind.product, u.email, u.id, now(), 'KD-' + (await sha256('y8|' + raw)).slice(0, 32).toUpperCase().match(/.{8}/g).join('-')).run();
    const mine = await env.DB.prepare('SELECT user_id FROM purchases WHERE txn_id=?').bind(txn).first();
    return mine && mine.user_id === u.id ? json(h, 200, { ok: true }) : json(h, 400, { error: 'That Code Is Already Used.' });
  }
  const key = raw.toUpperCase();
  const r = await env.DB.prepare("UPDATE purchases SET user_id=?, email=? WHERE license_key=? AND user_id IS NULL AND email='' AND status='active'")
    .bind(u.id, u.email, key).run();
  if (!r.meta.changes) return json(h, 400, { error: 'That Code Is Wrong Or Already Used.' });
  return json(h, 200, { ok: true });
}

// ---- Hub app login, device-code style: the Hub never sees a password, Turnstile or 2FA code. ----
// 1) Hub POST /hub/start -> {device_code, user_code, verify_url}; opens verify_url in the browser.
// 2) Buyer (logged in on the website) presses Connect -> POST /hub/approve {user_code}.
// 3) Hub POST /hub/poll {device_code} every 5s -> 202 {pending} until approved, then {token}. Then GET /me with it.
async function hubStart(env, h, req) {
  if (await hit(env, 'hub:' + (req.headers.get('CF-Connecting-IP') || ''), 20)) return json(h, 429, { error: TOO_MANY });
  const device = rand(), code = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31]).join('');
  const user_code = code.slice(0, 4) + '-' + code.slice(4);
  await env.DB.prepare('INSERT INTO hub_links(device_hash,user_code,user_id,expires) VALUES(?,?,NULL,?)').bind(await sha256(device), user_code, now() + 600).run();
  return json(h, 200, { device_code: device, user_code, verify_url: env.SITE_ORIGIN + '/account/#hub=' + user_code, interval: 5, expires_in: 600 });
}
async function hubApprove(env, h, req) {
  const u = await currentUser(env, req);
  if (!u) return json(h, 401, { error: 'Not Logged In.' });
  const code = String((await readBody(req)).user_code || '').toUpperCase();
  const r = await env.DB.prepare('UPDATE hub_links SET user_id=? WHERE user_code=? AND user_id IS NULL AND expires>?').bind(u.id, code, now()).run();
  if (!r.meta.changes) return json(h, 400, { error: 'That Hub Code Expired. Hit Log In Again In The Hub.' });
  return json(h, 200, { ok: true });
}
async function hubPoll(env, h, req) {
  const hash = await sha256(String((await readBody(req)).device_code || ''));
  const row = await env.DB.prepare('SELECT user_id, expires FROM hub_links WHERE device_hash=?').bind(hash).first();
  if (!row || row.expires < now()) return json(h, 410, { error: 'Expired. Start Again.' });
  if (!row.user_id) return json(h, 202, { pending: true });
  await env.DB.prepare('DELETE FROM hub_links WHERE device_hash=?').bind(hash).run(); // one token per approval
  return json(h, 200, { token: await newSession(env, row.user_id) });
}

// ---- Sign in with GitHub / Google / Discord / Microsoft (OAuth). A provider is on once its <NAME>_ID and
// <NAME>_SECRET are set on the Worker. Accounts link by VERIFIED email only. ----
const OAUTH = {
  github: { auth: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user user:email',
    async email(at) {
      const r = await fetch('https://api.github.com/user/emails', { headers: { Authorization: 'Bearer ' + at, 'User-Agent': 'koumakan-accounts', Accept: 'application/vnd.github+json' } });
      const e = (await r.json()).find?.((x) => x.primary && x.verified);
      return e && e.email;
    } },
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email',
    async email(at) {
      const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + at } })).json();
      return u.email_verified === true && u.email;
    } },
  discord: { auth: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token', scope: 'identify email',
    async email(at) {
      const u = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + at } })).json();
      return u.verified === true && u.email;
    } },
  // 'consumers' = personal Microsoft accounts only: their email is the sign-in address, so it's verified. Work/school accounts aren't.
  microsoft: { auth: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', scope: 'openid email',
    async email(at) {
      const u = await (await fetch('https://graph.microsoft.com/oidc/userinfo', { headers: { Authorization: 'Bearer ' + at } })).json();
      return u.email;
    } },
};
const oauthOn = (env, p) => OAUTH[p] && env[p.toUpperCase() + '_ID'] && env[p.toUpperCase() + '_SECRET'];
const oauthProviders = (env, h) => json(h, 200, { providers: Object.keys(OAUTH).filter((p) => oauthOn(env, p)) });
const back = (env, frag, cookie) => new Response(null, { status: 302, headers: { ...SECURE, Location: env.SITE_ORIGIN + '/account/#' + frag,
  'Set-Cookie': cookie || 'kd_oauth=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0' } });
async function oauth(env, req, p, step) {
  const url = new URL(req.url), redirect = url.origin + '/oauth/' + p + '/callback', P = p.toUpperCase();
  if (step === 'start') {
    const state = rand(16);
    const q = new URLSearchParams({ client_id: env[P + '_ID'], redirect_uri: redirect, response_type: 'code', scope: OAUTH[p].scope, state });
    if (p === 'google') q.set('prompt', 'select_account');
    // state lives in an HttpOnly cookie on this Worker, so a callback started in someone else's browser is refused (login CSRF)
    return new Response(null, { status: 302, headers: { ...SECURE, Location: OAUTH[p].auth + '?' + q,
      'Set-Cookie': `kd_oauth=${p}.${state}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
  }
  const fail = (msg) => back(env, 'oautherr=' + encodeURIComponent(msg));
  const cookie = ((req.headers.get('Cookie') || '').match(/(?:^|;\s*)kd_oauth=([^;]+)/) || [])[1] || '';
  if (url.searchParams.get('error')) return fail('Sign-In Was Cancelled Or Blocked (' + url.searchParams.get('error').slice(0, 40) + ').');
  if (!url.searchParams.get('code')) return fail('Sign-In Expired. Try Again.');
  if (!safeEq(cookie, p + '.' + (url.searchParams.get('state') || ''))) return fail(cookie ? 'Sign-In Expired. Try Again.' : 'Your Browser Blocked The Sign-In Cookie. Try Again.');
  if (await hit(env, 'oa:' + (req.headers.get('CF-Connecting-IP') || ''), 20)) return fail(TOO_MANY);
  const tr = await fetch(OAUTH[p].token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env[P + '_ID'], client_secret: env[P + '_SECRET'], code: url.searchParams.get('code'), redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const at = tr.ok && (await tr.json()).access_token;
  const email = normEmail(at && (await OAUTH[p].email(at)));
  if (!validEmail(email)) return fail('That Account Has No Verified Email. Use Email Sign-Up Instead.');
  let u = await env.DB.prepare('SELECT id, verified, totp_secret FROM users WHERE email=?').bind(email).first();
  if (u && u.totp_secret) return fail('This Account Uses 2FA. Log In With Email, Password And Your Code.');
  if (!u) {
    u = { id: crypto.randomUUID() };
    await env.DB.prepare("INSERT INTO users(id,email,pw_hash,salt,created,verified) VALUES(?,?,'!',?,?,1)").bind(u.id, email, rand(16), now()).run();
  } else if (!u.verified) {
    // Someone may have signed up with this email without owning it: the provider proves ownership, so wipe their password + sessions.
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET verified=1, pw_hash='!', salt=? WHERE id=?").bind(rand(16), u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id),
    ]);
  }
  const t = rand(); // one-time handoff code (2 min) instead of putting a session token in the URL
  await env.DB.prepare("INSERT INTO tokens(token_hash,user_id,kind,expires) VALUES(?,?,'oauth',?)").bind(await sha256(t), u.id, now() + 120).run();
  return back(env, 'oauth=' + t);
}
async function oauthFinish(env, h, req) {
  const id = await useToken(env, (await readBody(req)).token, 'oauth');
  if (!id) return json(h, 400, { error: 'Sign-In Expired. Try Again.' });
  return json(h, 200, { token: await newSession(env, id) });
}

const ROUTES = { '/signup': signup, '/login': login, '/logout': logout, '/me': me,
  '/password': changePassword, '/free-computers': freeComputers, '/forgot': forgot, '/reset': reset,
  '/verify': verify, '/resend-verify': resendVerify, '/redeem': redeem,
  '/oauth/providers': oauthProviders, '/oauth/finish': oauthFinish,
  '/hub/start': hubStart, '/hub/approve': hubApprove, '/hub/poll': hubPoll,
  '/admin/2fa/start': admin2faStart, '/admin/2fa/confirm': admin2faConfirm, '/admin/list': adminList,
  '/admin/grant': adminGrant, '/admin/status': adminSetStatus };
const GETS = new Set(['/me', '/admin/list', '/oauth/providers']);

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname, h = cors(env, req);
    try {
      if (path === '/paddle-webhook' && req.method === 'POST') return await paddleWebhook(env, req);
      const lic = path.match(/^\/v1\/licenses\/(activate|validate|deactivate)$/);
      if (lic && req.method === 'POST') return await licenseApi(env, req, lic[1]);
      const oa = path.match(/^\/oauth\/(\w+)\/(start|callback)$/);
      if (oa && req.method === 'GET') return oauthOn(env, oa[1]) ? await oauth(env, req, oa[1], oa[2]) : back(env, 'oautherr=' + encodeURIComponent('That Sign-In Is Not Set Up Yet.'));
    } catch (e) { console.error(e); return new Response('error', { status: 500, headers: SECURE }); }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const fn = ROUTES[path];
    if (!fn) return json(h, 404, { error: 'Not Found' });
    if (GETS.has(path) !== (req.method === 'GET')) return json(h, 405, { error: 'Wrong Method' });
    try { return await fn(env, h, req); } catch (e) { console.error(e); return json(h, 500, { error: 'Something Broke On Our End. Try Again.' }); }
  },
  async scheduled(_, env) { // daily cleanup of expired rows
    await env.DB.batch([...['sessions', 'tokens', 'hub_links'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE expires<?`).bind(now())),
      env.DB.prepare('DELETE FROM attempts WHERE window_start<?').bind(now() - FAIL_WINDOW)]);
  },
};
