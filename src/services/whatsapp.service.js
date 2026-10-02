// RECONSTRUCTED — referenced by reminder-scheduler.js but missing from the
// uploaded repo. Best-guess implementation inferred from its call site:
//   const { sendWhatsAppReminder } = require('./src/services/whatsapp.service');
//   await sendWhatsAppReminder(invoice, invoice.client, stage.stage)   // Pro-only, best-effort
const twilio = require('twilio');

let client;
function getClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured');
  }
  if (!client) client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

async function sendWhatsAppReminder(invoice, client_, stage) {
  if (!client_?.phone) return { success: false, error: 'Client has no phone number' };
  if (!process.env.TWILIO_WHATSAPP_FROM) return { success: false, error: 'TWILIO_WHATSAPP_FROM not configured' };

  try {
    await getClient().messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${client_.phone}`,
      body: `Reminder (stage ${stage}): invoice ${invoice.invoiceNumber} — ${invoice.totalAmount} ${invoice.currency || 'USD'}, due ${new Date(invoice.dueDate).toLocaleDateString()}.`,
    });
    return { success: true };
  } catch (err) {
    // Best-effort channel — the scheduler logs this but a WhatsApp failure
    // never blocks the (already-sent) email reminder.
    console.error('[whatsapp] send failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendWhatsAppReminder };
