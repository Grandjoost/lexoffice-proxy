// Shared invoice sync logic — used by lexoffice-webhook.js (auto sync)
// and api/sync-invoice.js (manual sync from monthly overview).
//
// Exports createHubSpotInvoice() with optional forcedAssociations param.
// forcedAssociations: array of { type, id } pairs to force-add (used when
// the user manually links an invoice to a deal that has no AB-based link).

import { LEXOFFICE_STATUS_MAP, createDefaultAssociation } from './shared.js';

export async function fetchLexoffice(path, token) {
  const res = await fetch('https://api.lexware.io' + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Lexoffice ' + path + ' returned ' + res.status + ': ' + text);
  }
  return res.json();
}

export async function searchHubSpotObject(objectType, propertyName, value, properties, token) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/' + objectType + '/search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filterGroups: [{
        filters: [{
          propertyName: propertyName,
          operator: 'EQ',
          value: value
        }]
      }],
      properties: properties,
      limit: 1
    })
  });

  if (!res.ok) {
    console.error('[hubspot-search] Error searching', objectType, res.status);
    return null;
  }

  const data = await res.json();
  if (data.total > 0) {
    return data.results[0];
  }
  return null;
}

export async function getAssociations(fromType, fromId, toType, token) {
  const res = await fetch(
    'https://api.hubapi.com/crm/v4/objects/' + fromType + '/' + fromId + '/associations/' + toType,
    {
      headers: { 'Authorization': 'Bearer ' + token }
    }
  );

  if (!res.ok) {
    console.log('[hubspot-assoc] No associations', fromType, fromId, '->', toType, res.status);
    return [];
  }

  const data = await res.json();
  return (data.results || []).map(r => ({ id: String(r.toObjectId) }));
}

// Dedup helper: append { type, id } to associations only if not already present
function addAssoc(associations, type, id) {
  if (!id) return;
  const idStr = String(id);
  if (associations.some(a => a.type === type && String(a.id) === idStr)) return;
  associations.push({ type, id: idStr });
}

export async function createHubSpotInvoice(invoice, resourceId, HUBSPOT_TOKEN, forcedAssociations = []) {
  const hsStatus = LEXOFFICE_STATUS_MAP[invoice.voucherStatus] || 'open';

  let dueDate = null;
  if (invoice.paymentConditions?.paymentTermDuration != null && invoice.voucherDate) {
    const vDate = new Date(invoice.voucherDate);
    vDate.setDate(vDate.getDate() + invoice.paymentConditions.paymentTermDuration);
    dueDate = vDate.toISOString().split('T')[0];
  }

  const voucherType = invoice.voucherType || 'invoice';
  const urlType = voucherType.charAt(0).toUpperCase() + voucherType.slice(1);
  const totalGross = invoice.totalPrice?.totalGrossAmount ?? 0;

  const sc = invoice.shippingConditions || {};
  const serviceFrom = sc.shippingDate ? sc.shippingDate.split('T')[0] : null;
  const serviceTo = sc.shippingEndDate ? sc.shippingEndDate.split('T')[0] : null;

  const properties = {
    hs_currency: 'EUR',
    hs_invoice_billable: 'false',
    hs_invoice_status: hsStatus,
    hs_invoice_date: invoice.voucherDate ? invoice.voucherDate.split('T')[0] : null,
    hs_external_createdate: invoice.createdDate || null,
    hs_amount_billed: String(totalGross),
    amount_open: String(totalGross),
    hs_number: invoice.voucherNumber,
    lexoffice_invoice_id: resourceId,
    url_lexoffice_invoice: 'https://app.lexoffice.de/vouchers#!/VoucherView/' + urlType + '/' + resourceId,
    lex_service_from: serviceFrom,
    lex_service_to: serviceTo,
  };

  if (dueDate) {
    properties.hs_due_date = dueDate;
  }

  Object.keys(properties).forEach(key => {
    if (properties[key] === null || properties[key] === undefined) {
      delete properties[key];
    }
  });

  // Find associations
  const associations = [];

  const orderVoucher = (invoice.relatedVouchers || []).find(
    v => v.voucherType === 'orderconfirmation'
  );

  if (orderVoucher) {
    console.log('[invoice-sync] Found related order confirmation:', orderVoucher.id);

    const hsOrder = await searchHubSpotObject(
      'orders', 'hs_external_order_id', orderVoucher.id,
      ['hs_external_order_id', 'hs_order_name'], HUBSPOT_TOKEN
    );

    if (hsOrder) {
      addAssoc(associations, 'orders', hsOrder.id);
      console.log('[invoice-sync] Found HubSpot Order:', hsOrder.id, hsOrder.properties.hs_order_name);

      const [orderDeals, orderCompanies, orderContacts, orderQuotes] = await Promise.all([
        getAssociations('orders', hsOrder.id, 'deals', HUBSPOT_TOKEN),
        getAssociations('orders', hsOrder.id, 'companies', HUBSPOT_TOKEN),
        getAssociations('orders', hsOrder.id, 'contacts', HUBSPOT_TOKEN),
        getAssociations('orders', hsOrder.id, 'quotes', HUBSPOT_TOKEN)
      ]);

      orderDeals.forEach(d => addAssoc(associations, 'deals', d.id));
      orderCompanies.forEach(c => addAssoc(associations, 'companies', c.id));
      orderContacts.forEach(c => addAssoc(associations, 'contacts', c.id));
      orderQuotes.forEach(q => addAssoc(associations, 'quotes', q.id));

      console.log('[invoice-sync] Inherited from Order:',
        orderDeals.length, 'deals,', orderCompanies.length, 'companies,',
        orderContacts.length, 'contacts,', orderQuotes.length, 'quotes');
    } else {
      console.log('[invoice-sync] Order not found in HubSpot for', orderVoucher.id);
    }
  }

  const hasCompany = associations.some(a => a.type === 'companies');

  if (!hasCompany) {
    const lexContactId = invoice.address?.contactId;

    if (lexContactId) {
      console.log('[invoice-sync] Fallback: searching Company by kunden_id:', lexContactId);

      const hsCompany = await searchHubSpotObject(
        'companies', 'kunden_id', lexContactId,
        ['kunden_id', 'name'], HUBSPOT_TOKEN
      );

      if (hsCompany) {
        addAssoc(associations, 'companies', hsCompany.id);
        console.log('[invoice-sync] Found Company via kunden_id:', hsCompany.id, hsCompany.properties.name);
      } else {
        console.log('[invoice-sync] No Company found for kunden_id:', lexContactId);
      }
    } else {
      console.log('[invoice-sync] No contactId on invoice (Sammelkunde?)');
    }
  }

  // Append forced associations from manual sync (deal/company picked by user)
  for (const forced of forcedAssociations) {
    addAssoc(associations, forced.type, forced.id);
  }

  console.log('[invoice-sync] Creating Invoice:', invoice.voucherNumber,
    'associations:', associations.length, 'forced:', forcedAssociations.length);

  const createBody = { properties };

  const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createBody)
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    // HubSpot search index lag: invoice already exists from a prior attempt but search didn't find it.
    // Extract the existing HubSpot id from the error and treat as already created.
    const dupMatch = errText.match(/(\d+) already has that value/);
    if (createRes.status === 400 && dupMatch) {
      const existingId = dupMatch[1];
      console.log('[invoice-sync] Invoice already exists (search index lag):', existingId);
      // Still try to add forced associations to the existing invoice
      const assocResults = [];
      for (const assoc of associations) {
        const ok = await createDefaultAssociation('invoices', existingId, assoc.type, assoc.id, HUBSPOT_TOKEN);
        assocResults.push({ type: assoc.type, id: assoc.id, ok });
      }
      return { hsInvoiceId: existingId, voucherNumber: invoice.voucherNumber, hsStatus, assocResults, alreadyExisted: true };
    }
    console.error('[invoice-sync] HubSpot invoice create error', createRes.status, errText);
    throw new Error('HubSpot invoice create failed: ' + errText);
  }

  const created = await createRes.json();
  const hsInvoiceId = created.id;
  console.log('[invoice-sync] Created HubSpot Invoice:', hsInvoiceId);

  const assocResults = [];
  for (const assoc of associations) {
    const ok = await createDefaultAssociation('invoices', hsInvoiceId, assoc.type, assoc.id, HUBSPOT_TOKEN);
    assocResults.push({ type: assoc.type, id: assoc.id, ok });
  }

  console.log('[invoice-sync] Done:', invoice.voucherNumber, '→ HubSpot', hsInvoiceId,
    'with', assocResults.filter(a => a.ok).length + '/' + assocResults.length, 'associations');

  return { hsInvoiceId, voucherNumber: invoice.voucherNumber, hsStatus, assocResults };
}

// ============================================================
// External vouchers (voucherType = "salesinvoice", e.g. JU-xxxxxx from Junico).
// These live under /v1/vouchers/{id} with a flat schema:
//   { voucherNumber, voucherDate, voucherStatus, contactId,
//     totalGrossAmount, totalTaxAmount, ... }
// They have no relatedVouchers / order confirmations, so the only
// auto-association is via contactId → HubSpot company kunden_id.
// forcedAssociations is appended (deal/company picked by user).
// ============================================================
export async function createHubSpotInvoiceFromVoucher(voucher, resourceId, HUBSPOT_TOKEN, forcedAssociations = [], serviceMonth = null) {
  const hsStatus = LEXOFFICE_STATUS_MAP[voucher.voucherStatus] || 'open';
  const totalGross = voucher.totalGrossAmount ?? 0;
  const totalTax = voucher.totalTaxAmount ?? 0;
  const totalNet = totalGross - totalTax;

  // For external salesinvoice vouchers (JU-xxxxxx) the user picks the service
  // month manually in the monthly overview UI — we use that as the period.
  let serviceFrom = null;
  let serviceTo = null;
  if (serviceMonth && /^\d{4}-\d{2}$/.test(serviceMonth)) {
    const [yy, mm] = serviceMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    serviceFrom = `${serviceMonth}-01`;
    serviceTo = `${serviceMonth}-${String(lastDay).padStart(2, '0')}`;
  }

  const properties = {
    hs_currency: voucher.currency || 'EUR',
    hs_invoice_billable: 'false',
    hs_invoice_status: hsStatus,
    hs_invoice_date: voucher.voucherDate ? voucher.voucherDate.split('T')[0] : null,
    hs_external_createdate: voucher.createdDate || null,
    hs_amount_billed: String(totalGross),
    amount_open: String(totalGross),
    lex_amount_net: String(totalNet),
    lex_amount_tax: String(totalTax),
    lex_voucher_type: 'salesinvoice',
    hs_number: voucher.voucherNumber,
    lexoffice_invoice_id: resourceId,
    url_lexoffice_invoice: 'https://app.lexoffice.de/vouchers#!/VoucherView/Salesinvoice/' + resourceId,
    lex_service_from: serviceFrom,
    lex_service_to: serviceTo,
  };

  if (voucher.dueDate) {
    properties.hs_due_date = voucher.dueDate.split('T')[0];
  }

  Object.keys(properties).forEach(k => {
    if (properties[k] === null || properties[k] === undefined) delete properties[k];
  });

  const associations = [];

  // Auto-link via contactId → HubSpot company kunden_id
  if (voucher.contactId) {
    const hsCompany = await searchHubSpotObject(
      'companies', 'kunden_id', voucher.contactId,
      ['kunden_id', 'name'], HUBSPOT_TOKEN
    );
    if (hsCompany) {
      addAssoc(associations, 'companies', hsCompany.id);
      console.log('[invoice-sync salesinvoice] Found Company via kunden_id:', hsCompany.id, hsCompany.properties.name);
    }
  }

  for (const f of forcedAssociations) {
    addAssoc(associations, f.type, f.id);
  }

  console.log('[invoice-sync salesinvoice] Creating Invoice:', voucher.voucherNumber,
    'associations:', associations.length, 'forced:', forcedAssociations.length);

  const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    const dupMatch = errText.match(/(\d+) already has that value/);
    if (createRes.status === 400 && dupMatch) {
      const existingId = dupMatch[1];
      console.log('[invoice-sync salesinvoice] Already exists (search index lag):', existingId);
      const assocResults = [];
      for (const a of associations) {
        const ok = await createDefaultAssociation('invoices', existingId, a.type, a.id, HUBSPOT_TOKEN);
        assocResults.push({ type: a.type, id: a.id, ok });
      }
      return { hsInvoiceId: existingId, voucherNumber: voucher.voucherNumber, hsStatus, assocResults, alreadyExisted: true };
    }
    throw new Error('HubSpot invoice create failed: ' + errText);
  }

  const created = await createRes.json();
  const hsInvoiceId = created.id;
  console.log('[invoice-sync salesinvoice] Created HubSpot Invoice:', hsInvoiceId);

  const assocResults = [];
  for (const a of associations) {
    const ok = await createDefaultAssociation('invoices', hsInvoiceId, a.type, a.id, HUBSPOT_TOKEN);
    assocResults.push({ type: a.type, id: a.id, ok });
  }

  return { hsInvoiceId, voucherNumber: voucher.voucherNumber, hsStatus, assocResults };
}

