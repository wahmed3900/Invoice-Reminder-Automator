/**
 * One-time setup: creates the $5-for-5-weeks intro Price in Stripe, on the
 * SAME Product as your existing regular Pro price, and prints the new price
 * ID to add to your .env as STRIPE_TRIAL_PRICE_ID.
 *
 * Run once, locally, with your real Stripe secret key:
 *   node scripts/setup-trial-price.js
 *
 * Requires STRIPE_SECRET_KEY and STRIPE_PRO_PRICE_ID already set (in .env or
 * the environment) — the trial price is attached to the regular price's
 * existing Product so both show up together in the Stripe dashboard.
 */
require('dotenv').config();
const Stripe = require('stripe');

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set. Add it to .env first.');
    process.exitCode = 1;
    return;
  }
  if (!process.env.STRIPE_PRO_PRICE_ID) {
    console.error(
      'STRIPE_PRO_PRICE_ID is not set. This script attaches the trial price to your ' +
      'EXISTING Pro product, so create your regular Pro price in Stripe first, set ' +
      'STRIPE_PRO_PRICE_ID in .env, then re-run this.'
    );
    process.exitCode = 1;
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const regularPrice = await stripe.prices.retrieve(process.env.STRIPE_PRO_PRICE_ID);
  const productId = typeof regularPrice.product === 'string' ? regularPrice.product : regularPrice.product.id;
  console.log(`Found regular Pro price ${regularPrice.id} on product ${productId} (${regularPrice.unit_amount / 100} ${regularPrice.currency}/${regularPrice.recurring?.interval}).`);

  const trialPrice = await stripe.prices.create({
    product: productId,
    currency: regularPrice.currency,
    unit_amount: 500, // $5.00 — change here if you want a different intro amount
    recurring: { interval: 'week', interval_count: 5 },
    nickname: 'Pro intro offer — $5 / 5 weeks',
  });

  console.log('\nCreated trial price:', trialPrice.id);
  console.log('\nAdd this to your .env:');
  console.log(`STRIPE_TRIAL_PRICE_ID="${trialPrice.id}"`);
  console.log('\n(Remember to also set it in your Render/production env vars — see render.yaml.)');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
