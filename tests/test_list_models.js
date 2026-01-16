// Test file to list available Gemini models using REST API
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

async function listModels() {
    try {
        console.log("🔍 Listing available models from Gemini API...\n");

        // Try v1beta endpoint first
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        console.log("Available models that support generateContent:\n");

        for (const model of data.models) {
            if (model.supportedGenerationMethods?.includes('generateContent')) {
                console.log(`📦 ${model.name}`);
                console.log(`   Display: ${model.displayName}`);
                console.log(`   Methods: ${model.supportedGenerationMethods.join(', ')}`);
                console.log('');
            }
        }

        console.log("✅ Done!");

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

listModels();
