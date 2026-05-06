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

async function fixNotifications() {
    try {
        console.log('--- ĐANG SỬA THÔNG BÁO CŨ ---');
        
        // Lấy tất cả thông báo loại 'order' mà chưa có ảnh
        const res = await pool.query("SELECT id, related_id FROM notifications WHERE type = 'order' AND (image_url IS NULL OR image_url = '')");
        
        console.log(`Tìm thấy ${res.rows.length} thông báo cần cập nhật.`);

        for (const row of res.rows) {
            const orderId = row.related_id;
            if (!orderId) continue;

            // Tìm ảnh sản phẩm đầu tiên của đơn hàng này
            const imgRes = await pool.query(`
                SELECT p.image_url 
                FROM order_items oi 
                JOIN products p ON oi.product_id = p.id 
                WHERE oi.order_id = $1 
                LIMIT 1
            `, [orderId]);

            if (imgRes.rows.length > 0) {
                const imageUrl = imgRes.rows[0].image_url;
                await pool.query('UPDATE notifications SET image_url = $1 WHERE id = $2', [imageUrl, row.id]);
                console.log(`✅ Đã cập nhật ảnh cho thông báo ID ${row.id} (Order: ${orderId})`);
            }
        }
        
        console.log('--- HOÀN THÀNH ---');
    } catch (e) {
        console.error('Lỗi khi sửa thông báo:', e.message);
    } finally {
        pool.end();
    }
}

fixNotifications();
