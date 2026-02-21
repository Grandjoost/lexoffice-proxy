# lexoffice-proxy

A Vercel serverless proxy that connects HubSpot UI extensions with the [Lexoffice API](https://developers.lexoffice.io/docs/). HubSpot UI extensions cannot call external APIs directly, so this proxy acts as a middleware layer to forward requests to Lexoffice and return the results.

## API Endpoints

### `GET /api/customer`

Fetches contact details from Lexoffice.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `kunden_id` | Yes | The Lexoffice contact UUID |

**Example:**
```
GET /api/customer?kunden_id=e9066f04-8cc7-4616-93f8-ac9b0133cba4
```

### `GET /api/invoices`

Fetches invoices for a specific contact. Returns up to 25 vouchers of type `invoice` and `salesinvoice` across all statuses (open, draft, paid, paidoff, voided).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `kunden_id` | Yes | The Lexoffice contact UUID |

**Example:**
```
GET /api/invoices?kunden_id=e9066f04-8cc7-4616-93f8-ac9b0133cba4
```

## Setup

### Prerequisites

- A [Vercel](https://vercel.com) account
- A [Lexoffice](https://www.lexoffice.de) API key

### 1. Clone and deploy

```bash
git clone <repo-url>
cd lexoffice-proxy
vercel
```

### 2. Set environment variables

Add the following environment variable in your Vercel project settings (Settings > Environment Variables):

| Variable | Description |
|----------|-------------|
| `LEXOFFICE_API_KEY` | Your Lexoffice API key ([generate one here](https://app.lexoffice.de/addons/public-api)) |

Or via the CLI:

```bash
vercel env add LEXOFFICE_API_KEY
```

### 3. Deploy

```bash
vercel --prod
```

## Usage in HubSpot

Call the proxy from your HubSpot UI extension using `hubspot.fetch()`:

```javascript
const response = await hubspot.fetch(
  "https://your-project.vercel.app/api/invoices?kunden_id=" + kundenId
);
const data = await response.json();
```

## License

ISC
