const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'policy.json'), 'utf8'));
const AUDIT_LOG_PATH = path.join(__dirname, 'data', 'audit-log.jsonl');
const MODEL = 'claude-sonnet-4-6';

function customerById(id) {
  return POLICY.customers.find(c => c.id === id);
}

function buildSystemPrompt(customer) {
  return `You are a customer-facing resolution agent for an airline, handling flight disruptions on ${POLICY.exerciseDate}.

You may ONLY use the data below as fact. Never invent policies, dates, amounts, or customer details that aren't given here. If something is genuinely outside this data, say you don't have that information rather than guessing.

CUSTOMER ON THE LINE:
- Name: ${customer.name}
- Loyalty tier: ${customer.tier}
- Booking reference: ${customer.pnr}
- Travel history: ${customer.history}

BOOKING DATA FOR THIS CUSTOMER:
${customer.booking}

SERVICE RULES (the only rules that exist — never invent others):
${POLICY.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

ALLOWED, without escalation:
${POLICY.allowed.map(a => `- ${a}`).join('\n')}

MUST ESCALATE to a human agent instead of acting (say so, in the tone of the samples below, and set escalate:true):
${POLICY.mustEscalate.map(a => `- ${a}`).join('\n')}

TONE REFERENCE ONLY (from unrelated past customers — not fact or policy for this case, do not reuse their specifics):
${POLICY.toneReference.map(t => `- "${t}"`).join('\n')}

Behave like a competent, warm human support agent — concise, specific, no corporate filler. Apply the rules correctly to this customer's exact situation (do the delay-hour math yourself from the booking data). If the customer asks for something the rules don't allow you to grant, do not grant it and do not argue policy at length — acknowledge the ask, explain plainly what you can do, and if it falls under a must-escalate case, tell them you're escalating it to a human specialist (matching the tone reference), and set escalate:true.

Respond ONLY with a single JSON object, no markdown fences, no commentary outside it, in exactly this shape:
{"reply": "<your message to the customer>", "escalate": true or false, "reason": "<short internal note on why, or null if escalate is false>"}`;
}

function appendAuditLog(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('audit log write failed', e);
  }
}

app.get('/api/customers', (req, res) => {
  // Never leak the system-prompt-only fields (booking narrative) to the list view —
  // the client only needs what it renders.
  const list = POLICY.customers.map(({ id, name, tier, pnr, flightLine, statusLine, statusKind, opening, chips }) =>
    ({ id, name, tier, pnr, flightLine, statusLine, statusKind, opening, chips }));
  res.json({ exerciseDate: POLICY.exerciseDate, customers: list });
});

app.get('/api/policy', (req, res) => {
  res.json({
    rules: POLICY.rules,
    allowed: POLICY.allowed,
    mustEscalate: POLICY.mustEscalate
  });
});

app.post('/api/chat', async (req, res) => {
  const { customerId, messages } = req.body || {};
  const customer = customerById(customerId);
  if (!customer) return res.status(400).json({ error: 'Unknown customerId' });
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server. Copy .env.example to .env and add your key.' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: buildSystemPrompt(customer),
        messages
      })
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      appendAuditLog({ ts: new Date().toISOString(), customerId, error: data });
      return res.status(upstream.status).json({ error: data });
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text : '{"reply":"Sorry, I ran into a problem pulling up your case. Could you repeat that?","escalate":false,"reason":null}';

    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = { reply: raw, escalate: false, reason: null };
    }

    appendAuditLog({
      ts: new Date().toISOString(),
      customerId,
      lastCustomerMessage: messages[messages.length - 1],
      agentReply: parsed.reply,
      escalate: !!parsed.escalate,
      reason: parsed.reason || null
    });

    res.json(parsed);
  } catch (err) {
    appendAuditLog({ ts: new Date().toISOString(), customerId, error: String(err) });
    res.status(500).json({ error: 'Upstream call failed', detail: String(err) });
  }
});

app.get('/api/audit-log', (req, res) => {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return res.json({ entries: [] });
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  res.json({ entries: lines.map(l => JSON.parse(l)) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Resolution Desk running at http://localhost:${PORT}`);
});
