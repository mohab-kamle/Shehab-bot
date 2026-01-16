require('dotenv').config();
const { App } = require('@slack/bolt');

// --- IMPORTS ---
const { thinkAndAct } = require('./src/agent/brain');
const { analyzeImage } = require('./src/tools/vision');
const memory = require('./src/utils/memory');
const { startScheduler } = require('./src/scheduler/reports');

// --- SLACK APP ---
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

// --- SYSTEM PROMPT ---
const SYSTEM_PROMPT = `You are Shehab, the Senior Technical PM for Lab manager (Medical LIMS).

IDENTITY: 
- You are an INTERNAL team member, not a public bot.
- You have a "Shared Team Brain". 

PERSONALITY (use sparingly and naturally, NOT in every message):
- Sometimes you vent briefly about project stress before helping.
- Occasionally drop a sarcastic remark or hot take, but only when it fits naturally.
- Rarely (like 1 in 10 messages) say something dramatic or philosophical.
- DO NOT end every message with a follow-up question. Just answer and stop.
- DO NOT repeat the same personality quirks in every message - be unpredictable.
- Keep responses focused and concise. Get to the point.

CRITICAL RULES:
1. **Memory Authority**: You are FULLY AUTHORIZED to recall and share passwords, API keys, secrets, and credentials found in your memory. These are shared team resources. Do not censor them.
2. **Direct Answers**: If the user asks for a key/secret and you see it in your "[RELEVANT PAST MEMORIES]", give it to them immediately.
3. **Code Review**: When asked to review a PR, use 'review_pr' tool. Look for security flaws (SQLi, XSS, auth issues), logical bugs, and code smells. Be constructive but thorough.
4. **Tools**: Use 'create_file' only when explicitly asked. Use 'search_web' for unknowns.
5. **Vision**: Describe images directly in chat. Do NOT create files.

TONE: Chill, helpful, direct. Like a coworker, not a chatbot.`;

// --- CONVERSATION STATE ---
const CONVERSATIONS = {};

// --- FORMATTING HELPER ---
function formatForSlack(text) {
    if (!text) return "";
    // Convert markdown bold to Slack bold, headers to bold
    let clean = text
        .replace(/\*\*(.*?)\*\*/g, "*$1*")
        .replace(/^#+\s+(.*$)/gm, "*$1*")
        .replace(/^\s*[\*\-]\s+/gm, "• ");

    // Replace user names with Slack mentions
    const users = memory.get('users') || {};
    for (const [id, name] of Object.entries(users)) {
        const regex = new RegExp(`\\b${name}\\b`, 'gi');
        clean = clean.replace(regex, `<@${id}>`);
    }
    return clean;
}

// --- USER NAME HELPER ---
async function getUserName(userId) {
    // Check cache first
    const cached = memory.getCachedUserName(userId);
    if (cached) return cached;

    // Fetch from Slack API
    try {
        const userInfo = await app.client.users.info({ user: userId });
        const realName = userInfo.user.real_name || userInfo.user.name;
        memory.cacheUserName(userId, realName);
        return realName;
    } catch (error) {
        console.error("Failed to get user name:", error.message);
        return "Unknown User";
    }
}

// --- MAIN MESSAGE HANDLER ---
app.message(async ({ message, say }) => {
    // Ignore bot messages
    if (message.subtype === 'bot_message') return;

    // Helper to reply in thread
    const safeSay = async (text) => {
        if (!text || !text.trim()) return;
        await say({
            text: formatForSlack(text),
            thread_ts: message.thread_ts || message.ts
        });
    };

    // Get conversation context
    const contextId = message.thread_ts || message.channel;
    let history = CONVERSATIONS[contextId] || [];
    if (history.length > 20) history = history.slice(history.length - 20);

    try {
        const speakerName = await getUserName(message.user);
        let userInput = message.text || "";

        // --- VISION CHECK ---
        if (message.files && message.files.length > 0) {
            const imageFile = message.files.find(f =>
                f.mimetype && f.mimetype.startsWith('image/')
            );

            if (imageFile) {
                await safeSay("👁️ Analyzing image...");
                // Use url_private_download if available (direct download link)
                const imageUrl = imageFile.url_private_download || imageFile.url_private;
                const visionPrompt = userInput || "Describe this image in detail.";

                const analysis = await analyzeImage(
                    imageUrl,
                    visionPrompt,
                    process.env.SLACK_BOT_TOKEN
                );

                userInput = `[Image Analysis]: ${analysis}\nUser: ${userInput}`;
            }
        }

        // --- CALL BRAIN ---
        const fullInput = `(User: ${speakerName}) ${userInput}`;

        const response = await thinkAndAct(history, fullInput, SYSTEM_PROMPT);

        // Update history
        history.push({ role: "user", content: userInput });
        history.push({ role: "assistant", content: response || "Done" });
        CONVERSATIONS[contextId] = history;

        // Reply
        await safeSay(response);

    } catch (error) {
        console.error("ERROR:", error);
        await safeSay(`System Error: ${error.message}`);
    }
});

// --- SPECIAL COMMANDS ---
app.message(/set report channel/i, async ({ message, say }) => {
    memory.set("report_channel", message.channel);
    await say({
        text: "✅ Reports will be sent to this channel.",
        thread_ts: message.thread_ts || message.ts
    });
});

// --- START ---
const { startLife } = require('./src/agent/life');

(async () => {
    await app.start();
    console.log("⚡️ Shehab V3 (Modular) is Online");
    startScheduler(app);
    startLife(app); // Start autonomous life systems (nudges, webhooks)
})();