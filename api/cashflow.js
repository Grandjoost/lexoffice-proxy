import { checkOrigin } from './_middleware.js';
import { getCashflowData, getCashflowSummary, getSalary, getRevenue, getInvoiceCache } from '../lib/redis.js';

function getMonthRange(n, endingAt) {
  const [selYear, selMon] = endingAt.split('-').map(Number);
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(selYear, selMon - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

// Gibt den Monatsstring ("YYYY-MM") des Leistungsdatums zurück (Start des Zeitraums)
function getServiceMonth(serviceDate) {
  if (!serviceDate) return null;
  if (typeof serviceDate === 'string') return serviceDate.substring(0, 7);
  if (serviceDate.startDate) return serviceDate.startDate.substring(0, 7);
  if (serviceDate.date) return serviceDate.date.substring(0, 7);
  return null;
}

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const selectedMonth = req.query?.month || currentMonth;
  const dateMode = req.query?.dateMode === 'service' ? 'service' : 'invoice';

  const trendMonths = getMonthRange(6, selectedMonth);

  // Für Leistungsdatum-Modus: auch Nachbarmonat laden (Rechnung nächsten Monat = Leistung diesen Monat)
  const invoiceCacheMonths = dateMode === 'service'
    ? [...new Set([...trendMonths, getMonthRange(7, selectedMonth).at(-1)])]
    : trendMonths;

  try {
    const [expensesCache, salaryCache, summary, ...parallelData] = await Promise.all([
      getCashflowData(selectedMonth),
      getSalary(selectedMonth),
      getCashflowSummary(),
      ...invoiceCacheMonths.map(m => getInvoiceCache(m)),
      ...trendMonths.map(m => Promise.all([getCashflowData(m), getRevenue(m)])),
    ]);

    // parallelData: erst invoiceCacheMonths.length Invoice-Cache-Einträge, dann trendMonths.length Trend-Paare
    const invoiceCacheEntries = parallelData.slice(0, invoiceCacheMonths.length);
    const trendData = parallelData.slice(invoiceCacheMonths.length);

    // Alle gecachten Rechnungen zusammenführen und nach dateMode filtern
    const allCachedInvoices = invoiceCacheEntries.flatMap(entry => entry?.invoices ?? []);
    const allSkipped = invoiceCacheEntries.flatMap(entry => entry?.skipped ?? []);

    const invoices = allCachedInvoices.filter(inv => {
      const month = dateMode === 'service'
        ? (getServiceMonth(inv.serviceDate) ?? inv.voucherDate?.substring(0, 7))
        : inv.voucherDate?.substring(0, 7);
      return month === selectedMonth;
    });

    // Prüfen ob Invoice-Cache vorhanden ist
    const invoiceCacheForMonth = invoiceCacheEntries[invoiceCacheMonths.indexOf(selectedMonth)];
    const invoicesSynced = invoiceCacheForMonth !== null;

    // Revenue aus validierten Invoices
    const validInvoices = invoices.filter(i => i.status !== 'voided');
    const totalNet = validInvoices.reduce((s, i) => s + i.totalNet, 0);
    const totalGross = validInvoices.reduce((s, i) => s + i.totalGross, 0);
    const openInvoices = invoices.filter(i => i.status === 'open' || i.status === 'overdue');
    const totalOpen = openInvoices.reduce((s, i) => s + (i.openAmount ?? i.totalGross), 0);

    // Ausgaben aus Redis-Cache
    const salaryAmount = salaryCache?.amount ?? null;
    const lexExpensesNet = expensesCache?.expenses?.total ?? null;
    const lexExpensesGross = expensesCache?.expenses?.totalGross ?? null;

    const totalExpensesNet = lexExpensesNet !== null
      ? lexExpensesNet + (salaryAmount ?? 0)
      : (salaryAmount !== null ? salaryAmount : null);
    const totalExpensesGross = lexExpensesGross !== null
      ? lexExpensesGross + (salaryAmount ?? 0)
      : (salaryAmount !== null ? salaryAmount : null);

    const cashflowNet = totalExpensesNet !== null
      ? Math.round((totalNet - totalExpensesNet) * 100) / 100
      : null;
    const cashflowGross = totalExpensesGross !== null
      ? Math.round((totalGross - totalExpensesGross) * 100) / 100
      : null;

    // Kategorie-Charts
    const byCategoryChart = [];
    const byCategoryGrossChart = [];
    if (expensesCache?.expenses?.byCategory) {
      const raw = { ...expensesCache.expenses.byCategory };
      if (salaryAmount) raw['Personalkosten'] = (raw['Personalkosten'] ?? 0) + salaryAmount;
      byCategoryChart.push(...Object.entries(raw).sort(([, a], [, b]) => b - a).map(([Kategorie, Betrag]) => ({ Kategorie, Betrag })));
    }
    if (expensesCache?.expenses?.byCategoryGross) {
      const raw = { ...expensesCache.expenses.byCategoryGross };
      if (salaryAmount) raw['Personalkosten'] = (raw['Personalkosten'] ?? 0) + salaryAmount;
      byCategoryGrossChart.push(...Object.entries(raw).sort(([, a], [, b]) => b - a).map(([Kategorie, Betrag]) => ({ Kategorie, Betrag })));
    }

    // Trend: Monate ohne Daten herausfiltern
    const trend = trendMonths.flatMap((month, i) => {
      const [expData, revData] = trendData[i];
      const expTotal = expData?.expenses?.total ?? null;
      const revTotal = revData?.totalNet ?? null;
      if (expTotal === null && revTotal === null) return [];
      const entries = [];
      if (revTotal !== null) entries.push({ Monat: month, Betrag: revTotal, Typ: 'Einnahmen' });
      if (expTotal !== null) entries.push({ Monat: month, Betrag: expTotal, Typ: 'Ausgaben' });
      return entries;
    });

    return res.status(200).json({
      selectedMonth,
      currentMonth,
      dateMode,
      stale: !summary,
      updatedAt: summary?.updatedAt ?? expensesCache?.updatedAt ?? null,
      salary: { amount: salaryAmount, updatedAt: salaryCache?.updatedAt ?? null },
      revenue: {
        totalNet: Math.round(totalNet * 100) / 100,
        totalGross: Math.round(totalGross * 100) / 100,
        open: Math.round(totalOpen * 100) / 100,
      },
      expenses: {
        total: totalExpensesNet !== null ? Math.round(totalExpensesNet * 100) / 100 : null,
        totalGross: totalExpensesGross !== null ? Math.round(totalExpensesGross * 100) / 100 : null,
        lexofficeTotal: lexExpensesNet !== null ? Math.round(lexExpensesNet * 100) / 100 : null,
        lexofficeTotalGross: lexExpensesGross !== null ? Math.round(lexExpensesGross * 100) / 100 : null,
        salaryTotal: salaryAmount,
        totalTax: expensesCache?.expenses?.totalTax ?? null,
        byCategoryChart,
        byCategoryGrossChart,
        byStatus: expensesCache?.expenses?.byStatus ?? null,
        vouchers: expensesCache?.expenses?.vouchers ?? null,
        synced: expensesCache !== null,
      },
      cashflow: {
        net: cashflowNet,
        gross: cashflowGross,
      },
      invoices,
      invoicesSynced,
      warnings: allSkipped.length > 0 ? { skippedInvoices: allSkipped } : null,
      trend,
      trendMonths,
    });
  } catch (error) {
    console.error('[cashflow] Fehler:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
