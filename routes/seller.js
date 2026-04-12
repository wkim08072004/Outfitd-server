// ═══════════════════════════════════════════════════════════════
// seller.js — Seller application & listing routes
// Uses seller_listings table AS-IS with existing columns only:
// id(uuid), seller_id(uuid), title(text), description(text),
// price(integer), images(ARRAY), category(text), sizes(ARRAY),
// status(text), created_at(timestamp), updated_at(timestamp)
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}


// ═══════════════════════════════════════════════════════════════
// LISTING ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/seller/listings/all — All active listings (PUBLIC)
router.get('/listings/all', async (req, res) => {
  try {
  const { data, error } = await supabase
    .from('seller_listings')
    .select('id, seller_id, title, description, price, images, category, sizes, status, created_at, updated_at')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Listings fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch listings' });
  }

  return res.json({ listings: data || [] });
} catch (err) {
  console.error('GET /listings/all error:', err);
  return res.status(500).json({ error: 'Server error' });
}
        

    res.json({ listings });
  } catch (err) {
    console.error('GET /listings/all error:', err);
    res.json({ listings: [] });
  }
});

// GET /api/seller/listings — Seller's own listings
router.get('/listings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_listings')
      .select('*')
      .eq('seller_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ listings: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch listings', listings: [] });
  }
});

// POST /api/seller/listings — Create a listing
router.post('/listings', requireAuth, async (req, res) => {
  try {
    const {
      name, brand, category, price, size, color,
      emoji, desc, condition, returnWindow,
      photos, stock, style, shipDays, photoPosition,
      photoFit, localId, sellerEmail
    } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    if (!price || price <= 0) return res.status(400).json({ error: 'Valid price required' });

    let sellerId = null;
    let email = sellerEmail || '';

    if (req.user) {
      sellerId = req.user.id;
      if (!email) {
        const { data: userData } = await supabase
          .from('users').select('email').eq('id', req.user.id).single();
        email = userData?.email || '';
      }
    } else if (email) {
      const { data: userData } = await supabase
        .from('users').select('id').eq('email', email).single();
      if (userData) sellerId = userData.id;
    }

    // Pack extra metadata into description as JSON
    const meta = JSON.stringify({
      localId: localId || null,
      brand: brand || 'Seller',
      sellerEmail: email,
      sellerName: brand || 'Seller',
      color: color || 'Black',
      emoji: emoji || '👗',
      condition: condition || 'New',
      returnWindow: String(returnWindow || '14'),
      desc: (desc || '').slice(0, 500),
      stock: stock !== undefined ? Number(stock) : -1,
      sold: 0,
      style: style || 'Streetwear',
      shipDays: shipDays || '3-7',
      photoPosition: photoPosition || 'center center',
      photoFit: photoFit || 'cover'
    });

    const insertData = {
      title: String(name).trim().slice(0, 100),
      description: meta,
      price: Math.round(Number(price) * 100) / 100,
      images: Array.isArray(photos) ? photos : [],
      category: category || 'Tops',
      sizes: Array.isArray(size) ? size : (size ? String(size).split(',').map(s => s.trim()).filter(Boolean) : ['S','M','L']),
      status: 'active'
    };
const sellerId = req.user?.sub || null;
    // seller_id is nullable — include only if we have it
    if (sellerId) {
      insertData.seller_id = sellerId;
    } else if (email) {
      const { data: emailUser } = await supabase.from('users').select('id').eq('email', email).single();
      if (emailUser) insertData.seller_id = emailUser.id;
    }

    const { data, error } = await supabase
      .from('seller_listings')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Listing insert error:', error);
      return res.status(500).json({ error: 'Failed to create listing: ' + error.message });
    }

    res.json({ success: true, listing: data });
  } catch (err) {
    console.error('POST /listings error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// DELETE /api/seller/listings/:id — Soft-delete a listing
router.delete('/listings/:id', requireAuth, async (req, res) => {
  try {
    const listingId = req.params.id;
    const cleanId = String(listingId).replace(/^(dyn_|sl_)/, '');

    // Try direct uuid match first
    if (cleanId.includes('-')) {
      await supabase
        .from('seller_listings')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('id', cleanId);
      return res.json({ success: true });
    }

    // Search by localId stored in description JSON
    const { data: allActive } = await supabase
      .from('seller_listings')
      .select('id, description')
      .eq('status', 'active');

    if (allActive) {
      for (const row of allActive) {
        try {
          const meta = JSON.parse(row.description || '{}');
          if (meta.localId === cleanId || meta.localId === listingId) {
            await supabase
              .from('seller_listings')
              .update({ status: 'inactive', updated_at: new Date().toISOString() })
              .eq('id', row.id);
            break;
          }
        } catch(e) {}
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /listings/:id error:', err);
    res.json({ success: true });
  }
});

// ═══════════════════════════════════════════════════════════════
// SELLER APPLICATION ROUTES
// ═══════════════════════════════════════════════════════════════

router.post('/apply', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { brand, ig, email, categories, currentSales, volume, bio,
            agreementVersion, agreementAcceptedAt, agreementUserAgent } = req.body;

    if (!brand || !email) {
      return res.status(400).json({ error: 'Brand name and email required' });
    }

    const { data, error } = await supabase
      .from('seller_applications')
      .insert({
        user_id: userId,
        brand_name: brand,
        brand_type: 'marketplace',
        website: null,
        instagram: ig || null,
        description: bio || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ application_id: data.id, status: 'pending' });
  } catch (err) {
    console.error('Seller apply error:', err);
    return res.status(500).json({ error: 'Application submission failed' });
  }
});

router.post('/partner-apply', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { brand, url, email, commission } = req.body;

    if (!brand || !email) {
      return res.status(400).json({ error: 'Brand name and email required' });
    }

    const { data, error } = await supabase
      .from('seller_applications')
      .insert({
        user_id: userId,
        brand_name: brand,
        brand_type: 'partner',
        website: url || null,
        description: `Commission: ${commission || 'standard'}`,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ application_id: data.id, status: 'pending' });
  } catch (err) {
    console.error('Partner apply error:', err);
    return res.status(500).json({ error: 'Application submission failed' });
  }
});

module.exports = router;
