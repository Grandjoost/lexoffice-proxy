import { checkOrigin } from './_middleware.js';

const HUBSPOT_API = 'https://api.hubapi.com';

async function hubspotGet(path, token) {
  const res = await fetch(`${HUBSPOT_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    console.log(`[deal-data] HubSpot ${path} → ${res.status}`);
    return null;
  }
  return res.json();
}

// Association-IDs für ein Deal laden
async function fetchAssociationIds(dealId, toObjectType, token) {
  const data = await hubspotGet(
    `/crm/v4/objects/deals/${dealId}/associations/${toObjectType}`,
    token
  );
  return (data?.results || []).map((r) => String(r.toObjectId));
}

// Einzelnes CRM-Objekt mit Properties laden
async function fetchObjectProps(objectType, objectId, properties, token) {
  return hubspotGet(
    `/crm/v3/objects/${objectType}/${objectId}?properties=${properties.join(',')}`,
    token
  );
}

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { dealId } = req.query;
  const token = process.env.HUBSPOT_TOKEN;

  if (!dealId) {
    return res.status(400).json({ error: 'dealId query parameter required' });
  }
  if (!token) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN not configured' });
  }

  try {
    // 1. Associations parallel laden
    const [quoteIds, companyIds, orderIds] = await Promise.all([
      fetchAssociationIds(dealId, '0-14', token),
      fetchAssociationIds(dealId, '0-2', token),
      fetchAssociationIds(dealId, '0-123', token),
    ]);

    console.log(`[deal-data] dealId=${dealId} quotes=${quoteIds.length} companies=${companyIds.length} orders=${orderIds.length}`);

    // 2. Neustes Quote laden (nach Erstelldatum)
    let quote = null;
    if (quoteIds.length > 0) {
      const quoteProps = [
        'hs_title',
        'hs_status',
        'hs_sign_status',
        'hs_expiration_date',
        'hs_quote_amount',
        'hs_createdate',
      ];
      const allQuotes = (
        await Promise.all(
          quoteIds.map((qId) => fetchObjectProps('quotes', qId, quoteProps, token))
        )
      ).filter(Boolean);

      allQuotes.sort(
        (a, b) =>
          new Date(b.properties.hs_createdate).getTime() -
          new Date(a.properties.hs_createdate).getTime()
      );
      quote = allQuotes[0] || null;
    }

    // 3. Company laden (erste Verknüpfung)
    let company = null;
    if (companyIds.length > 0) {
      company = await fetchObjectProps(
        'companies',
        companyIds[0],
        ['name', 'address', 'city', 'zip', 'country', 'vat_id'],
        token
      );
    }

    // 4. Orders laden
    let orders = [];
    if (orderIds.length > 0) {
      const orderProps = ['hs_order_name', 'hs_pipeline_stage', 'hs_external_order_id'];
      orders = (
        await Promise.all(
          orderIds.map((oId) => fetchObjectProps('0-123', oId, orderProps, token))
        )
      ).filter(Boolean);
    }

    return res.status(200).json({ quote, company, orders });
  } catch (error) {
    console.error('[deal-data] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
