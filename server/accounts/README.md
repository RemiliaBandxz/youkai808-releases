# Koumakan Digital accounts server

Cloudflare Worker + D1 (free tier). Powers koumakandigital.xyz/account/ and the Hub's license checks.

- Email + password accounts (PBKDF2-SHA256, salted; 30-day sessions; lockout after 8 bad tries / 15 min).
- `POST /paddle-webhook`: verifies `Paddle-Signature`, on `transaction.completed` saves the purchase and mints a `KD-` license key;
  approved refund/chargeback `adjustment.*` disables the key.
- My Plugins page shows each key, how many computers use it (limit 3), and "Free Up Computers" (once per 7 days).
- `POST /v1/licenses/{activate,validate,deactivate}`: Lemon-Squeezy-compatible, so the Hub (Y8Store.h) only needs
  `apiHost()` = `https://<worker>/v1/licenses/` and catalog `store_product_ids`: youkai808 = 808001, melodyveil = 808002.

## Deploy
1. `npx wrangler d1 create koumakan-accounts` → paste the id into wrangler.toml
2. `npx wrangler d1 execute koumakan-accounts --remote --file schema.sql`
3. `npx wrangler deploy`
4. Paddle → Developer Tools → Notifications → new destination: `https://<worker>/paddle-webhook`,
   events `transaction.completed`, `adjustment.created`, `adjustment.updated` → copy the secret →
   `npx wrangler secret put PADDLE_WEBHOOK_SECRET`
5. Optional: `wrangler secret put PADDLE_API_KEY` (links guest checkouts by email), `RESEND_API_KEY` (Forgot Password emails).
6. Put the worker URL in `docs/account/index.html` → `var API = '...'`.
