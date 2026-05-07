const axios = require('axios');
require('dotenv').config();

async function testRawApi() {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    console.log('--- ĐANG KIỂM TRA RAW API ---');
    
    try {
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: "Chào bạn" }] }]
        });
        console.log('Phản hồi:', response.data.candidates[0].content.parts[0].text);
        console.log('✅ KẾT NỐI THÀNH CÔNG!');
    } catch (error) {
        console.error('❌ LỖI:', error.response ? error.response.data : error.message);
    }
}

testRawApi();
