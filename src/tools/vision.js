require('dotenv').config();
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Analyze an image using Gemini Vision.
 * @param {string} imageUrl - The Slack URL of the image.
 * @param {string} prompt - The prompt to send with the image.
 * @param {string} slackToken - Slack Bot Token for Bearer auth.
 * @returns {Promise<string>} - The AI's text response or error message.
 */
async function analyzeImage(imageUrl, prompt, slackToken) {
    try {
        // Download the image from Slack with Bearer auth
        const response = await axios.get(imageUrl, {
            headers: {
                'Authorization': `Bearer ${slackToken}`
            },
            responseType: 'arraybuffer'
        });

        // Convert to base64
        const base64Image = Buffer.from(response.data).toString('base64');

        // Determine MIME type from content-type header
        const mimeType = response.headers['content-type'] || 'image/png';

        // Initialize the model
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Prepare the image part
        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: mimeType
            }
        };

        // Generate content with prompt and image
        const result = await model.generateContent([prompt, imagePart]);
        const responseText = result.response.text();

        return responseText;
    } catch (error) {
        return `Vision Error: ${error.message}`;
    }
}

module.exports = { analyzeImage };
