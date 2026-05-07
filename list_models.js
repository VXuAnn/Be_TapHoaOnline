const https = require('https');
require('dotenv').config();

function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    console.log('--- ĐANG LIÊT KÊ CÁC MODEL KHẢ DỤNG ---');
    
    https.get(url, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            console.log('Status Code:', res.statusCode);
            try {
                const json = JSON.parse(responseBody);
                if (res.statusCode === 200) {
                    console.log('Các model bạn có quyền truy cập:');
                    json.models.forEach(m => console.log(`- ${m.name}`));
                } else {
                    console.error('❌ LỖI:', json);
                }
            } catch (e) {
                console.error('❌ LỖI PARSE JSON:', responseBody);
            }
        });
    }).on('error', (e) => {
        console.error('❌ LỖI KẾT NỐI:', e.message);
    });
}

listModels();
