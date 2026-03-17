import {
  getCashflowData,
  setCashflowData,
  setCashflowSummary,
  getCategories,
  setCategories,
  getVoucherCache,
  setVoucherCache,
  setRevenue,
  setInvoiceCache,
} from '../../lib/redis.js';
import { aggregateVouchers, getLastNMonths } from '../../lib/cashflow.js';

const LEXOFFICE_API = 'https://api.lexware.io';
const RATE_LIMIT_MS = 550; // 2 req/sec + Buffer
let lastRequestTime = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 5;

async function lexofficeRequest(path, attempt = 0) {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();

  const response = await fetch(`${LEXOFFICE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.LEXOFFICE_API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Lexoffice ${path}: Rate limit nach ${MAX_RETRIES} Versuchen`);
    }
    const backoff = 2000 * (attempt + 1);
    console.warn(`[sync-expenses] Rate limited — warte ${backoff}ms (Versuch ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(backoff);
    return lexofficeRequest(path, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Lexoffice ${path}: HTTP ${response.status} — ${text}`);
  }

  return response.json();
}

async function loadCategories() {
  const cached = await getCategories();
  if (cached) return cached.categories;

  const data = await lexofficeRequest('/v1/posting-categories');
  const categories = {};
  for (const cat of data || []) {
    categories[cat.id] = cat.name;
  }

  await setCategories({ updatedAt: new Date().toISOString(), categories });
  console.log(`[sync-expenses] ${Object.keys(categories).length} Kategorien geladen`);
  return categories;
}

async function fetchVouchersForMonth(month) {
  // Letzten Tag des Monats berechnen
  const [year, mon] = month.split('-').map(Number);
  const dateFrom = `${month}-01`;
  const lastDay = new Date(year, mon, 0).getDate();
  const dateTo = `${month}-${String(lastDay).padStart(2, '0')}`;

  const vouchers = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      voucherType: 'purchaseinvoice,purchasecreditnote',
      voucherStatus: 'open,paid,paidoff',
      voucherDateFrom: dateFrom,
      voucherDateTo: dateTo,
      page: String(page),
      size: '100',
      sortColumn: 'voucherDate',
      sortDirection: 'DESC',
    });

    const data = await lexofficeRequest(`/v1/voucherlist?${params}`);
    const content = data?.content || [];
    vouchers.push(...content);

    hasMore = content.length === 100;
    page++;
  }

  return vouchers;
}

async function fetchVoucherDetail(id, status) {
  const isFinal = status === 'paid' || status === 'paidoff';
  if (isFinal) {
    const cached = await getVoucherCache(id);
    if (cached) return { detail: cached, fromCache: true };
  }

  const detail = await lexofficeRequest(`/v1/vouchers/${id}`);
  if (isFinal) await setVoucherCache(id, detail);
  return { detail, fromCache: false };
}

async function syncInvoices(month) {
  console.log(`[sync-invoices] Starte Sync für Monat: ${month}`);
  const startTime = Date.now();

  const [year, mon] = month.split('-').map(Number);
  const dateFrom = `${month}-01`;
  const lastDay = new Date(year, mon, 0).getDate();
  const dateTo = `${month}-${String(lastDay).padStart(2, '0')}`;

  const invoiceList = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      voucherType: 'invoice,salesinvoice',
      voucherStatus: 'open,paid,paidoff,draft',
      voucherDateFrom: dateFrom,
      voucherDateTo: dateTo,
      page: String(page),
      size: '100',
      sortColumn: 'voucherDate',
      sortDirection: 'DESC',
    });

    const data = await lexofficeRequest(`/v1/voucherlist?${params}`);
    const content = data?.content || [];
    invoiceList.push(...content);

    hasMore = content.length === 100;
    page++;
  }

  const invoices = [];
  const skipped = [];

  for (const inv of invoiceList) {
    const isSalesInvoice = inv.voucherType === 'salesinvoice';
    let detail;
    try {
      detail = isSalesInvoice
        ? await lexofficeRequest(`/v1/vouchers/${inv.id}`)
        : await lexofficeRequest(`/v1/invoices/${inv.id}`);
    } catch (err) {
      console.error(`[sync-invoices] Detail-Fetch fehlgeschlagen ${inv.id}: ${err.message}`);
      skipped.push({ id: inv.id, number: inv.voucherNumber, reason: err.message });
      continue;
    }

    let netAmount, grossAmount, taxAmount;
    if (isSalesInvoice) {
      grossAmount = detail?.totalGrossAmount;
      taxAmount = detail?.totalTaxAmount;
      if (grossAmount == null) {
        skipped.push({ id: inv.id, number: inv.voucherNumber, reason: 'totalGrossAmount fehlt (salesinvoice)' });
        continue;
      }
      netAmount = grossAmount - (taxAmount ?? 0);
    } else {
      netAmount = detail?.totalPrice?.totalNetAmount;
      grossAmount = detail?.totalPrice?.totalGrossAmount;
      taxAmount = detail?.totalPrice?.totalTaxAmount;
      if (netAmount == null || grossAmount == null) {
        skipped.push({ id: inv.id, number: inv.voucherNumber, reason: 'totalPrice fehlt (invoice)' });
        continue;
      }
    }

    invoices.push({
      id: inv.id,
      number: inv.voucherNumber ?? null,
      status: inv.voucherStatus,
      voucherType: inv.voucherType,
      voucherDate: inv.voucherDate,
      serviceDate: detail?.serviceDate ?? null,
      company: inv.contactName ?? null,
      totalNet: Math.round(netAmount * 100) / 100,
      totalGross: Math.round(grossAmount * 100) / 100,
      totalTax: Math.round((taxAmount ?? (grossAmount - netAmount)) * 100) / 100,
      openAmount: inv.openAmount ?? null,
      url: detail?.viewOnlineUrl ?? null,
    });
  }

  if (skipped.length > 0) {
    console.warn(`[sync-invoices] ${month}: ${skipped.length} Rechnungen übersprungen:`, JSON.stringify(skipped));
  }

  // Revenue-Totals für Trend aus validierten Detail-Daten berechnen
  const validInvoices = invoices.filter(i => i.status !== 'voided');
  const totalNet = validInvoices.reduce((s, i) => s + i.totalNet, 0);
  const totalGross = validInvoices.reduce((s, i) => s + i.totalGross, 0);

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const isCurrent = month === currentMonth;

  await setInvoiceCache(month, {
    month,
    invoices,
    skipped,
    updatedAt: new Date().toISOString(),
  }, { current: isCurrent });

  await setRevenue(month, {
    totalNet: Math.round(totalNet * 100) / 100,
    totalGross: Math.round(totalGross * 100) / 100,
    count: invoices.length,
    updatedAt: new Date().toISOString(),
  }, { current: isCurrent });

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`[sync-invoices] ${month} abgeschlossen in ${duration}s (${invoices.length} Rechnungen, ${skipped.length} übersprungen)`);

  return { month, count: invoices.length, skipped: skipped.length, durationSeconds: duration };
}

async function syncMonth(month, categories) {
  console.log(`[sync-expenses] Starte Sync für Monat: ${month}`);
  const startTime = Date.now();

  const vouchers = await fetchVouchersForMonth(month);
  console.log(`[sync-expenses] ${month}: ${vouchers.length} Voucher gefunden`);

  const detailsMap = {};
  let fetched = 0;
  let fromCache = 0;

  for (const voucher of vouchers) {
    try {
      const { detail, fromCache: cached } = await fetchVoucherDetail(voucher.id, voucher.voucherStatus);
      detailsMap[voucher.id] = detail;
      cached ? fromCache++ : fetched++;
    } catch (err) {
      console.error(`[sync-expenses] Detail-Fetch fehlgeschlagen ${voucher.id}: ${err.message}`);
    }
  }

  const { data: monthlyData, skipped } = aggregateVouchers(vouchers, detailsMap, categories);
  if (skipped.length > 0) {
    console.warn(`[sync-expenses] ${month}: ${skipped.length} Belege übersprungen:`, JSON.stringify(skipped));
  }

  // Kein Voucher für diesen Monat = legitim 0 Ausgaben (Cron lief, nichts gefunden)
  const data = monthlyData[month] ?? {
    month,
    expenses: {
      total: 0, totalGross: 0, totalTax: 0,
      byCategory: {}, byCategoryGross: {},
      byStatus: { paid: 0, open: 0 },
      vouchers: [],
    },
  };

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  await setCashflowData(month, { ...data, updatedAt: new Date().toISOString() }, { current: month === currentMonth });

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`[sync-expenses] ${month} abgeschlossen in ${duration}s (${fetched} neu, ${fromCache} aus Cache)`);

  return { month, vouchers: vouchers.length, fetched, fromCache, durationSeconds: duration };
}

export default async function handler(req, res) {
  // Cron-Auth: Vercel setzt Authorization-Header automatisch beim Cron
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.LEXOFFICE_API_KEY) {
    return res.status(500).json({ error: 'LEXOFFICE_API_KEY nicht konfiguriert' });
  }

  // ?month=YYYY-MM → einzelnen Monat synchronisieren (für Setup + manuelle Aufrufe)
  // kein Parameter → nur aktuellen Monat (täglicher Cron)
  const requestedMonth = req.query?.month;
  const allMonths = getLastNMonths(6);

  // Validierung wenn month-Parameter übergeben
  if (requestedMonth && !allMonths.includes(requestedMonth)) {
    return res.status(400).json({
      error: `Ungültiger Monat "${requestedMonth}". Erlaubt: ${allMonths.join(', ')}`,
    });
  }

  const monthsToSync = requestedMonth ? [requestedMonth] : [allMonths[allMonths.length - 1]];

  try {
    const categories = await loadCategories();
    const results = [];

    for (const month of monthsToSync) {
      const expenseResult = await syncMonth(month, categories);
      const invoiceResult = await syncInvoices(month);
      results.push({ ...expenseResult, invoices: invoiceResult.count, invoicesSkipped: invoiceResult.skipped });
    }

    // Summary aus aktuellen Redis-Daten neu aufbauen
    const expensesByMonth = {};
    for (const month of allMonths) {
      const data = await getCashflowData(month);
      expensesByMonth[month] = data?.expenses?.total || 0;
    }

    await setCashflowSummary({
      updatedAt: new Date().toISOString(),
      months: allMonths,
      expensesByMonth,
    });

    return res.status(200).json({ ok: true, synced: results });
  } catch (error) {
    console.error('[sync-expenses] Fehler:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
