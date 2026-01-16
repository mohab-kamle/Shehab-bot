const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
require('dotenv').config();

// Initialize with v1beta endpoint
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeImage(imageUrl, prompt, token) {
    try {
        const response = await axios.get(imageUrl, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer'
        });

        // Detect actual MIME type from response headers (Slack can serve various formats)
        const contentType = response.headers['content-type'] || 'image/png';
        const mimeType = contentType.split(';')[0].trim(); // Remove charset if present

        console.log(`📸 Vision: Processing image (${mimeType}, ${response.data.length} bytes)`);

        const imagePart = {
            inlineData: {
                data: Buffer.from(response.data).toString("base64"),
                mimeType: mimeType
            },
        };

        // Use gemini-2.5-flash with v1beta API
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash"
        }, { apiVersion: 'v1beta' });

        const result = await model.generateContent([
            prompt || "Describe this image technically.",
            imagePart
        ]);

        return `[IMAGE ANALYSIS]: ${result.response.text()}`;

    } catch (e) {
        console.error("❌ VISION ERROR:", e.message);
        return `[System Message]: Vision tool is currently unavailable. Just inform the user you can't see the image right now. Do NOT search the web for this error.`;
    }
}

module.exports = { analyzeImage };
