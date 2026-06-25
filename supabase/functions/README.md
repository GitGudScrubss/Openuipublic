# OpenUI Supabase Edge Functions

These functions are the **only** place the Stripe **secret key** and the Supabase
**service-role key** ever live. The Electron app holds neither — it uses only the
Supabase **anon** key and calls these functions via `supabase.functions.invoke`.

They run on Deno (not Node), so they import from URLs (`deno.land`, `esm.sh`) and
are intentionally **excluded** from the Electron TypeScript build
(`tsconfig.json` only includes `src/`).

## Functions

| Function             | Called by            | Purpose                                                            |
| -------------------- | -------------------- | ------------------------------------------------------------------ |
| `chat-proxy`         | App (cloudFreeTier.ts) | Proxy chat to Anthropic/OpenAI on OUR keys; enforce the per-tier daily message limit (Free = 20/day). The cloud-first path that makes the app work with no local setup. |
| `create-checkout`    | App (checkout.ts)    | Create a Stripe Checkout Session, return its hosted URL.            |
| `customer-portal`    | App (checkout.ts)    | Return a Stripe Billing Portal URL (manage/cancel/invoices).       |
| `check-subscription` | App (subscriptionSync) | Return live `{ tier, status, currentPeriodEnd, customerId }`.    |
| `stripe-webhook`     | **Stripe**           | On subscription events, write `app_metadata.tier` (authoritative). |

### `chat-proxy` request contract

The app POSTs `{ messages, system, modelKey, stream }` with the user's Supabase
access token in the `Authorization: Bearer …` header. The function:

1. Verifies the token → resolves the user and their authoritative tier
   (`app_metadata.tier`).
2. Enforces the daily limit (`DAILY_LIMIT` in the function mirrors
   `src/main/stripe/pricing.ts`) against the `usage_tracking` table — over the
   limit returns **429** `{ error: 'rate_limited', remaining: 0, limit }`.
3. Gates the requested `modelKey` to the user's tier, then proxies to Anthropic
   or OpenAI. Streaming responses are **normalized** to a uniform
   `data: {"delta":"…"}` … `data: [DONE]` SSE so the client is provider-agnostic.
4. Returns `x-ratelimit-{tier,limit,remaining}` headers, which the app turns into
   the "15/20 messages today" counter.

The `usage_tracking` table is created by
`supabase/migrations/001_create_usage_tracking.sql`.

## Secrets

Set these on the Supabase project (never in the app's `.env`):

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SIGNING_SECRET=whsec_... \
  STRIPE_PRO_PRICE_ID=price_... \
  STRIPE_ENTERPRISE_PRICE_ID=price_... \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY / OPENAI_API_KEY power chat-proxy — these are OUR cloud keys,
# held only here and never shipped in the app.
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically.
```

## Deploy

```bash
# chat-proxy requires a signed-in user, so keep the default JWT verification on
# (the platform validates the access token; the function then re-derives the user
# and their tier via getUser()).
supabase functions deploy chat-proxy
supabase functions deploy create-checkout
supabase functions deploy customer-portal
supabase functions deploy check-subscription
# Stripe calls the webhook directly, so JWT verification must be disabled —
# the Stripe signature authenticates the request instead.
supabase functions deploy stripe-webhook --no-verify-jwt

# Apply the usage-tracking migration (daily message limits):
supabase db push   # or: psql "$DATABASE_URL" -f supabase/migrations/001_create_usage_tracking.sql
```

Then register the webhook endpoint in the Stripe dashboard
(`https://<project-ref>.functions.supabase.co/stripe-webhook`) for the events:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`.

## Security notes

- The webhook **verifies the Stripe signature** (`constructEventAsync`) before
  trusting any payload — it never trusts the request body alone.
- `app_metadata.tier` is the source of truth. The app's local SQLite cache is
  treated as untrusted and is only honoured for ≤ 24h when Supabase is offline.
