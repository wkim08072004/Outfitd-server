const express = require('express');
const router = express.Router();

function toFrontend(row) {
  return {
    id: row.local_id || row.id,
    localId: row.local_id || '',
    name: row.name || '',
    brand: row.brand || '',
    category: row.category || '',
    price: Number(row.price) || 0,
    size: typeof row.size === 'string' ? JSON.parse(row.size || '["S","M","L"]') : (row.size || ['S','M','L']),
    color: row.color || 'Black',
    emoji: row.emoji || '👕',
    desc: row.description || '',
    style: row.style || 'Streetwear',
    photos: typeof row.photos === 'string' ? JSON.parse(row.photos || '[]') : (row.photos || []),
    sellerEmail: row.seller_email || '',
    condition: row.condition || 'New',
    returnWindow: row.return_window || '30 days',
    shipDays: row.ship_days || '3-7',
    stock: row.stock,
    badge: 'NEW',
    type: 'marketplace',
    status: row.status || 'active',
    listedAt: Date.now()
  };
}

router.get('/listings/all', async (req, res) => {
  try {
    const sb = req.app.locals.supabase;
    const { data, error } = await sb.from('seller_listings').select('*').eq('status', 'active');
    if (error) throw error;
    res.json({ listings: (data || []).map(toFrontend), sellers: {} });
  } catch (err) {
    console.error('GET listings/all:', err.message);
    res.json({ listings: [], sellers: {} });
  }
});

router.get('/listings', async (req, res) => {
  try {
    const sb = req.app.locals.supabase;
    let q = sb.from('seller_listings').select('*').eq('status', 'active');
    if (req.query.email) q = q.eq('seller_email', req.query.email);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ listings: (data || []).map(toFrontend) });
  } catch (err) {
    console.error('GET listings:', err.message);
    res.json({ listings: [] });
  }
});

router.post('/listings', async (req, res) => {
  try {
    const sb = req.app.locals.supabase;
    const b = req.body;
    const photos = (b.photos || []).filter(p => !p || p.length < 200000);
    const row = {
      local_id: String(b.localId || b.id || Date.now()),
      name: b.name || '', brand: b.brand || '', category: b.category || '',
      price: Number(b.price) || 0, size: JSON.stringify(b.size || ['S','M','L']),
      color: b.color || 'Black', emoji: b.emoji || '👕',
      description: b.desc || '', style: b.style || 'Streetwear',
      photos: JSON.stringify(photos), seller_email: b.sellerEmail || '',
      condition: b.condition || 'New', return_window: b.returnWindow || '30',
      ship_days: b.shipDays || '3-7', stock: b.stock !== undefined ? b.stock : 1,
      status: 'active'
    };
    const { data: existing } = await sb.from('seller_listings').select('id').eq('local_id', row.local_id).limit(1);
    let result;
    if (existing && existing.length) {
      const { data, error } = await sb.from('seller_listings').update(row).eq('id', existing[0].id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await sb.from('seller_listings').insert(row).select().single();
      if (error) throw error;
      result = data;
    }
    console.log('[Seller] Saved:', row.name);
    res.json({ success: true, id: result.id });
  } catch (err) {
    console.error('POST listings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/listings/:id', async (req, res) => {
  try {
    const sb = req.app.locals.supabase;
    await sb.from('seller_listings').delete().eq('local_id', req.params.id);
    await sb.from('seller_listings').delete().eq('local_id', 'dyn_' + req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/profile', (req, res) => { res.json({ success: true }); });
router.post('/apply', (req, res) => { res.json({ success: true }); });
router.get('/applications', (req, res) => { res.json({ applications: [] }); });
router.post('/approve', (req, res) => { res.json({ success: true }); });
router.post('/partner-apply', (req, res) => { res.json({ success: true }); });

module.exports = router;
