export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { dealId } = req.body;
  const hubspotToken = process.env.HUBSPOT_TOKEN;
  const lexofficeKey = process.env.LEXOFFICE_API_KEY;

  if (!dealId) {
    return res.status(400).json({ error: 'Keine Deal-ID übergeben' });
  }

  const TAX_RATES = { '116101773': 19 };

  try {
    // 1. Fetch deal, associations in parallel
    const [dealRes, companyAssocRes, contactAssocRes, lineItemAssocRes] = await Promise.all([
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=description`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/companies`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/line_items`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
    ]);

    const deal = await dealRes.json();
    const companyAssoc = await companyAssocRes.json();
    const contactAssoc = await contactAssocRes.json();
    const lineItemAssoc = await lineItemAssocRes.json();

    if (!dealRes.ok) {
      return res.status(404).json({ error: 'Deal nicht gefunden', details: deal });
    }

    const companyId = companyAssoc.results?.[0]?.id;
    const contactId = contactAssoc.results?.[0]?.id;

    if (!companyId) {
      return res.status(400).json({ error: 'Keine Company mit dem Deal verknüpft' });
    }

    // 2. Fetch company, contact, and line items in parallel
    const lineItemIds = (lineItemAssoc.results || []).map((r) => r.id);

    const fetchPromises = [
      fetch(
        `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,kunden_id`,
        { headers: { Authorization: `Bearer ${hubspotToken}` } }
      ),
    ];

    if (contactId) {
      fetchPromises.push(
        fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email`,
          { headers: { Authorization: `Bearer ${hubspotToken}` } }
        )
      );
    }

    for (const itemId of lineItemIds) {
      fetchPromises.push(
        fetch(
          `https://api.hubapi.com/crm/v3/objects/line_items/${itemId}?properties=name,description,quantity,price,hs_discount_percentage,hs_tax_rate_group_id`,
          { headers: { Authorization: `Bearer ${hubspotToken}` } }
        )
      );
    }

    const responses = await Promise.all(fetchPromises);
    const results = await Promise.all(responses.map((r) => r.json()));

    const company = results[0];
    const contact = contactId ? results[1] : null;
    const lineItems = results.slice(contactId ? 2 : 1);

    // 3. Ensure kunden_id exists — create Lexoffice contact if missing
    let kundenId = company.properties?.kunden_id;

    if (!kundenId) {
      const contactBody = {
        version: 0,
        roles: { customer: {} },
        company: {
          name: company.properties.name,
          contactPersons: contact
            ? [
                {
                  firstName: contact.properties.firstname || '',
                  lastName: contact.properties.lastname || '',
                  emailAddress: contact.properties.email || '',
                },
              ]
            : [],
        },
      };

      const createContactRes = await fetch('https://api.lexoffice.io/v1/contacts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lexofficeKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(contactBody),
      });

      const newContact = await createContactRes.json();

      if (!createContactRes.ok) {
        return res.status(500).json({ error: 'Lexoffice-Kontakt konnte nicht erstellt werden', details: newContact });
      }

      kundenId = newContact.id;

      // Write kunden_id back to HubSpot
      await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${companyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: { kunden_id: kundenId } }),
      });
    }

    // 4. Build Lexoffice order confirmation
    const lexofficeLineItems = lineItems.map((item) => {
      const props = item.properties;
      const taxRateGroupId = props.hs_tax_rate_group_id;
      const taxRate = TAX_RATES[taxRateGroupId] ?? 19;
      const netAmount = parseFloat(props.price) || 0;
      const discount = parseFloat(props.hs_discount_percentage) || 0;

      const lineItem = {
        type: 'custom',
        name: props.name || '',
        description: props.description || '',
        quantity: parseFloat(props.quantity) || 1,
        unitName: 'Stück',
        unitPrice: {
          currency: 'EUR',
          netAmount,
          taxRatePercentage: taxRate,
        },
      };

      if (discount > 0) {
        lineItem.discountPercentage = discount;
      }

      return lineItem;
    });

    const orderBody = {
      voucherDate: new Date().toISOString(),
      address: { contactId: kundenId },
      lineItems: lexofficeLineItems,
      totalPrice: { currency: 'EUR' },
      taxConditions: { taxType: 'net' },
      introduction: deal.properties?.description || '',
    };

    const orderRes = await fetch('https://api.lexoffice.io/v1/order-confirmations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lexofficeKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(orderBody),
    });

    const order = await orderRes.json();

    if (!orderRes.ok) {
      return res.status(500).json({ error: 'Auftragsbestätigung konnte nicht erstellt werden', details: order });
    }

    res.status(200).json({ orderId: order.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
