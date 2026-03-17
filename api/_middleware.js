export function checkOrigin(req, res) {
  const portalId = req.query?.portalId;
  if (portalId !== '143405850') {
    res.status(403).json({ error: 'Forbidden: Invalid portal' });
    return false;
  }
  return true;
}
