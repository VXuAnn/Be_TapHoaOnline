const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
require('dotenv').config();

// Cấu hình Cloudinary từ file .env của bạn
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cấu hình kết nối Database
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Tự động bật SSL nếu không phải là localhost
    ssl: process.env.DB_HOST !== 'localhost' ? { rejectUnauthorized: false } : false
});

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SQL_INPUT = path.join(__dirname, 'init_db.sql');
const SQL_OUTPUT = path.join(__dirname, 'init_db_cloudinary.sql');

async function migrate() {
    console.log('🚀 Bắt đầu quá trình di chuyển ảnh lên Cloudinary...');

    if (!fs.existsSync(UPLOADS_DIR)) {
        console.error('❌ Không tìm thấy thư mục uploads!');
        return;
    }

    const files = fs.readdirSync(UPLOADS_DIR).filter(file => 
        ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file).toLowerCase())
    );

    console.log(`📸 Tìm thấy ${files.length} ảnh cần upload.`);

    const urlMapping = {};

    // 1. Upload từng ảnh lên Cloudinary
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = path.join(UPLOADS_DIR, file);
        
        try {
            console.log(`[${i+1}/${files.length}] Đang upload: ${file}...`);
            const result = await cloudinary.uploader.upload(filePath, {
                folder: 'taphoa_migration'
            });
            
            // Lưu lại mapping: tên file cũ -> link cloudinary mới
            urlMapping[file] = result.secure_url;
            console.log(`   ✅ Upload thành công: ${result.secure_url}`);

            // 2. Cập nhật trực tiếp vào Database
            console.log(`   🗄️  Đang cập nhật DB cho file: ${file}...`);
            
            // Cập nhật bảng products
            await pool.query(
                "UPDATE products SET image_url = $1 WHERE image_url LIKE $2",
                [result.secure_url, `%${file}`]
            );

            // Cập nhật bảng product_images
            await pool.query(
                "UPDATE product_images SET image_url = $1 WHERE image_url LIKE $2",
                [result.secure_url, `%${file}`]
            );
            
            console.log(`   ✔️  Đã cập nhật DB xong.`);
        } catch (err) {
            console.error(`   ❌ Lỗi với file ${file}:`, err.message);
        }
    }

    // (Vẫn giữ phần tạo file SQL dự phòng nếu bạn cần)
    console.log('\n📝 Đang tạo thêm file SQL dự phòng (Vui lòng đợi)...');

    // 2. Đọc file SQL khổng lồ và thay thế link (Dùng stream để không bị tràn bộ nhớ)
    const readStream = fs.createReadStream(SQL_INPUT, { encoding: 'utf8' });
    const writeStream = fs.createWriteStream(SQL_OUTPUT);

    // Thay thế link localhost và đường dẫn tương đối
    // Ví dụ: http://localhost:3000/uploads/abc.jpg hoặc đơn giản là /uploads/abc.jpg
    
    let buffer = '';
    readStream.on('data', (chunk) => {
        let content = buffer + chunk;
        
        // Thay thế dựa trên mapping đã có
        for (const [oldFile, newUrl] of Object.entries(urlMapping)) {
            // Regex để tìm tên file trong các định dạng URL khác nhau
            const regex = new RegExp(`(http://localhost:3000)?(/)?uploads/${oldFile}`, 'g');
            content = content.replace(regex, newUrl);
        }
        
        // Giữ lại một phần cuối để tránh việc tên file bị cắt đôi giữa 2 chunk
        const lastIndex = content.lastIndexOf(' ');
        writeStream.write(content.substring(0, lastIndex));
        buffer = content.substring(lastIndex);
    });

    readStream.on('end', async () => {
        writeStream.write(buffer);
        writeStream.end();
        console.log(`\n✨ HOÀN THÀNH!`);
        console.log(`👉 File SQL mới: ${SQL_OUTPUT}`);
        console.log(`👉 Tổng số ảnh đã xử lý: ${Object.keys(urlMapping).length}`);
        console.log(`\nBây giờ bạn có thể kiểm tra trực tiếp trên Web Admin hoặc App Flutter!`);
        await pool.end();
    });
}

migrate();
