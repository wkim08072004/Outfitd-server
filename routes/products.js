// ═══════════════════════════════════════════════════════════
// GET /api/products — Fetch all active products
// ═══════════════════════════════════════════════════════════
// Option A: Add to an existing route file (e.g. seller.js)
// Option B: Create a new routes/products.js and mount in server.js
//
// If creating routes/products.js, use this full file.
// If adding to existing file, just paste the router.get block.

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/products
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('status', 'active')
      .order('legacy_id', { ascending: true });

    if (error) throw error;

    const result = (data || []).map(p => ({
      id: p.legacy_id || p.id,
      brand: p.brand,
      name: p.name,
      category: p.category,
      color: p.color,
      price: parseFloat(p.price),
      emoji: p.emoji,
      zone: p.zone,
      badge: p.badge || '',
      url: p.url || '',
      img: p.img || null,
      style: p.style || [],
      size: p.size || ['S','M','L'],
      type: p.product_type === 'marketplace' ? 'marketplace' : undefined,
      sellerId: p.seller_ref || undefined,
      description: p.description || '',
      shipDays: p.ship_days || ''
    }));

    res.json({ products: result });
  } catch (err) {
    console.error('GET /api/products error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

module.exports = router;
