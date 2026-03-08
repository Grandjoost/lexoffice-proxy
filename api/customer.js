const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const wait = (attempt + 1) * 1500;
    console.log(`[customer] 429 rate limit, retrying in ${wait}ms (attempt ${attempt + 1})`);
    await sleep(wait);
  }
  return fetch(url, options);
}

export default async function handler(req, res) {
  const { kunden_id } = req.query;
  const apiKey = process.env.LEXOFFICE_API_KEY;

  if (!kunden_id) {
    return res.status(400).json({ error: 'Keine Kunden-ID übergeben' });
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  try {
    // Fetch contact first, then vouchers sequentially to avoid rate limit spikes
    const contactRes = await fetchWithRetry(
      `https://api.lexware.io/v1/contacts/${kunden_id}`,
      { headers }
    );
    const contact = await contactRes.json();

    if (!contactRes.ok) {
      console.error('[customer] Contact fetch failed:', contactRes.status, JSON.stringify(contact));
      return res.status(contactRes.status).json({
        error: contact.message || 'Fehler beim Laden des Lexoffice-Kontakts',
        details: contact,
      });
    }

    const voucherRes = await fetchWithRetry(
      `https://api.lexware.io/v1/voucherlist?voucherType=invoice,salesinvoice,downpaymentinvoice&voucherStatus=open,draft,paid,paidoff,voided&contactId=${kunden_id}&page=0&size=100`,
      { headers }
    );

    let billedRevenue = null;
    let vouchers = [];
    if (voucherRes.ok) {
      const voucherData = await voucherRes.json();
      vouchers = voucherData.content || [];
      billedRevenue = vouchers
        .filter(v => v.voucherStatus === 'paid' || v.voucherStatus === 'paidoff')
        .reduce((sum, v) => sum + (v.totalAmount || 0), 0);
    } else {
      console.error('[customer] Voucher fetch failed:', voucherRes.status);
    }

    res.status(200).json({ ...contact, billedRevenue, vouchers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}