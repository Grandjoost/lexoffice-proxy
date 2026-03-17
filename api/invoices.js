export default async function handler(req, res) {
  const { kunden_id } = req.query;
  const apiKey = process.env.LEXOFFICE_API_KEY;

  if (!kunden_id) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Keine Kunden-ID übergeben' });
  }

  try {
    const response = await fetch(
      `https://api.lexware.io/v1/voucherlist?voucherType=invoice,salesinvoice&voucherStatus=open,draft,paid,paidoff,voided&contactId=${kunden_id}&page=0&size=25`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      }
    );
    const data = await response.json();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: error.message });
  }
}