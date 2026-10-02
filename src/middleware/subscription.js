const prisma = require('../lib/prisma');

const PLANS = {
  FREE: { maxClients: 5, maxInvoices: 10, autoReminders: false },
  PRO:  { maxClients: Infinity, maxInvoices: Infinity, autoReminders: true },
};

function getLimits(plan) {
  return PLANS[plan] ?? PLANS.FREE;
}

// JSON has no Infinity — it silently serializes to `null`, which looks like
// a bug/missing value to an API consumer. Make "no limit" an explicit,
// documented `null` instead of an accidental one wherever limits leave the
// server as JSON. Internal comparisons (limitCheck below) keep using the
// real Infinity value, untouched.
function toPublicLimits(limits) {
  const out = {};
  for (const [key, value] of Object.entries(limits)) {
    out[key] = value === Infinity ? null : value;
  }
  return out;
}

function toPublicPlans(plans) {
  const out = {};
  for (const [name, limits] of Object.entries(plans)) out[name] = toPublicLimits(limits);
  return out;
}

// The plan a user record actually entitles them to right now
function getUserPlan(user) {
  if (!user) return 'FREE';
  const expired = user.proExpiresAt && new Date(user.proExpiresAt) <= new Date();
  return user.subscription === 'PRO' && !expired ? 'PRO' : 'FREE';
}

// Plan is read from the DATABASE on every check, never from the JWT.
// The token's `subscription` claim goes stale the moment Stripe changes the plan.
async function loadPlan(req) {
  if (req.plan) return req.plan;
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { subscription: true, proExpiresAt: true },
  });
  req.plan = getUserPlan(user);
  return req.plan;
}

function limitCheck(model, limitKey, label) {
  return async (req, res, next) => {
    try {
      const limits = getLimits(await loadPlan(req));
      if (limits[limitKey] === Infinity) return next();

      const count = await prisma[model].count({ where: { userId: req.user.userId } });
      if (count >= limits[limitKey]) {
        return res.status(403).json({
          error: `Free plan is limited to ${limits[limitKey]} ${label}. Upgrade to Pro for unlimited.`,
          upgradeRequired: true,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

const checkInvoiceLimit = limitCheck('invoice', 'maxInvoices', 'invoices');
const checkClientLimit = limitCheck('client', 'maxClients', 'clients');

async function requirePro(req, res, next) {
  try {
    if ((await loadPlan(req)) !== 'PRO') {
      return res.status(403).json({ error: 'This feature requires a Pro subscription.', upgradeRequired: true });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  PLANS, getLimits, getUserPlan, loadPlan, checkInvoiceLimit, checkClientLimit, requirePro,
  toPublicLimits, toPublicPlans,
};
