require('dotenv').config();
const { App } = require('@slack/bolt');
const OpenAI = require("openai");
const { Octokit } = require("octokit");
const JiraClient = require("jira-client");
const { search } = require('duck-duck-scrape');

const fs = require('fs');

// --- CONFIGURATION ---
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
});

// --- 👥 TEAM CONFIGURATION ---
const TEAM_IDS = {
    "Mohab": "U09JQFXPY0M",
    "Ziad": "U09JU0R35C2",
    "Kareem": "U09JRSYTGCW"
};

const MODEL_ID = "meta-llama/llama-4-scout-17b-16e-instruct"; // or llama-3.3-70b

const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const jira = new JiraClient({
    protocol: 'https',
    host: process.env.JIRA_HOST,
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
    apiVersion: '2',
    strictSSL: true
});

// --- STATE ---
const CONVERSATIONS = {};
let lastReportDate = "";

// --- FORMATTING HELPERS ---
function formatForSlack(text) {
    if (!text) return "";
    let clean = text.replace(/\*\*(.*?)\*\*/g, "*$1*").replace(/^#+\s+(.*$)/gm, "*$1*").replace(/^\s*[\*\-]\s+/gm, "• ");

    let mem = {};
    try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
    const users = mem.users || {};

    for (const [id, name] of Object.entries(users)) {
        const regex = new RegExp(`\\b${name}\\b`, 'gi');
        clean = clean.replace(regex, `<@${id}>`);
    }
    for (const [name, id] of Object.entries(TEAM_IDS)) {
        const regex = new RegExp(`\\b${name}\\b`, 'gi');
        clean = clean.replace(regex, `<@${id}>`);
    }
    return clean;
}

// --- TOOLS ---
async function getPullRequests() {
    try {
        const { data } = await octokit.rest.pulls.list({ owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, state: 'open' });
        if (!data || data.length === 0) return "No open PRs.";
        return data.map(pr => `- [PR #${pr.number}] ${pr.title} (Author: ${pr.user.login})`).join("\n");
    } catch (error) { return `GitHub Error: ${error.message}`; }
}

async function getIssues() {
    try {
        const { data } = await octokit.rest.issues.listForRepo({ owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, state: 'open' });
        const realIssues = data.filter(issue => !issue.pull_request);
        if (realIssues.length === 0) return "No open Issues.";
        return realIssues.map(i => `- [Issue #${i.number}] ${i.title}`).join("\n");
    } catch (e) { return "Could not fetch issues."; }
}

async function getFileTree() {
    try {
        const { data } = await octokit.rest.repos.getContent({ owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, path: '' });
        return data.map(f => ` - ${f.type}: ${f.name}`).join("\n");
    } catch (e) { return "Could not read file tree."; }
}

async function readFileContent(path) {
    if (path.includes('memory.json')) {
        try { return fs.readFileSync('memory.json', 'utf8'); } catch (e) { return "Memory empty."; }
    }
    try {
        const { data } = await octokit.rest.repos.getContent({ owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, path: path });
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return content.substring(0, 2000) + "... (truncated)";
    } catch (e) { return `Could not read file: ${path}`; }
}

async function createJiraTask(summary) {
    try {
        const issue = await jira.addNewIssue({ fields: { project: { key: process.env.JIRA_PROJECT_KEY }, summary: summary, issuetype: { name: 'Task' } } });
        return `✅ Ticket Created: ${issue.key} (<https://${process.env.JIRA_HOST}/browse/${issue.key}|Link>)`;
    } catch (error) { return `❌ Jira Error: ${error.message}`; }
}

async function updateProjectMemory(key, value) {
    try {
        let currentMemory = {};
        try { currentMemory = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
        currentMemory[key] = value;
        fs.writeFileSync('memory.json', JSON.stringify(currentMemory, null, 2));
        return `💾 Memory Updated! Set '${key}' to: "${value}"`;
    } catch (error) { return `Failed to update memory: ${error.message}`; }
}

async function searchWeb(query) {
    try {
        console.log(`🌍 Searching: ${query}`);
        const results = await search(query, { safeSearch: 0 });
        if (!results.results || results.results.length === 0) return "No results found.";
        return results.results.slice(0, 3).map(r => `Title: ${r.title}\nSnippet: ${r.description}\nLink: ${r.url}`).join("\n\n");
    } catch (error) { return `Search Error: ${error.message}`; }
}



// --- TOOL DEFINITIONS ---
const TOOLS_DEFINITION = [
    { type: "function", function: { name: "get_prs", description: "Get active Pull Requests", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "get_issues", description: "Get Open Issues", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "get_file_tree", description: "List files in repo root", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "read_file", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    { type: "function", function: { name: "create_ticket", description: "Create Jira task", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
    { type: "function", function: { name: "update_memory", description: "Update memory", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } } },
    { type: "function", function: { name: "search_web", description: "Search internet", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
];

// --- 🧠 THE AUTONOMY LOOP (The "Free Will") ---
async function runAutonomyLoop() {
    const now = new Date();
    // Only wake up between 9 AM and 6 PM
    if (now.getHours() < 9 || now.getHours() > 18) return;

    // 20% Chance to wake up every check (so he isn't annoying)
    if (Math.random() > 0.2) return;

    console.log("🤖 Shehab Waking Up (Autonomy Check)...");

    let mem = {};
    try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
    if (!mem.report_channel) return;

    try {
        const [prs, issues] = await Promise.all([getPullRequests(), getIssues()]);

        const prompt = `
        You are Shehab. It is ${now.toLocaleTimeString()}.
        You are checking on the team autonomously.
        
        STATUS:
        - PRs: ${prs}
        - Issues: ${issues}

        DECISION:
        - If there is a "stale" PR (older than 2 days) or a critical issue, send a message to the team tagging the right person.
        - If everything looks fine, stay silent (reply with "NO_ACTION").
        - If you speak, keep it short, casual, and helpful. "Hey @Mohab, that PR looks lonely..."
        `;

        const completion = await groq.chat.completions.create({
            model: MODEL_ID,
            messages: [{ role: "user", content: prompt }]
        });

        const decision = completion.choices[0].message.content;

        if (!decision.includes("NO_ACTION")) {
            await app.client.chat.postMessage({
                channel: mem.report_channel,
                text: formatForSlack(decision)
            });
            console.log("🗣️ Shehab spoke autonomously!");
        } else {
            console.log("🤫 Shehab decided to stay quiet.");
        }

    } catch (error) { console.error("Autonomy Error:", error); }
}

// --- SCHEDULE ---
// 1. Daily Report (10 AM)
setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 10 && now.getMinutes() === 0 && lastReportDate !== now.toDateString()) {
        let mem = {};
        try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
        if (mem.report_channel) {
            // Reuse autonomy logic but force report generation (simplified here for brevity)
            await app.client.chat.postMessage({ channel: mem.report_channel, text: "☀️ Daily Report time!" });
            lastReportDate = now.toDateString();
        }
    }
}, 60000);

// 2. Autonomy Loop (Runs every 30 minutes)
setInterval(runAutonomyLoop, 1800000); // 30 mins * 60 * 1000

// --- USER RECOGNITION ---
async function getOrRegisterUser(userId) {
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
    if (!mem.users) mem.users = {};
    if (mem.users[userId]) return mem.users[userId];
    try {
        const userInfo = await app.client.users.info({ user: userId });
        const realName = userInfo.user.real_name || userInfo.user.name;
        mem.users[userId] = realName;
        fs.writeFileSync('memory.json', JSON.stringify(mem, null, 2));
        return realName;
    } catch (error) { return "Unknown User"; }
}

// --- MAIN HANDLER ---
app.message(async ({ message, say }) => {
    if (message.subtype === 'bot_message') return;
    const safeSay = async (text) => { if (!text || !text.trim()) return; await say(formatForSlack(text)); };

    if (message.text.toLowerCase().includes("set report channel")) { await updateProjectMemory("report_channel", message.channel); await safeSay(`✅ Reports set to this channel.`); return; }

    const contextId = message.thread_ts || message.channel;
    let history = CONVERSATIONS[contextId] || [];
    if (history.length > 20) history = history.slice(history.length - 20);

    try {
        const speakerName = await getOrRegisterUser(message.user);
        let mem = { project_name: "Lab Manager" };
        try { const f = JSON.parse(fs.readFileSync('memory.json', 'utf8')); mem = { ...mem, ...f }; } catch (e) { }

        const SYSTEM_PROMPT = `
        You are Shehab, Senior PM for "Core Orbit" (Medical LIMS).
        
        IDENTITY:
        - Pragmatic, Agile, "Gen Z" friendly.
        - DOMAIN: Medical Lab Tech (HIPAA/GDPR is vital).
        
        RULES:
        1. Use 'search_web' for unknown tech/standards.

        3. Be proactive.
        
        TOOLS: GitHub, Jira, Memory, DuckDuckGo.
        `;

        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            ...history,
            { role: "user", content: `(User: ${speakerName}) ${message.text}` }
        ];

        const completion = await groq.chat.completions.create({
            model: MODEL_ID,
            messages: messages,
            tools: TOOLS_DEFINITION,
            tool_choice: "auto"
        });

        const responseMessage = completion.choices[0].message;
        let finalReply = responseMessage.content;
        let toolCalls = responseMessage.tool_calls;

        history.push({ role: "user", content: message.text });

        if (toolCalls) {
            const toolCall = toolCalls[0];
            const fnName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            console.log(`Tool: ${fnName}`);

            if (fnName === "search_web") {
                await safeSay(`🌍 Searching: "${args.query}"...`);
                const searchResults = await searchWeb(args.query);
                const followUp = await groq.chat.completions.create({
                    model: MODEL_ID,
                    messages: [...messages, { role: "assistant", tool_calls: [toolCall] }, { role: "tool", tool_call_id: toolCall.id, name: fnName, content: searchResults }]
                });
                finalReply = followUp.choices[0].message.content;
            }
            else if (fnName === "get_prs") { await safeSay("👀 Checking PRs..."); finalReply = await getPullRequests(); }
            else if (fnName === "get_issues") { await safeSay("📋 Checking Backlog..."); finalReply = await getIssues(); }
            else if (fnName === "get_file_tree") { await safeSay("📂 Scanning repo..."); finalReply = await getFileTree(); }
            else if (fnName === "read_file") { await safeSay(`📖 Reading ${args.path}...`); finalReply = await readFileContent(args.path); }
            else if (fnName === "create_ticket") { await safeSay("📝 Creating Ticket..."); finalReply = await createJiraTask(args.summary); }
            else if (fnName === "update_memory") { await safeSay("💾 Saving..."); finalReply = await updateProjectMemory(args.key, args.value); }


            if (fnName !== "search_web") await safeSay(finalReply);
        }

        // FAILSAFES
        if (finalReply && typeof finalReply === 'string' && finalReply.trim().startsWith('{') && finalReply.includes('"name":')) {
            try {
                const raw = JSON.parse(finalReply);
                const params = raw.parameters || raw.arguments || raw;
                if (raw.name === 'update_memory') { await safeSay(`⚠️ (Auto-Fix) Updating Memory...`); finalReply = await updateProjectMemory(params.key, params.value); await safeSay(finalReply); }
                else if (raw.name === 'search_web') { await safeSay(`🌍 (Auto-Fix) Searching...`); finalReply = await searchWeb(params.query); await safeSay(finalReply); }
            } catch (e) { }
        }

        await safeSay(finalReply);
        history.push({ role: "assistant", content: finalReply || "Done" });
        CONVERSATIONS[contextId] = history;

    } catch (error) {
        console.error("ERROR:", error);
        await safeSay(`System Error: ${error.message}`);
    }
});

(async () => { await app.start(); console.log(`⚡️ Shehab V23 (Autonomous) is Online`); })();