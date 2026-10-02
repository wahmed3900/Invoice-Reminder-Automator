// Stripe webhook: the ONLY place a user's plan changes, and where invoices get auto-marked PAID.
// Must be mounted with express.raw() BEFORE express.json() — see server.js.
const prisma = require('../lib/prisma');
const { getStripe } = require('../lib/stripe');

const OBJECT_ID = /^[a-f0-9]{24}$/i;
// past_due keeps Pro while Stripe retries the card; canceled/unpaid/incomplete_expired drop to Free
const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);

async function syncPlanFromSubscription(sub) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return;

  const plan = PRO_STATUSES.has(sub.status) ? 'PRO' : 'FREE';
  const { count } = await prisma.user.updateMany({
    where: { stripeCustomerId: customerId },
    data: { subscription: plan, stripeSubscriptionId: sub.id, proExpiresAt: null },
  });

  if (count === 0) console.warn(`[stripe] no user for customer ${customerId} (subscription ${sub.id})`);
  else console.log(`[stripe] customer ${customerId} → ${plan} (${sub.status})`);
}

async function markInvoicePaid(invoiceId) {
  if (!invoiceId || !OBJECT_ID.test(invoiceId)) return;
  // updateMany + status filter makes Stripe's duplicate deliveries harmless
  const { count } = await prisma.invoice.updateMany({
    where: { id: invoiceId, status: { not: 'PAID' } },
    data: { status: 'PAID', paidDate: new Date() },
  });
  if (count) console.log(`[stripe] invoice ${invoiceId} marked PAID`);
}

async function handleStripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers['stripe-signature'];

  if (!secret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });
  if (!signature) return res.status(400).json({ error: 'Missing Stripe-Signature header' });
  if (!Buffer.isBuffer(req.body)) {
    console.error('[stripe] body was already parsed — webhook route must be mounted before express.json()');
    return res.status(500).json({ error: 'Webhook misconfigured' });
  }

  // constructEvent checks the HMAC against the exact raw bytes AND rejects
  // timestamps older than 5 minutes (replay protection)
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, signature, secret);
  } catch (err) {
    console.warn('[stripe] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid Stripe signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await getStripe().subscriptions.retrieve(session.subscription);
          await syncPlanFromSubscription(sub);
        } else if (session.mode === 'payment' && session.payment_status === 'paid') {
          await markInvoicePaid(session.metadata?.invoiceId);
        }
        break;
      }

      case 'payment_intent.succeeded':
        await markInvoicePaid(event.data.object.metadata?.invoiceId);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncPlanFromSubscription(event.data.object);
        break;

      default:
        break; // ignore everything else
    }
    res.json({ received: true });
  } catch (err) {
    // 500 makes Stripe retry the event later instead of silently dropping it
    console.error(`[stripe] failed handling ${event.type} (${event.id}):`, err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = { handleStripeWebhook };
