import { checkOrigin } from './_middleware.js';

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { orderId, dealId } = req.body || {};
  if (!orderId || !dealId) {
    return res.status(400).json({ error: 'orderId and dealId required' });
  }

  const hubspotToken = process.env.HUBSPOT_TOKEN;
  const results = [];

  try {
    // 1. Load deal associations
    const [companyAssocRes, contactAssocRes, quoteAssocRes, lineItemAssocRes] = await Promise.all([
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/companies`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/quotes`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/line_items`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
    ]);

    const companyAssoc = await companyAssocRes.json();
    const contactAssoc = await contactAssocRes.json();
    const quoteAssoc = await quoteAssocRes.json();
    const lineItemAssoc = await lineItemAssocRes.json();

    const companyId = companyAssoc.results?.[0]?.id;
    const contactId = contactAssoc.results?.[0]?.id;
    const quoteIds = (quoteAssoc.results || []).map(r => r.id);
    const lineItemIds = (lineItemAssoc.results || []).map(r => String(r.toObjectId));

    // Also try quote line items (they have different IDs)
    let quoteLineItemIds = [];
    if (quoteIds.length > 0) {
      // Find active quote
      const quoteChecks = await Promise.all(quoteIds.map(qId =>
        fetch(`https://api.hubapi.com/crm/v3/objects/quotes/${qId}?properties=hs_quote_status`, {
          headers: { Authorization: `Bearer ${hubspotToken}` },
        }).then(r => r.json()).then(q => ({ qId, status: q.properties?.hs_quote_status }))
      ));
      const activeQuote = quoteChecks.find(q => q.status !== 'ARCHIVED');
      if (activeQuote) {
        const qlRes = await fetch(`https://api.hubapi.com/crm/v4/objects/quotes/${activeQuote.qId}/associations/line_items`, {
          headers: { Authorization: `Bearer ${hubspotToken}` },
        });
        const qlData = await qlRes.json();
        quoteLineItemIds = (qlData.results || []).map(r => String(r.toObjectId));
      }
    }

    const allLineItemIds = quoteLineItemIds.length > 0 ? quoteLineItemIds : lineItemIds;

    console.log('[fix-associations] Order:', orderId, 'Deal:', dealId);
    console.log('[fix-associations] Company:', companyId, 'Contact:', contactId, 'Quotes:', quoteIds, 'LineItems:', allLineItemIds.length);

    // 2. Create associations
    const assocPromises = [];

    if (companyId) {
      assocPromises.push(
        fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${orderId}/associations/0-2/${companyId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 509 }]),
        }).then(r => { results.push({ type: 'company', id: companyId, status: r.status }); })
      );
    }

    if (contactId) {
      assocPromises.push(
        fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${orderId}/associations/default/0-1/${contactId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${hubspotToken}` },
        }).then(r => { results.push({ type: 'contact', id: contactId, status: r.status }); })
      );
    }

    for (const qId of quoteIds) {
      assocPromises.push(
        fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${orderId}/associations/default/0-14/${qId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${hubspotToken}` },
        }).then(r => { results.push({ type: 'quote', id: qId, status: r.status }); })
      );
    }

    for (const liId of allLineItemIds) {
      assocPromises.push(
        fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${orderId}/associations/default/0-8/${liId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${hubspotToken}` },
        }).then(r => { results.push({ type: 'lineItem', id: liId, status: r.status }); })
      );
    }

    await Promise.all(assocPromises);

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('[fix-associations] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
