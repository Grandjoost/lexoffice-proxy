export default async function handler(req, res) {
  const { kunden_id } = req.query;
  const apiKey = process.env.LEXOFFICE_API_KEY;

  if (!kunden_id) {
    return res.status(400).json({ error: 'Keine Kunden-ID übergeben' });
  }

  try {
    const response = await fetch(
      `https://api.lexoffice.io/v1/contacts/${kunden_id}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      }
    );

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}