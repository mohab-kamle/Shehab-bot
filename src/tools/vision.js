// src/tools/vision.js
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

        // 2. Use Gemini 1.5 Flash on the V1BETA endpoint
        // The error happened because it defaulted to 'v1'. We force 'v1beta'.
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
        }, { apiVersion: 'v1beta' }); // <--- THIS IS THE CRITICAL FIX

        const result = await model.generateContent([
            prompt || "Describe this image technically. If it's code, explain the bug.",
            imagePart
        ]);

        const text = result.response.text();
        return `[IMAGE ANALYSIS]: ${text}`;

    } catch (e) {
        console.error("❌ VISION ERROR:", e.message);
        return `[System Error]: Could not analyze image. Error details: ${e.message}`;
    }
}

module.exports = { analyzeImage };
