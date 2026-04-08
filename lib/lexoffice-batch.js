// Throttled Lexoffice fetch helpers — same pattern as noditch-billing/due-deals.js.
// Lexoffice has a strict ~2 req/s limit; this batches with concurrency 2 + retries.

export async function lexofficeFetch(path, token) {
  const doFetch = () => fetch('https://api.lexware.io' + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  const delays = [1000, 2000, 4000];
  let res = await doFetch();
  for (const delay of delays) {
    if (res.status !== 429) break;
    console.log('[lexoffice-batch] 429 on', path, '— retry in', delay + 'ms');
    await new Promise(r => setTimeout(r, delay));
    res = await doFetch();
  }
  if (!res.ok) {
    console.error('[lexoffice-batch] Lexoffice', path, '→', res.status);
    return null;
  }
  return res.json();
}

export async function lexofficeBatch(paths, token, concurrency = 2) {
  const results = [];
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(p => lexofficeFetch(p, token)));
    results.push(...batchResults);
    if (i + concurrency < paths.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return results;
}
