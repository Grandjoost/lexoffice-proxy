// One-off endpoint to manually sync a Lexoffice down-payment invoice into HubSpot.
// Usage: GET /api/sync-downpayment?resourceId=<lexoffice-uuid>&token=<webhook-secret>

import { LEXOFFICE_STATUS_MAP, INVOICE_ASSOC_TYPE_IDS, createDefaultAssociation } from '../lib/shared.js';

export default async function handler(req, res) {
  const expectedToken = process.env.WEBHOOK_SECRET;
  if (expectedToken && req.query.token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { resourceId } = req.query;
  if (!resourceId) {
    return res.status(400).json({ error: 'resourceId required' });
  }

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  const LEXOFFICE_TOKEN = process.env.LEXOFFICE_API_KEY;

  try {
    // 1. Fetch from Lexoffice
    const lexRes = await fetch(`https://api.lexware.io/v1/down-payment-invoices/${resourceId}`, {
      headers: { Authorization: `Bearer ${LEXOFFICE_TOKEN}`, Accept: 'application/json' }
    });
    if (!lexRes.ok) {
      const text = await lexRes.text();
      return res.status(502).json({ error: `Lexoffice returned ${lexRes.status}: ${text}` });
    }
    const invoice = await lexRes.json();

    // 2. Check if already exists in HubSpot
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'lexoffice_invoice_id', operator: 'EQ', value: resourceId }] }],
        properties: ['lexoffice_invoice_id', 'url_lexoffice_invoice'],
        limit: 1
      })
    });
    const searchData = await searchRes.json();

    const correctUrl = `https://app.lexoffice.de/vouchers#!/VoucherView/Downpaymentinvoice/${resourceId}`;

    if (searchData.total > 0) {
      // Exists — fix URL and amount if wrong
      const hsId = searchData.results[0].id;
      const currentUrl = searchData.results[0].properties.url_lexoffice_invoice || '';
      const lexRes2 = await fetch(`https://api.lexware.io/v1/down-payment-invoices/${resourceId}`, {
        headers: { Authorization: `Bearer ${LEXOFFICE_TOKEN}`, Accept: 'application/json' }
      });
      const inv2 = lexRes2.ok ? await lexRes2.json() : null;
      const fixProps = {};
      if (currentUrl !== correctUrl) fixProps.url_lexoffice_invoice = correctUrl;
      if (inv2) {
        const gross2 = inv2.totalPrice?.totalGrossAmount ?? 0;
        const net2 = inv2.totalPrice?.totalNetAmount ?? gross2;
        const tax2 = inv2.totalPrice?.totalTaxAmount ?? Math.round((gross2 - net2) * 100) / 100;
        fixProps.hs_amount_billed = String(gross2);
        fixProps.lex_amount_net = String(net2);
        fixProps.lex_amount_tax = String(tax2);
        fixProps.lex_voucher_type = 'downpaymentinvoice';
        fixProps.amount_open = String(gross2);
      }
      if (Object.keys(fixProps).length > 0) {
        await fetch(`https://api.hubapi.com/crm/v3/objects/invoices/${hsId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: fixProps })
        });
        return res.status(200).json({ ok: true, action: 'fixed', hsId, fixedFields: Object.keys(fixProps) });
      }
      return res.status(200).json({ ok: true, action: 'already_correct', hsId });
    }

    // 3. Build properties
    const hsStatus = LEXOFFICE_STATUS_MAP[invoice.voucherStatus] || 'open';
    const totalGross = invoice.totalPrice?.totalGrossAmount ?? 0;
    const totalNet = invoice.totalPrice?.totalNetAmount ?? totalGross;
    const totalTax = invoice.totalPrice?.totalTaxAmount ?? Math.round((totalGross - totalNet) * 100) / 100;

    const properties = {
      hs_currency: 'EUR',
      hs_invoice_billable: 'false',
      hs_invoice_status: hsStatus,
      hs_invoice_date: invoice.voucherDate ? invoice.voucherDate.split('T')[0] : null,
      hs_amount_billed: String(totalGross),
      lex_amount_net: String(totalNet),
      lex_amount_tax: String(totalTax),
      lex_voucher_type: 'downpaymentinvoice',
      amount_open: String(totalGross),
      hs_number: invoice.voucherNumber,
      lexoffice_invoice_id: resourceId,
      url_lexoffice_invoice: correctUrl
    };
    Object.keys(properties).forEach(k => { if (properties[k] === null) delete properties[k]; });

    // 4. Find associations via related order confirmation
    const associations = [];
    const orderVoucher = (invoice.relatedVouchers || []).find(v => v.voucherType === 'orderconfirmation');

    if (orderVoucher) {
      const orderSearch = await fetch('https://api.hubapi.com/crm/v3/objects/orders/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'hs_external_order_id', operator: 'EQ', value: orderVoucher.id }] }],
          properties: ['hs_external_order_id', 'hs_order_name'], limit: 1
        })
      });
      const orderData = await orderSearch.json();
      if (orderData.total > 0) {
        const hsOrder = orderData.results[0];
        associations.push({ type: 'orders', id: hsOrder.id });

        for (const toType of ['deals', 'companies', 'contacts']) {
          const assocRes = await fetch(
            `https://api.hubapi.com/crm/v4/objects/orders/${hsOrder.id}/associations/${toType}`,
            { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
          );
          if (assocRes.ok) {
            const assocData = await assocRes.json();
            (assocData.results || []).forEach(r => associations.push({ type: toType, id: String(r.toObjectId) }));
          }
        }
      }
    }

    // 5. Create invoice with inline associations (companies + deals)
    const inlineAssoc = associations
      .filter(a => INVOICE_ASSOC_TYPE_IDS[a.type])
      .map(a => ({ to: { id: a.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: INVOICE_ASSOC_TYPE_IDS[a.type] }] }));
    const deferredAssoc = associations.filter(a => !INVOICE_ASSOC_TYPE_IDS[a.type]);

    const createBody = { properties };
    if (inlineAssoc.length) createBody.associations = inlineAssoc;

    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody)
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return res.status(502).json({ error: `HubSpot create failed: ${errText}` });
    }

    const created = await createRes.json();
    const hsInvoiceId = created.id;

    // 6. Deferred associations (orders, contacts)
    for (const assoc of deferredAssoc) {
      await createDefaultAssociation('invoices', hsInvoiceId, assoc.type, assoc.id, HUBSPOT_TOKEN);
    }

    return res.status(200).json({
      ok: true,
      action: 'created',
      hsId: hsInvoiceId,
      voucherNumber: invoice.voucherNumber,
      status: hsStatus,
      associations: associations.length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
