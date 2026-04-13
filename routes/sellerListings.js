const express = require('express');
const router = express.Router();
let _listings = [];
let _sellers = {};
let _applications = [];

router.get('/listings/all', (req, res) => {
  res.json({ listings: _listings.filter(l => l.status !== 'deleted'), sellers: _sellers });
});

router.get('/listings', (req, res) => {
  const email = req.query.email;
  const active = _listings.filter(l => l.status !== 'deleted' && (!email || l.sellerEmail === email));
  res.json({ listings: active });
});

router.post('/listings', (req, res) => {
  try {
    const b = req.body;
    const listing = {
      id: b.localId || b.id || ('srv_' + Date.now()), localId: b.localId || '',
      name: b.name || '', brand: b.brand || '', category: b.category || '',
      price: Number(b.price) || 0, size: b.size || ['S','M','L'],
      color: b.color || 'Black', emoji: b.emoji || '👕',
      desc: b.desc || '', style: b.style || 'Streetwear',
      photos: (b.photos || []).filter(p => !p || p.length < 200000),
      sellerEmail: b.sellerEmail || '', condition: b.condition || 'New',
      returnWindow: b.returnWindow || '30 days', shipDays: b.shipDays || '3-7',
      stock: b.stock !== undefined ? b.stock : 1,
      photoPosition: b.photoPosition || 'center center',
      photoFit: b.photoFit || 'cover',
      badge: 'NEW', type: 'marketplace', status: 'active', listedAt: Date.now()
    };
    _listings = _listings.filter(l => String(l.id) !== String(listing.id) && String(l.localId || '') !== String(listing.localId || '' ));
    _listings.push(listing);
    console.log('[Seller] Saved:', listing.name, '| Total:', _listings.length);
    res.json({ success: true, id: listing.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/listings/:id', (req, res) => {
  const id = req.params.id;
  _listings = _listings.filter(l => String(l.id) !== id && String(l.id) !== 'dyn_' + id);
  res.json({ success: true });
});

router.post('/profile', (req, res) => {
  const { email, seller } = req.body || {};
  if (email) _sellers[email.toLowerCase().trim()] = seller;
  res.json({ success: true });
});

router.post('/apply', (req, res) => {
  _applications.push(Object.assign({}, req.body, { submittedAt: new Date().toISOString() }));
  res.json({ success: true });
});

router.get('/applications', (req, res) => { res.json({ applications: _applications }); });

router.post('/approve', (req, res) => {
  const { email, status, code } = req.body || {};
  _applications.forEach(a => {
    if ((a.email || '').toLowerCase() === (email || '').toLowerCase()) {
      a.status = status || 'approved';
      if (code) a.inviteCode = code;
    }
  });
  res.json({ success: true });
});

router.post('/partner-apply', (req, res) => {
  _applications.push(Object.assign({}, req.body, { type: 'partner', status: 'pending' }));
  res.json({ success: true });
});

module.exports = router;
