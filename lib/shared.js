// Shared constants and helpers used across lexoffice-proxy endpoints.

export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL',
  'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export const LEXOFFICE_STATUS_MAP = {
  'draft': 'draft',
  'open': 'open',
  'overdue': 'open',
  'paid': 'paid',
  'paidoff': 'voided',
  'voided': 'voided',
  'cancelled': 'voided',
};

// HubSpot association type IDs for inline associations on invoice create
export const INVOICE_ASSOC_TYPE_IDS = {
  companies: 179,
  contacts: 181,
  deals: 175,
};

// Create a default association via HubSpot v4 API
export async function createDefaultAssociation(fromType, fromId, toType, toId, token) {
  const res = await fetch(
    'https://api.hubapi.com/crm/v4/objects/' + fromType + '/' + fromId + '/associations/default/' + toType + '/' + toId,
    {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token }
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('[hubspot-assoc] Failed to create association', fromType, fromId, '->', toType, toId, res.status, text);
    return false;
  }

  console.log('[hubspot-assoc] Created:', fromType, fromId, '->', toType, toId);
  return true;
}
