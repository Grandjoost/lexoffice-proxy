import { checkOrigin } from './_middleware.js';
import { EU_COUNTRIES } from '../lib/shared.js';

const stripHtml = (html) => html ? html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : '';

// "P3M" → 3, "P12M" → 12
function parseRecurringPeriod(period) {
  if (!period) return null;
  const match = period.match(/^P(\d+)M$/);
  return match ? parseInt(match[1], 10) : null;
}

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const dealId = body.dealId || (typeof body === 'string' ? JSON.parse(body).dealId : null);
  const hubspotToken = process.env.HUBSPOT_TOKEN;
  const lexofficeKey = process.env.LEXOFFICE_API_KEY;

  if (!dealId) {
    return res.status(400).json({ error: 'Keine Deal-ID übergeben' });
  }

  try {
    // 1. Fetch deal, associations in parallel
    const [dealRes, companyAssocRes, contactAssocRes, quoteAssocRes] = await Promise.all([
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=description,dealname,hs_order_business_type,hubspot_owner_id`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/companies`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/quotes`, {
        headers: { Authorization: `Bearer ${hubspotToken}` },
      }),
    ]);

    const deal = await dealRes.json();
    const companyAssoc = await companyAssocRes.json();
    const contactAssoc = await contactAssocRes.json();
    const quoteAssoc = await quoteAssocRes.json();

    if (!dealRes.ok) {
      return res.status(404).json({ error: 'Deal nicht gefunden', details: deal });
    }

    const companyId = companyAssoc.results?.[0]?.id;
    const contactId = contactAssoc.results?.[0]?.id;
    const quoteId = quoteAssoc.results?.[0]?.id;

    if (!companyId) {
      return res.status(400).json({ error: 'Keine Company mit dem Deal verknüpft' });
    }
    if (!quoteId) {
      return res.status(400).json({ error: 'Keine Quote am Deal gefunden' });
    }

    // 2. Quote Details laden
    const quoteDetailRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/quotes/${quoteId}?properties=hs_title,hs_status,hs_sign_status,hs_expiration_date,hs_quote_amount,hs_quote_number,hs_comments`,
      { headers: { Authorization: `Bearer ${hubspotToken}` } }
    );
    const quoteData = await quoteDetailRes.json();

    // 3. Line Items: Quote zuerst, Deal als Fallback
    let lineItemIds = [];
    let lineItemSource = '';

    const quoteLineItemsRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/quotes/${quoteId}/associations/line_items`,
      { headers: { Authorization: `Bearer ${hubspotToken}` } }
    );
    const quoteLineItemsData = await quoteLineItemsRes.json();
    lineItemIds = (quoteLineItemsData.results || []).map((r) => String(r.toObjectId));

    if (lineItemIds.length > 0) {
      lineItemSource = 'quote';
    } else {
      const dealLineItemsRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/line_items`,
        { headers: { Authorization: `Bearer ${hubspotToken}` } }
      );
      const dealLineItemsData = await dealLineItemsRes.json();
      lineItemIds = (dealLineItemsData.results || []).map((r) => String(r.toObjectId));
      lineItemSource = 'deal';
    }

    console.log(`[create-order] lineItemIds (${lineItemSource}):`, lineItemIds);

    if (lineItemIds.length === 0) {
      return res.status(400).json({ error: 'Keine Line Items gefunden (weder an Quote noch Deal)' });
    }

    const fetchPromises = [
      fetch(
        `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,kunden_id,vat_id,country,address,city,zip,state,e_invoice_address`,
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
          `https://api.hubapi.com/crm/v3/objects/line_items/${itemId}?properties=name,description,quantity,price,hs_discount_percentage,hs_tax_rate_group_id,amount,recurringbillingfrequency,hs_recurring_billing_period,hs_sku,hs_recurring_billing_start_date,hs_billing_start_delay_type,hs_billing_start_delay_months,hs_billing_start_delay_days`,
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
      const vatId = company.properties.vat_id;
      const country = company.properties.country;
      const eInvoiceAddress = company.properties.e_invoice_address;
      const isGermany = !country || country === 'DE' || country === 'Germany' || country === 'Deutschland';
      const hasVatId = !!vatId;

      // Build billing address from HubSpot company
      const billingAddress = {};
      if (company.properties.address) billingAddress.street = company.properties.address;
      if (company.properties.zip) billingAddress.zip = company.properties.zip;
      if (company.properties.city) billingAddress.city = company.properties.city;
      if (country) billingAddress.countryCode = (country === 'Germany' || country === 'Deutschland') ? 'DE' : country;
      const hasBillingAddress = Object.keys(billingAddress).length > 0;

      const contactBody = {
        version: 0,
        roles: { customer: {} },
        company: {
          name: company.properties.name,
          ...(hasVatId && { vatRegistrationId: vatId.replace(/\s/g, '') }),
          allowTaxFreeInvoices: !isGermany && hasVatId,
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
        ...(hasBillingAddress && {
          addresses: { billing: [billingAddress] },
        }),
        ...(eInvoiceAddress && { emailAddresses: { business: [eInvoiceAddress] } }),
      };

      const createContactRes = await fetch('https://api.lexware.io/v1/contacts', {
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
    } else {
      // Existing Lexoffice contact — update shipping address only (never touch billing)
      const shippingAddress = {};
      const country = company.properties.country;
      if (company.properties.address) shippingAddress.street = company.properties.address;
      if (company.properties.zip) shippingAddress.zip = company.properties.zip;
      if (company.properties.city) shippingAddress.city = company.properties.city;
      if (country) shippingAddress.countryCode = (country === 'Germany' || country === 'Deutschland') ? 'DE' : country;

      if (Object.keys(shippingAddress).length > 0) {
        // Fetch current Lexoffice contact to get version
        const lexContactRes = await fetch(`https://api.lexware.io/v1/contacts/${kundenId}`, {
          headers: { Authorization: `Bearer ${lexofficeKey}`, Accept: 'application/json' },
        });
        if (lexContactRes.ok) {
          const lexContact = await lexContactRes.json();
          const updateBody = {
            ...lexContact,
            version: lexContact.version,
            addresses: {
              ...(lexContact.addresses || {}),
              shipping: [shippingAddress],
            },
          };
          // Remove read-only fields
          delete updateBody.id;
          delete updateBody.resourceUri;
          delete updateBody.createdDate;
          delete updateBody.updatedDate;
          delete updateBody.archived;
          const updateRes = await fetch(`https://api.lexware.io/v1/contacts/${kundenId}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${lexofficeKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(updateBody),
          });
          console.log('[create-order] Shipping address update:', updateRes.status);
          if (!updateRes.ok) {
            const updateErr = await updateRes.text();
            console.log('[create-order] Shipping address update error:', updateErr);
          }
        }
      }
    }

    // 4. Determine tax type from country + VAT ID
    const companyCountry = company.properties.country;
    const companyVatId = company.properties.vat_id;
    const normalizedCountry = (!companyCountry || companyCountry === 'Germany' || companyCountry === 'Deutschland') ? 'DE' : companyCountry;

    let taxType, taxRatePercentage;
    if (normalizedCountry === 'DE') {
      taxType = 'net';
      taxRatePercentage = 19;
    } else if (EU_COUNTRIES.has(normalizedCountry) && companyVatId) {
      taxType = 'intraCommunitySupply';
      taxRatePercentage = 0;
    } else {
      taxType = 'thirdPartyCountryService';
      taxRatePercentage = 0;
    }

    // 5. Determine Tage vs Retainer deal
    const hasRecurring = lineItems.some(li => !!li.properties.recurringbillingfrequency);
    const paymentTermLabel = hasRecurring
      ? 'Die Abrechnung erfolgt monatlich zum Monatsanfang. Die Zahlung des Auftraggebers ist sofort fällig. Der Auftraggeber wird darauf hingewiesen, dass er spätestens 30 Tage nach Zugang der Rechnung in Verzug gerät.'
      : 'Die Abrechnung erfolgt monatlich zum Monatsende. Die Zahlung des Auftraggebers ist sofort fällig. Der Auftraggeber wird darauf hingewiesen, dass er spätestens 30 Tage nach Zugang der Rechnung in Verzug gerät.';

    // 6. Build Lexoffice order confirmation
    const lexofficeLineItems = lineItems.map((item) => {
      const props = item.properties;
      const netAmount = parseFloat(props.price) || 0;
      const discount = parseFloat(props.hs_discount_percentage) || 0;

      const isRecurring = !!props.recurringbillingfrequency;
      const recurringMonths = parseRecurringPeriod(props.hs_recurring_billing_period);

      const lineItem = {
        type: 'custom',
        name: props.name || '',
        productNumber: props.hs_sku || undefined,
        description: props.description || '',
        quantity: isRecurring ? (recurringMonths || parseFloat(props.quantity) || 1) : (parseFloat(props.quantity) || 1),
        unitName: isRecurring ? 'Monate' : 'Tage',
        unitPrice: {
          currency: 'EUR',
          netAmount,
          taxRatePercentage,
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
      taxConditions: { taxType },
      shippingConditions: {
        shippingType: 'none',
      },
      paymentConditions: {
        paymentTermLabel: paymentTermLabel,
        paymentTermDuration: 30,
        paymentDiscountConditions: {
          discountPercentage: 3,
          discountRange: 10,
        },
      },
      introduction: quoteData?.properties?.hs_quote_number ? `Bezug: Angebot Nr. ${quoteData.properties.hs_quote_number}` : '',
      remark: stripHtml(quoteData?.properties?.hs_comments) || deal.properties?.description || '',
    };

    console.log('Creating Lexoffice order...');
    let orderRes, order;
    for (let attempt = 0; attempt < 3; attempt++) {
      orderRes = await fetch('https://api.lexware.io/v1/order-confirmations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lexofficeKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(orderBody),
      });

      if (orderRes.status === 429) {
        const wait = (attempt + 1) * 2000;
        console.log(`[create-order] Rate limit hit, retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      break;
    }

    order = await orderRes.json();

    console.log('[create-order] Lexoffice raw response status:', orderRes.status);
    console.log('[create-order] Lexoffice raw body:', JSON.stringify(order));
    console.log('Lexoffice orderId:', order.id);

    if (!orderRes.ok) {
      return res.status(500).json({ error: 'Auftragsbestätigung konnte nicht erstellt werden', details: order });
    }

    // 5. Fetch full Lexoffice order for pricing and address details
    console.log('Fetching Lexoffice order details...');
    const lexOrderRes = await fetch(`https://api.lexware.io/v1/order-confirmations/${order.id}`, {
      headers: {
        Authorization: `Bearer ${lexofficeKey}`,
        Accept: 'application/json',
      },
    });
    console.log('Lexoffice order details status:', lexOrderRes.status);
    const lexOrder = await lexOrderRes.json();
    console.log('Lexoffice totalPrice:', JSON.stringify(lexOrder.totalPrice));

    const lexAddress = lexOrder.address || {};
    const lexTotal = lexOrder.totalPrice || {};

    // 6. Create HubSpot Order and associate with deal
    const dealName = deal.properties?.dealname || '';
    const hsOrderProperties = {
      hs_order_name: `${lexOrder.voucherNumber || 'AB'} - ${dealName}`,
      hs_external_order_id: order.id,
      hs_external_order_status: 'draft',
      hs_pipeline: '1627093225',
      hs_pipeline_stage: '2220863724',
      hs_subtotal_price: (lexTotal.totalNetAmount ?? '').toString(),
      hs_tax: (lexTotal.totalTaxAmount ?? '').toString(),
      hs_total_price: (lexTotal.totalGrossAmount ?? '').toString(),
      hs_billing_address_name: lexAddress.name || '',
      hs_billing_address_street: [lexAddress.street, lexAddress.houseNumber].filter(Boolean).join(' '),
      hs_billing_address_city: lexAddress.city || '',
      hs_billing_address_postal_code: lexAddress.zip || '',
      hs_billing_address_country: lexAddress.countryCode || '',
      hs_external_order_url: `https://app.lexoffice.de/vouchers#!/VoucherView/Order/${order.id}`,
      hs_external_created_date: lexOrder.createdDate || '',
    };

    const businessType = deal.properties?.hs_order_business_type;
    if (businessType) {
      hsOrderProperties.hs_order_business_type = businessType;
    }
    const ownerId = deal.properties?.hubspot_owner_id;
    if (ownerId) {
      hsOrderProperties.hubspot_owner_id = ownerId;
    }

    const hsOrderRes = await fetch('https://api.hubapi.com/crm/v3/objects/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: hsOrderProperties }),
    });

    const hsOrder = await hsOrderRes.json();
    console.log('HubSpot Order response:', JSON.stringify(hsOrder));

    let hubspotOrderId = null;

    // Owner Email für Epic-Erstellung (wird im Response mitgegeben)
    let ownerEmail = null;
    console.log('[create-order] ownerId:', ownerId);
    if (ownerId) {
      try {
        const ownerRes = await fetch(`https://api.hubapi.com/crm/v3/owners/${ownerId}`, {
          headers: { Authorization: `Bearer ${hubspotToken}` },
        });
        if (ownerRes.ok) {
          const ownerData = await ownerRes.json();
          ownerEmail = ownerData.email || null;
          console.log('[create-order] ownerEmail:', ownerEmail);
        } else {
          console.error('[create-order] Owner fetch failed:', ownerRes.status);
        }
      } catch (e) { console.error('[create-order] Owner fetch error:', e.message); }
    } else {
      console.log('[create-order] Kein ownerId auf Deal');
    }

    if (!hsOrderRes.ok) {
      console.error('HubSpot Order creation failed:', hsOrderRes.status, JSON.stringify(hsOrder));
    } else {
      hubspotOrderId = hsOrder.properties?.hs_object_id;
      console.log('HubSpot Order ID:', hubspotOrderId);

      // Alle Associations parallel
      await Promise.all([
        fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${hubspotOrderId}/associations/default/0-3/${dealId}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${hubspotToken}` } }
        ).then(r => console.log('Order-deal association:', r.status)).catch(e => console.error('Order-deal error:', e.message)),

        ...(companyId ? [fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${hubspotOrderId}/associations/0-2/${companyId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 509 }]),
        }).then(r => console.log('Order-company association:', r.status)).catch(e => console.error('Order-company error:', e.message))] : []),

        ...(contactId ? [fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${hubspotOrderId}/associations/default/0-1/${contactId}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${hubspotToken}` } }
        ).then(r => console.log('Order-contact association:', r.status)).catch(e => console.error('Order-contact error:', e.message))] : []),

        ...(quoteId ? [fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${hubspotOrderId}/associations/default/0-14/${quoteId}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${hubspotToken}` } }
        ).then(r => console.log('Order-quote association:', r.status)).catch(e => console.error('Order-quote error:', e.message))] : []),

        ...lineItemIds.map(lineItemId =>
          fetch(`https://api.hubapi.com/crm/v4/objects/0-123/${hubspotOrderId}/associations/default/0-8/${lineItemId}`,
            { method: 'PUT', headers: { Authorization: `Bearer ${hubspotToken}` } }
          ).then(r => console.log(`Order-lineitem ${lineItemId} association:`, r.status)).catch(e => console.error(`Order-lineitem error:`, e.message))
        ),
      ]);
    }

    // Epics werden jetzt vom Frontend separat aufgerufen
    res.status(200).json({
      orderId: order.id,
      hubspotOrderId,
      companyName: company.properties.name,
      dealName,
      dealOwnerEmail: ownerEmail,
      orderNumber: lexOrder.voucherNumber || null,
      lineItems: lineItems.map(li => ({
        id: li.id,
        name: li.properties.name,
        description: li.properties.description || null,
        price: parseFloat(li.properties.price),
        discount: parseFloat(li.properties.hs_discount_percentage) || 0,
        quantity: parseFloat(li.properties.quantity),
        recurringbillingfrequency: li.properties.recurringbillingfrequency || null,
        hs_recurring_billing_period: li.properties.hs_recurring_billing_period || null,
        hs_recurring_billing_start_date: li.properties.hs_recurring_billing_start_date || null,
        hs_billing_start_delay_type: li.properties.hs_billing_start_delay_type || null,
        hs_billing_start_delay_months: li.properties.hs_billing_start_delay_months || null,
        hs_billing_start_delay_days: li.properties.hs_billing_start_delay_days || null,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
