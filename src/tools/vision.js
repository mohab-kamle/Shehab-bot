const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeImage(imageUrl, prompt, token) {
    try {
        // 1. Download Image
        const response = await axios.get(imageUrl, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer'
        });

        const imagePart = {
            inlineData: {
                data: Buffer.from(response.data).toString("base64"),
                mimeType: "image/png"
            },
        };

        // 2. Try Gemini 1.5 Flash (Most Stable)
        // We will stick to 1.5 for now as 2.5 API is often in "Preview" and tricky
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const result = await model.generateContent([
            prompt || "Describe this image technically. If it's code, explain the bug.",
            imagePart
        ]);

        const text = result.response.text();
        return `[IMAGE ANALYSIS]: ${text}`;

    } catch (e) {
        console.error("❌ VISION CRITICAL ERROR:", e.message); // Log to PM2
        return `[System Error]: Could not analyze image. Error details: ${e.message}`;
    }
}

module.exports = { analyzeImage };
