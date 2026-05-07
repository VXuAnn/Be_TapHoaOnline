const https = require('https');
require('dotenv').config();

function testRawApi() {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    console.log('--- ĐANG KIỂM TRA RAW API (HTTPS) ---');
    
    const data = JSON.stringify({
        contents: [{ parts: [{ text: "Chào bạn" }] }]
    });

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    const req = https.request(url, options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            console.log('Status Code:', res.statusCode);
            try {
                const json = JSON.parse(responseBody);
                if (res.statusCode === 200) {
                    console.log('Phản hồi:', json.candidates[0].content.parts[0].text);
                    console.log('✅ KẾT NỐI THÀNH CÔNG!');
                } else {
                    console.error('❌ LỖI:', json);
                }
            } catch (e) {
                console.error('❌ LỖI PARSE JSON:', responseBody);
            }
        });
    });

    req.on('error', (error) => {
        console.error('❌ LỖI KẾT NỐI:', error.message);
    });

    req.write(data);
    req.end();
}

testRawApi();
