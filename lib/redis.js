import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function parse(data) {
  if (data == null) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

// Ausgaben pro Monat:
// - aktueller Monat: 48h TTL (wird täglich neu geschrieben)
// - vergangene Monate: kein Ablauf (einmalig manuell gesetzt, ändert sich nicht mehr)
export async function getCashflowData(month) {
  return parse(await redis.get(`cashflow:${month}`));
}

export async function setCashflowData(month, data, { current = false } = {}) {
  if (current) {
    await redis.set(`cashflow:${month}`, JSON.stringify(data), { ex: 86400 * 2 });
  } else {
    await redis.set(`cashflow:${month}`, JSON.stringify(data)); // kein TTL
  }
}

// Zusammenfassung aller 6 Monate (TTL 25h — täglich überschrieben vom Cron)
export async function getCashflowSummary() {
  return parse(await redis.get('cashflow:summary'));
}

export async function setCashflowSummary(data) {
  await redis.set('cashflow:summary', JSON.stringify(data), { ex: 86400 + 3600 });
}

// Posting-Kategorien (TTL 7 Tage — ändern sich selten)
export async function getCategories() {
  return parse(await redis.get('cashflow:categories'));
}

export async function setCategories(data) {
  await redis.set('cashflow:categories', JSON.stringify(data), { ex: 86400 * 7 });
}

// Einzelner Voucher-Detail-Cache (TTL 8 Tage — nur für paid/paidoff)
export async function getVoucherCache(id) {
  return parse(await redis.get(`cashflow:voucher:${id}`));
}

export async function setVoucherCache(id, data) {
  await redis.set(`cashflow:voucher:${id}`, JSON.stringify(data), { ex: 86400 * 8 });
}

// Personalkosten pro Monat (kein TTL — manuell gesetzt)
export async function getSalary(month) {
  return parse(await redis.get(`cashflow:salary:${month}`));
}

export async function setSalary(month, amount) {
  await redis.set(`cashflow:salary:${month}`, JSON.stringify({
    amount,
    updatedAt: new Date().toISOString(),
  }));
}

// Revenue-Totals pro Monat für Trend (TTL 25h — vom Cron aktualisiert)
export async function getRevenue(month) {
  return parse(await redis.get(`cashflow:revenue:${month}`));
}

export async function setRevenue(month, data, { current = false } = {}) {
  if (current) {
    await redis.set(`cashflow:revenue:${month}`, JSON.stringify(data), { ex: 86400 * 2 });
  } else {
    await redis.set(`cashflow:revenue:${month}`, JSON.stringify(data));
  }
}

// Ausgangsrechnungen pro Monat (nach Abrechnungsmonat)
export async function getInvoiceCache(month) {
  return parse(await redis.get(`cashflow:invoicedata:${month}`));
}

export async function setInvoiceCache(month, data, { current = false } = {}) {
  if (current) {
    await redis.set(`cashflow:invoicedata:${month}`, JSON.stringify(data), { ex: 86400 * 2 });
  } else {
    await redis.set(`cashflow:invoicedata:${month}`, JSON.stringify(data));
  }
}

export { redis };
