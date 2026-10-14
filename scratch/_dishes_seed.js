/**
 * Seeds the common dish list for the client menu dropdown
 * (docs/MENU_TRACKING_REQUEST_CHANGES_PLAN.md). Re-runnable: a dish already in
 * the common list (same name, case-insensitive) is left alone, so nothing a
 * later run does can duplicate or overwrite it. Clients' own dishes are never touched.
 *
 *   node scratch/_dishes_seed.js
 *
 * Columns: name, category, diet, jain_ok, region, meals
 *   meals: B = breakfast, L = lunch, S = snacks, D = dinner
 *   jain_ok: no onion, garlic, potato or other root vegetables, no egg or meat
 */
const { Client } = require('pg');
require('dotenv').config();

const M = { B: 'BREAKFAST', L: 'LUNCH', S: 'SNACKS', D: 'DINNER' };
// [name, category, diet, jainOk, region, meals]
const DISHES = [
  // ── Breakfast ──
  ['Poha', 'BREAKFAST', 'VEG', false, 'MAHARASHTRIAN', 'BS'],
  ['Upma', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BS'],
  ['Rava Upma', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'B'],
  ['Idli Sambar', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BD'],
  ['Plain Dosa', 'BREAKFAST', 'VEG', true, 'SOUTH_INDIAN', 'BD'],
  ['Masala Dosa', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BD'],
  ['Rava Dosa', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BD'],
  ['Uttapam', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BD'],
  ['Medu Vada', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BS'],
  ['Pongal', 'BREAKFAST', 'VEG', true, 'SOUTH_INDIAN', 'B'],
  ['Appam with Stew', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'BD'],
  ['Puttu with Kadala Curry', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'B'],
  ['Pesarattu', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'B'],
  ['Aloo Paratha', 'BREAKFAST', 'VEG', false, 'PUNJABI', 'BL'],
  ['Gobi Paratha', 'BREAKFAST', 'VEG', false, 'PUNJABI', 'BL'],
  ['Paneer Paratha', 'BREAKFAST', 'VEG', false, 'PUNJABI', 'BL'],
  ['Methi Thepla', 'BREAKFAST', 'VEG', true, 'GUJARATI', 'BS'],
  ['Mooli Paratha', 'BREAKFAST', 'VEG', false, 'PUNJABI', 'B'],
  ['Puri Bhaji', 'BREAKFAST', 'VEG', false, 'NORTH_INDIAN', 'BL'],
  ['Chole Bhature', 'BREAKFAST', 'VEG', false, 'PUNJABI', 'BL'],
  ['Besan Chilla', 'BREAKFAST', 'VEG', false, 'NORTH_INDIAN', 'B'],
  ['Moong Dal Chilla', 'BREAKFAST', 'VEG', true, 'NORTH_INDIAN', 'B'],
  ['Dhokla', 'BREAKFAST', 'VEG', true, 'GUJARATI', 'BS'],
  ['Khandvi', 'BREAKFAST', 'VEG', true, 'GUJARATI', 'S'],
  ['Handvo', 'BREAKFAST', 'VEG', false, 'GUJARATI', 'BS'],
  ['Sabudana Khichdi', 'BREAKFAST', 'VEG', false, 'MAHARASHTRIAN', 'B'],
  ['Misal Pav', 'BREAKFAST', 'VEG', false, 'MAHARASHTRIAN', 'BS'],
  ['Thalipeeth', 'BREAKFAST', 'VEG', false, 'MAHARASHTRIAN', 'B'],
  ['Luchi Aloo Dum', 'BREAKFAST', 'VEG', false, 'BENGALI', 'B'],
  ['Kachori Sabzi', 'BREAKFAST', 'VEG', false, 'RAJASTHANI', 'B'],
  ['Vegetable Daliya', 'BREAKFAST', 'VEG', false, 'NORTH_INDIAN', 'B'],
  ['Oats Porridge', 'BREAKFAST', 'VEG', true, 'OTHER', 'B'],
  ['Vegetable Sandwich', 'BREAKFAST', 'VEG', false, 'OTHER', 'BS'],
  ['Bread Upma', 'BREAKFAST', 'VEG', false, 'SOUTH_INDIAN', 'B'],
  ['Masala Omelette', 'BREAKFAST', 'EGG', false, 'OTHER', 'B'],
  ['Boiled Eggs', 'BREAKFAST', 'EGG', false, 'OTHER', 'B'],
  ['Egg Bhurji', 'BREAKFAST', 'EGG', false, 'NORTH_INDIAN', 'BD'],
  ['Bread Omelette', 'BREAKFAST', 'EGG', false, 'OTHER', 'BS'],
  ['Egg Paratha', 'BREAKFAST', 'EGG', false, 'NORTH_INDIAN', 'B'],
  ['Keema Paratha', 'BREAKFAST', 'NON_VEG', false, 'PUNJABI', 'BL'],

  // ── Dal ──
  ['Dal Tadka', 'DAL', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Dal Fry', 'DAL', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Dal Makhani', 'DAL', 'VEG', false, 'PUNJABI', 'LD'],
  ['Moong Dal', 'DAL', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Masoor Dal', 'DAL', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Chana Dal', 'DAL', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Arhar Dal', 'DAL', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Panchmel Dal', 'DAL', 'VEG', false, 'RAJASTHANI', 'LD'],
  ['Rajma', 'DAL', 'VEG', false, 'PUNJABI', 'LD'],
  ['Chole', 'DAL', 'VEG', false, 'PUNJABI', 'LD'],
  ['Kadhi Pakora', 'DAL', 'VEG', false, 'PUNJABI', 'LD'],
  ['Gujarati Kadhi', 'DAL', 'VEG', true, 'GUJARATI', 'LD'],
  ['Gujarati Dal', 'DAL', 'VEG', true, 'GUJARATI', 'LD'],
  ['Sambar', 'DAL', 'VEG', false, 'SOUTH_INDIAN', 'BLD'],
  ['Rasam', 'DAL', 'VEG', false, 'SOUTH_INDIAN', 'LD'],
  ['Varan', 'DAL', 'VEG', true, 'MAHARASHTRIAN', 'LD'],
  ['Amti', 'DAL', 'VEG', false, 'MAHARASHTRIAN', 'LD'],
  ['Cholar Dal', 'DAL', 'VEG', false, 'BENGALI', 'LD'],
  ['Lobia Curry', 'DAL', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Kala Chana Curry', 'DAL', 'VEG', false, 'NORTH_INDIAN', 'LD'],

  // ── Sabzi (vegetable dishes) ──
  ['Aloo Gobi', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Jeera Aloo', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Aloo Matar', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Dum Aloo', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Bhindi Masala', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Baingan Bharta', 'SABZI', 'VEG', false, 'PUNJABI', 'LD'],
  ['Mix Veg', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Palak Paneer', 'SABZI', 'VEG', false, 'PUNJABI', 'LD'],
  ['Matar Paneer', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Paneer Butter Masala', 'SABZI', 'VEG', false, 'PUNJABI', 'LD'],
  ['Kadai Paneer', 'SABZI', 'VEG', false, 'PUNJABI', 'LD'],
  ['Shahi Paneer', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Paneer Bhurji', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'BLD'],
  ['Malai Kofta', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Sarson ka Saag', 'SABZI', 'VEG', false, 'PUNJABI', 'LD'],
  ['Lauki Sabzi', 'SABZI', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Tinda Sabzi', 'SABZI', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Tori Sabzi', 'SABZI', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Karela Fry', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Cabbage Matar', 'SABZI', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Gajar Matar', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Methi Aloo', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Capsicum Besan', 'SABZI', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Mushroom Masala', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Kaddu ki Sabzi', 'SABZI', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Arbi Fry', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Soya Chunks Curry', 'SABZI', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Gatte ki Sabzi', 'SABZI', 'VEG', false, 'RAJASTHANI', 'LD'],
  ['Ker Sangri', 'SABZI', 'VEG', true, 'RAJASTHANI', 'LD'],
  ['Papad ki Sabzi', 'SABZI', 'VEG', false, 'RAJASTHANI', 'LD'],
  ['Undhiyu', 'SABZI', 'VEG', false, 'GUJARATI', 'LD'],
  ['Sev Tameta', 'SABZI', 'VEG', false, 'GUJARATI', 'LD'],
  ['Bharwa Bhindi', 'SABZI', 'VEG', false, 'GUJARATI', 'LD'],
  ['Pitla', 'SABZI', 'VEG', false, 'MAHARASHTRIAN', 'LD'],
  ['Bharli Vangi', 'SABZI', 'VEG', false, 'MAHARASHTRIAN', 'LD'],
  ['Aloo Posto', 'SABZI', 'VEG', false, 'BENGALI', 'LD'],
  ['Shukto', 'SABZI', 'VEG', false, 'BENGALI', 'L'],
  ['Avial', 'SABZI', 'VEG', false, 'SOUTH_INDIAN', 'LD'],
  ['Beans Poriyal', 'SABZI', 'VEG', true, 'SOUTH_INDIAN', 'LD'],
  ['Cabbage Thoran', 'SABZI', 'VEG', true, 'SOUTH_INDIAN', 'LD'],
  ['Vegetable Kurma', 'SABZI', 'VEG', false, 'SOUTH_INDIAN', 'BLD'],
  ['Egg Curry', 'SABZI', 'EGG', false, 'NORTH_INDIAN', 'LD'],
  ['Chicken Curry', 'SABZI', 'NON_VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Butter Chicken', 'SABZI', 'NON_VEG', false, 'PUNJABI', 'LD'],
  ['Chicken Tikka Masala', 'SABZI', 'NON_VEG', false, 'PUNJABI', 'LD'],
  ['Kadai Chicken', 'SABZI', 'NON_VEG', false, 'PUNJABI', 'LD'],
  ['Chicken Chettinad', 'SABZI', 'NON_VEG', false, 'SOUTH_INDIAN', 'LD'],
  ['Mutton Curry', 'SABZI', 'NON_VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Mutton Rogan Josh', 'SABZI', 'NON_VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Keema Matar', 'SABZI', 'NON_VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Laal Maas', 'SABZI', 'NON_VEG', false, 'RAJASTHANI', 'LD'],
  ['Fish Curry', 'SABZI', 'NON_VEG', false, 'OTHER', 'LD'],
  ['Macher Jhol', 'SABZI', 'NON_VEG', false, 'BENGALI', 'LD'],
  ['Fish Fry', 'SABZI', 'NON_VEG', false, 'OTHER', 'LD'],
  ['Prawn Curry', 'SABZI', 'NON_VEG', false, 'OTHER', 'LD'],
  ['Kolhapuri Chicken', 'SABZI', 'NON_VEG', false, 'MAHARASHTRIAN', 'LD'],

  // ── Roti / Paratha ──
  ['Phulka', 'ROTI_PARATHA', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Tawa Roti', 'ROTI_PARATHA', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Plain Paratha', 'ROTI_PARATHA', 'VEG', true, 'NORTH_INDIAN', 'BLD'],
  ['Lachha Paratha', 'ROTI_PARATHA', 'VEG', true, 'PUNJABI', 'LD'],
  ['Missi Roti', 'ROTI_PARATHA', 'VEG', false, 'PUNJABI', 'LD'],
  ['Makki di Roti', 'ROTI_PARATHA', 'VEG', true, 'PUNJABI', 'LD'],
  ['Bajra Roti', 'ROTI_PARATHA', 'VEG', true, 'RAJASTHANI', 'LD'],
  ['Jowar Bhakri', 'ROTI_PARATHA', 'VEG', true, 'MAHARASHTRIAN', 'LD'],
  ['Ragi Roti', 'ROTI_PARATHA', 'VEG', true, 'SOUTH_INDIAN', 'BLD'],
  ['Puri', 'ROTI_PARATHA', 'VEG', true, 'NORTH_INDIAN', 'BL'],
  ['Naan', 'ROTI_PARATHA', 'VEG', true, 'PUNJABI', 'LD'],
  ['Kulcha', 'ROTI_PARATHA', 'VEG', true, 'PUNJABI', 'LD'],
  ['Malabar Parotta', 'ROTI_PARATHA', 'VEG', true, 'SOUTH_INDIAN', 'LD'],
  ['Baati', 'ROTI_PARATHA', 'VEG', true, 'RAJASTHANI', 'L'],

  // ── Rice ──
  ['Steamed Rice', 'RICE', 'VEG', true, 'OTHER', 'LD'],
  ['Jeera Rice', 'RICE', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Veg Pulao', 'RICE', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Matar Pulao', 'RICE', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Veg Biryani', 'RICE', 'VEG', false, 'OTHER', 'LD'],
  ['Khichdi', 'RICE', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Masala Khichdi', 'RICE', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Curd Rice', 'RICE', 'VEG', true, 'SOUTH_INDIAN', 'LD'],
  ['Lemon Rice', 'RICE', 'VEG', false, 'SOUTH_INDIAN', 'L'],
  ['Tamarind Rice', 'RICE', 'VEG', false, 'SOUTH_INDIAN', 'L'],
  ['Bisi Bele Bath', 'RICE', 'VEG', false, 'SOUTH_INDIAN', 'LD'],
  ['Masale Bhat', 'RICE', 'VEG', false, 'MAHARASHTRIAN', 'LD'],
  ['Egg Fried Rice', 'RICE', 'EGG', false, 'OTHER', 'LD'],
  ['Egg Biryani', 'RICE', 'EGG', false, 'OTHER', 'LD'],
  ['Chicken Biryani', 'RICE', 'NON_VEG', false, 'OTHER', 'LD'],
  ['Mutton Biryani', 'RICE', 'NON_VEG', false, 'OTHER', 'LD'],
  ['Chicken Pulao', 'RICE', 'NON_VEG', false, 'NORTH_INDIAN', 'LD'],

  // ── Snacks ──
  ['Samosa', 'SNACK', 'VEG', false, 'NORTH_INDIAN', 'S'],
  ['Veg Pakora', 'SNACK', 'VEG', false, 'NORTH_INDIAN', 'S'],
  ['Paneer Pakora', 'SNACK', 'VEG', false, 'NORTH_INDIAN', 'S'],
  ['Aloo Tikki', 'SNACK', 'VEG', false, 'NORTH_INDIAN', 'S'],
  ['Pav Bhaji', 'SNACK', 'VEG', false, 'MAHARASHTRIAN', 'SD'],
  ['Vada Pav', 'SNACK', 'VEG', false, 'MAHARASHTRIAN', 'S'],
  ['Bhel Puri', 'SNACK', 'VEG', false, 'MAHARASHTRIAN', 'S'],
  ['Sprouts Chaat', 'SNACK', 'VEG', false, 'NORTH_INDIAN', 'BS'],
  ['Corn Chaat', 'SNACK', 'VEG', false, 'OTHER', 'S'],
  ['Khaman', 'SNACK', 'VEG', true, 'GUJARATI', 'BS'],
  ['Muthiya', 'SNACK', 'VEG', false, 'GUJARATI', 'S'],
  ['Kanda Bhaji', 'SNACK', 'VEG', false, 'MAHARASHTRIAN', 'S'],
  ['Banana Chips', 'SNACK', 'VEG', true, 'SOUTH_INDIAN', 'S'],
  ['Masala Peanuts', 'SNACK', 'VEG', false, 'OTHER', 'S'],
  ['Chicken Tikka', 'SNACK', 'NON_VEG', false, 'PUNJABI', 'SD'],
  ['Chicken Pakora', 'SNACK', 'NON_VEG', false, 'NORTH_INDIAN', 'S'],
  ['Egg Pakora', 'SNACK', 'EGG', false, 'NORTH_INDIAN', 'S'],

  // ── Salad / raita ──
  ['Green Salad', 'SALAD', 'VEG', false, 'OTHER', 'LD'],
  ['Kachumber Salad', 'SALAD', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Sprouts Salad', 'SALAD', 'VEG', false, 'OTHER', 'BLD'],
  ['Boondi Raita', 'SALAD', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Cucumber Raita', 'SALAD', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Plain Curd', 'SALAD', 'VEG', true, 'OTHER', 'BLD'],
  ['Kosambari', 'SALAD', 'VEG', true, 'SOUTH_INDIAN', 'L'],

  // ── Sweet ──
  ['Suji Halwa', 'SWEET', 'VEG', true, 'NORTH_INDIAN', 'BLD'],
  ['Gajar Halwa', 'SWEET', 'VEG', false, 'NORTH_INDIAN', 'LD'],
  ['Kheer', 'SWEET', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Sewaiyan', 'SWEET', 'VEG', true, 'NORTH_INDIAN', 'BLD'],
  ['Gulab Jamun', 'SWEET', 'VEG', true, 'NORTH_INDIAN', 'LD'],
  ['Shrikhand', 'SWEET', 'VEG', true, 'MAHARASHTRIAN', 'LD'],
  ['Puran Poli', 'SWEET', 'VEG', true, 'MAHARASHTRIAN', 'L'],
  ['Payasam', 'SWEET', 'VEG', true, 'SOUTH_INDIAN', 'LD'],
  ['Mishti Doi', 'SWEET', 'VEG', true, 'BENGALI', 'LD'],
  ['Churma', 'SWEET', 'VEG', true, 'RAJASTHANI', 'L'],
  ['Besan Ladoo', 'SWEET', 'VEG', true, 'NORTH_INDIAN', 'S'],
  ['Fruit Custard', 'SWEET', 'VEG', true, 'OTHER', 'LD'],

  // ── Drinks ──
  ['Masala Chai', 'DRINK', 'VEG', false, 'OTHER', 'BS'],
  ['Filter Coffee', 'DRINK', 'VEG', true, 'SOUTH_INDIAN', 'BS'],
  ['Lassi', 'DRINK', 'VEG', true, 'PUNJABI', 'LS'],
  ['Chaas', 'DRINK', 'VEG', true, 'GUJARATI', 'L'],
  ['Nimbu Pani', 'DRINK', 'VEG', true, 'OTHER', 'LS'],
  ['Haldi Doodh', 'DRINK', 'VEG', false, 'OTHER', 'D'],
  ['Fruit Smoothie', 'DRINK', 'VEG', true, 'OTHER', 'BS'],
  ['Vegetable Soup', 'DRINK', 'VEG', false, 'OTHER', 'SD'],
  ['Tomato Soup', 'DRINK', 'VEG', false, 'OTHER', 'SD'],
  ['Chicken Soup', 'DRINK', 'NON_VEG', false, 'OTHER', 'SD'],
];

const key = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set — aborting.'); process.exit(1); }
  const needsSsl = /render\.com|dpg-|sslmode=require/i.test(url);
  const c = new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  const seen = new Set();
  let added = 0;
  try {
    await c.query('BEGIN');
    for (const [name, category, diet, jainOk, region, meals] of DISHES) {
      const k = key(name);
      if (seen.has(k)) throw new Error(`duplicate in the seed list: ${name}`);
      seen.add(k);
      const r = await c.query(
        `INSERT INTO dishes (name, name_key, category, diet, jain_ok, region, meals)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::boolean, $6::varchar, $7::text[]
          WHERE NOT EXISTS (SELECT 1 FROM dishes WHERE client_id IS NULL AND name_key = $2::varchar)`,
        [name, k, category, diet, jainOk, region, [...meals].map((m) => M[m])],
      );
      added += r.rowCount;
    }
    await c.query('COMMIT');
    const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM dishes WHERE client_id IS NULL`);
    console.log(`Dish seed: ${DISHES.length} in the list, ${added} added now, ${n.n} common dishes in the table.`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('Rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
