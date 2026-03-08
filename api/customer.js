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

    let billedRevenue = null;
    if (voucherRes.ok) {
      const vouchers = await voucherRes.json();
      billedRevenue = (vouchers.content || []).reduce((sum, v) => sum + (v.totalAmount || 0), 0);
    }

    res.status(200).json({ ...contact, billedRevenue });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}