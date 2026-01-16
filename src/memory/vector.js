const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// Initialize Clients
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

async function getEmbedding(text) {
    try {
        const result = await embedModel.embedContent(text);
        return result.embedding.values;
    } catch (e) {
        console.error("❌ Embedding Error:", e.message);
        return null;
    }
}

async function saveMemory(text, metadata = {}) {
    try {
        if (!text || text.length < 10) return; // Don't save "ok" or "hi"
        const vector = await getEmbedding(text);
        if (!vector) return;

        await index.upsert([{
            id: Date.now().toString(), // Unique ID based on time
            values: vector,
            metadata: {
                text: text,
                created_at: new Date().toISOString(),
                ...metadata
            }
        }]);
        console.log(`💾 Saved memory: "${text.substring(0, 30)}..."`);
    } catch (e) { console.error("Save Memory Error:", e.message); }
}

async function recallMemory(query) {
    try {
        const vector = await getEmbedding(query);
        if (!vector) return "";

        const result = await index.query({
            vector: vector,
            topK: 3, // Fetch top 3 most relevant memories
            includeMetadata: true
        });

        if (!result.matches.length) return "";

        // Format memories as text
        return result.matches
            .filter(m => m.score > 0.4) // Only reliable matches
            .map(m => `- ${m.metadata.text} (Date: ${m.metadata.created_at.split('T')[0]})`)
            .join("\n");
    } catch (e) {
        console.error("Recall Error:", e.message);
        return "";
    }
}

module.exports = { saveMemory, recallMemory };
