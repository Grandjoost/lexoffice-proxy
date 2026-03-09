import { checkOrigin } from './_middleware.js';

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const {
    kundenId,
    name,
    address,
    city,
    zip,
    country,
    phone,
    vatId,
    eInvoiceAddress,
  } = body;

  if (!kundenId) {
    return res.status(400).json({ error: 'kundenId ist erforderlich' });
  }

  const lexofficeKey = process.env.LEXOFFICE_API_KEY;

  try {
    // Fetch current Lexoffice contact to get version and existing data
    const contactRes = await fetch(`https://api.lexware.io/v1/contacts/${kundenId}`, {
      headers: { Authorization: `Bearer ${lexofficeKey}`, Accept: 'application/json' },
    });

    if (!contactRes.ok) {
      const err = await contactRes.text();
      return res.status(contactRes.status).json({
        error: 'Lexoffice-Kontakt konnte nicht geladen werden',
        details: err,
      });
    }

    const lexContact = await contactRes.json();

    const normalizedCountry =
      !country || country === 'Germany' || country === 'Deutschland' ? 'DE' : country;

    // Build updated billing address
    const billingAddress = {};
    if (address) billingAddress.street = address;
    if (zip) billingAddress.zip = zip;
    if (city) billingAddress.city = city;
    if (country) billingAddress.countryCode = normalizedCountry;

    const hasBillingAddress = Object.keys(billingAddress).length > 0;
    const hasVatId = !!vatId;

    // Build update body — spread existing contact, overlay HubSpot values
    const updateBody = {
      ...lexContact,
      company: {
        ...(lexContact.company || {}),
        ...(name && { name }),
        ...(hasVatId && { vatRegistrationId: vatId.replace(/\s/g, '') }),
        allowTaxFreeInvoices: normalizedCountry !== 'DE' && hasVatId,
      },
      ...(hasBillingAddress && {
        addresses: {
          ...(lexContact.addresses || {}),
          billing: [billingAddress],
        },
      }),
      emailAddresses: {
        ...(lexContact.emailAddresses || {}),
        ...(eInvoiceAddress !== undefined && { business: eInvoiceAddress ? [eInvoiceAddress] : [] }),
      },
    };

    // Remove read-only fields
    delete updateBody.id;
    delete updateBody.resourceUri;
    delete updateBody.createdDate;
    delete updateBody.updatedDate;
    delete updateBody.archived;
    delete updateBody.organizationId;
    delete updateBody._links;
    delete updateBody.billedRevenue;
    delete updateBody.vouchers;

    console.log('[update-customer] Updating contact', kundenId, JSON.stringify(updateBody).substring(0, 500));

    const updateRes = await fetch(`https://api.lexware.io/v1/contacts/${kundenId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${lexofficeKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(updateBody),
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('[update-customer] Update failed:', updateRes.status, errText);
      return res.status(500).json({
        error: 'Lexoffice-Kontakt konnte nicht aktualisiert werden',
        details: errText,
      });
    }

    const updated = await updateRes.json();
    return res.status(200).json({ id: updated.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
