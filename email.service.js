// RECONSTRUCTED — referenced by reminder-scheduler.js but missing from the
// uploaded repo. Best-guess implementation inferred from its call site:
//   const { sendReminderEmail } = require('./email.service');
//   const emailResult = await sendReminderEmail(invoice, invoice.client, stage.stage)
//   -> { success: boolean, error?: string }
const nodemailer = require('nodemailer');

let transporter;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP_HOST/SMTP_USER/SMTP_PASS not configured');
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

const STAGE_COPY = {
  1: { subject: (inv) => `Upcoming: invoice ${inv.invoiceNumber} is due soon`, urgency: 'is coming up' },
  2: { subject: (inv) => `Due tomorrow: invoice ${inv.invoiceNumber}`, urgency: 'is due tomorrow' },
  3: { subject: (inv) => `Overdue: invoice ${inv.invoiceNumber}`, urgency: 'is now overdue' },
  4: { subject: (inv) => `Still overdue: invoice ${inv.invoiceNumber}`, urgency: 'is still overdue' },
  5: { subject: (inv) => `Final notice: invoice ${inv.invoiceNumber}`, urgency: 'is significantly overdue — final notice' },
};

function formatAmount(invoice) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: invoice.currency || 'USD' }).format(invoice.totalAmount);
  } catch {
    return `${invoice.totalAmount} ${invoice.currency || 'USD'}`;
  }
}

async function sendReminderEmail(invoice, client, stage) {
  if (!client?.email) return { success: false, error: 'Client has no email address' };

  const copy = STAGE_COPY[stage] || STAGE_COPY[1];
  const amount = formatAmount(invoice);
  const dueDate = new Date(invoice.dueDate).toLocaleDateString();

  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: client.email,
      subject: copy.subject(invoice),
      text:
        `Hi ${client.name || 'there'},\n\n` +
        `Invoice ${invoice.invoiceNumber} for ${amount} (due ${dueDate}) ${copy.urgency}.\n\n` +
        `${invoice.description ? invoice.description + '\n\n' : ''}` +
        `Thanks,\nYour Invoice Reminder`,
    });
    return { success: true };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendReminderEmail };
