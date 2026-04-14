import { checkOrigin } from './_middleware.js';
import {
  deriveTaxRate,
  mapLineItemToABPosition,
  calculateDealRange,
} from '../lib/line-item-mapping.js';

const stripHtml = (html) => html ? html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : '';

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
    const [dealRes, companyAssocRes, contactAssocRes, quoteAssocRes] = await Promise.all([
      fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=description,dealname,hubspot_owner_id`, {
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

    // Quote laden inkl. bestehender Lexoffice-Referenz
    const quoteDetailRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/quotes/${quoteId}?properties=hs_title,hs_status,hs_sign_status,hs_expiration_date,hs_quote_amount,hs_quote_number,hs_comments,lex_quotation_id`,
      { headers: { Authorization: `Bearer ${hubspotToken}` } }
    );
    const quoteData = await quoteDetailRes.json();

    if (quoteData?.properties?.lex_quotation_id) {
      return res.status(409).json({
        error: 'Angebot wurde bereits nach Lexoffice kopiert',
        lexQuotationId: quoteData.properties.lex_quotation_id,
      });
    }

    // Line Items: Quote zuerst, Deal als Fallback
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

    console.log(`[create-quote] lineItemIds (${lineItemSource}):`, lineItemIds);

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

    // Lexoffice-Kontakt sicherstellen (gleiche Logik wie create-order)
    let kundenId = company.properties?.kunden_id;

    if (!kundenId) {
      const vatId = company.properties.vat_id;
      const country = company.properties.country;
      const eInvoiceAddress = company.properties.e_invoice_address;
      const isGermany = !country || country === 'DE' || country === 'Germany' || country === 'Deutschland';
      const hasVatId = !!vatId;

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

      await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${companyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${hubspotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: { kunden_id: kundenId } }),
      });
    }

    // Tax + Mapping
    const { taxType, taxRatePercentage } = deriveTaxRate(company.properties);

    const flatLineItems = lineItems.map((item) => ({
      id: item.id,
      ...item.properties,
    }));

    const hasRecurring = flatLineItems.some(li => !!li.recurringbillingfrequency);
    const paymentTermLabel = hasRecurring
      ? 'Die Abrechnung erfolgt monatlich zum Monatsanfang. Die Zahlung des Auftraggebers ist sofort fällig. Der Auftraggeber wird darauf hingewiesen, dass er spätestens 30 Tage nach Zugang der Rechnung in Verzug gerät.'
      : 'Die Abrechnung erfolgt monatlich zum Monatsende. Die Zahlung des Auftraggebers ist sofort fällig. Der Auftraggeber wird darauf hingewiesen, dass er spätestens 30 Tage nach Zugang der Rechnung in Verzug gerät.';

    let lexofficeLineItems;
    try {
      lexofficeLineItems = flatLineItems.map((li) => {
        const position = mapLineItemToABPosition(li, taxRatePercentage);
        if (li.hs_sku) position.productNumber = li.hs_sku;
        return position;
      });
    } catch (err) {
      console.error('[create-quote] Mapping-Fehler:', err.message);
      return res.status(400).json({ error: err.message });
    }

    let shippingConditions = { shippingType: 'none' };
    const dealRange = calculateDealRange(flatLineItems);
    if (dealRange) {
      shippingConditions = {
        shippingType: 'serviceperiod',
        shippingDate: dealRange.earliestStart + 'T00:00:00.000+01:00',
        shippingEndDate: dealRange.latestEnd + 'T00:00:00.000+01:00',
      };
    }

    // Ablaufdatum — HubSpot-Wert bevorzugen, sonst +30 Tage
    let expirationDate;
    if (quoteData?.properties?.hs_expiration_date) {
      const d = new Date(quoteData.properties.hs_expiration_date);
      if (!isNaN(d.getTime())) expirationDate = d.toISOString();
    }
    if (!expirationDate) {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      expirationDate = d.toISOString();
    }

    const quotationBody = {
      voucherDate: new Date().toISOString(),
      expirationDate,
      address: { contactId: kundenId },
      lineItems: lexofficeLineItems,
      totalPrice: { currency: 'EUR' },
      taxConditions: { taxType },
      shippingConditions,
      paymentConditions: {
        paymentTermLabel,
        paymentTermDuration: 30,
        paymentDiscountConditions: {
          discountPercentage: 3,
          discountRange: 10,
        },
      },
      introduction: quoteData?.properties?.hs_quote_number ? `Angebot Nr. ${quoteData.properties.hs_quote_number}` : '',
      remark: stripHtml(quoteData?.properties?.hs_comments) || deal.properties?.description || '',
    };

    console.log('[create-quote] Creating Lexoffice quotation...');
    let quotationRes, quotation;
    for (let attempt = 0; attempt < 3; attempt++) {
      quotationRes = await fetch('https://api.lexware.io/v1/quotations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lexofficeKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(quotationBody),
      });

      if (quotationRes.status === 429) {
        const wait = (attempt + 1) * 2000;
        console.log(`[create-quote] Rate limit hit, retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      break;
    }

    quotation = await quotationRes.json();

    console.log('[create-quote] Lexoffice status:', quotationRes.status);
    console.log('[create-quote] Lexoffice body:', JSON.stringify(quotation));

    if (!quotationRes.ok) {
      return res.status(500).json({ error: 'Angebot konnte nicht in Lexoffice erstellt werden', details: quotation });
    }

    const lexQuotationUrl = `https://app.lexoffice.de/vouchers#!/VoucherView/Quotation/${quotation.id}`;

    // HubSpot-Quote mit Lexoffice-Referenz updaten
    const patchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/quotes/${quoteId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          lex_quotation_id: quotation.id,
          url_lexoffice_quotation: lexQuotationUrl,
        },
      }),
    });
    if (!patchRes.ok) {
      const patchErr = await patchRes.text();
      console.error('[create-quote] HubSpot Quote PATCH failed:', patchRes.status, patchErr);
    }

    // Lexoffice Voucher-Number nachladen (optional)
    let voucherNumber = null;
    try {
      const lexQuoteRes = await fetch(`https://api.lexware.io/v1/quotations/${quotation.id}`, {
        headers: { Authorization: `Bearer ${lexofficeKey}`, Accept: 'application/json' },
      });
      if (lexQuoteRes.ok) {
        const lexQuote = await lexQuoteRes.json();
        voucherNumber = lexQuote.voucherNumber || null;
      }
    } catch (e) {
      console.error('[create-quote] Voucher-Number fetch failed:', e.message);
    }

    return res.status(200).json({
      quotationId: quotation.id,
      quoteId,
      voucherNumber,
      lexofficeUrl: lexQuotationUrl,
    });
  } catch (error) {
    console.error('[create-quote] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
