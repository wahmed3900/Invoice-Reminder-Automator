# Invoice Reminder Automator

Automates invoice payment reminders to clients via email and WhatsApp, with
Google sign-in, Stripe billing (Free/Pro plans, including a $5-for-5-weeks
intro offer), and an in-app AI assistant for answering questions about your
invoices and clients.

## Stack

- **Express** API server (`server.js`)
- **MongoDB** via **Prisma** (`prisma/schema.prisma`)
- **Google OAuth 2.0** + JWT session tokens (`src/middleware/auth.js`)
- **Stripe** for billing — Checkout, Billing Portal, and webhooks
  (`src/lib/stripe.js`, `src/services/stripe-webhook.js`)
- **Nodemailer** for email reminders (`email.service.js`)
- **Twilio WhatsApp** for Pro-tier WhatsApp reminders (`src/services/whatsapp.service.js`)
- **OpenRouter** for the in-app AI chat assistant (`src/services/ai-chat.service.js`)
- Hourly reminder scheduler, 5 escalation stages per invoice (`reminder-scheduler.js`)

## Setup

```bash
npm install          # also runs `prisma generate` via postinstall
cp .env.example .env # fill in real values — see below
npm start
```

### Required environment variables

See `.env.example` for the full list and where to get each value. At minimum,
to boot locally you need `DATABASE_URL` (a MongoDB connection string) and
`JWT_SECRET`. Google login, Stripe billing, email, WhatsApp, and AI chat each
degrade gracefully (the relevant routes return a clear error) until their
own env vars are set — the server still boots without them.

### Stripe setup

1. Create your Pro plan's recurring Price in the Stripe dashboard, set its ID
   as `STRIPE_PRO_PRICE_ID`.
2. Run `npm run setup:trial-price` to create the $5-for-5-weeks intro Price on
   the same product, and set the printed ID as `STRIPE_TRIAL_PRICE_ID`.
3. Add a webhook endpoint in Stripe pointing at `/webhooks/stripe`, set its
   signing secret as `STRIPE_WEBHOOK_SECRET`.
4. To start the intro offer from your frontend, call
   `POST /api/subscription/checkout` with body `{ "trialOffer": true }`
   instead of `{}`.

### Running the reminder scheduler manually

```bash
npm run reminders:once   # one pass, then exits (useful for a cron job / testing)
```

## Deploying

`render.yaml` is set up for Render (free tier) with a self-ping keep-alive
(`src/services/keep-alive.js`) so the service doesn't sleep. Set all the
`sync: false` env vars in the Render dashboard (Environment tab) — never in
`render.yaml` itself, since that file is committed to this repo.

## Security

Known vulnerabilities (free Pro upgrade bypass, IDOR on clients/invoices,
unauthenticated user listing, mass assignment, a broken Stripe webhook route
ordering, and a scheduler that never re-checked already-overdue invoices)
were found and fixed — see `invoice-automator-security-fixes.patch` for the
original diff. All of those fixes are already applied in this codebase.
