/**
 * Test file for sending AI-generated nudge DMs
 * Run once: node tests/test_nudge_dm.js
 * Delete after testing!
 */

require('dotenv').config();
const { App } = require('@slack/bolt');
const OpenAI = require('openai');
const { TEAM } = require('../src/config/team');

// Slack App
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

// Groq Client
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const NUDGE_PROMPT = `You are Shehab, a laid-back but effective PM. 
You're DMing a teammate about stale work. Be:
- Casual and friendly (like a coworker, not a manager)
- Supportive, not naggy
- Brief (1-3 sentences max)
- Sometimes use a bit of humor or a gentle roast
- Occasionally be dramatic but playfully

DON'T:
- Be robotic or formal
- Use the same message every time
- Sound passive-aggressive

Generate ONLY the DM message, nothing else.`;

async function generateNudgeMessage(context) {
    const completion = await groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
            { role: "system", content: NUDGE_PROMPT },
            { role: "user", content: context }
        ]
    });
    return completion.choices[0].message.content;
}

async function testNudgeDM() {
    await app.start();
    console.log("🧪 Testing AI Nudge DM to Ziad...\n");

    // Fake stale PR data for testing
    const testPR = {
        number: 99,
        title: "Add new patient registration feature",
        days_old: 4
    };

    const member = TEAM.ziad;
    const context = `DM ${member.name} (${member.role}) about their PR #${testPR.number} titled "${testPR.title}" which has been open for ${testPR.days_old} days. Ask if they need help or if it's waiting for review.`;

    console.log("📝 Context:", context);
    console.log("\n⏳ Generating AI message...\n");

    const message = await generateNudgeMessage(context);
    console.log("🤖 AI Generated Message:\n");
    console.log(`"${message}"\n`);

    // Send to Ziad
    console.log(`📩 Sending DM to ${member.name} (${member.slackId})...`);
    await app.client.chat.postMessage({
        channel: member.slackId,
        text: message
    });

    console.log("✅ DM sent successfully!");
    console.log("\n🛑 Test complete. You can delete this file now.");

    process.exit(0);
}

testNudgeDM().catch(e => {
    console.error("❌ Test failed:", e.message);
    process.exit(1);
});
