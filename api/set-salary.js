import { checkOrigin } from './_middleware.js';
import { setSalary } from '../lib/redis.js';

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { month, amount } = req.body || {};

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Ungültiger Monat (erwartet: YYYY-MM)' });
  }

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed < 0) {
    return res.status(400).json({ error: 'Ungültiger Betrag' });
  }

  try {
    await setSalary(month, parsed);
    return res.status(200).json({ ok: true, month, amount: parsed });
  } catch (error) {
    console.error('[set-salary] Fehler:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
