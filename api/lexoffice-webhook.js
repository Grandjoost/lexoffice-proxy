// lexoffice-proxy/api/lexoffice-webhook.js
// Receives Lexoffice webhooks:
//   - invoice.created → creates Invoice in HubSpot with associations (Company, Deal, Contact, Order)
//   - invoice.changed → syncs all invoice properties to HubSpot (status, amounts, dates, payment)
//   - order-confirmation.status.changed → updates HubSpot Order object (0-123)
//
// Rate limit strategy: No self-retry on 429. Error bubbles up → Lexoffice retries after 10/20/40/80/160s.
// invoice.status.changed is kept in router for backwards compat but subscription is removed (redundant with invoice.changed).

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


// ============================================================
// HELPER: Fetch from Lexoffice API
// ============================================================
async function fetchLexoffice(path, token) {
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


// ============================================================
// HELPER: Search HubSpot for a single object by property value
// Returns the first result or null
// ============================================================
async function searchHubSpotObject(objectType, propertyName, value, properties, token) {
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


// ============================================================
// HELPER: Get associations for a HubSpot object
// Uses v4 API: GET /crm/v4/objects/{from}/{id}/associations/{to}
// Returns array of { id } objects
// ============================================================
async function getAssociations(fromType, fromId, toType, token) {
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
  // v4 returns { results: [{ toObjectId: "123", associationTypes: [...] }] }
  return (data.results || []).map(r => ({ id: String(r.toObjectId) }));
}


// ============================================================
// HELPER: Create default association (v4 API, no typeId needed)
// PUT /crm/v4/objects/{from}/{fromId}/associations/default/{to}/{toId}
// ============================================================
async function createDefaultAssociation(fromType, fromId, toType, toId, token) {
  const res = await fetch(
    'https://api.hubapi.com/crm/v4/objects/' + fromType + '/' + fromId + '/associations/default/' + toType + '/' + toId,
    {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token }
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('[hubspot-assoc] Failed to create association', fromType, fromId, '->', toType, toId, res.status, text);
    return false;
  }

  console.log('[hubspot-assoc] Created:', fromType, fromId, '->', toType, toId);
  return true;
}


// ============================================================
// HELPER: Create HubSpot Invoice from Lexoffice invoice data
// Shared by handleInvoiceCreated and handleInvoiceStatusChanged
// Returns { hsInvoiceId, voucherNumber, hsStatus, assocResults }
// ============================================================
async function createHubSpotInvoice(invoice, resourceId, HUBSPOT_TOKEN) {
  const statusMap = {
    'draft': 'draft',
    'open': 'open',
    'overdue': 'open',
    'paid': 'paid',
    'paidoff': 'voided',
    'voided': 'voided',
    'cancelled': 'voided'
  };
  const hsStatus = statusMap[invoice.voucherStatus] || 'open';

  let dueDate = null;
  if (invoice.paymentConditions?.paymentTermDuration && invoice.voucherDate) {
    const vDate = new Date(invoice.voucherDate);
    vDate.setDate(vDate.getDate() + invoice.paymentConditions.paymentTermDuration);
    dueDate = vDate.toISOString().split('T')[0];
  }

  const voucherType = invoice.voucherType || 'invoice';
  const urlType = voucherType.charAt(0).toUpperCase() + voucherType.slice(1);
  const totalGross = invoice.totalPrice?.totalGrossAmount ?? 0;

  const properties = {
    hs_currency: 'EUR',
    hs_invoice_billable: 'false',
    hs_invoice_status: hsStatus,
    hs_invoice_date: invoice.voucherDate ? invoice.voucherDate.split('T')[0] : null,
    hs_external_createdate: invoice.createdDate || null,
    hs_amount_billed: String(totalGross),
    amount_open: String(totalGross),
    hs_number: invoice.voucherNumber,
    invoice_id_lexoffice: resourceId,
    url_lexoffice_invoice: 'https://app.lexoffice.de/vouchers#!/VoucherView/' + urlType + '/' + resourceId
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
    console.log('[lexoffice-webhook] Found related order confirmation:', orderVoucher.id);

    const hsOrder = await searchHubSpotObject(
      'orders', 'hs_external_order_id', orderVoucher.id,
      ['hs_external_order_id', 'hs_order_name'], HUBSPOT_TOKEN
    );

    if (hsOrder) {
      associations.push({ type: 'orders', id: hsOrder.id });
      console.log('[lexoffice-webhook] Found HubSpot Order:', hsOrder.id, hsOrder.properties.hs_order_name);

      const [orderDeals, orderCompanies, orderContacts] = await Promise.all([
        getAssociations('orders', hsOrder.id, 'deals', HUBSPOT_TOKEN),
        getAssociations('orders', hsOrder.id, 'companies', HUBSPOT_TOKEN),
        getAssociations('orders', hsOrder.id, 'contacts', HUBSPOT_TOKEN)
      ]);

      orderDeals.forEach(d => associations.push({ type: 'deals', id: d.id }));
      orderCompanies.forEach(c => associations.push({ type: 'companies', id: c.id }));
      orderContacts.forEach(c => associations.push({ type: 'contacts', id: c.id }));

      console.log('[lexoffice-webhook] Inherited from Order:',
        orderDeals.length, 'deals,', orderCompanies.length, 'companies,', orderContacts.length, 'contacts');
    } else {
      console.log('[lexoffice-webhook] Order not found in HubSpot for', orderVoucher.id);
    }
  }

  const hasCompany = associations.some(a => a.type === 'companies');

  if (!hasCompany) {
    const lexContactId = invoice.address?.contactId;

    if (lexContactId) {
      console.log('[lexoffice-webhook] Fallback: searching Company by kunden_id:', lexContactId);

      const hsCompany = await searchHubSpotObject(
        'companies', 'kunden_id', lexContactId,
        ['kunden_id', 'name'], HUBSPOT_TOKEN
      );

      if (hsCompany) {
        associations.push({ type: 'companies', id: hsCompany.id });
        console.log('[lexoffice-webhook] Found Company via kunden_id:', hsCompany.id, hsCompany.properties.name);
      } else {
        console.log('[lexoffice-webhook] No Company found for kunden_id:', lexContactId);
      }
    } else {
      console.log('[lexoffice-webhook] No contactId on invoice (Sammelkunde?)');
    }
  }

  const ASSOC_TYPE_IDS = {
    companies: 179,
    contacts: 181,
    deals: 175,
  };

  const inlineAssociations = [];
  const deferredAssociations = [];

  for (const assoc of associations) {
    const typeId = ASSOC_TYPE_IDS[assoc.type];
    if (typeId) {
      inlineAssociations.push({
        to: { id: assoc.id },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }]
      });
    } else {
      deferredAssociations.push(assoc);
    }
  }

  console.log('[lexoffice-webhook] Creating Invoice:', invoice.voucherNumber,
    'inline:', inlineAssociations.length, 'deferred:', deferredAssociations.length);

  const createBody = { properties };
  if (inlineAssociations.length > 0) {
    createBody.associations = inlineAssociations;
  }

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
    console.error('[lexoffice-webhook] HubSpot invoice create error', createRes.status, errText);
    throw new Error('HubSpot invoice create failed: ' + errText);
  }

  const created = await createRes.json();
  const hsInvoiceId = created.id;
  console.log('[lexoffice-webhook] Created HubSpot Invoice:', hsInvoiceId);

  const assocResults = associations.map(a => ({ type: a.type, id: a.id, ok: true }));

  for (const assoc of deferredAssociations) {
    const ok = await createDefaultAssociation('invoices', hsInvoiceId, assoc.type, assoc.id, HUBSPOT_TOKEN);
    const entry = assocResults.find(r => r.type === assoc.type && r.id === assoc.id);
    if (entry) entry.ok = ok;
  }

  console.log('[lexoffice-webhook] Done:', invoice.voucherNumber, '→ HubSpot', hsInvoiceId,
    'with', assocResults.filter(a => a.ok).length + '/' + assocResults.length, 'associations');

  return { hsInvoiceId, voucherNumber: invoice.voucherNumber, hsStatus, assocResults };
}


// ============================================================
// INVOICE CREATED — skip drafts, create finalized invoices
// ============================================================
async function handleInvoiceCreated(req, res, { resourceId, HUBSPOT_TOKEN, LEXOFFICE_TOKEN, lexPath = '/v1/invoices/' }) {
  // 1. Check if invoice already exists in HubSpot (duplicate protection)
  const existing = await searchHubSpotObject(
    'invoices', 'invoice_id_lexoffice', resourceId,
    ['invoice_id_lexoffice'], HUBSPOT_TOKEN
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
    'invoices', 'invoice_id_lexoffice', resourceId,
    ['invoice_id_lexoffice', 'hs_invoice_status', 'amount_open', 'hs_amount_billed', 'hs_invoice_date', 'hs_due_date'], HUBSPOT_TOKEN
  );

  if (!hsInvoice) {
    // No HubSpot invoice yet — create it if no longer draft (was skipped during invoice.created)
    if (lexStatus !== 'draft') {
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
  const statusMap = {
    'draft': 'draft',
    'open': 'open',
    'overdue': 'open',
    'paid': 'paid',
    'paidoff': 'voided',
    'voided': 'voided',
    'cancelled': 'voided'
  };
  const newStatus = statusMap[lexStatus] || 'open';

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
  if (lexInvoice.paymentConditions?.paymentTermDuration && lexInvoice.voucherDate) {
    const vDate = new Date(lexInvoice.voucherDate);
    vDate.setDate(vDate.getDate() + lexInvoice.paymentConditions.paymentTermDuration);
    dueDate = vDate.toISOString().split('T')[0];
  }
  if (dueDate && dueDate !== (hsInvoice.properties.hs_due_date || '').split('T')[0]) {
    update.hs_due_date = dueDate;
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
