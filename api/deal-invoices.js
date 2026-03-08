export default async function handler(req, res) {
  const { dealId } = req.query;
  const hubspotToken = process.env.HUBSPOT_TOKEN;

  if (!dealId) {
    return res.status(400).json({ error: 'dealId required' });
  }

  try {
    // Get invoice IDs associated with the deal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/invoices`,
      { headers: { Authorization: `Bearer ${hubspotToken}` } }
    );

    if (!assocRes.ok) {
      return res.status(200).json({ invoices: [] });
    }

    const assocData = await assocRes.json();
    const ids = (assocData.results || []).map(r => String(r.toObjectId));

    if (!ids.length) {
      return res.status(200).json({ invoices: [] });
    }

    // Batch fetch invoice details
    const batchRes = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/batch/read', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: ['hs_number', 'hs_invoice_status', 'hs_invoice_date', 'hs_amount_billed', 'url_lexoffice_invoice'],
        inputs: ids.map(id => ({ id })),
      }),
    });

    const batchData = await batchRes.json();
    const invoices = (batchData.results || []).sort(
      (a, b) =>
        new Date(b.properties.hs_invoice_date || 0).getTime() -
        new Date(a.properties.hs_invoice_date || 0).getTime()
    );

    res.status(200).json({ invoices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
