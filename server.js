const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
    process.exit(1);
});

// Đảm bảo thư mục uploads tồn tại
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Cấu hình Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cấu hình Cloudinary Storage cho Multer
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'taphoa_mobile', // Tên thư mục trên Cloudinary
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        public_id: (req, file) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            return uniqueSuffix;
        }
    },
});

const upload = multer({ storage: storage });

// Thay đổi CLIENT_ID này bằng WEB CLIENT ID của bạn từ Google Cloud Console
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '893168496830-1ps6f3pmockmt2pf50bsgs5tusmvdp7e.apps.googleusercontent.com';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware ghi log mọi request
app.use((req, res, next) => {
    console.log(`[Request] ${req.method} ${req.url} - ${new Date().toLocaleTimeString()}`);
    next();
});

// Giữ cho process luôn sống và báo hiệu
setInterval(() => {
    // console.log(`[Heartbeat] ${new Date().toLocaleTimeString()} - Process ID: ${process.pid}`);
}, 30000);

// Cấu hình kết nối PostgreSQL
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

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    console.log(`✅ Đã kết nối Database tại: ${process.env.DB_HOST}`);
    release();
});

// ==========================================
// ROUTES (API Endpoints)
// ==========================================

// --- AUTHENTICATION ROUTES ---

// Đăng ký (Register)
app.post('/api/register', async (req, res) => {
    const { fullName, email, password } = req.body;
    try {
        // Kiểm tra xem email đã tồn tại hay chưa
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Email đã được sử dụng' });
        }

        // Hash mật khẩu
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Lưu user vào db
        const newUser = await pool.query(
            'INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, full_name, email',
            [fullName, email, hashedPassword]
        );

        res.status(201).json({ message: 'Đăng ký thành công', user: newUser.rows[0] });
    } catch (err) {
        console.error('Lỗi khi đăng ký:', err.message);
        res.status(500).json({ error: 'Lỗi server khi đăng ký' });
    }
});

// Đăng nhập (Login)
app.post('/api/login', async (req, res) => {
    console.log(`[Login] Nhận yêu cầu đăng nhập cho email: ${req.body?.email}`);
    const { email, password } = req.body;
    try {
        // Tìm user theo email
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác' });
        }

        const user = userResult.rows[0];

        // So sánh mật khẩu
        const isMatch = await bcrypt.compare(password, user.password_hash || '');
        if (!isMatch) {
            return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác' });
        }

        // Tạo JWT Token
        const payload = {
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                role: user.role
            }
        };

        const token = jwt.sign(
            payload,
            process.env.JWT_SECRET || 'secret_token_default',
            { expiresIn: '7d' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                role: user.role
            }
        });
    } catch (err) {
        console.error('Lỗi khi đăng nhập:', err.message);
        res.status(500).json({ error: 'Lỗi server khi đăng nhập' });
    }
});

// Đăng nhập bằng Google (Google Login)
app.post('/api/google-login', async (req, res) => {
    const { idToken } = req.body;
    console.log('--------------------------------------------------');
    console.log('[Google Login] 📥 Nhận yêu cầu đăng nhập Google');

    if (!idToken) {
        console.error('[Google Login] ❌ Lỗi: Không tìm thấy ID Token trong request body');
        return res.status(400).json({ error: 'Không tìm thấy Google ID Token' });
    }

    try {
        console.log('[Google Login] 🔍 Đang xác thực ID Token với Google...');
        console.log(`[Google Login] 🎯 Audience mong đợi: ${GOOGLE_CLIENT_ID}`);

        // Verify token với Google
        const ticket = await client.verifyIdToken({
            idToken: idToken,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];
        const name = payload['name'];

        console.log(`[Google Login] ✅ Xác thực thành công! User: ${email} (${name})`);

        // Kiểm tra xem User đã tồn tại trong DB chưa
        console.log(`[Google Login] 🗄️ Đang kiểm tra người dùng trong database...`);
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        let user;

        if (userResult.rows.length === 0) {
            console.log(`[Google Login] ✨ Người dùng mới! Đang tạo tài khoản cho: ${email}`);
            const newUser = await pool.query(
                `INSERT INTO users (full_name, email, auth_provider, role) 
                 VALUES ($1, $2, 'google', 'user') 
                 RETURNING id, full_name, email, role`,
                [name, email]
            );
            user = newUser.rows[0];
            console.log(`[Google Login] 👤 Đã tạo user ID: ${user.id}`);
        } else {
            user = userResult.rows[0];
            console.log(`[Google Login] 👋 Chào mừng quay trở lại, user ID: ${user.id}`);
        }

        console.log(`[Google Login] 🔑 Đang tạo JWT Token hệ thống...`);
        // Tạo JWT Token của hệ thống mình cho thiết bị
        const jwtPayload = {
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name || user.fullName,
                role: user.role
            }
        };

        const token = jwt.sign(
            jwtPayload,
            process.env.JWT_SECRET || 'secret_token_default',
            { expiresIn: '7d' }
        );

        console.log(`[Google Login] 🚀 Gửi phản hồi thành công về cho App!`);
        console.log('--------------------------------------------------');

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name || user.fullName,
                role: user.role
            }
        });

    } catch (err) {
        console.error('--------------------------------------------------');
        console.error('[Google Login] ❌ LỖI XÁC THỰC GOOGLE:');
        console.error(`[Google Login] Chi tiết lỗi: ${err.message}`);
        if (err.message.includes('audience')) {
            console.error(`[Google Login] GỢI Ý: Kiểm tra xem Client ID trên Backend (${GOOGLE_CLIENT_ID}) đã khớp với Client ID trên Google Cloud Console chưa.`);
        }
        console.error('--------------------------------------------------');

        res.status(401).json({ error: `Xác thực Google thất bại: ${err.message}` });
    }
});

// ==========================================
// SHIPPER APIs
// ==========================================

// Auto-migration: Thêm các cột shipper vào bảng orders nếu chưa có
(async () => {
    try {
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipper_id INTEGER REFERENCES users(id);');
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;');
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_proof TEXT;');
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS failed_reason TEXT;');
        console.log('✅ Shipper columns migration completed');
    } catch (e) {
        console.log('ℹ️ Shipper columns migration skipped (already exists or error):', e.message);
    }
})();

// Lấy danh sách đơn hàng cho Shipper (chỉ lấy đơn được gán cho shipper này)
app.get('/api/shipper/orders', async (req, res) => {
    try {
        // Xác thực shipper qua JWT token
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ error: 'Chưa đăng nhập' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_token_default');
        const shipperId = decoded.user.id;

        const query = `
            SELECT o.*, u.full_name as shipper_name 
            FROM orders o
            LEFT JOIN users u ON o.shipper_id = u.id
            WHERE o.shipper_id = $1
            ORDER BY 
                CASE o.order_status 
                    WHEN 'confirmed' THEN 1 
                    WHEN 'shipping' THEN 2 
                    WHEN 'delivered' THEN 3 
                    WHEN 'failed' THEN 4 
                    ELSE 5 
                END,
                o.created_at DESC;
        `;
        const result = await pool.query(query, [shipperId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tải danh sách đơn hàng cho Shipper' });
    }
});

// Cập nhật trạng thái đơn hàng (Shipper)
app.put('/api/shipper/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, proof_image, failed_reason } = req.body;

    try {
        let query = `
            UPDATE orders 
            SET order_status = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING *;
        `;
        let values = [status, id];

        if (proof_image) {
            query = `
                UPDATE orders 
                SET order_status = $1, delivery_proof = $2, updated_at = NOW()
                WHERE id = $3
                RETURNING *;
            `;
            values = [status, proof_image, id];
        } else if (failed_reason) {
            query = `
                UPDATE orders 
                SET order_status = $1, failed_reason = $2, updated_at = NOW()
                WHERE id = $3
                RETURNING *;
            `;
            values = [status, failed_reason, id];
        }

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        }
        res.json({ message: 'Cập nhật trạng thái thành công', order: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi cập nhật trạng thái đơn hàng' });
    }
});

// ==========================================
// ADMIN DISPATCH APIs (Điều phối đơn hàng)
// ==========================================

// Lấy danh sách tất cả Shipper (để Admin chọn khi phân đơn thủ công)
app.get('/api/admin/shippers', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.full_name, u.email, u.is_online,
                (SELECT COUNT(*) FROM orders WHERE shipper_id = u.id AND order_status IN ('confirmed', 'shipping')) as active_orders,
                (SELECT COUNT(*) FROM orders WHERE shipper_id = u.id AND order_status = 'delivered') as delivered_orders,
                (SELECT COUNT(*) FROM orders WHERE shipper_id = u.id AND order_status = 'failed') as failed_orders,
                (SELECT COALESCE(SUM(CAST(total_amount AS NUMERIC)), 0) FROM orders WHERE shipper_id = u.id AND order_status = 'shipping' AND payment_method = 'COD') as cod_holding
            FROM users u 
            WHERE u.role = 'shipper'
            ORDER BY u.is_online DESC, u.full_name;
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi lấy danh sách shipper:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Admin duyệt đơn + Tự động phân shipper (Auto Dispatch)
app.post('/api/admin/orders/:id/approve', async (req, res) => {
    const { id } = req.params;
    const { shipper_id } = req.body; // Nếu có = phân thủ công, không có = tự động

    try {
        // Kiểm tra đơn hàng tồn tại và đang ở trạng thái pending
        const orderCheck = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        }
        if (orderCheck.rows[0].order_status !== 'pending') {
            return res.status(400).json({ error: 'Đơn hàng không ở trạng thái chờ duyệt' });
        }

        let assignedShipperId = shipper_id;

        if (assignedShipperId) {
            // Kiểm tra shipper này có online không
            const sCheck = await pool.query('SELECT is_online FROM users WHERE id = $1 AND role = \'shipper\'', [assignedShipperId]);
            if (sCheck.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy shipper' });
            if (!sCheck.rows[0].is_online) return res.status(400).json({ error: 'Tài xế này đang Offline, không thể gán đơn!' });
        } else {
            // Tự động tìm shipper online và có ít đơn nhất (Load Balancing)
            const shipperResult = await pool.query(`
                SELECT u.id, u.full_name,
                    (SELECT COUNT(*) FROM orders WHERE shipper_id = u.id AND order_status IN ('confirmed', 'shipping')) as active_count
                FROM users u
                WHERE u.role = 'shipper' AND u.is_online = true
                ORDER BY active_count ASC, u.id ASC
                LIMIT 1;
            `);

            if (shipperResult.rows.length === 0) {
                return res.status(400).json({ error: 'Hiện tại không có tài xế nào đang Online để gán đơn!' });
            }
            assignedShipperId = shipperResult.rows[0].id;
        }

        // Duyệt đơn: chuyển sang confirmed + gán shipper
        const result = await pool.query(`
            UPDATE orders 
            SET order_status = 'confirmed', shipper_id = $1, assigned_at = NOW(), updated_at = NOW()
            WHERE id = $2
            RETURNING *;
        `, [assignedShipperId, id]);

        // Lấy tên shipper để trả về
        const shipperInfo = await pool.query('SELECT full_name FROM users WHERE id = $1', [assignedShipperId]);
        const shipperName = shipperInfo.rows[0]?.full_name || 'Không rõ';

        res.json({
            message: `Đã duyệt đơn và giao cho shipper: ${shipperName}`,
            order: result.rows[0],
            shipper_name: shipperName
        });
    } catch (err) {
        console.error('Lỗi duyệt đơn hàng:', err.message);
        res.status(500).json({ error: 'Lỗi server khi duyệt đơn hàng' });
    }
});

// Admin: Duyệt TẤT CẢ đơn hàng pending (Auto Dispatch cho tất cả)
app.post('/api/admin/orders/approve-all', async (req, res) => {
    try {
        // Lấy tất cả đơn pending
        const pendingOrders = await pool.query("SELECT id FROM orders WHERE order_status = 'pending' ORDER BY created_at ASC");
        if (pendingOrders.rows.length === 0) {
            return res.json({ message: 'Không có đơn hàng nào cần duyệt', approved: 0 });
        }

        // Lấy tất cả shipper
        const shippers = await pool.query("SELECT id, full_name FROM users WHERE role = 'shipper' ORDER BY id");
        if (shippers.rows.length === 0) {
            return res.status(400).json({ error: 'Không có shipper nào trong hệ thống' });
        }

        let approvedCount = 0;
        for (let i = 0; i < pendingOrders.rows.length; i++) {
            // Round-robin: phân đều cho các shipper
            const shipperIndex = i % shippers.rows.length;
            const shipperId = shippers.rows[shipperIndex].id;

            await pool.query(`
                UPDATE orders 
                SET order_status = 'confirmed', shipper_id = $1, assigned_at = NOW(), updated_at = NOW()
                WHERE id = $2;
            `, [shipperId, pendingOrders.rows[i].id]);
            approvedCount++;
        }

        res.json({ message: `Đã duyệt và phân ${approvedCount} đơn hàng cho ${shippers.rows.length} shipper`, approved: approvedCount });
    } catch (err) {
        console.error('Lỗi duyệt tất cả đơn:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// 1. API lấy toàn bộ Danh mục chính và Danh mục con tương ứng
app.get('/api/categories', async (req, res) => {
    try {
        const query = `
      SELECT 
        mc.id as main_id, mc.name as main_name, mc.icon_data, mc.color_hex,
        sc.id as sub_id, sc.name as sub_name
      FROM main_categories mc
      LEFT JOIN sub_categories sc ON mc.id = sc.main_category_id
      ORDER BY mc.id, sc.id;
    `;
        const result = await pool.query(query);

        // Format JSON trả về (gom sub-categories vào mảng của main-category)
        const formattedData = {};
        result.rows.forEach(row => {
            if (!formattedData[row.main_id]) {
                formattedData[row.main_id] = {
                    id: row.main_id,
                    name: row.main_name,
                    icon_data: row.icon_data,
                    color_hex: row.color_hex,
                    sub_categories: []
                };
            }
            if (row.sub_name) {
                formattedData[row.main_id].sub_categories.push({
                    id: row.sub_id,
                    name: row.sub_name
                });
            }
        });

        res.json(Object.values(formattedData));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tải categories' });
    }
});

// 2. API lấy Danh sách sản phẩm theo Sub-Category
app.get('/api/products/sub/:subCategoryId', async (req, res) => {
    const { subCategoryId } = req.params;
    try {
        const query = `
      SELECT p.*, sc.name as sub_category_name,
        COALESCE(
          (SELECT json_agg(pi.image_url) FROM product_images pi WHERE pi.product_id = p.id),
          '[]'::json
        ) as images
      FROM products p
      JOIN sub_categories sc ON p.sub_category_id = sc.id
      WHERE p.sub_category_id = $1
    `;
        const result = await pool.query(query, [subCategoryId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tải products' });
    }
});

// 3. API Tìm kiếm sản phẩm
app.get('/api/products/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
        const query = `
      SELECT p.*, sc.name as sub_category_name,
        COALESCE(
          (SELECT json_agg(pi.image_url) FROM product_images pi WHERE pi.product_id = p.id),
          '[]'::json
        ) as images
      FROM products p
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.id
      WHERE p.name ILIKE $1 OR p.description ILIKE $1
    `;
        const result = await pool.query(query, [`%${q}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tìm kiếm sản phẩm' });
    }
});

// 4. API lấy toàn bộ sản phẩm 
app.get('/api/products', async (req, res) => {
    try {
        const query = `
      SELECT p.*, sc.name as sub_category_name,
        COALESCE(
          (SELECT json_agg(pi.image_url) FROM product_images pi WHERE pi.product_id = p.id),
          '[]'::json
        ) as images
      FROM products p
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.id
      ORDER BY p.id ASC;
    `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tải danh sách sản phẩm' });
    }
});

// 3.5 API lấy chi tiết 1 sản phẩm theo ID
app.get('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
      SELECT p.*, sc.name as sub_category_name,
        COALESCE(
          (SELECT json_agg(pi.image_url) FROM product_images pi WHERE pi.product_id = p.id),
          '[]'::json
        ) as images
      FROM products p
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.id
      WHERE p.id = $1;
    `;
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tải chi tiết sản phẩm' });
    }
});

// ==========================================
// CATEGORY MANAGEMENT APIs
// ==========================================

// --- MAIN CATEGORIES ---
app.post('/api/categories/main', async (req, res) => {
    const { name, icon_data, color_hex } = req.body;
    try {
        const query = `
            INSERT INTO main_categories (name, icon_data, color_hex)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const result = await pool.query(query, [name, icon_data || null, color_hex || null]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi thêm danh mục chính' });
    }
});

app.put('/api/categories/main/:id', async (req, res) => {
    const { id } = req.params;
    const { name, icon_data, color_hex } = req.body;
    try {
        const query = `
            UPDATE main_categories 
            SET name = $1, icon_data = $2, color_hex = $3
            WHERE id = $4
            RETURNING *;
        `;
        const result = await pool.query(query, [name, icon_data || null, color_hex || null, id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy danh mục' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi cập nhật danh mục chính' });
    }
});

app.delete('/api/categories/main/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM main_categories WHERE id = $1 RETURNING *';
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy danh mục' });
        res.json({ message: 'Xóa danh mục chính thành công' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi xóa danh mục chính' });
    }
});

// --- SUB CATEGORIES ---
app.post('/api/categories/sub', async (req, res) => {
    const { main_category_id, name } = req.body;
    try {
        const query = `
            INSERT INTO sub_categories (main_category_id, name)
            VALUES ($1, $2)
            RETURNING *;
        `;
        const result = await pool.query(query, [main_category_id, name]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi thêm danh mục con' });
    }
});

app.put('/api/categories/sub/:id', async (req, res) => {
    const { id } = req.params;
    const { main_category_id, name } = req.body;
    try {
        const query = `
            UPDATE sub_categories 
            SET main_category_id = $1, name = $2
            WHERE id = $3
            RETURNING *;
        `;
        const result = await pool.query(query, [main_category_id, name, id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy danh mục con' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi cập nhật danh mục con' });
    }
});

app.delete('/api/categories/sub/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM sub_categories WHERE id = $1 RETURNING *';
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy danh mục con' });
        res.json({ message: 'Xóa danh mục con thành công' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi xóa danh mục con' });
    }
});

// 4. API Lấy toàn bộ Sub-Categories (Dùng cho Admin chọn danh mục khi thêm sản phẩm)
app.get('/api/sub-categories', async (req, res) => {
    try {
        const query = `
      SELECT sc.id, sc.name, mc.name as main_category_name 
      FROM sub_categories sc
      JOIN main_categories mc ON sc.main_category_id = mc.id
      ORDER BY mc.id, sc.id
    `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi server khi tải sub-categories' });
    }
});

// 5. Thêm sản phẩm mới (CREATE)
app.post('/api/products', async (req, res) => {
    const { name, price, original_price, discount_percent, description, stock_quantity, import_quantity, sold_quantity, unit, sub_category_id, images } = req.body;
    try {
        await pool.query('BEGIN');

        const mainImage = images && images.length > 0 ? images[0] : '';
        const query = `
            INSERT INTO products (name, price, original_price, discount_percent, image_url, description, stock_quantity, import_quantity, sold_quantity, unit, sub_category_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *;
        `;
        const result = await pool.query(query, [name, price, original_price || null, discount_percent || 0, mainImage, description || '', stock_quantity || 0, import_quantity || 0, sold_quantity || 0, unit || 'Cái', sub_category_id || null]);
        const newProduct = result.rows[0];

        if (images && images.length > 0) {
            for (let i = 0; i < images.length; i++) {
                await pool.query(
                    'INSERT INTO product_images (product_id, image_url, is_primary) VALUES ($1, $2, $3)',
                    [newProduct.id, images[i], i === 0]
                );
            }
        }

        await pool.query('COMMIT');

        newProduct.images = images || [];
        res.status(201).json(newProduct);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi thêm sản phẩm mới' });
    }
});

// 5.5 Upload images API
app.post('/api/upload', upload.array('images', 10), (req, res) => {
    try {
        const fileUrls = req.files.map(file => {
            // Cloudinary trả về URL trong trường path
            return file.path;
        });
        res.json({ urls: fileUrls });
    } catch (error) {
        console.error('Lỗi khi upload ảnh:', error);
        res.status(500).json({ error: 'Lỗi upload ảnh' });
    }
});

// 6. Cập nhật sản phẩm (UPDATE)
app.put('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price, original_price, discount_percent, description, stock_quantity, import_quantity, sold_quantity, unit, sub_category_id, images } = req.body;
    try {
        await pool.query('BEGIN');

        const mainImage = images && images.length > 0 ? images[0] : '';
        const query = `
            UPDATE products 
            SET name = $1, price = $2, original_price = $3, discount_percent = $4, image_url = $5, description = $6, stock_quantity = $7, import_quantity = $8, sold_quantity = $9, unit = $10, sub_category_id = $11
            WHERE id = $12
            RETURNING *;
        `;
        const result = await pool.query(query, [name, price, original_price || null, discount_percent || 0, mainImage, description || '', stock_quantity || 0, import_quantity || 0, sold_quantity || 0, unit || 'Cái', sub_category_id || null, id]);

        if (result.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: 'Không tìm thấy sản phẩm để cập nhật' });
        }

        // Remove old images related to this product fully replacing them
        await pool.query('DELETE FROM product_images WHERE product_id = $1', [id]);

        if (images && images.length > 0) {
            for (let i = 0; i < images.length; i++) {
                await pool.query(
                    'INSERT INTO product_images (product_id, image_url, is_primary) VALUES ($1, $2, $3)',
                    [id, images[i], i === 0]
                );
            }
        }

        await pool.query('COMMIT');

        const updatedProduct = result.rows[0];
        updatedProduct.images = images || [];
        res.json(updatedProduct);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi cập nhật sản phẩm' });
    }
});

// 7. Xóa sản phẩm (DELETE)
app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM products WHERE id = $1 RETURNING *';
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy sản phẩm để xóa' });
        }
        res.json({ message: 'Đã xóa sản phẩm thành công', deletedProduct: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi xóa sản phẩm' });
    }
});

// ==========================================
// USER MANAGEMENT APIs
// ==========================================

// Lấy danh sách tài khoản
app.get('/api/users', async (req, res) => {
    try {
        const query = 'SELECT id, full_name, email, role, created_at FROM users ORDER BY created_at DESC';
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi tải danh sách người dùng' });
    }
});

// Cập nhật thông tin cá nhân (User tự cập nhật)
app.put('/api/profile/:id', async (req, res) => {
    const { id } = req.params;
    const { fullName, email, password } = req.body;
    try {
        let query, values;

        // Kiểm tra xem email đã được sử dụng bởi user khác chưa
        const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, id]);
        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Email đã được sử dụng bởi tài khoản khác' });
        }

        if (password) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            query = `
                UPDATE users 
                SET full_name = $1, email = $2, password_hash = $3
                WHERE id = $4
                RETURNING id, full_name, email;
            `;
            values = [fullName, email, hashedPassword, id];
        } else {
            query = `
                UPDATE users 
                SET full_name = $1, email = $2
                WHERE id = $3
                RETURNING id, full_name, email;
            `;
            values = [fullName, email, id];
        }

        const result = await pool.query(query, values);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

        const user = result.rows[0];
        res.json({
            message: 'Cập nhật thành công',
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi cập nhật thông tin cá nhân' });
    }
});

// Admin Tạo tài khoản mới (Shipper, Admin, User)
app.post('/api/users', async (req, res) => {
    const { full_name, email, password, role } = req.body;
    try {
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Email đã tồn tại' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const query = `
            INSERT INTO users (full_name, email, password_hash, role)
            VALUES ($1, $2, $3, $4)
            RETURNING id, full_name, email, role, created_at;
        `;
        const result = await pool.query(query, [full_name, email, hashedPassword, role || 'user']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi tạo tài khoản' });
    }
});

// Admin Cập nhật tài khoản
app.put('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const { full_name, email, password, role } = req.body;
    try {
        let query, values;

        if (password) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            query = `
                UPDATE users 
                SET full_name = $1, email = $2, password_hash = $3, role = $4
                WHERE id = $5
                RETURNING id, full_name, email, role, created_at;
            `;
            values = [full_name, email, hashedPassword, role, id];
        } else {
            query = `
                UPDATE users 
                SET full_name = $1, email = $2, role = $3
                WHERE id = $4
                RETURNING id, full_name, email, role, created_at;
            `;
            values = [full_name, email, role, id];
        }

        const result = await pool.query(query, values);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi cập nhật tài khoản' });
    }
});

// Xóa tài khoản
app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM users WHERE id = $1 RETURNING id';
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản để xóa' });
        res.json({ message: 'Đã xóa tài khoản' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Lỗi khi xóa tài khoản' });
    }
});

// ==========================================
// ORDER & PAYMENT APIs (VNPay)
// ==========================================

// -- Payment Configuration --
const VNPAY_TMN_CODE = process.env.VNPAY_TMN_CODE || 'YOUR_VNPAY_TMN_CODE';
const VNPAY_HASH_SECRET = process.env.VNPAY_HASH_SECRET || 'YOUR_VNPAY_HASH_SECRET';
const VNPAY_URL = process.env.VNPAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
const VNPAY_RETURN_URL = process.env.VNPAY_RETURN_URL || 'https://taphoa.com/api/payment/vnpay/return';

// Helper: Tạo mã đơn hàng duy nhất
function generateOrderCode() {
    const timestamp = Date.now().toString();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `TH${timestamp}${random}`;
}

// Helper: Tạo thông báo
async function createNotification(userId, title, body, type = 'system', relatedId = null) {
    try {
        const query = `
            INSERT INTO notifications (user_id, title, body, type, related_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        await pool.query(query, [userId, title, body, type, relatedId]);
    } catch (err) {
        console.error('Lỗi tạo thông báo:', err.message);
    }
}

// Helper: Sắp xếp object theo key (yêu cầu của VNPay)
function sortObject(obj) {
    let sorted = {};
    let keys = Object.keys(obj).sort();
    keys.forEach(key => {
        sorted[key] = obj[key]; // Không mã hóa tay ở đây tránh bị Double Encoding
    });
    return sorted;
}

// ---- TẠO ĐƠN HÀNG ----
app.post('/api/orders', async (req, res) => {
    const { customer_name, customer_phone, customer_address, total_amount, payment_method, items } = req.body;

    try {
        await pool.query('BEGIN');

        const orderCode = generateOrderCode();

        // Trích xuất user ID từ JWT token (nếu có)
        let userId = null;
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            try {
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_token_default');
                userId = decoded.user.id;
            } catch (e) {
                // Token không hợp lệ, tiếp tục không có user ID
            }
        }

        const paymentStatus = payment_method === 'COD' ? 'cod_pending' : 'pending';
        const orderQuery = `
            INSERT INTO orders (user_id, order_code, customer_name, customer_phone, customer_address, total_amount, payment_method, payment_status, order_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const orderResult = await pool.query(orderQuery, [
            userId, orderCode, customer_name, customer_phone, customer_address,
            total_amount, payment_method, paymentStatus, 'pending'
        ]);
        const order = orderResult.rows[0];

        // Lưu chi tiết đơn hàng và cập nhật số lượng kho
        if (items && items.length > 0) {
            for (const item of items) {
                // 1. Kiểm tra tồn kho trước khi trừ
                const productCheck = await pool.query(
                    'SELECT name, stock_quantity FROM products WHERE id = $1 FOR UPDATE',
                    [item.product_id]
                );

                if (productCheck.rows.length === 0) {
                    throw new Error(`Sản phẩm ID ${item.product_id} không tồn tại`);
                }

                const stock = productCheck.rows[0].stock_quantity;
                if (stock < item.quantity) {
                    // Nếu không đủ kho, báo lỗi cụ thể
                    await pool.query('ROLLBACK');
                    return res.status(400).json({
                        error: `Sản phẩm "${productCheck.rows[0].name}" chỉ còn ${stock} sản phẩm trong kho. Vui lòng cập nhật lại giỏ hàng.`
                    });
                }

                // 2. Lưu vào order_items
                await pool.query(
                    'INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity) VALUES ($1, $2, $3, $4, $5)',
                    [order.id, item.product_id, item.product_name, item.product_price, item.quantity]
                );

                // 3. Trừ số lượng tồn kho và tăng số lượng đã bán
                await pool.query(
                    'UPDATE products SET stock_quantity = stock_quantity - $1, sold_quantity = sold_quantity + $1 WHERE id = $2',
                    [item.quantity, item.product_id]
                );
            }
        }

        await pool.query('COMMIT');

        // Tạo thông báo cho người dùng
        if (userId) {
            await createNotification(
                userId,
                'Đặt hàng thành công! 🎉',
                `Đơn hàng #${orderCode} của bạn đã được tiếp nhận. Tổng tiền: ${total_amount.toLocaleString()}đ`,
                'order',
                order.id
            );
        }

        res.status(201).json(order);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Lỗi tạo đơn hàng:', err.message);
        res.status(500).json({ error: 'Lỗi server khi tạo đơn hàng' });
    }
});

// ---- TẠO URL THANH TOÁN VNPAY ----
app.post('/api/payment/vnpay/create', async (req, res) => {
    try {
        const { order_id, amount, order_info } = req.body;

        const date = new Date();
        // Format: yyyyMMddHHmmss
        const pad = (n) => n.toString().padStart(2, '0');
        const createDate = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
        const txnRef = `${order_id}_${createDate}`;

        let vnp_Params = {
            'vnp_Version': '2.1.0',
            'vnp_Command': 'pay',
            'vnp_TmnCode': VNPAY_TMN_CODE,
            'vnp_Locale': 'vn',
            'vnp_CurrCode': 'VND',
            'vnp_TxnRef': txnRef,
            'vnp_OrderInfo': order_info || `Thanh toan don hang #${order_id}`,
            'vnp_OrderType': 'other',
            'vnp_Amount': Math.round(amount * 100), // VNPay yêu cầu x100
            'vnp_ReturnUrl': VNPAY_RETURN_URL,
            'vnp_IpAddr': '127.0.0.1',
            'vnp_CreateDate': createDate,
        };

        vnp_Params = sortObject(vnp_Params);

        const signData = new URLSearchParams(vnp_Params).toString();
        const hmac = crypto.createHmac('sha512', VNPAY_HASH_SECRET);
        const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');
        vnp_Params['vnp_SecureHash'] = signed;

        const paymentUrl = VNPAY_URL + '?' + new URLSearchParams(vnp_Params).toString();

        console.log('VNPay Payment URL created for order:', order_id);
        res.json({ payment_url: paymentUrl, order_id: order_id });
    } catch (err) {
        console.error('Lỗi tạo VNPay URL:', err.message);
        res.status(500).json({ error: 'Lỗi tạo URL thanh toán VNPay' });
    }
});

// ---- VNPAY RETURN URL (redirect từ VNPay sau thanh toán) ----
app.get('/api/payment/vnpay/return', async (req, res) => {
    try {
        let vnp_Params = { ...req.query };
        const secureHash = vnp_Params['vnp_SecureHash'];

        delete vnp_Params['vnp_SecureHash'];
        delete vnp_Params['vnp_SecureHashType'];

        vnp_Params = sortObject(vnp_Params);
        const signData = new URLSearchParams(vnp_Params).toString();
        const hmac = crypto.createHmac('sha512', VNPAY_HASH_SECRET);
        const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

        const responseCode = vnp_Params['vnp_ResponseCode'];
        const txnRef = decodeURIComponent(vnp_Params['vnp_TxnRef'] || '');
        const orderId = txnRef.split('_')[0];

        if (secureHash === signed) {
            if (responseCode === '00') {
                await pool.query(
                    'UPDATE orders SET payment_status = $1, vnpay_transaction_no = $2, updated_at = NOW() WHERE id = $3',
                    ['paid', vnp_Params['vnp_TransactionNo'] || '', orderId]
                );
                res.send('<html><body style="text-align:center;padding:50px;font-family:sans-serif;"><h1 style="color:green;">✅ Thanh toán thành công!</h1><p>Bạn có thể quay lại ứng dụng.</p></body></html>');
            } else {
                await pool.query(
                    'UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2',
                    ['failed', orderId]
                );
                res.send('<html><body style="text-align:center;padding:50px;font-family:sans-serif;"><h1 style="color:red;">❌ Thanh toán thất bại!</h1><p>Mã lỗi: ' + responseCode + '</p></body></html>');
            }
        } else {
            res.send('<html><body style="text-align:center;padding:50px;font-family:sans-serif;"><h1 style="color:red;">⚠️ Chữ ký không hợp lệ!</h1></body></html>');
        }
    } catch (err) {
        console.error('Lỗi xử lý VNPay return:', err.message);
        res.status(500).send('Lỗi server');
    }
});

// ---- TẠO URL THANH TOÁN MOMO ----
// ---- XÁC NHẬN THANH TOÁN (gọi từ Flutter sau khi WebView bắt kết quả) ----
app.post('/api/payment/confirm', async (req, res) => {
    try {
        const { order_id, payment_method, success, transaction_no } = req.body;
        const paymentStatus = success ? 'paid' : 'failed';

        if (payment_method === 'VNPAY') {
            await pool.query(
                'UPDATE orders SET payment_status = $1, vnpay_transaction_no = $2, updated_at = NOW() WHERE id = $3',
                [paymentStatus, transaction_no || '', order_id]
            );
        } else {
            await pool.query(
                'UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2',
                [paymentStatus, order_id]
            );
        }

        const result = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
        res.json(result.rows[0] || { message: 'Updated' });
    } catch (err) {
        console.error(`Lỗi tại ${req.path}:`, err.message);
        res.status(500).json({ error: `Lỗi server (${req.path}): ${err.message}` });
    }
});

// ---- KIỂM TRA TRẠNG THÁI ĐƠN HÀNG ----
app.get('/api/orders/status/:orderCode', async (req, res) => {
    try {
        const { orderCode } = req.params;
        const result = await pool.query(
            'SELECT id, order_code, payment_method, payment_status, order_status, total_amount, created_at FROM orders WHERE order_code = $1',
            [orderCode]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Lỗi kiểm tra trạng thái đơn hàng:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ---- LẤY LỊCH SỬ ĐƠN HÀNG (USER) ----
app.get('/api/orders', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            console.log('❌ [GET /api/orders] No Authorization header');
            return res.status(401).json({ error: 'Chưa đăng nhập' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_token_default');
        const userId = decoded.user.id;

        console.log(`🔍 [GET /api/orders] Fetching orders for user ID: ${userId}`);

        const result = await pool.query(
            'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );

        console.log(`✅ [GET /api/orders] Found ${result.rows.length} orders`);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ [GET /api/orders] Error:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ---- NGƯỜI DÙNG HỦY ĐƠN HÀNG ----
app.post('/api/orders/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const { cancel_reason } = req.body;

        // Xác thực user qua JWT
        const authHeader = req.headers['authorization'];
        if (!authHeader) return res.status(401).json({ error: 'Chưa đăng nhập' });
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_token_default');
        const userId = decoded.user.id;

        // Kiểm tra đơn hàng tồn tại và thuộc về user này
        const orderCheck = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        }

        const order = orderCheck.rows[0];

        // Chỉ cho phép hủy đơn ở trạng thái pending hoặc confirmed
        if (!['pending', 'confirmed'].includes(order.order_status)) {
            return res.status(400).json({ error: 'Không thể hủy đơn hàng đang giao hoặc đã hoàn tất' });
        }

        // Cập nhật trạng thái sang cancelled + lưu lý do
        await pool.query(
            'UPDATE orders SET order_status = $1, failed_reason = $2, updated_at = NOW() WHERE id = $3',
            ['cancelled', cancel_reason || 'Người dùng hủy đơn', id]
        );

        // Hoàn lại tồn kho
        const items = await pool.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [id]);
        for (const item of items.rows) {
            await pool.query(
                'UPDATE products SET stock_quantity = stock_quantity + $1, sold_quantity = sold_quantity - $1 WHERE id = $2',
                [item.quantity, item.product_id]
            );
        }

        console.log(`🚫 [POST /api/orders/${id}/cancel] User ${userId} cancelled order. Reason: ${cancel_reason}`);
        res.json({ message: 'Đã hủy đơn hàng thành công' });
    } catch (err) {
        console.error('❌ [POST /api/orders/cancel] Error:', err.message);
        res.status(500).json({ error: 'Lỗi server khi hủy đơn hàng' });
    }
});

// ---- CHI TIẾT ĐƠN HÀNG ----
app.get('/api/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const orderResult = await pool.query(`
            SELECT o.*, u.full_name as shipper_name, u.email as shipper_email
            FROM orders o
            LEFT JOIN users u ON o.shipper_id = u.id
            WHERE o.id = $1
        `, [id]);
        if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy' });

        const itemsResult = await pool.query(`
            SELECT oi.*, p.image_url 
            FROM order_items oi 
            LEFT JOIN products p ON oi.product_id = p.id 
            WHERE oi.order_id = $1
        `, [id]);
        res.json({
            ...orderResult.rows[0],
            items: itemsResult.rows
        });
    } catch (err) {
        console.error(`Lỗi tại ${req.path}:`, err.message);
        res.status(500).json({ error: `Lỗi server (${req.path}): ${err.message}` });
    }
});

// ---- ADMIN: LẤY TẤT CẢ ĐƠN HÀNG ----
app.get('/api/admin/orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.*, u.full_name as shipper_name 
            FROM orders o 
            LEFT JOIN users u ON o.shipper_id = u.id 
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(`Lỗi tại ${req.path}:`, err.message);
        res.status(500).json({ error: `Lỗi server (${req.path}): ${err.message}` });
    }
});

// ---- ADMIN: CẬP NHẬT TRẠNG THÁI ----
app.put('/api/admin/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { order_status, payment_status } = req.body;

        // Lấy trạng thái hiện tại trước khi cập nhật
        const currentOrder = await pool.query('SELECT order_status FROM orders WHERE id = $1', [id]);
        if (currentOrder.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

        const oldStatus = currentOrder.rows[0].order_status;

        await pool.query(
            'UPDATE orders SET order_status = $1, payment_status = $2 WHERE id = $3',
            [order_status, payment_status, id]
        );

        // Nếu chuyển từ trạng thái khác sang 'cancelled' -> Hoàn lại kho
        if (oldStatus !== 'cancelled' && order_status === 'cancelled') {
            const items = await pool.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [id]);
            for (const item of items.rows) {
                await pool.query(
                    'UPDATE products SET stock_quantity = stock_quantity + $1, sold_quantity = sold_quantity - $1 WHERE id = $2',
                    [item.quantity, item.product_id]
                );
            }
        }
        // Nếu chuyển từ 'cancelled' sang trạng thái khác (phục hồi đơn) -> Trừ lại kho
        else if (oldStatus === 'cancelled' && order_status !== 'cancelled') {
            const items = await pool.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [id]);
            for (const item of items.rows) {
                await pool.query(
                    'UPDATE products SET stock_quantity = stock_quantity - $1, sold_quantity = sold_quantity + $1 WHERE id = $2',
                    [item.quantity, item.product_id]
                );
            }
        }

        // Tạo thông báo cập nhật trạng thái
        const orderInfo = await pool.query('SELECT user_id, order_code FROM orders WHERE id = $1', [id]);
        if (orderInfo.rows.length > 0 && orderInfo.rows[0].user_id) {
            let statusText = '';
            switch(order_status) {
                case 'confirmed': statusText = 'đã được xác nhận'; break;
                case 'shipping': statusText = 'đang được giao'; break;
                case 'completed': statusText = 'đã hoàn thành'; break;
                case 'cancelled': statusText = 'đã bị hủy'; break;
                default: statusText = 'đã thay đổi trạng thái';
            }
            
            await createNotification(
                orderInfo.rows[0].user_id,
                'Cập nhật đơn hàng 📦',
                `Đơn hàng #${orderInfo.rows[0].order_code} của bạn ${statusText}.`,
                'order',
                id
            );
        }

        res.json({ message: 'Cập nhật thành công' });
    } catch (err) {
        console.error(`Lỗi tại ${req.path}:`, err.message);
        res.status(500).json({ error: `Lỗi server (${req.path}): ${err.message}` });
    }
});

// ==========================================
// MIDDLEWARE XÁC THỰC
// ==========================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Truy cập bị từ chối. Không tìm thấy token.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_token_default');
        req.user = decoded.user;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
    }
}

// ==========================================
// ADDRESS MANAGEMENT APIs
// ==========================================

// 1. Lấy danh sách địa chỉ của user
app.get('/api/addresses', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi lấy địa chỉ:', err.message);
        res.status(500).json({ error: 'Lỗi Database (GET): ' + err.message });
    }
});

// 2. Thêm địa chỉ mới
app.post('/api/addresses', authenticateToken, async (req, res) => {
    const { receiver_name, receiver_phone, full_address, latitude, longitude, label, is_default } = req.body;
    try {
        await pool.query('BEGIN');

        if (is_default) {
            await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
        }

        const query = `
            INSERT INTO addresses (user_id, receiver_name, receiver_phone, full_address, latitude, longitude, label, is_default)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *;
        `;
        const result = await pool.query(query, [
            req.user.id,
            receiver_name,
            receiver_phone,
            full_address,
            latitude || 0, // Giá trị mặc định tránh lỗi DB
            longitude || 0,
            label || 'Nhà riêng',
            is_default || false
        ]);

        await pool.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Lỗi thêm địa chỉ:', err.message);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// 3. Cập nhật địa chỉ
app.put('/api/addresses/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { receiver_name, receiver_phone, full_address, latitude, longitude, label, is_default } = req.body;
    try {
        await pool.query('BEGIN');

        if (is_default) {
            await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
        }

        const query = `
            UPDATE addresses 
            SET receiver_name = $1, receiver_phone = $2, full_address = $3, 
                latitude = $4, longitude = $5, label = $6, is_default = $7
            WHERE id = $8 AND user_id = $9
            RETURNING *;
        `;
        const result = await pool.query(query, [
            receiver_name, receiver_phone, full_address,
            latitude || 0, longitude || 0, label || 'Nhà riêng', is_default || false,
            id, req.user.id
        ]);

        await pool.query('COMMIT');
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy địa chỉ' });
        res.json(result.rows[0]);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Lỗi cập nhật địa chỉ:', err.message);
        res.status(500).json({ error: 'Lỗi server: ' + err.message });
    }
});

// 4. Xóa địa chỉ
app.delete('/api/addresses/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            'DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy địa chỉ' });
        res.json({ message: 'Đã xóa địa chỉ thành công' });
    } catch (err) {
        console.error('Lỗi xóa địa chỉ:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// 5. Đặt địa chỉ mặc định
app.patch('/api/addresses/:id/set-default', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('BEGIN');
        await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
        const result = await pool.query(
            'UPDATE addresses SET is_default = TRUE WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, req.user.id]
        );
        if (result.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: 'Không tìm thấy địa chỉ' });
        }
        await pool.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Lỗi đặt mặc định:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ==========================================
// NOTIFICATION APIs
// ==========================================

// 1. Lấy danh sách thông báo của user
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi lấy thông báo:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// 2. Đánh dấu thông báo đã đọc
app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
            [id, req.user.id]
        );
        res.json({ message: 'Success' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// 3. Đánh dấu tất cả đã đọc
app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
            [req.user.id]
        );
        res.json({ message: 'Success' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// 4. Gửi thông báo Sale hàng loạt (Chỉ Admin)
app.post('/api/notifications/broadcast', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Không có quyền' });
    
    const { title, body } = req.body;
    try {
        const users = await pool.query('SELECT id FROM users WHERE role = $1', ['user']);
        for (const user of users.rows) {
            await createNotification(user.id, title, body, 'sale');
        }
        res.json({ message: `Đã gửi thông báo tới ${users.rowCount} khách hàng` });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ==========================================
// MARKETING & DISCOUNT APIs
// ==========================================

// API kiểm tra kết nối Marketing
app.get('/api/marketing/ping', (req, res) => {
    res.json({ message: 'Marketing API is active!' });
});

// 1. Áp dụng giảm giá hàng loạt cho sản phẩm
app.post('/api/marketing/discount/products', async (req, res) => {
    const { productIds, discountPercent } = req.body;
    console.log('--- YÊU CẦU GIẢM GIÁ SẢM PHẨM ---');
    console.log('Product IDs:', productIds);
    console.log('Discount %:', discountPercent);

    if (!Array.isArray(productIds) || productIds.length === 0) {
        return res.status(400).json({ error: 'Danh sách ID sản phẩm không hợp lệ' });
    }

    try {
        await pool.query('BEGIN');

        // Ép kiểu cụ thể cho $1 và $2 để PostgreSQL không bị nhầm lẫn
        const query = `
            UPDATE products 
            SET 
                original_price = COALESCE(original_price, price),
                discount_percent = $1::int,
                price = (COALESCE(original_price, price) * (100 - $1::int)) / 100.0
            WHERE id = ANY($2::int[])
            RETURNING *;
        `;
        const result = await pool.query(query, [discountPercent, productIds]);

        await pool.query('COMMIT');
        console.log(`Cập nhật thành công ${result.rowCount} sản phẩm.`);
        res.json({ message: `Đã cập nhật giảm giá cho ${result.rowCount} sản phẩm`, count: result.rowCount });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('LỖI DATABASE (Products):', err.message);
        res.status(500).json({ error: 'Database Error: ' + err.message });
    }
});

app.post('/api/marketing/discount/categories', async (req, res) => {
    const { subCategoryIds, discountPercent } = req.body;
    console.log('--- YÊU CẦU GIẢM GIÁ DANH MỤC ---');
    console.log('Category IDs:', subCategoryIds);

    if (!Array.isArray(subCategoryIds) || subCategoryIds.length === 0) {
        return res.status(400).json({ error: 'Danh sách ID danh mục không hợp lệ' });
    }

    try {
        await pool.query('BEGIN');

        const query = `
            UPDATE products 
            SET 
                original_price = COALESCE(original_price, price),
                discount_percent = $1::int,
                price = (COALESCE(original_price, price) * (100 - $1::int)) / 100.0
            WHERE sub_category_id = ANY($2::int[])
            RETURNING *;
        `;
        const result = await pool.query(query, [discountPercent, subCategoryIds]);

        await pool.query('COMMIT');
        console.log(`Cập nhật thành công ${result.rowCount} sản phẩm từ danh mục.`);
        res.json({ message: `Đã cập nhật giảm giá cho ${result.rowCount} sản phẩm trong danh mục`, count: result.rowCount });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('LỖI DATABASE (Categories):', err.message);
        res.status(500).json({ error: 'Database Error: ' + err.message });
    }
});

// 3. Nhập thêm hàng vào kho
app.post('/api/admin/products/:id/restock', async (req, res) => {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Số lượng nhập không hợp lệ' });
    }

    try {
        const result = await pool.query(
            'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2 RETURNING *',
            [quantity, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
        res.json({ message: 'Nhập hàng thành công', product: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Database Error: ' + err.message });
    }
});

// 4. Lấy thống kê doanh thu
app.get('/api/admin/stats/revenue', async (req, res) => {
    try {
        // Doanh số thực tế (Đã giao hàng thành công)
        const actualResult = await pool.query(
            "SELECT SUM(total_amount) as total FROM orders WHERE order_status = 'delivered'"
        );

        // Doanh số ước tính (Tất cả trừ Hủy)
        const potentialResult = await pool.query(
            "SELECT SUM(total_amount) as total FROM orders WHERE order_status != 'cancelled'"
        );

        // Thống kê doanh thu 7 ngày gần nhất
        const weeklyStats = await pool.query(`
            SELECT 
                TO_CHAR(date_series, 'DD/MM') as name,
                COALESCE(SUM(o.total_amount), 0) as total
            FROM 
                GENERATE_SERIES(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, '1 day') AS date_series
            LEFT JOIN 
                orders o ON DATE(o.created_at) = DATE(date_series) AND o.order_status = 'delivered'
            GROUP BY 
                date_series
            ORDER BY 
                date_series
        `);

        // Thống kê theo danh mục
        const categoryStats = await pool.query(`
            SELECT 
                sc.name as name, 
                SUM(oi.quantity * oi.product_price)::float as value
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            JOIN sub_categories sc ON p.sub_category_id = sc.id
            JOIN orders o ON oi.order_id = o.id
            WHERE o.order_status = 'delivered'
            GROUP BY sc.name
            ORDER BY value DESC
            LIMIT 5
        `);

        // Tổng giá vốn (cost) của đơn đã giao
        const costResult = await pool.query(`
            SELECT COALESCE(SUM(oi.quantity * COALESCE(p.cost_price, 0)), 0) as total_cost
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            JOIN orders o ON oi.order_id = o.id
            WHERE o.order_status = 'delivered'
        `);

        // Top 10 sản phẩm bán chạy
        const topProducts = await pool.query(`
            SELECT p.name, p.image_url, SUM(oi.quantity) as total_sold, 
                   SUM(oi.quantity * oi.product_price)::float as total_revenue
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            JOIN orders o ON oi.order_id = o.id
            WHERE o.order_status = 'delivered'
            GROUP BY p.id, p.name, p.image_url
            ORDER BY total_sold DESC
            LIMIT 10
        `);

        // Thống kê đơn hàng theo trạng thái
        const orderStats = await pool.query(`
            SELECT order_status, COUNT(*) as count 
            FROM orders GROUP BY order_status
        `);

        // Số lượng user
        const userCount = await pool.query("SELECT COUNT(*) as total FROM users WHERE role = 'customer'");

        const revenue = parseFloat(actualResult.rows[0].total || 0);
        const cost = parseFloat(costResult.rows[0].total_cost || 0);

        res.json({
            actualRevenue: revenue,
            potentialRevenue: parseFloat(potentialResult.rows[0].total || 0),
            totalCost: cost,
            profit: revenue - cost,
            categoryStats: categoryStats.rows,
            weeklyRevenue: weeklyStats.rows,
            topProducts: topProducts.rows,
            orderStats: orderStats.rows,
            customerCount: parseInt(userCount.rows[0].total || 0)
        });
    } catch (err) {
        res.status(500).json({ error: 'Database Error: ' + err.message });
    }
});

// ==========================================
// NHẬP HÀNG (Stock Import) APIs
// ==========================================

// Auto-migration: Tạo bảng nhập hàng + cột cost_price + Shipper columns
(async () => {
    try {
        await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) DEFAULT 0;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT true;');
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_fee NUMERIC(12,2) DEFAULT 30000;');
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_confirmed_at TIMESTAMP;');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_imports (
                id SERIAL PRIMARY KEY,
                import_code VARCHAR(50) UNIQUE NOT NULL,
                supplier_name VARCHAR(200),
                total_cost NUMERIC(12,2) DEFAULT 0,
                note TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_import_items (
                id SERIAL PRIMARY KEY,
                import_id INTEGER REFERENCES stock_imports(id) ON DELETE CASCADE,
                product_id INTEGER REFERENCES products(id),
                product_name VARCHAR(200),
                quantity INTEGER NOT NULL,
                cost_price NUMERIC(12,2) NOT NULL,
                subtotal NUMERIC(12,2) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id),
                receiver_id INTEGER REFERENCES users(id), -- NULL nếu là Admin nhận chung
                is_from_admin BOOLEAN DEFAULT false,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Shipper, Stock & Chat tables migration completed');
    } catch (e) {
        console.log('ℹ : Migration skipped (already exists or error):', e.message);
    }
})();

// Lấy danh sách phiếu nhập hàng
app.get('/api/admin/stock-imports', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT si.*, u.full_name as created_by_name,
                (SELECT COUNT(*) FROM stock_import_items WHERE import_id = si.id) as item_count
            FROM stock_imports si
            LEFT JOIN users u ON si.created_by = u.id
            ORDER BY si.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi lấy phiếu nhập:', err.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Chi tiết 1 phiếu nhập
app.get('/api/admin/stock-imports/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const importResult = await pool.query('SELECT * FROM stock_imports WHERE id = $1', [id]);
        if (importResult.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy' });

        const items = await pool.query(`
            SELECT sii.*, p.image_url
            FROM stock_import_items sii
            LEFT JOIN products p ON sii.product_id = p.id
            WHERE sii.import_id = $1
        `, [id]);

        res.json({ ...importResult.rows[0], items: items.rows });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Tạo phiếu nhập hàng mới
app.post('/api/admin/stock-imports', async (req, res) => {
    const { supplier_name, note, items } = req.body;
    // items = [{ product_id, product_name, quantity, cost_price }]

    try {
        await pool.query('BEGIN');

        // Tạo mã phiếu
        const importCode = 'NK' + Date.now().toString().slice(-10) + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

        // Tính tổng tiền
        let totalCost = 0;
        for (const item of items) {
            totalCost += item.quantity * item.cost_price;
        }

        // Lưu phiếu nhập
        const importResult = await pool.query(`
            INSERT INTO stock_imports (import_code, supplier_name, total_cost, note)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `, [importCode, supplier_name || '', totalCost, note || '']);
        const importId = importResult.rows[0].id;

        // Lưu chi tiết + cập nhật tồn kho
        for (const item of items) {
            const subtotal = item.quantity * item.cost_price;
            await pool.query(`
                INSERT INTO stock_import_items (import_id, product_id, product_name, quantity, cost_price, subtotal)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [importId, item.product_id, item.product_name, item.quantity, item.cost_price, subtotal]);

            // Cộng tồn kho + cập nhật giá nhập mới nhất
            await pool.query(`
                UPDATE products SET stock_quantity = stock_quantity + $1, cost_price = $2 WHERE id = $3
            `, [item.quantity, item.cost_price, item.product_id]);
        }

        await pool.query('COMMIT');
        console.log(`📥 Phiếu nhập ${importCode}: ${items.length} sản phẩm, tổng ${totalCost.toLocaleString()}₫`);
        res.status(201).json(importResult.rows[0]);
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('Lỗi tạo phiếu nhập:', err.message);
        res.status(500).json({ error: 'Lỗi server khi tạo phiếu nhập' });
    }
});

// Cảnh báo hàng sắp hết (stock < 10)
app.get('/api/admin/low-stock', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, image_url, stock_quantity, cost_price, price
            FROM products 
            WHERE stock_quantity < 10
            ORDER BY stock_quantity ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ==========================================
// SHIPPER PRO APIs
// ==========================================

// Middleware kiểm tra quyền Shipper (Đơn giản hóa)
const isShipper = (req, res, next) => {
    // Trong thực tế sẽ verify token và check role, ở đây ta giả định shipperId truyền qua params/body hoặc header
    next();
};

// Bật/Tắt trạng thái Online
app.put('/api/shipper/toggle-online', async (req, res) => {
    const { shipperId, isOnline } = req.body;
    try {
        await pool.query('UPDATE users SET is_online = $1 WHERE id = $2 AND role = \'shipper\'', [isOnline, shipperId]);
        res.json({ message: 'Cập nhật trạng thái thành công', isOnline });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Thống kê Thu nhập & COD cho Shipper
app.get('/api/shipper/stats/:shipperId', async (req, res) => {
    const { shipperId } = req.params;
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(CASE WHEN order_status = 'delivered' THEN 1 END) as completed_orders,
                COALESCE(SUM(CASE WHEN order_status = 'delivered' THEN shipping_fee END), 0) as total_earnings,
                COALESCE(SUM(CASE WHEN order_status = 'delivered' AND payment_method = 'COD' THEN CAST(total_amount AS NUMERIC) END), 0) as cod_collected,
                COALESCE(SUM(CASE WHEN order_status = 'shipping' AND payment_method = 'COD' THEN CAST(total_amount AS NUMERIC) END), 0) as cod_pending,
                (SELECT is_online FROM users WHERE id = $1) as is_online
            FROM orders
            WHERE shipper_id = $1
        `, [shipperId]);

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Xác nhận lấy hàng bằng QR Code (Warehouse Pickup)
app.put('/api/shipper/orders/:orderId/pickup', async (req, res) => {
    const { orderId } = req.params;
    const { shipperId } = req.body;
    try {
        const result = await pool.query(`
            UPDATE orders 
            SET order_status = 'shipping', pickup_confirmed_at = NOW() 
            WHERE id = $1 AND (shipper_id = $2 OR shipper_id IS NULL)
            RETURNING *
        `, [orderId, shipperId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng hoặc bạn không có quyền gán đơn này' });
        }
        res.json({ message: 'Xác nhận lấy hàng thành công', order: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CHAT & CUSTOMER SUPPORT APIs
// ==========================================

// Gửi tin nhắn (Cả User và Admin dùng chung)
app.post('/api/messages', async (req, res) => {
    const { sender_id, receiver_id, message, is_from_admin } = req.body;
    console.log(`[Chat] Gửi tin nhắn: from=${sender_id}, to=${receiver_id}, admin=${is_from_admin}`);
    try {
        const result = await pool.query(
            'INSERT INTO messages (sender_id, receiver_id, message, is_from_admin) VALUES ($1::integer, $2::integer, $3, $4) RETURNING *',
            [sender_id, receiver_id || null, message, is_from_admin || false]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[Chat Error] Lỗi gửi tin nhắn:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Lấy lịch sử chat của 1 User (với Admin)
app.get('/api/messages/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(`
            SELECT * FROM messages 
            WHERE (sender_id = $1 AND is_from_admin = false) 
               OR (receiver_id = $1 AND is_from_admin = true)
            ORDER BY created_at ASC
        `, [userId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Lấy danh sách các cuộc hội thoại (Danh sách khách hàng đã nhắn tin)
app.get('/api/admin/conversations', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                u.id, u.full_name, u.email, u.role,
                (SELECT message FROM messages 
                 WHERE sender_id = u.id OR receiver_id = u.id 
                 ORDER BY created_at DESC LIMIT 1) as last_message,
                (SELECT created_at FROM messages 
                 WHERE sender_id = u.id OR receiver_id = u.id 
                 ORDER BY created_at DESC LIMIT 1) as last_message_at,
                (SELECT COUNT(*) FROM messages 
                 WHERE sender_id = u.id AND is_read = false AND is_from_admin = false) as unread_count
            FROM users u
            WHERE u.role != 'admin'
              AND EXISTS (SELECT 1 FROM messages WHERE sender_id = u.id OR receiver_id = u.id)
            ORDER BY last_message_at DESC NULLS LAST
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[Chat Error] Lỗi lấy danh sách hội thoại:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Đánh dấu đã đọc
app.put('/api/messages/read/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        await pool.query('UPDATE messages SET is_read = true WHERE sender_id = $1 AND is_from_admin = false', [userId]);
        res.json({ message: 'Đã đánh dấu đã đọc' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Đối soát COD shipper (Dành cho Admin)
app.get('/api/admin/cod-report', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                u.id as shipper_id, u.full_name as shipper_name,
                COUNT(CASE WHEN o.order_status = 'delivered' AND o.payment_method = 'COD' THEN 1 END) as cod_delivered,
                COALESCE(SUM(CASE WHEN o.order_status = 'delivered' AND o.payment_method = 'COD' THEN CAST(o.total_amount AS NUMERIC) END), 0) as cod_collected,
                COUNT(CASE WHEN o.order_status = 'shipping' AND o.payment_method = 'COD' THEN 1 END) as cod_pending,
                COALESCE(SUM(CASE WHEN o.order_status = 'shipping' AND o.payment_method = 'COD' THEN CAST(o.total_amount AS NUMERIC) END), 0) as cod_pending_amount
            FROM users u
            LEFT JOIN orders o ON o.shipper_id = u.id
            WHERE u.role = 'shipper'
            GROUP BY u.id, u.full_name
            ORDER BY u.full_name
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// KHỞI CHẠY SERVER
app.listen(port, () => {
    console.log(`✅ Backend API đang chạy tại http://localhost:${port}`);
    console.log(`🚀 Admin Dashboard có thể kết nối tại http://localhost:3000/api/admin/orders`);
});
