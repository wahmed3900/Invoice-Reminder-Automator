require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./src/lib/prisma');
const { getStripe } = require('./src/lib/stripe');
const { passport, issueToken, requireAuth } = require('./src/middleware/auth');
const {
  checkInvoiceLimit, checkClientLimit, requirePro, getLimits, getUserPlan, PLANS,
  toPublicLimits, toPublicPlans,
} = require('./src/middleware/subscription');
const { startScheduler, runReminderCycle } = require('./reminder-scheduler');
const aiChat = require('./src/services/ai-chat.service');
const { startKeepAlive } = require('./src/services/keep-alive');
const { handleStripeWebhook } = require('./src/services/stripe-webhook');

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// FIX #5 — Stripe needs the untouched raw body to verify its signature,
// so this route is registered BEFORE express.json() runs.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json({ limit: '100kb' }));
app.use(passport.initialize());

// ==================== HELPERS ====================
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const INVOICE_STATUSES = ['PENDING', 'PAID', 'OVERDUE', 'CANCELLED'];

// FIX #4 — only these fields can ever come from the request body.
// userId, status, reminder fields, etc. are set by the server only.
const CLIENT_FIELDS = ['name', 'email', 'company', 'phone', 'address'];
const INVOICE_FIELDS = [
  'invoiceNumber', 'clientId', 'subtotal', 'taxRate', 'taxAmount', 'discount',
  'totalAmount', 'currency', 'description', 'notes', 'issueDate', 'dueDate',
];

function pick(source, fields) {
  const out = {};
  for (const f of fields) if (source?.[f] !== undefined) out[f] = source[f];
  return out;
}

// Malformed Mongo ids would make Prisma throw — treat them as "not found"
app.param('id', (req, res, next, id) => (OBJECT_ID.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

// FIX #2 — every single-record lookup is scoped to the logged-in user
const findOwnedClient = (id, userId) => prisma.client.findFirst({ where: { id, userId } });
const findOwnedInvoice = (id, userId) => prisma.invoice.findFirst({ where: { id, userId } });

async function clientBelongsToUser(clientId, userId) {
  if (typeof clientId !== 'string' || !OBJECT_ID.test(clientId)) return false;
  return Boolean(await findOwnedClient(clientId, userId));
}

// Wraps async handlers so errors reach the error middleware instead of leaking err.message
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ==================== PUBLIC ====================
app.get('/', (_req, res) => res.json({ message: 'Invoice API is working!' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/api/plans', (_req, res) => res.json(toPublicPlans(PLANS)));

// ==================== GOOGLE AUTH ====================
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failed' }),
  (req, res) => {
    const token = issueToken(req.user);
    res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}`);
  }
);

app.get('/auth/failed', (_req, res) => res.status(401).json({ error: 'Google authentication failed' }));

app.get('/api/me', requireAuth, route(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, email: true, name: true, picture: true, subscription: true, proExpiresAt: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const plan = getUserPlan(user);
  res.json({ ...user, plan, limits: toPublicLimits(getLimits(plan)) });
}));

// FIX #3 — GET /api/users (which returned every user) has been removed.

// ==================== SUBSCRIPTION ====================
// FIX #1 — the free "upgrade" and "downgrade" routes are gone. Plans now change
// ONLY when Stripe tells the webhook a subscription started, changed or ended.

// Starts a Stripe Checkout for Pro; frontend redirects the browser to `url`.
// Pass { trialOffer: true } to start on the $5/5-week intro price instead of
// the regular Pro price — the webhook (applyTrialSchedule) then schedules the
// automatic switch to the regular price after that one billing cycle.
app.post('/api/subscription/checkout', requireAuth, route(async (req, res) => {
  const trialOffer = Boolean(req.body?.trialOffer);
  const priceId = trialOffer ? process.env.STRIPE_TRIAL_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return res.status(500).json({ error: 'Billing is not configured' });

  const stripe = getStripe();
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (getUserPlan(user) === 'PRO') return res.status(400).json({ error: 'You are already on Pro' });

  // One Stripe customer per user, created up front so webhooks can always find the user
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
  }

  const metadata = { userId: user.id, trialOffer: trialOffer ? 'true' : 'false' };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${FRONTEND_URL}/billing?status=success`,
    cancel_url: `${FRONTEND_URL}/billing?status=cancelled`,
  });

  res.json({ url: session.url });
}));

// Stripe-hosted page where users cancel/downgrade or update their card
app.post('/api/subscription/portal', requireAuth, route(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { stripeCustomerId: true } });
  if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No billing account yet' });

  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${FRONTEND_URL}/billing`,
  });
  res.json({ url: session.url });
}));

// ==================== CLIENTS ====================
app.get('/api/clients', requireAuth, route(async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { userId: req.user.userId },
    include: { invoices: true },
  });
  res.json(clients);
}));

app.post('/api/clients', requireAuth, checkClientLimit, route(async (req, res) => {
  const data = pick(req.body, CLIENT_FIELDS);
  if (!data.name || !data.email) return res.status(400).json({ error: 'name and email are required' });
  const client = await prisma.client.create({ data: { ...data, userId: req.user.userId } });
  res.status(201).json(client);
}));

app.put('/api/clients/:id', requireAuth, route(async (req, res) => {
  if (!(await findOwnedClient(req.params.id, req.user.userId))) return res.status(404).json({ error: 'Client not found' });
  const client = await prisma.client.update({
    where: { id: req.params.id },
    data: pick(req.body, CLIENT_FIELDS),
  });
  res.json(client);
}));

app.delete('/api/clients/:id', requireAuth, route(async (req, res) => {
  if (!(await findOwnedClient(req.params.id, req.user.userId))) return res.status(404).json({ error: 'Client not found' });
  await prisma.client.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ==================== INVOICES ====================
app.get('/api/invoices', requireAuth, route(async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { userId: req.user.userId },
    include: { client: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invoices);
}));

// The scheduler flips past-due invoices to OVERDUE, so include both statuses
app.get('/api/invoices/overdue', requireAuth, route(async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { userId: req.user.userId, status: { in: ['PENDING', 'OVERDUE'] }, dueDate: { lt: new Date() } },
    include: { client: true },
  });
  res.json(invoices);
}));

app.get('/api/invoices/status/:status', requireAuth, route(async (req, res) => {
  const status = String(req.params.status).toUpperCase();
  if (!INVOICE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const invoices = await prisma.invoice.findMany({
    where: { userId: req.user.userId, status },
    include: { client: true },
  });
  res.json(invoices);
}));

app.get('/api/invoices/:id', requireAuth, route(async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, userId: req.user.userId },
    include: { client: true, reminders: true },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  res.json(invoice);
}));

app.post('/api/invoices', requireAuth, checkInvoiceLimit, route(async (req, res) => {
  const data = pick(req.body, INVOICE_FIELDS);
  if (!data.invoiceNumber || data.totalAmount === undefined || !data.dueDate) {
    return res.status(400).json({ error: 'invoiceNumber, totalAmount and dueDate are required' });
  }
  // Without this, a user could attach an invoice to someone else's client
  // and the scheduler would email that person.
  if (!(await clientBelongsToUser(data.clientId, req.user.userId))) {
    return res.status(400).json({ error: 'clientId does not match one of your clients' });
  }
  const invoice = await prisma.invoice.create({
    data: { ...data, userId: req.user.userId, status: 'PENDING' },
  });
  res.status(201).json(invoice);
}));

app.patch('/api/invoices/:id/status', requireAuth, route(async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!INVOICE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!(await findOwnedInvoice(req.params.id, req.user.userId))) return res.status(404).json({ error: 'Invoice not found' });

  const invoice = await prisma.invoice.update({
    where: { id: req.params.id },
    data: { status, paidDate: status === 'PAID' ? new Date() : null },
  });
  res.json(invoice);
}));

app.put('/api/invoices/:id', requireAuth, route(async (req, res) => {
  if (!(await findOwnedInvoice(req.params.id, req.user.userId))) return res.status(404).json({ error: 'Invoice not found' });
  const data = pick(req.body, INVOICE_FIELDS);
  if (data.clientId !== undefined && !(await clientBelongsToUser(data.clientId, req.user.userId))) {
    return res.status(400).json({ error: 'clientId does not match one of your clients' });
  }
  const invoice = await prisma.invoice.update({ where: { id: req.params.id }, data });
  res.json(invoice);
}));

app.delete('/api/invoices/:id', requireAuth, route(async (req, res) => {
  if (!(await findOwnedInvoice(req.params.id, req.user.userId))) return res.status(404).json({ error: 'Invoice not found' });
  await prisma.invoice.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ==================== REMINDERS ====================
app.get('/api/reminders', requireAuth, route(async (req, res) => {
  const reminders = await prisma.reminder.findMany({
    where: { invoice: { userId: req.user.userId } },
    include: { invoice: true },
  });
  res.json(reminders);
}));

// Pro only — runs a reminder pass over THIS user's invoices (not everyone's)
app.post('/api/reminders/run', requireAuth, requirePro, route(async (req, res) => {
  const result = await runReminderCycle({ userId: req.user.userId });
  res.json({ success: true, ...result });
}));

// ==================== STATISTICS ====================
app.get('/api/stats', requireAuth, route(async (req, res) => {
  const userId = req.user.userId;
  const now = new Date();
  const [totalInvoices, pendingInvoices, overdueInvoices, paidInvoices, totalRevenue] = await Promise.all([
    prisma.invoice.count({ where: { userId } }),
    prisma.invoice.count({ where: { userId, status: 'PENDING' } }),
    prisma.invoice.count({ where: { userId, status: { in: ['PENDING', 'OVERDUE'] }, dueDate: { lt: now } } }),
    prisma.invoice.count({ where: { userId, status: 'PAID' } }),
    prisma.invoice.aggregate({ where: { userId, status: 'PAID' }, _sum: { totalAmount: true } }),
  ]);
  res.json({ totalInvoices, pendingInvoices, overdueInvoices, paidInvoices, totalRevenue: totalRevenue._sum.totalAmount || 0 });
}));

// ==================== AI CHAT BOT ====================
app.post('/api/chat', requireAuth, route(async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });
  if (sessionId && !OBJECT_ID.test(sessionId)) return res.status(404).json({ error: 'Session not found' });
  const result = await aiChat.chat(req.user.userId, sessionId || null, message.trim());
  res.json(result);
}));

app.get('/api/chat/sessions', requireAuth, route(async (req, res) => {
  res.json(await aiChat.getSessions(req.user.userId));
}));

app.get('/api/chat/sessions/:sessionId', requireAuth, route(async (req, res) => {
  if (!OBJECT_ID.test(req.params.sessionId)) return res.status(404).json({ error: 'Session not found' });
  res.json(await aiChat.getHistory(req.user.userId, req.params.sessionId));
}));

// ==================== ERRORS ====================
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.code === 'P2002') return res.status(409).json({ error: 'That record already exists (duplicate value)' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startScheduler();
    startKeepAlive();
  });
}

module.exports = app;
