// Combined endpoint for manually linking Lexoffice invoices to HubSpot deals.
//
// GET  ?companyId={hsCompanyId}&month=YYYY-MM&portalId=143405850
//      → list Lexoffice invoices for this company in the given month
//        that are NOT yet synced to HubSpot.
//
// POST ?portalId=143405850
//      Body: { lexofficeInvoiceId, dealId?, companyId? }
//      → sync the picked Lexoffice invoice into HubSpot, force-associating
//        it with the given deal/company (used by the monthly overview UI).
//
// Reuses createHubSpotInvoice() from lib/invoice-sync.js so the same logic
// as the webhook applies (Order/Deal/Company/Contact/Quote auto-resolution),
// plus the forced associations from the manual link click.

import { checkOrigin } from './_middleware.js';
import { createHubSpotInvoice, createHubSpotInvoiceFromVoucher, fetchLexoffice, searchHubSpotObject } from '../lib/invoice-sync.js';
import { createDefaultAssociation } from '../lib/shared.js';
import { lexofficeBatch, lexofficeFetch } from '../lib/lexoffice-batch.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkOrigin(req, res)) return;

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  const LEXOFFICE_TOKEN = process.env.LEXOFFICE_API_KEY;
  if (!HUBSPOT_TOKEN || !LEXOFFICE_TOKEN) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  if (req.method === 'GET') {
    if (req.query.action === 'create-properties') {
      return await handleCreateProperties(req, res, HUBSPOT_TOKEN);
    }
    if (req.query.action === 'backfill-service-period') {
      return await handleBackfillServicePeriod(req, res, HUBSPOT_TOKEN, LEXOFFICE_TOKEN);
    }
    if (req.query.action === 'backfill-salesinvoice-period') {
      return await handleBackfillSalesinvoicePeriod(req, res, HUBSPOT_TOKEN);
    }
    if (req.query.action === 'unlink') {
      return await handleUnlink(req, res, HUBSPOT_TOKEN);
    }
    if (req.query.action === 'inspect') {
      return await handleInspect(req, res, HUBSPOT_TOKEN);
    }
    if (req.query.action === 'inspect-lex') {
      return await handleInspectLex(req, res, LEXOFFICE_TOKEN);
    }
    if (req.query.action === 'inspect-li') {
      return await handleInspectLineItem(req, res, HUBSPOT_TOKEN);
    }
    return await handleList(req, res, HUBSPOT_TOKEN, LEXOFFICE_TOKEN);
  }
  if (req.method === 'POST') {
    return await handleSync(req, res, HUBSPOT_TOKEN, LEXOFFICE_TOKEN);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ============================================================
// One-shot: Create custom HubSpot invoice properties
// GET ?action=create-properties&portalId=143405850
// ============================================================
async function handleCreateProperties(req, res, HUBSPOT_TOKEN) {
  const props = [
    { name: 'lex_service_from', label: 'Leistungszeitraum von', type: 'date', fieldType: 'date', groupName: 'invoiceinformation', description: 'Leistungszeitraum-Beginn aus Lexoffice (shippingConditions.shippingDate)' },
    { name: 'lex_service_to',   label: 'Leistungszeitraum bis', type: 'date', fieldType: 'date', groupName: 'invoiceinformation', description: 'Leistungszeitraum-Ende aus Lexoffice (shippingConditions.shippingEndDate)' },
  ];
  const results = [];
  for (const p of props) {
    const r = await fetch('https://api.hubapi.com/crm/v3/properties/invoices', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    if (r.ok) {
      results.push({ name: p.name, status: 'created' });
    } else {
      const text = await r.text();
      if (r.status === 409 || text.includes('already exists') || text.includes('PROPERTY_DOESNT_EXIST') === false && text.includes('already')) {
        results.push({ name: p.name, status: 'exists' });
      } else {
        results.push({ name: p.name, status: 'error', code: r.status, error: text });
      }
    }
  }
  return res.status(200).json({ ok: true, results });
}

// ============================================================
// One-shot backfill: fill lex_service_from / lex_service_to on existing
// HubSpot invoices that have a lexoffice_invoice_id but no service period.
// GET ?action=backfill-service-period&portalId=143405850&dryRun=true&limit=100
// ============================================================
async function handleBackfillServicePeriod(req, res, HUBSPOT_TOKEN, LEXOFFICE_TOKEN) {
  const dryRun = req.query.dryRun === 'true';
  const limit = parseInt(req.query.limit, 10) || 100;

  // Search HubSpot for invoices with lexoffice_invoice_id but empty lex_service_from
  const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/search', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [{
        filters: [
          { propertyName: 'lexoffice_invoice_id', operator: 'HAS_PROPERTY' },
          { propertyName: 'lex_service_from', operator: 'NOT_HAS_PROPERTY' },
        ],
      }],
      properties: ['lexoffice_invoice_id', 'hs_number', 'lex_voucher_type'],
      limit,
    }),
  });
  if (!searchRes.ok) {
    const text = await searchRes.text();
    return res.status(500).json({ error: 'HubSpot search failed: ' + text });
  }
  const searchData = await searchRes.json();
  const candidates = (searchData.results || []).filter(r =>
    // Skip salesinvoice — Lexoffice has no service period for /v1/vouchers/
    r.properties?.lex_voucher_type !== 'salesinvoice'
  );

  if (candidates.length === 0) {
    return res.status(200).json({ ok: true, total: searchData.total ?? 0, candidates: 0, dryRun, results: [] });
  }

  // Batch-fetch invoice details from Lexoffice
  const details = await lexofficeBatch(
    candidates.map(c => '/v1/invoices/' + c.properties.lexoffice_invoice_id),
    LEXOFFICE_TOKEN
  );

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let inv = details[i];
    // Fallback: invoice not under /v1/invoices/ → try /v1/down-payment-invoices/
    if (!inv) {
      inv = await lexofficeFetch('/v1/down-payment-invoices/' + c.properties.lexoffice_invoice_id, LEXOFFICE_TOKEN);
    }
    if (!inv) {
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, status: 'lexoffice-fetch-failed' });
      continue;
    }
    const sc = inv.shippingConditions || {};
    const from = sc.shippingDate ? sc.shippingDate.split('T')[0] : null;
    const to = sc.shippingEndDate ? sc.shippingEndDate.split('T')[0] : null;
    if (!from && !to) {
      results.push({
        hsId: c.id,
        voucherNumber: c.properties.hs_number,
        status: 'no-service-period',
        shippingConditions: inv.shippingConditions || null,
        voucherDate: inv.voucherDate || null,
      });
      continue;
    }
    if (dryRun) {
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, from, to, status: 'would-update' });
      continue;
    }
    const update = {};
    if (from) update.lex_service_from = from;
    if (to) update.lex_service_to = to;
    const patchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/' + c.id, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: update }),
    });
    if (patchRes.ok) {
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, from, to, status: 'updated' });
    } else {
      const text = await patchRes.text();
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, status: 'patch-failed', error: text });
    }
  }

  return res.status(200).json({
    ok: true,
    total: searchData.total ?? 0,
    candidates: candidates.length,
    dryRun,
    results,
  });
}

// ============================================================
// One-shot backfill for salesinvoice (JU-xxx) vouchers:
// these have no service period in Lexoffice, but typically each invoice
// covers exactly one month — the month BEFORE the voucherDate (e.g.
// invoice issued 2026-04-07 covers March 2026). We group by company and
// assign service periods chronologically.
//
// GET ?action=backfill-salesinvoice-period&portalId=143405850&dryRun=true
// ============================================================
async function handleBackfillSalesinvoicePeriod(req, res, HUBSPOT_TOKEN) {
  const dryRun = req.query.dryRun === 'true';

  const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/search', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [{
        filters: [
          { propertyName: 'lex_voucher_type', operator: 'EQ', value: 'salesinvoice' },
          { propertyName: 'lex_service_from', operator: 'NOT_HAS_PROPERTY' },
        ],
      }],
      properties: ['hs_number', 'hs_invoice_date', 'lex_voucher_type'],
      limit: 200,
    }),
  });
  if (!searchRes.ok) {
    const text = await searchRes.text();
    return res.status(500).json({ error: 'HubSpot search failed: ' + text });
  }
  const searchData = await searchRes.json();
  const candidates = searchData.results || [];

  const results = [];
  for (const c of candidates) {
    const voucherDate = c.properties?.hs_invoice_date;
    if (!voucherDate) {
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, status: 'no-voucher-date' });
      continue;
    }
    // Service period = month BEFORE voucherDate
    const [yy, mm] = voucherDate.split('-').map(Number);
    // mm is 1-12; previous month: handle January → December of previous year
    const prevMonthDate = new Date(Date.UTC(yy, mm - 2, 1));
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth() + 1; // 1-12
    const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
    const from = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
    const to = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    if (dryRun) {
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, voucherDate, from, to, status: 'would-update' });
      continue;
    }
    const patchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/' + c.id, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { lex_service_from: from, lex_service_to: to } }),
    });
    if (patchRes.ok) {
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, voucherDate, from, to, status: 'updated' });
    } else {
      const text = await patchRes.text();
      results.push({ hsId: c.id, voucherNumber: c.properties.hs_number, status: 'patch-failed', error: text });
    }
  }

  return res.status(200).json({ ok: true, total: candidates.length, dryRun, results });
}

// ============================================================
// Unlink an invoice from a deal.
// GET ?action=unlink&voucherNumber=RE-202412-105&dealId=286781994208&portalId=...
// or  ?action=unlink&hsInvoiceId=...&dealId=...
// ============================================================
async function handleUnlink(req, res, HUBSPOT_TOKEN) {
  const { voucherNumber, hsInvoiceId, dealId } = req.query;
  if (!dealId || (!voucherNumber && !hsInvoiceId)) {
    return res.status(400).json({ error: 'dealId and voucherNumber or hsInvoiceId required' });
  }
  let invId = hsInvoiceId;
  if (!invId) {
    const sr = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/search', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'hs_number', operator: 'EQ', value: voucherNumber }] }],
        properties: ['hs_number'],
        limit: 5,
      }),
    });
    const sd = await sr.json();
    if (!sd.results || sd.results.length === 0) {
      return res.status(404).json({ error: 'Invoice not found by voucherNumber: ' + voucherNumber });
    }
    if (sd.results.length > 1) {
      return res.status(400).json({ error: 'Multiple matches', candidates: sd.results.map(r => r.id) });
    }
    invId = sd.results[0].id;
  }
  const dr = await fetch(
    'https://api.hubapi.com/crm/v4/objects/invoices/' + invId + '/associations/deals/' + dealId,
    { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN } }
  );
  if (!dr.ok && dr.status !== 204) {
    const text = await dr.text();
    return res.status(500).json({ error: 'Unlink failed: ' + text });
  }
  return res.status(200).json({ ok: true, hsInvoiceId: invId, dealId, status: 'unlinked' });
}

async function handleInspectLineItem(req, res, HUBSPOT_TOKEN) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/line_items/' + id + '?properties=name,recurringbillingfrequency,hs_recurring_billing_period,quantity,price,hs_sku', {
    headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN },
  });
  if (!r.ok) return res.status(r.status).json({ error: await r.text() });
  return res.status(200).json(await r.json());
}

async function handleInspectLex(req, res, LEXOFFICE_TOKEN) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const r = await fetch('https://api.lexware.io/v1/invoices/' + id, {
    headers: { 'Authorization': 'Bearer ' + LEXOFFICE_TOKEN, 'Accept': 'application/json' },
  });
  if (!r.ok) return res.status(r.status).json({ error: await r.text() });
  const inv = await r.json();
  return res.status(200).json({
    voucherNumber: inv.voucherNumber,
    voucherDate: inv.voucherDate,
    lineItems: (inv.lineItems || []).map(li => ({
      name: li.name,
      quantity: li.quantity,
      unitName: li.unitName,
      netAmount: li.unitPrice?.netAmount,
    })),
    shippingConditions: inv.shippingConditions,
  });
}

async function handleInspect(req, res, HUBSPOT_TOKEN) {
  const { voucherNumber } = req.query;
  if (!voucherNumber) return res.status(400).json({ error: 'voucherNumber required' });
  const sr = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/search', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'hs_number', operator: 'EQ', value: voucherNumber }] }],
      properties: ['hs_number', 'lex_service_from', 'lex_service_to', 'hs_invoice_date', 'lex_voucher_type', 'lexoffice_invoice_id'],
      limit: 5,
    }),
  });
  const sd = await sr.json();
  const out = [];
  for (const r of sd.results || []) {
    const ar = await fetch('https://api.hubapi.com/crm/v4/objects/invoices/' + r.id + '/associations/deals', { headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN } });
    const ad = ar.ok ? await ar.json() : { results: [] };
    out.push({ id: r.id, properties: r.properties, deals: (ad.results || []).map(x => String(x.toObjectId)) });
  }
  return res.status(200).json({ ok: true, results: out });
}

async function handleList(req, res, HUBSPOT_TOKEN, LEXOFFICE_TOKEN) {
  const { companyId, month } = req.query;
  if (!companyId || !month) {
    return res.status(400).json({ error: 'Missing companyId or month (YYYY-MM)' });
  }

  try {
    const compRes = await fetch(
      'https://api.hubapi.com/crm/v3/objects/companies/' + companyId + '?properties=name,kunden_id',
      { headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN } }
    );
    if (!compRes.ok) {
      return res.status(404).json({ error: 'Company not found in HubSpot' });
    }
    const company = await compRes.json();
    const kundenId = company.properties?.kunden_id;
    const companyName = company.properties?.name;

    if (!kundenId) {
      return res.status(200).json({
        companyName,
        kundenId: null,
        invoices: [],
        warning: 'Company hat keine kunden_id — keine Verkn\u00fcpfung zu Lexoffice m\u00f6glich',
      });
    }

    // Server-side date window: month ± 1 (typical invoice is issued in the
    // month after the service period). We'll then narrow down to the exact
    // service period via per-invoice detail fetch (cheap because the window is small).
    const [yy, mm] = month.split('-').map(Number);
    const fromDate = new Date(yy, mm - 2, 1);
    const toDate = new Date(yy, mm + 1, 0); // last day of month+1
    const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    const voucherRes = await fetch(
      'https://api.lexware.io/v1/voucherlist'
        + '?voucherType=invoice,salesinvoice'
        + '&voucherStatus=open,paid,paidoff,voided'
        + '&contactId=' + kundenId
        + '&voucherDateFrom=' + fmt(fromDate)
        + '&voucherDateTo=' + fmt(toDate)
        + '&page=0&size=100',
      {
        headers: {
          'Authorization': 'Bearer ' + LEXOFFICE_TOKEN,
          'Accept': 'application/json',
        },
      }
    );
    if (!voucherRes.ok) {
      const text = await voucherRes.text();
      return res.status(500).json({ error: 'Lexoffice voucherlist failed: ' + text });
    }
    const voucherData = await voucherRes.json();
    const allVouchers = voucherData.content || [];

    if (allVouchers.length === 0) {
      return res.status(200).json({ companyName, kundenId, invoices: [] });
    }

    // Sort by voucherDate desc
    const sorted = [...allVouchers].sort((a, b) =>
      (b.voucherDate || '').localeCompare(a.voucherDate || '')
    );

    // Step 1: Look up all candidates in HubSpot first — we already store lex_service_from
    // there, so for synced invoices we don't need to call Lexoffice again.
    const allLexIds = sorted.map(v => v.id);
    const periodById = new Map();
    const hsByLexId = new Map();

    if (allLexIds.length > 0) {
      const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/search', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'lexoffice_invoice_id',
              operator: 'IN',
              values: allLexIds,
            }],
          }],
          properties: ['lexoffice_invoice_id', 'lex_service_from', 'lex_service_to'],
          limit: 100,
        }),
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        for (const r of searchData.results || []) {
          const lid = r.properties?.lexoffice_invoice_id;
          if (!lid) continue;
          hsByLexId.set(lid, r.id);
          if (r.properties.lex_service_from) {
            periodById.set(lid, {
              from: r.properties.lex_service_from.split('T')[0],
              to: r.properties.lex_service_to ? r.properties.lex_service_to.split('T')[0] : null,
            });
          }
        }
      }
    }

    // Step 2: For invoice-type vouchers NOT in HubSpot (or without service period there),
    // fetch shippingConditions from Lexoffice. salesinvoice (JU) is skipped.
    const needsFetch = sorted.filter(v =>
      v.voucherType === 'invoice' && !periodById.has(v.id)
    );
    if (needsFetch.length > 0) {
      const details = await lexofficeBatch(
        needsFetch.map(v => '/v1/invoices/' + v.id),
        LEXOFFICE_TOKEN
      );
      needsFetch.forEach((v, idx) => {
        const inv = details[idx];
        if (!inv) return;
        const sc = inv.shippingConditions || {};
        if (sc.shippingDate) {
          periodById.set(v.id, {
            from: sc.shippingDate.split('T')[0],
            to: sc.shippingEndDate ? sc.shippingEndDate.split('T')[0] : null,
          });
        }
      });
    }

    // Strict filter: keep invoices whose service period starts in the requested
    // month, and keep all salesinvoice vouchers (no service period available).
    const filtered = sorted.filter(v => {
      if (v.voucherType === 'salesinvoice') return true;
      const period = periodById.get(v.id);
      if (!period) return false;
      return period.from.startsWith(month);
    });

    if (filtered.length === 0) {
      return res.status(200).json({ companyName, kundenId, invoices: [] });
    }

    // For each HubSpot invoice, check which deals it is associated with (so we
    // can show "already linked" vs "in HubSpot but not linked to this deal")
    const dealsByHsId = new Map();
    for (const hsId of hsByLexId.values()) {
      try {
        const ar = await fetch(
          'https://api.hubapi.com/crm/v4/objects/invoices/' + hsId + '/associations/deals',
          { headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN } }
        );
        if (ar.ok) {
          const ad = await ar.json();
          dealsByHsId.set(hsId, (ad.results || []).map(r => String(r.toObjectId)));
        }
      } catch {}
    }

    const invoices = filtered.map(inv => {
      const hsId = hsByLexId.get(inv.id) || null;
      const linkedDealIds = hsId ? (dealsByHsId.get(hsId) || []) : [];
      const period = periodById.get(inv.id);
      return {
        id: inv.id,
        voucherNumber: inv.voucherNumber,
        voucherDate: inv.voucherDate ? inv.voucherDate.split('T')[0] : null,
        voucherStatus: inv.voucherStatus,
        totalAmount: inv.totalAmount ?? 0,
        contactName: inv.contactName || companyName,
        voucherType: inv.voucherType,
        servicePeriodFrom: period?.from || null,
        servicePeriodTo: period?.to || null,
        hubspotInvoiceId: hsId,
        linkedDealIds,
      };
    });

    return res.status(200).json({ companyName, kundenId, invoices });
  } catch (err) {
    console.error('[link-invoice list] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSync(req, res, HUBSPOT_TOKEN, LEXOFFICE_TOKEN) {
  const { lexofficeInvoiceId, dealId, companyId, voucherType, serviceMonth } = req.body || {};
  if (!lexofficeInvoiceId) {
    return res.status(400).json({ error: 'Missing lexofficeInvoiceId' });
  }

  try {
    // Dedup-check FIRST — for already-synced invoices we only need to add the
    // forced association and never have to fetch the full Lexoffice voucher.
    // This also allows linking external 'salesinvoice' vouchers (JU-xxxxxx) which
    // are not available under /v1/invoices/{id}.
    const existing = await searchHubSpotObject(
      'invoices', 'lexoffice_invoice_id', lexofficeInvoiceId,
      ['lexoffice_invoice_id', 'hs_number', 'lex_voucher_type', 'lex_service_from'], HUBSPOT_TOKEN
    );
    if (existing) {
      const assocResults = [];
      const forced = [];
      if (dealId) forced.push({ type: 'deals', id: String(dealId) });
      if (companyId) forced.push({ type: 'companies', id: String(companyId) });
      for (const a of forced) {
        const ok = await createDefaultAssociation('invoices', existing.id, a.type, a.id, HUBSPOT_TOKEN);
        assocResults.push({ type: a.type, id: a.id, ok });
      }

      // If salesinvoice without service period and user picked a month → set it
      if (
        existing.properties?.lex_voucher_type === 'salesinvoice'
        && !existing.properties?.lex_service_from
        && serviceMonth
        && /^\d{4}-\d{2}$/.test(serviceMonth)
      ) {
        const [yy, mm] = serviceMonth.split('-').map(Number);
        const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        await fetch('https://api.hubapi.com/crm/v3/objects/invoices/' + existing.id, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: {
            lex_service_from: `${serviceMonth}-01`,
            lex_service_to: `${serviceMonth}-${String(lastDay).padStart(2, '0')}`,
          }}),
        });
      }

      return res.status(200).json({
        ok: true,
        action: 'already-existed',
        hsInvoiceId: existing.id,
        voucherNumber: existing.properties?.hs_number,
        assocResults,
      });
    }

    // Not yet in HubSpot — fetch from Lexoffice and create.
    // Route by voucherType: regular invoices vs external "salesinvoice" vouchers
    // (JU-xxxxxx from Junico etc.) which live under /v1/vouchers/ with a flat schema.
    const forcedAssociations = [];
    if (dealId) forcedAssociations.push({ type: 'deals', id: String(dealId) });
    if (companyId) forcedAssociations.push({ type: 'companies', id: String(companyId) });

    let result;
    if (voucherType === 'salesinvoice') {
      const voucher = await fetchLexoffice('/v1/vouchers/' + lexofficeInvoiceId, LEXOFFICE_TOKEN);
      if (voucher.voucherStatus === 'draft') {
        return res.status(400).json({ error: 'Voucher is still a draft — finalize in Lexoffice first' });
      }
      result = await createHubSpotInvoiceFromVoucher(voucher, lexofficeInvoiceId, HUBSPOT_TOKEN, forcedAssociations, serviceMonth);
    } else {
      const invoice = await fetchLexoffice('/v1/invoices/' + lexofficeInvoiceId, LEXOFFICE_TOKEN);
      if (invoice.voucherStatus === 'draft') {
        return res.status(400).json({ error: 'Invoice is still a draft — finalize in Lexoffice first' });
      }
      result = await createHubSpotInvoice(invoice, lexofficeInvoiceId, HUBSPOT_TOKEN, forcedAssociations);
    }

    return res.status(200).json({
      ok: true,
      action: result.alreadyExisted ? 'already-existed' : 'created',
      hsInvoiceId: result.hsInvoiceId,
      voucherNumber: result.voucherNumber,
      assocResults: result.assocResults,
    });
  } catch (err) {
    console.error('[link-invoice sync] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
