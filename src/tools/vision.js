const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeImage(imageUrl, prompt, token) {
    try {
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

        // FORCE gemini-2.5-flash (The standard free model with quota)
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash"
        }, { apiVersion: 'v1beta' });

        const result = await model.generateContent([
            prompt || "Describe this image technically.",
            imagePart
        ]);

        return `[IMAGE ANALYSIS]: ${result.response.text()}`;

    } catch (e) {
        // Return a clear message so the Brain doesn't panic and search Google
        console.error("❌ VISION ERROR:", e.message);
        return `[System Message]: Vision tool is currently unavailable (Quota/API Error). Do NOT search the web to fix this. Just inform the user you can't see the image right now.`;
    }
}

module.exports = { analyzeImage };
