export default async function handler(req, res) {
  const { kunden_id } = req.query;
  const apiKey = process.env.LEXOFFICE_API_KEY;

  if (!kunden_id) {
    return res.status(400).json({ error: 'Keine Kunden-ID übergeben' });
  }

  try {
    const [contactRes, voucherRes] = await Promise.all([
      fetch(`https://api.lexware.io/v1/contacts/${kunden_id}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      }),
      fetch(`https://api.lexware.io/v1/voucherlist?voucherType=invoice,salesinvoice,downpaymentinvoice&voucherStatus=paid,paidoff&contactId=${kunden_id}&page=0&size=100`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      }),
    ]);

    const contact = await contactRes.json();

    if (!contactRes.ok) {
      console.error('[customer] Lexoffice contact fetch failed:', contactRes.status, JSON.stringify(contact));
      return res.status(contactRes.status).json({ error: contact.message || contact.IssueList?.[0]?.i18nKey || 'Fehler beim Laden des Lexoffice-Kontakts', details: contact });
    }

    let billedRevenue = null;
    if (voucherRes.ok) {
      const vouchers = await voucherRes.json();
      billedRevenue = (vouchers.content || []).reduce((sum, v) => sum + (v.totalAmount || 0), 0);
      console.log(`[customer] billedRevenue for ${kunden_id}: ${billedRevenue} (${vouchers.content?.length} vouchers)`);
    } else {
      console.error('[customer] Voucher fetch failed:', voucherRes.status);
    }

    res.status(200).json({ ...contact, billedRevenue });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}