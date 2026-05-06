const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    }
});

async function test() {
    try {
        const orderCode = 'TH17780618834520696';
        const res = await pool.query("SELECT id FROM orders WHERE order_code = $1", [orderCode]);
        console.log('Order ID:', res.rows[0]?.id);
        if (res.rows[0]) {
            const id = res.rows[0].id;
            const updateImgRes = await pool.query('SELECT p.image_url FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1 LIMIT 1', [id]);
            console.log('Image Result:', updateImgRes.rows);
        }
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
test();
