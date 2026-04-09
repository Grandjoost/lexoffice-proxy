// ============================================================
// HubSpot Line Item → Lexoffice Position Mapping
//
// DUPLIZIERT in:
//   lexoffice-proxy/lib/line-item-mapping.js
//   noditch-billing/api/_line-item-mapping.js
//
// Beide Kopien manuell synchron halten. Bei Änderungen IMMER beide
// Dateien anfassen.
//
// Erwartet flache Line-Item-Objekte (nicht HubSpot.properties.X).
// Caller muss vorher flatten:
//   { id, name, description, price, quantity, amount,
//     hs_discount_percentage, recurringbillingfrequency,
//     hs_recurring_billing_period, hs_recurring_billing_start_date }
// ============================================================

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL',
  'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ============================================================
// ISO 8601 Period Parser
// ============================================================
export function parseISOPeriodToMonths(iso) {
  if (!iso) throw new Error('hs_recurring_billing_period ist leer');
  const match = iso.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/);
  if (!match) throw new Error('Ungültiges ISO-8601 Period: ' + iso);
  const years = parseInt(match[1] || '0', 10);
  const months = parseInt(match[2] || '0', 10);
  const days = parseInt(match[3] || '0', 10);
  if (days > 0) throw new Error('Tage in billing period nicht unterstützt: ' + iso);
  const total = years * 12 + months;
  if (total <= 0) throw new Error('Term muss > 0 sein: ' + iso);
  return total;
}

// ============================================================
// Date Helpers
// ============================================================
export function calculateEndDate(startDateStr, isoTerm) {
  if (!startDateStr) throw new Error('hs_recurring_billing_start_date fehlt');
  const termMonths = parseISOPeriodToMonths(isoTerm);
  const start = new Date(startDateStr + 'T00:00:00');
  const end = new Date(start);
  end.setMonth(end.getMonth() + termMonths);
  end.setDate(end.getDate() - 1);
  return end;
}

export function formatMMYYYY(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return mm + '/' + date.getFullYear();
}

export function formatMonthLabelDE(date) {
  return MONTHS_DE[date.getMonth()] + ' ' + date.getFullYear();
}

export function formatJiraDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

// ============================================================
// Tax Logic — { country, vat_id } → { taxType, taxRatePercentage }
// ============================================================
function normalizeCountry(country) {
  if (!country) return 'DE';
  if (country === 'Germany' || country === 'Deutschland' || country === 'DE') return 'DE';
  return country;
}

export function deriveTaxRate(company) {
  const country = normalizeCountry(company && company.country);
  const vatId = company && company.vat_id;

  if (country === 'DE') {
    return { taxType: 'net', taxRatePercentage: 19 };
  }
  if (EU_COUNTRIES.has(country) && vatId) {
    return { taxType: 'intraCommunitySupply', taxRatePercentage: 0 };
  }
  return { taxType: 'thirdPartyCountryService', taxRatePercentage: 0 };
}

// ============================================================
// Pflicht-Gegenprobe — exakter Cent-Vergleich, kein Toleranz
// ============================================================
export function verifyLineItemPrice(lineItem) {
  const price = parseFloat(lineItem.price);
  const quantity = parseFloat(lineItem.quantity);
  const discount = parseFloat(lineItem.hs_discount_percentage || '0');
  const amount = parseFloat(lineItem.amount);

  if (isNaN(price)) throw new Error('price fehlt für "' + lineItem.name + '"');
  if (isNaN(quantity)) throw new Error('quantity fehlt für "' + lineItem.name + '"');
  if (isNaN(amount)) throw new Error('amount fehlt für "' + lineItem.name + '"');

  const monthlyGross = price * quantity;
  const expected = Math.round(monthlyGross * (1 - discount / 100) * 100) / 100;
  const actual = Math.round(amount * 100) / 100;

  if (expected !== actual) {
    throw new Error(
      'Preisabweichung "' + lineItem.name + '": berechnet ' + expected +
      ' ≠ HubSpot ' + actual + '. Abbruch.'
    );
  }
}

// ============================================================
// Filter: Ist Line Item im Monat aktiv?
// ============================================================
export function isLineItemActiveInMonth(lineItem, monthStartStr) {
  const isRecurring = !!lineItem.recurringbillingfrequency;
  if (!isRecurring) return false; // one-time: caller entscheidet via isFirstInvoiceMonth

  const startStr = lineItem.hs_recurring_billing_start_date;
  if (!startStr) throw new Error('hs_recurring_billing_start_date fehlt für "' + lineItem.name + '"');
  const termMonths = parseISOPeriodToMonths(lineItem.hs_recurring_billing_period);

  const startDate = new Date(startStr + 'T00:00:00');
  const monthStart = new Date(monthStartStr + 'T00:00:00');

  if (startDate > monthStart) return false;

  const endExclusive = new Date(startDate);
  endExclusive.setMonth(endExclusive.getMonth() + termMonths);
  return endExclusive > monthStart;
}

// One-Time Items kommen auf den ersten Abrechnungsmonat des Deals.
// dealEarliestStartStr = frühestes hs_recurring_billing_start_date aller LIs.
export function isFirstInvoiceMonth(monthStartStr, dealEarliestStartStr) {
  if (!dealEarliestStartStr) return false;
  return monthStartStr.substring(0, 7) === dealEarliestStartStr.substring(0, 7);
}

// ============================================================
// Mapping: Line Item → AB Position
// ============================================================
export function mapLineItemToABPosition(lineItem, taxRatePercentage) {
  verifyLineItemPrice(lineItem);

  const isRecurring = !!lineItem.recurringbillingfrequency;
  const price = parseFloat(lineItem.price);
  const quantity = parseFloat(lineItem.quantity);
  const discount = parseFloat(lineItem.hs_discount_percentage || '0');

  if (isRecurring) {
    const startStr = lineItem.hs_recurring_billing_start_date;
    if (!startStr) throw new Error('hs_recurring_billing_start_date fehlt für "' + lineItem.name + '"');
    const termMonths = parseISOPeriodToMonths(lineItem.hs_recurring_billing_period);
    const start = new Date(startStr + 'T00:00:00');
    const end = calculateEndDate(startStr, lineItem.hs_recurring_billing_period);

    const position = {
      type: 'custom',
      name: lineItem.name + ' (' + formatMMYYYY(start) + ' – ' + formatMMYYYY(end) + ')',
      quantity: termMonths,
      unitName: 'Monat',
      unitPrice: {
        currency: 'EUR',
        netAmount: Math.round(price * quantity * 100) / 100,
        taxRatePercentage,
      },
    };
    if (lineItem.description) position.description = lineItem.description;
    if (discount > 0) position.discountPercentage = discount;
    return position;
  }

  // One-Time
  const position = {
    type: 'custom',
    name: lineItem.name,
    quantity,
    unitName: 'Stück',
    unitPrice: {
      currency: 'EUR',
      netAmount: price,
      taxRatePercentage,
    },
  };
  if (lineItem.description) position.description = lineItem.description;
  if (discount > 0) position.discountPercentage = discount;
  return position;
}

// ============================================================
// Mapping: Line Item → Monatsrechnung Position
// monthStart/monthEnd sind Date-Objekte für den Abrechnungsmonat
// ============================================================
export function mapLineItemToInvoicePosition(lineItem, taxRatePercentage, monthStart) {
  verifyLineItemPrice(lineItem);

  const isRecurring = !!lineItem.recurringbillingfrequency;
  const price = parseFloat(lineItem.price);
  const quantity = parseFloat(lineItem.quantity);
  const discount = parseFloat(lineItem.hs_discount_percentage || '0');

  if (isRecurring) {
    const position = {
      type: 'custom',
      name: lineItem.name + ' – ' + formatMonthLabelDE(monthStart),
      quantity: 1,
      unitName: 'Monat',
      unitPrice: {
        currency: 'EUR',
        netAmount: Math.round(price * quantity * 100) / 100,
        taxRatePercentage,
      },
    };
    if (lineItem.description) position.description = lineItem.description;
    if (discount > 0) position.discountPercentage = discount;
    return position;
  }

  // One-Time
  const position = {
    type: 'custom',
    name: lineItem.name,
    quantity,
    unitName: 'Stück',
    unitPrice: {
      currency: 'EUR',
      netAmount: price,
      taxRatePercentage,
    },
  };
  if (lineItem.description) position.description = lineItem.description;
  if (discount > 0) position.discountPercentage = discount;
  return position;
}

// ============================================================
// Deal-Range — frühester Start + spätestes Ende über alle LIs
// Liefert { earliestStart: 'YYYY-MM-DD', latestEnd: 'YYYY-MM-DD' } oder null
// ============================================================
export function calculateDealRange(lineItems) {
  let earliestStart = null;
  let latestEnd = null;
  for (const li of lineItems) {
    if (!li.recurringbillingfrequency) continue;
    const start = li.hs_recurring_billing_start_date;
    if (!start) continue;
    if (!earliestStart || start < earliestStart) earliestStart = start;
    const end = calculateEndDate(start, li.hs_recurring_billing_period);
    const endStr = formatJiraDate(end);
    if (!latestEnd || endStr > latestEnd) latestEnd = endStr;
  }
  if (!earliestStart || !latestEnd) return null;
  return { earliestStart, latestEnd };
}
