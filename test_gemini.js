const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function testGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('--- ĐANG KIỂM TRA KẾT NỐI GEMINI ---');
    console.log('API Key length:', apiKey ? apiKey.length : 0);

    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
        console.error('❌ LỖI: Chưa có API Key trong .env');
        return;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        
        console.log('Đang gửi tin nhắn thử nghiệm...');
        const result = await model.generateContent("Chào bạn, bạn có nghe thấy tôi không? Hãy trả lời ngắn gọn 'Kết nối thành công'.");
        const response = result.response.text();
        
        console.log('Phản hồi từ AI:', response);
        console.log('✅ KẾT NỐI THÀNH CÔNG!');
    } catch (error) {
        console.error('❌ LỖI KẾT NỐI:', error.message);
        if (error.message.includes('API_KEY_INVALID')) {
            console.error('👉 Gợi ý: API Key của bạn không đúng hoặc đã hết hạn.');
        } else if (error.message.includes('user location is not supported')) {
            console.error('👉 Gợi ý: Khu vực của bạn hiện chưa được Gemini hỗ trợ trực tiếp (cần dùng Proxy hoặc VPN).');
        }
    }
}

testGemini();
