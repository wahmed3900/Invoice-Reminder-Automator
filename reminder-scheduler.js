// Hourly reminder engine: escalates through 5 stages per open invoice.
const prisma = require('./src/lib/prisma');
const { sendReminderEmail } = require('./email.service');
const { sendWhatsAppReminder } = require('./src/services/whatsapp.service');
const { getUserPlan, getLimits } = require('./src/middleware/subscription');

// Days relative to dueDate that trigger each stage (negative = before due)
const STAGES = [
  { stage: 1, label: 'upcoming-7d',  daysFromDue: -7 },
  { stage: 2, label: 'due-tomorrow', daysFromDue: -1 },
  { stage: 3, label: 'overdue-3d',   daysFromDue: 3 },
  { stage: 4, label: 'overdue-7d',   daysFromDue: 7 },
  { stage: 5, label: 'final-14d',    daysFromDue: 14 },
];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function sendStageReminder(invoice, stage, plan) {
  const emailResult = await sendReminderEmail(invoice, invoice.client, stage.stage);

  if (invoice.client.phone && plan === 'PRO') {
    await sendWhatsAppReminder(invoice, invoice.client, stage.stage);
  }

  await prisma.reminder.create({
    data: {
      invoiceId: invoice.id,
      type: stage.label,
      status: emailResult.success ? 'SENT' : 'FAILED',
      error: emailResult.success ? null : (emailResult.error || null),
    },
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { reminderSent: true, reminderCount: { increment: 1 }, reminderStage: stage.stage },
  });

  console.log(`[scheduler] stage ${stage.stage} (${stage.label}) — ${emailResult.success ? 'sent' : 'failed'} for ${invoice.invoiceNumber}`);
  return emailResult.success;
}

// Pass { userId } to limit the run to one user's invoices (manual "run now" button)
async function runReminderCycle({ userId } = {}) {
  console.log('[scheduler] running cycle', new Date().toISOString(), userId ? `(user ${userId})` : '');

  // OVERDUE must be included — otherwise stages 3–5 never fire once an invoice
  // has been flipped to OVERDUE (the old version only queried PENDING).
  const where = { status: { in: ['PENDING', 'OVERDUE'] } };
  if (userId) where.userId = userId;

  const open = await prisma.invoice.findMany({ where, include: { client: true, user: true } });
  const now = new Date();
  let sent = 0;
  let skipped = 0;

  for (const invoice of open) {
    try {
      const due = new Date(invoice.dueDate);

      if (now > due && invoice.status === 'PENDING') {
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'OVERDUE' } });
      }

      // Automatic reminders are a Pro feature per PLANS
      const plan = getUserPlan(invoice.user);
      if (!getLimits(plan).autoReminders || !invoice.client) {
        skipped++;
        continue;
      }

      const currentStage = invoice.reminderStage || 0;
      for (let i = STAGES.length - 1; i >= 0; i--) {
        const s = STAGES[i];
        if (s.stage <= currentStage) break;
        if (now >= addDays(due, s.daysFromDue)) {
          if (await sendStageReminder(invoice, s, plan)) sent++;
          break; // one stage per cycle
        }
      }
    } catch (err) {
      // One bad invoice shouldn't stop everyone else's reminders
      console.error(`[scheduler] invoice ${invoice.id} failed:`, err.message);
    }
  }

  console.log(`[scheduler] cycle done — ${open.length} open, ${sent} sent, ${skipped} skipped (free plan)`);
  return { checked: open.length, sent, skipped };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  console.log('[scheduler] starting — checks every hour');
  const tick = () => runReminderCycle().catch((err) => console.error('[scheduler] cycle failed:', err));
  tick();
  timer = setInterval(tick, 60 * 60 * 1000);
}

if (require.main === module && process.argv.includes('--once')) {
  runReminderCycle()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}

module.exports = { startScheduler, runReminderCycle };
