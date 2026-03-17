/**
 * Aggregiert Lexoffice-Voucher nach Monat und Buchungskategorie.
 *
 * @param {Array} vouchers - Rohdaten aus /v1/voucherlist
 * @param {Object} detailsMap - { [voucherId]: voucherDetail }
 * @param {Object} categories - { [categoryId]: categoryName }
 * @returns {{ data: Object, skipped: Array }}
 */
export function aggregateVouchers(vouchers, detailsMap, categories) {
  const monthlyData = {};
  const skipped = [];

  for (const voucher of vouchers) {
    if (!voucher.voucherDate) {
      skipped.push({ id: voucher.id, reason: 'voucherDate fehlt' });
      continue;
    }

    const month = voucher.voucherDate.substring(0, 7);
    const isCreditNote = voucher.voucherType === 'purchasecreditnote';
    const sign = isCreditNote ? -1 : 1;

    if (!monthlyData[month]) {
      monthlyData[month] = {
        month,
        expenses: {
          total: 0,
          totalGross: 0,
          totalTax: 0,
          byCategory: {},
          byCategoryGross: {},
          byStatus: { paid: 0, open: 0 },
          vouchers: [],
        },
      };
    }

    const data = monthlyData[month];
    const detail = detailsMap[voucher.id];

    let voucherNet = null;
    let voucherTax = 0;
    let primaryCategory = 'Sonstige';
    let maxItemAmount = 0;
    let hasSkippedItems = false;

    if (detail?.voucherItems?.length) {
      let accumNet = 0;
      let accumTax = 0;

      for (const item of detail.voucherItems) {
        if (item.amount == null) {
          skipped.push({ id: voucher.id, reason: `voucherItem.amount fehlt` });
          hasSkippedItems = true;
          continue;
        }

        const amount = item.amount * sign;
        // taxAmount kann legitim 0 sein (0% MwSt) — aber nicht null/undefined
        const tax = (item.taxAmount ?? 0) * sign;
        const gross = amount + tax;
        const catName = (item.categoryId && categories[item.categoryId]) || 'Sonstige';

        accumNet += item.amount;
        accumTax += item.taxAmount ?? 0;

        data.expenses.total += amount;
        data.expenses.totalTax += tax;
        data.expenses.totalGross += gross;
        data.expenses.byCategory[catName] = (data.expenses.byCategory[catName] ?? 0) + amount;
        data.expenses.byCategoryGross[catName] = (data.expenses.byCategoryGross[catName] ?? 0) + gross;

        if (item.amount > maxItemAmount) {
          maxItemAmount = item.amount;
          primaryCategory = catName;
        }
      }

      voucherNet = accumNet;
      voucherTax = accumTax;
    } else if (voucher.totalAmount != null) {
      // Fallback: kein Detail verfügbar, totalAmount aus Voucherlist (Brutto-Betrag, keine Netto/Steuer-Trennung)
      const amount = voucher.totalAmount * sign;
      voucherNet = voucher.totalAmount;
      data.expenses.total += amount;
      data.expenses.totalGross += amount;
      data.expenses.byCategory['Sonstige'] = (data.expenses.byCategory['Sonstige'] ?? 0) + amount;
      data.expenses.byCategoryGross['Sonstige'] = (data.expenses.byCategoryGross['Sonstige'] ?? 0) + amount;
    } else {
      skipped.push({ id: voucher.id, reason: 'Betrag nicht verfügbar (kein Detail, kein totalAmount)' });
      continue;
    }

    const netSigned = voucherNet * sign;
    const taxSigned = voucherTax * sign;

    data.expenses.vouchers.push({
      id: voucher.id,
      number: voucher.voucherNumber ?? null,
      status: voucher.voucherStatus,
      voucherDate: voucher.voucherDate,
      serviceDate: detail?.serviceDate ?? null,
      company: voucher.contactName ?? null,
      totalNet: Math.round(netSigned * 100) / 100,
      totalGross: Math.round((netSigned + taxSigned) * 100) / 100,
      totalTax: Math.round(taxSigned * 100) / 100,
      openAmount: voucher.openAmount ?? null,
      category: primaryCategory,
      incomplete: hasSkippedItems,
    });

    // Status-Aufschlüsselung
    const isPaid = voucher.voucherStatus === 'paid' || voucher.voucherStatus === 'paidoff';
    if (isPaid) {
      if (voucher.totalAmount != null) {
        data.expenses.byStatus.paid += voucher.totalAmount * sign;
      }
    } else {
      const openAmt = voucher.openAmount ?? voucher.totalAmount;
      if (openAmt != null) {
        data.expenses.byStatus.open += openAmt * sign;
      }
    }
  }

  // Beträge auf 2 Dezimalstellen runden
  for (const data of Object.values(monthlyData)) {
    data.expenses.total = Math.round(data.expenses.total * 100) / 100;
    data.expenses.totalGross = Math.round(data.expenses.totalGross * 100) / 100;
    data.expenses.totalTax = Math.round(data.expenses.totalTax * 100) / 100;
    for (const [key, val] of Object.entries(data.expenses.byCategory)) {
      data.expenses.byCategory[key] = Math.round(val * 100) / 100;
    }
    for (const [key, val] of Object.entries(data.expenses.byCategoryGross)) {
      data.expenses.byCategoryGross[key] = Math.round(val * 100) / 100;
    }
    data.expenses.byStatus.paid = Math.round(data.expenses.byStatus.paid * 100) / 100;
    data.expenses.byStatus.open = Math.round(data.expenses.byStatus.open * 100) / 100;
  }

  return { data: monthlyData, skipped };
}

/**
 * Aggregiert HubSpot-Invoices nach Monat.
 */
export function aggregateInvoices(invoices) {
  const revenueByMonth = {};
  const openInvoices = [];
  let totalOpen = 0;

  for (const inv of invoices) {
    const props = inv.properties;
    const month = (props.hs_invoice_date || '').substring(0, 7);
    const amountNet = parseFloat(props.lex_amount_net || props.hs_amount_billed || 0);
    const amountOpen = parseFloat(props.amount_open || props.hs_balance_due || 0);

    if (month) {
      revenueByMonth[month] = Math.round(((revenueByMonth[month] || 0) + amountNet) * 100) / 100;
    }

    const isOpen = props.hs_invoice_status === 'open' || amountOpen > 0;
    if (isOpen) {
      totalOpen += amountOpen;
      openInvoices.push({
        id: inv.id,
        number: props.hs_number,
        company: props.hs_invoice_latest_company_name,
        amount: parseFloat(props.hs_amount_billed || 0),
        amountNet,
        amountOpen,
        date: props.hs_invoice_date,
        url: props.url_lexoffice_invoice,
        status: props.hs_invoice_status,
      });
    }
  }

  openInvoices.sort((a, b) => new Date(a.date) - new Date(b.date));
  totalOpen = Math.round(totalOpen * 100) / 100;

  return { revenueByMonth, openInvoices, totalOpen };
}

/**
 * Gibt die letzten N Monate als Array zurück, z.B. ["2025-10", ..., "2026-03"]
 */
export function getLastNMonths(n = 6) {
  const months = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/**
 * Datumsbereich für die letzten N Monate (YYYY-MM-DD Strings)
 */
export function getDateRange(n = 6) {
  const now = new Date();
  const dateFrom = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1)
    .toISOString()
    .substring(0, 10);
  const dateTo = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .substring(0, 10);
  return { dateFrom, dateTo };
}
