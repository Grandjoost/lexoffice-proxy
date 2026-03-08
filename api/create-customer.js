import { checkOrigin } from './_middleware.js';

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL',
  'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export default async function handler(req, res) {
  if (!checkOrigin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const {
    companyId,
    name,
    address,
    city,
    zip,
    country,
    phone,
    vatId,
    contactName,
    contactEmail,
  } = body;

  if (!companyId || !name) {
    return res.status(400).json({ error: 'companyId und name sind erforderlich' });
  }

  const lexofficeKey = process.env.LEXOFFICE_API_KEY;
  const hubspotToken = process.env.HUBSPOT_TOKEN;

  try {
    const normalizedCountry =
      !country || country === 'Germany' || country === 'Deutschland' ? 'DE' : country;
    const isGermany = normalizedCountry === 'DE';
    const hasVatId = !!vatId;

    // Build billing address
    const billingAddress = {};
    if (address) billingAddress.street = address;
    if (zip) billingAddress.zip = zip;
    if (city) billingAddress.city = city;
    if (country) billingAddress.countryCode = normalizedCountry;
    const hasBillingAddress = Object.keys(billingAddress).length > 0;

    // Build contact persons
    const contactPersons = [];
    if (contactName || contactEmail) {
      const [firstName, ...rest] = (contactName || '').split(' ');
      contactPersons.push({
        firstName: firstName || '',
        lastName: rest.join(' ') || '',
        emailAddress: contactEmail || '',
      });
    }

    const contactBody = {
      version: 0,
      roles: { customer: {} },
      company: {
        name,
        ...(hasVatId && { vatRegistrationId: vatId.replace(/\s/g, '') }),
        allowTaxFreeInvoices: !isGermany && hasVatId,
        contactPersons,
      },
      ...(hasBillingAddress && { addresses: { billing: [billingAddress] } }),
    };

    const createRes = await fetch('https://api.lexware.io/v1/contacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lexofficeKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(contactBody),
    });

    const newContact = await createRes.json();

    if (!createRes.ok) {
      return res.status(500).json({
        error: 'Lexoffice-Kontakt konnte nicht erstellt werden',
        details: newContact,
      });
    }

    const kundenId = newContact.id;

    // Write kunden_id back to HubSpot company
    await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${companyId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: { kunden_id: kundenId } }),
    });

    return res.status(200).json({ kundenId });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
