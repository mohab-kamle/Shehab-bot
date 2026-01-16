const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeImage(imageUrl, prompt, token) {
    try {
        console.log(`📸 Vision: Downloading from ${imageUrl.substring(0, 60)}...`);

        const response = await axios.get(imageUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'image/*'
            },
            responseType: 'arraybuffer',
            maxRedirects: 5,
            validateStatus: (status) => status < 400
        });

        // Detect actual MIME type from response headers
        const contentType = response.headers['content-type'] || 'image/png';
        const mimeType = contentType.split(';')[0].trim();

        // Check if we actually got an image (not HTML error page)
        if (mimeType.startsWith('text/') || mimeType === 'application/json') {
            console.error(`❌ VISION ERROR: Slack returned ${mimeType} instead of an image. Auth may have failed.`);
            return `[System Message]: Could not download the image (received ${mimeType}). Inform the user the vision feature is temporarily unavailable.`;
        }

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
        return `[System Message]: Vision tool unavailable. Inform the user you cannot see the image right now.`;
    }
}

module.exports = { analyzeImage };
