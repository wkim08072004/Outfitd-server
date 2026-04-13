const express = require('express');
const router = express.Router();

router.get('/listings/all', async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const { data, error } = await supabase
      .from('seller_listings')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      ;
    if (error) { console.error('listings/all error:', error); return res.json({ listings: [], sellers: {} }); }
    const listings = (data || []).map(r => ({
      id: r.local_id || r.id, localId: r.local_id || '', name: r.name || r.title || '',
      brand: r.brand || '', category: r.category || '', price: Number(r.price) || 0,
      size: typeof r.size === 'string' ? JSON.parse(r.size) : (r.sizes || r.size || ['S','M','L']),
      color: r.color || 'Black', emoji: r.emoji || '👕', desc: r.description || '',
      style: r.style || 'Streetwear',
      photos: typeof r.photos === 'string' ? JSON.parse(r.photos) : (r.images || r.photos || []),
      sellerEmail: r.seller_email || '', condition: r.condition || 'New',
      returnWindow: r.return_window || '30 days', shipDays: r.ship_days || '3-7',
      stock: r.stock || 1, badge: 'NEW', type: 'marketplace', status: 'active',
      listedAt: new Date(r.created_at).getTime()
    }));
    res.json({ listings, sellers: {} });
  } catch (err) { console.error('listings/all catch:', err); res.json({ listings: [], sellers: {} }); }
});

router.get('/listings', async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    let q = supabase.from('seller_listings').select('*').eq('status', 'active');
    if (req.query.email) q = q.eq('seller_email', req.query.email);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ listings: data || [] });
  } catch (err) { console.error('listings catch:', err); res.json({ listings: [] }); }
});

router.post('/listings', async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
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
    const { data: existing } = await supabase.from('seller_listings').select('id').eq('local_id', row.local_id).limit(1);
    if (existing && existing.length) {
      const { error } = await supabase.from('seller_listings').update(row).eq('id', existing[0].id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('seller_listings').insert(row);
      if (error) throw error;
    }
    console.log('[Seller] Saved:', row.name);
    res.json({ success: true, id: row.local_id });
  } catch (err) { console.error('POST listings:', err); res.status(500).json({ error: err.message }); }
});

router.delete('/listings/:id', async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    await supabase.from('seller_listings').update({ status: 'deleted' }).eq('local_id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/profile', (req, res) => { res.json({ success: true }); });
router.post('/apply', (req, res) => { res.json({ success: true }); });
router.get('/applications', (req, res) => { res.json({ applications: [] }); });
router.post('/approve', (req, res) => { res.json({ success: true }); });
router.post('/partner-apply', (req, res) => { res.json({ success: true }); });

module.exports = router;
