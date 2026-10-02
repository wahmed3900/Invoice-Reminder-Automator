// RECONSTRUCTED — referenced by server.js but missing from the uploaded repo.
// Best-guess implementation inferred from its call sites and the
// ChatSession/ChatMessage models in prisma/schema.prisma:
//   aiChat.chat(userId, sessionId | null, message) -> { sessionId, reply }
//   aiChat.getSessions(userId)                     -> ChatSession[]
//   aiChat.getHistory(userId, sessionId)           -> ChatMessage[]
// This repo started life as "openrouter-backend" (see the dependency history
// in invoice-automator-security-fixes.patch), so this talks to OpenRouter's
// chat-completions API rather than a provider SDK.
const prisma = require('../lib/prisma');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const HISTORY_LIMIT = 20; // messages of context sent to the model

const SYSTEM_PROMPT =
  'You are the in-app assistant for an invoice reminder tool. Help the user ' +
  'understand their invoices, clients and reminder status. Be concise.';

async function getOrCreateSession(userId, sessionId) {
  if (sessionId) {
    const existing = await prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (existing) return existing;
  }
  return prisma.chatSession.create({ data: { userId } });
}

async function chat(userId, sessionId, message) {
  const session = await getOrCreateSession(userId, sessionId);

  await prisma.chatMessage.create({
    data: { sessionId: session.id, role: 'user', content: message },
  });

  const recent = await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
    take: HISTORY_LIMIT,
  });

  if (!process.env.OPENROUTER_API_KEY) {
    const reply = "AI chat isn't configured yet (missing OPENROUTER_API_KEY).";
    await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'assistant', content: reply } });
    return { sessionId: session.id, reply };
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recent.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "Sorry, I didn't get a response.";

  await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'assistant', content: reply } });

  return { sessionId: session.id, reply };
}

function getSessions(userId) {
  return prisma.chatSession.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } });
}

async function getHistory(userId, sessionId) {
  const session = await prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) return [];
  return prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
}

module.exports = { chat, getSessions, getHistory };
