// Backfill script: extract Lexoffice invoice ID from url_lexoffice_invoice
// and write it back to lexoffice_invoice_id for all HubSpot invoices.
//
// Usage: HUBSPOT_TOKEN=xxx node backfill-lexoffice-ids.js

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('Missing HUBSPOT_TOKEN');
  process.exit(1);
}

async function getAllInvoices() {
  const invoices = [];
  let after = undefined;

  while (true) {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/invoices');
    url.searchParams.set('properties', 'hs_number,url_lexoffice_invoice,lexoffice_invoice_id');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error('HubSpot list error: ' + res.status + ' ' + text);
    }

    const data = await res.json();
    invoices.push(...data.results);
    console.log('Loaded', invoices.length, 'invoices...');

    if (data.paging?.next?.after) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }

  return invoices;
}

async function patchInvoice(id, lexofficeId) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/invoices/' + id, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: { lexoffice_invoice_id: lexofficeId } })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Patch failed for ' + id + ': ' + res.status + ' ' + text);
  }
}

async function main() {
  const invoices = await getAllInvoices();
  console.log('\nTotal invoices found:', invoices.length);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const inv of invoices) {
    const { hs_number, url_lexoffice_invoice, lexoffice_invoice_id } = inv.properties;
    const hsId = inv.id;

    if (!url_lexoffice_invoice) {
      console.log('SKIP (no url):', hs_number || hsId);
      skipped++;
      continue;
    }

    // Extract ID from URL — last segment after final "/"
    const lexofficeId = url_lexoffice_invoice.split('/').pop();

    if (!lexofficeId || lexofficeId.length < 10) {
      console.log('SKIP (bad url):', hs_number || hsId, url_lexoffice_invoice);
      skipped++;
      continue;
    }

    if (lexoffice_invoice_id === lexofficeId) {
      console.log('SKIP (already set):', hs_number || hsId, lexofficeId);
      skipped++;
      continue;
    }

    try {
      await patchInvoice(hsId, lexofficeId);
      console.log('UPDATED:', hs_number || hsId, '→', lexofficeId);
      updated++;
    } catch (err) {
      console.error('ERROR:', hs_number || hsId, err.message);
      errors++;
    }
  }

  console.log('\nDone. Updated:', updated, '| Skipped:', skipped, '| Errors:', errors);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
