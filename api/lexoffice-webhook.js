// lexoffice-proxy/api/lexoffice-webhook.js
// Receives Lexoffice webhooks:
//   - invoice.created → creates Invoice in HubSpot with associations (Company, Deal, Contact, Order)
//   - invoice.changed → syncs all invoice properties to HubSpot (status, amounts, dates, payment)
//   - order-confirmation.status.changed → updates HubSpot Order object (0-123)
//
// Rate limit strategy: No self-retry on 429. Error bubbles up → Lexoffice retries after 10/20/40/80/160s.
// invoice.status.changed is kept in router for backwards compat but subscription is removed (redundant with invoice.changed).

import { LEXOFFICE_STATUS_MAP, createDefaultAssociation } from '../lib/shared.js';
import { createHubSpotInvoice, fetchLexoffice, searchHubSpotObject, getAssociations } from '../lib/invoice-sync.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedToken = process.env.WEBHOOK_SECRET;
  if (expectedToken && req.query.token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  const LEXOFFICE_TOKEN = process.env.LEXOFFICE_API_KEY;

  if (!HUBSPOT_TOKEN || !LEXOFFICE_TOKEN) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  try {
    const { eventType, resourceId, organizationId, eventDate } = req.body;
    console.log('[lexoffice-webhook] Event:', eventType, 'resourceId:', resourceId);

    if (!resourceId) {
      return res.status(400).json({ error: 'Missing resourceId' });
    }

    // Route to the correct handler
    if (eventType === 'invoice.created') {
      return await handleInvoiceCreated(req, res, { resourceId, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath: '/v1/invoices/' });
    } else if (eventType === 'invoice.status.changed' || eventType === 'invoice.changed') {
      return await handleInvoiceStatusChanged(req, res, { resourceId, eventDate, eventType, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath: '/v1/invoices/' });
    } else if (eventType === 'down-payment-invoice.created') {
      return await handleInvoiceCreated(req, res, { resourceId, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath: '/v1/down-payment-invoices/' });
    } else if (eventType === 'down-payment-invoice.changed' || eventType === 'down-payment-invoice.status.changed') {
      return await handleInvoiceStatusChanged(req, res, { resourceId, eventDate, eventType, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath: '/v1/down-payment-invoices/' });
    } else if (eventType === 'order-confirmation.status.changed') {
      return await handleOrderConfirmationStatusChanged(req, res, { resourceId, eventDate, HUBSPOT_TOKEN, LEXOFFICE_TOKEN });
    } else {
      return res.status(200).json({ ok: true, skipped: true, reason: 'Unhandled eventType: ' + eventType });
    }

  } catch (err) {
    console.error('[lexoffice-webhook] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// Helpers (fetchLexoffice, searchHubSpotObject, getAssociations, createHubSpotInvoice)
// are imported from ../lib/invoice-sync.js


// ============================================================
// INVOICE CREATED — skip drafts, create finalized invoices
// ============================================================
async function handleInvoiceCreated(req, res, { resourceId, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath = '/v1/invoices/' }) {
  // 1. Check if invoice already exists in HubSpot (duplicate protection)
  const existing = await searchHubSpotObject(
    'invoices', 'lexoffice_invoice_id', resourceId,
    ['lexoffice_invoice_id'], HUBSPOT_TOKEN
  );

  if (existing) {
    console.log('[lexoffice-webhook] Invoice already exists in HubSpot:', existing.id);
    return res.status(200).json({ ok: true, action: 'skipped', reason: 'already exists', hsId: existing.id });
  }

  // 2. Fetch invoice from Lexoffice
  const invoice = await fetchLexoffice(lexPath + resourceId, LEXOFFICE_TOKEN);
  console.log('[lexoffice-webhook] Invoice created:', invoice.voucherNumber, 'status:', invoice.voucherStatus);

  // 3. Skip drafts — HubSpot invoice will be created when finalized (via invoice.changed)
  if (invoice.voucherStatus === 'draft') {
    console.log('[lexoffice-webhook] Skipping draft invoice:', invoice.voucherNumber);
    return res.status(200).json({ ok: true, skipped: true, reason: 'draft' });
  }

  // 4. Create in HubSpot
  const result = await createHubSpotInvoice(invoice, resourceId, HUBSPOT_TOKEN);

  return res.status(200).json({
    ok: true,
    type: 'invoice',
    action: 'created',
    hsId: result.hsInvoiceId,
    voucherNumber: result.voucherNumber,
    status: result.hsStatus,
    associations: result.assocResults
  });
}


// ============================================================
// INVOICE STATUS CHANGED
// ============================================================
async function handleInvoiceStatusChanged(req, res, { resourceId, eventDate, eventType, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath = '/v1/invoices/' }) {
  // Handles both invoice.status.changed and invoice.changed
  // 1. Fetch invoice from Lexoffice
  const lexInvoice = await fetchLexoffice(lexPath + resourceId, LEXOFFICE_TOKEN);
  const lexStatus = lexInvoice.voucherStatus;
  const totalGross = lexInvoice.totalPrice?.totalGrossAmount ?? 0;

  console.log('[lexoffice-webhook]', eventType, '→ status:', lexStatus, 'gross:', totalGross);

  // 2. Fetch payment info (real payment date = Überweisungsdatum)
  let paymentDate = null;
  let openAmount = null;

  try {
    const payData = await fetchLexoffice('/v1/payments/' + resourceId, LEXOFFICE_TOKEN);
    openAmount = payData.openAmount ?? null;

    if (payData.paidDate) {
      paymentDate = payData.paidDate;
    } else if (payData.paymentItems && payData.paymentItems.length > 0) {
      const sorted = payData.paymentItems
        .filter(item => item.postingDate)
        .sort((a, b) => new Date(b.postingDate) - new Date(a.postingDate));
      if (sorted.length > 0) {
        paymentDate = sorted[0].postingDate;
      }
    }
    console.log('[lexoffice-webhook] Payments: openAmount:', openAmount, 'paymentDate:', paymentDate);
  } catch (e) {
    console.log('[lexoffice-webhook] Payments endpoint error:', e.message);
    if (lexStatus === 'paid' || lexStatus === 'paidoff') {
      openAmount = 0;
    } else if (lexStatus === 'open' || lexStatus === 'overdue') {
      openAmount = totalGross;
    }
  }

  // 3. Search HubSpot invoice
  const hsInvoice = await searchHubSpotObject(
    'invoices', 'lexoffice_invoice_id', resourceId,
    ['lexoffice_invoice_id', 'hs_invoice_status', 'amount_open', 'hs_amount_billed', 'hs_invoice_date', 'hs_due_date', 'lex_service_from', 'lex_service_to'], HUBSPOT_TOKEN
  );

  if (!hsInvoice) {
    // No HubSpot invoice yet — create it if no longer draft (was skipped during invoice.created)
    if (lexStatus !== 'draft') {
      // Wait 3s before creating — avoids race condition with invoice.created which may have
      // just created the invoice but HubSpot search index hasn't caught up yet
      await new Promise(r => setTimeout(r, 3000));
      const doubleCheck = await searchHubSpotObject(
        'invoices', 'lexoffice_invoice_id', resourceId,
        ['lexoffice_invoice_id'], HUBSPOT_TOKEN
      );
      if (doubleCheck) {
        console.log('[lexoffice-webhook] Invoice already created by invoice.created event:', doubleCheck.id);
        return res.status(200).json({ ok: true, action: 'skipped', reason: 'created by invoice.created', hsId: doubleCheck.id });
      }
      console.log('[lexoffice-webhook] No HubSpot invoice for', resourceId, '— creating now (status:', lexStatus + ', path:', lexPath + ')');
      const result = await createHubSpotInvoice(lexInvoice, resourceId, HUBSPOT_TOKEN);
      return res.status(200).json({
        ok: true,
        type: 'invoice',
        action: 'created',
        hsId: result.hsInvoiceId,
        voucherNumber: result.voucherNumber,
        status: result.hsStatus,
        associations: result.assocResults
      });
    }
    console.log('[lexoffice-webhook] No HubSpot invoice for', resourceId, '(still draft, skipping)');
    return res.status(200).json({ ok: true, skipped: true, reason: 'draft' });
  }

  const hsInvoiceId = hsInvoice.id;
  const currentStatus = hsInvoice.properties.hs_invoice_status;
  const currentOpen = parseFloat(hsInvoice.properties.amount_open) || 0;
  const currentBilled = parseFloat(hsInvoice.properties.hs_amount_billed) || 0;

  // 4. Map status
  const newStatus = LEXOFFICE_STATUS_MAP[lexStatus] || 'open';

  // 5. Build update
  const update = {};

  if (newStatus !== currentStatus) {
    update.hs_invoice_status = newStatus;
  }

  if (openAmount !== null && openAmount !== currentOpen) {
    update.amount_open = openAmount;
  }

  // Always sync hs_amount_billed (may have been 0 after create)
  if (totalGross && totalGross !== currentBilled) {
    update.hs_amount_billed = String(totalGross);
  }

  // Sync invoice date and due date (relevant for invoice.changed)
  const lexInvoiceDate = lexInvoice.voucherDate ? lexInvoice.voucherDate.split('T')[0] : null;
  if (lexInvoiceDate && lexInvoiceDate !== (hsInvoice.properties.hs_invoice_date || '').split('T')[0]) {
    update.hs_invoice_date = lexInvoiceDate;
  }

  let dueDate = null;
  if (lexInvoice.paymentConditions?.paymentTermDuration != null && lexInvoice.voucherDate) {
    const vDate = new Date(lexInvoice.voucherDate);
    vDate.setDate(vDate.getDate() + lexInvoice.paymentConditions.paymentTermDuration);
    dueDate = vDate.toISOString().split('T')[0];
  }
  if (dueDate && dueDate !== (hsInvoice.properties.hs_due_date || '').split('T')[0]) {
    update.hs_due_date = dueDate;
  }

  // Sync service period (Leistungszeitraum)
  const sc = lexInvoice.shippingConditions || {};
  const newFrom = sc.shippingDate ? sc.shippingDate.split('T')[0] : null;
  const newTo = sc.shippingEndDate ? sc.shippingEndDate.split('T')[0] : null;
  if (newFrom && newFrom !== (hsInvoice.properties.lex_service_from || '').split('T')[0]) {
    update.lex_service_from = newFrom;
  }
  if (newTo && newTo !== (hsInvoice.properties.lex_service_to || '').split('T')[0]) {
    update.lex_service_to = newTo;
  }

  if (newStatus === 'paid' && currentStatus !== 'paid') {
    if (paymentDate) {
      update.hs_payment_date = paymentDate;
    } else {
      update.hs_payment_date = eventDate || new Date().toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    console.log('[lexoffice-webhook] No invoice changes for', hsInvoiceId);
    return res.status(200).json({ ok: true, type: 'invoice', hsId: hsInvoiceId, changed: false });
  }

  // 6. Update HubSpot
  console.log('[lexoffice-webhook] Updating invoice', hsInvoiceId, JSON.stringify(update));

  let updateRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/' + hsInvoiceId, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: update })
  });

  // If update fails because of missing line items (can't finalize without them),
  // retry without hs_invoice_status to still sync amounts and dates
  if (!updateRes.ok && update.hs_invoice_status) {
    const errText = await updateRes.text();
    if (errText.includes('INVOICE_TO_LINE_ITEM')) {
      console.log('[lexoffice-webhook] Line item validation error, retrying without status change');
      delete update.hs_invoice_status;

      if (Object.keys(update).length > 0) {
        updateRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/' + hsInvoiceId, {
          method: 'PATCH',
          headers: {
            'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ properties: update })
        });

        if (!updateRes.ok) {
          const errText2 = await updateRes.text();
          console.error('[lexoffice-webhook] HubSpot invoice update error (retry)', updateRes.status, errText2);
          return res.status(502).json({ error: 'HubSpot invoice update failed', details: errText2 });
        }
      } else {
        console.log('[lexoffice-webhook] No remaining fields to update');
        return res.status(200).json({ ok: true, type: 'invoice', hsId: hsInvoiceId, changed: false, note: 'status skipped (no line items)' });
      }
    } else {
      console.error('[lexoffice-webhook] HubSpot invoice update error', updateRes.status, errText);
      return res.status(502).json({ error: 'HubSpot invoice update failed', details: errText });
    }
  } else if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error('[lexoffice-webhook] HubSpot invoice update error', updateRes.status, errText);
    return res.status(502).json({ error: 'HubSpot invoice update failed', details: errText });
  }

  console.log('[lexoffice-webhook] Done invoice', hsInvoiceId, currentStatus, '->', newStatus);

  return res.status(200).json({
    ok: true,
    type: 'invoice',
    hsId: hsInvoiceId,
    statusChange: currentStatus + ' -> ' + newStatus,
    openAmount: openAmount,
    paymentDate: paymentDate,
    updatedFields: Object.keys(update)
  });
}


// ============================================================
// ORDER CONFIRMATION STATUS CHANGED
// ============================================================
async function handleOrderConfirmationStatusChanged(req, res, { resourceId, eventDate, HUBSPOT_TOKEN, LEXOFFICE_TOKEN }) {
  // 1. Fetch order confirmation from Lexoffice
  const lexOrder = await fetchLexoffice('/v1/order-confirmations/' + resourceId, LEXOFFICE_TOKEN);
  const lexStatus = lexOrder.voucherStatus;

  console.log('[lexoffice-webhook] Order confirmation status:', lexStatus);

  // 2. Search HubSpot order
  const hsOrder = await searchHubSpotObject(
    'orders', 'hs_external_order_id', resourceId,
    ['hs_external_order_id', 'hs_external_order_status', 'hs_order_name'], HUBSPOT_TOKEN
  );

  if (!hsOrder) {
    console.log('[lexoffice-webhook] No HubSpot order for', resourceId);
    return res.status(404).json({ error: 'Order not found in HubSpot' });
  }

  const hsOrderId = hsOrder.id;
  const currentStatus = hsOrder.properties.hs_external_order_status;
  const orderName = hsOrder.properties.hs_order_name;

  // 3. Build update — pass through Lexoffice status directly
  const update = {};

  if (lexStatus && lexStatus !== currentStatus) {
    update.hs_external_order_status = lexStatus;
  }

  // Move pipeline stage to "Verarbeitet" when no longer draft
  if (lexStatus && lexStatus !== 'draft') {
    update.hs_pipeline_stage = '2220863725'; // Verarbeitet
  }

  if (Object.keys(update).length === 0) {
    console.log('[lexoffice-webhook] No order changes for', hsOrderId, '(' + orderName + ')');
    return res.status(200).json({ ok: true, type: 'order', hsId: hsOrderId, orderName, changed: false });
  }

  // 4. Update HubSpot
  console.log('[lexoffice-webhook] Updating order', hsOrderId, '(' + orderName + ')', JSON.stringify(update));

  const updateRes = await fetch('https://api.hubapi.com/crm/v3/objects/orders/' + hsOrderId, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: update })
  });

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error('[lexoffice-webhook] HubSpot order update error', updateRes.status, errText);
    return res.status(502).json({ error: 'HubSpot order update failed', details: errText });
  }

  console.log('[lexoffice-webhook] Done order', hsOrderId, '(' + orderName + ')', currentStatus, '->', lexStatus);

  return res.status(200).json({
    ok: true,
    type: 'order',
    hsId: hsOrderId,
    orderName,
    statusChange: currentStatus + ' -> ' + lexStatus,
    updatedFields: Object.keys(update)
  });
}
