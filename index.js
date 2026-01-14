require('dotenv').config();
const { App } = require('@slack/bolt');
const OpenAI = require("openai"); // CHANGED: Using OpenAI SDK for Groq
const { Octokit } = require("octokit");
const JiraClient = require("jira-client");
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

// --- CHANGED: GROQ CLIENT ---
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
function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "☀️ Good Morning";
    if (hour < 18) return "👋 Good Afternoon";
    return "🌙 Good Evening";
}

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
    // 1. Local Memory Bypass
    if (path.includes('memory.json')) {
        try {
            return fs.readFileSync('memory.json', 'utf8');
        } catch (e) {
            return "Memory file is empty or missing.";
        }
    }

    // 2. Normal GitHub Read
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

// --- CHANGED: TOOL DEFINITIONS (OpenAI Format) ---
const TOOLS_DEFINITION = [
    { type: "function", function: { name: "get_prs", description: "Get active Pull Requests", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "get_issues", description: "Get Open Issues", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "get_file_tree", description: "List files in repo root", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "read_file", description: "Read file content", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    { type: "function", function: { name: "create_ticket", description: "Create Jira task", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
    { type: "function", function: { name: "update_memory", description: "Update memory", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } } }
];

// --- CHANGED: REPORT ENGINE (Groq) ---
async function generateDailyReport(channelId) {
    console.log("Generating Report...");
    try {
        const [prs, issues, files] = await Promise.all([getPullRequests(), getIssues(), getFileTree()]);
        const today = new Date().toDateString();

        const prompt = `
        You are Shehab, Project Manager. Today is ${today}.
        Analyze the project state and assign tasks.
        
        TEAM: Mohab, Ziad, Kareem.
        REPO STATE:
        - PRs: ${prs}
        - Issues: ${issues}
        - Files: ${files}

        INSTRUCTIONS:
        - Create a "Daily Plan".
        - Assign 1 task to EACH person.
        - Use standard Markdown (e.g. # Header, * Item).
        - Use names explicitly (e.g. @Mohab) so I can tag them.
        - Be concise.
        `;

        const completion = await groq.chat.completions.create({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [{ role: "user", content: prompt }]
        });

        const report = completion.choices[0].message.content;

        const formattedReport = formatForSlack(report);
        const greeting = getGreeting();

        await app.client.chat.postMessage({
            channel: channelId,
            text: `${greeting} Team! Daily Pulse`,
            blocks: [
                { type: "section", text: { type: "mrkdwn", text: `*${greeting} Team! Here is the plan:* \n\n${formattedReport}` } }
            ]
        });
        return true;
    } catch (error) {
        console.error("Report Failed:", error);
        return false;
    }
}

// --- SCHEDULE ---
setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 10 && now.getMinutes() === 0 && lastReportDate !== now.toDateString()) {
        let mem = {};
        try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
        if (mem.report_channel) {
            await generateDailyReport(mem.report_channel);
            lastReportDate = now.toDateString();
        }
    }
}, 60000);

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

        console.log(`✨ Met a new person: ${realName} (${userId})`);
        return realName;
    } catch (error) {
        console.error("Who is this?", error);
        return "Unknown User";
    }
}

// --- MAIN HANDLER (GROQ EDITION) ---
app.message(async ({ message, say }) => {
    if (message.subtype === 'bot_message') return;

    const safeSay = async (text) => {
        if (!text || text.trim() === "") return;
        await say(formatForSlack(text));
    };

    // COMMANDS
    if (message.text.toLowerCase().includes("set report channel")) {
        await updateProjectMemory("report_channel", message.channel);
        await safeSay(`✅ Reports set to this channel (#${message.channel}).`);
        return;
    }
    if (message.text.toLowerCase().includes("run daily report")) {
        await safeSay("⏳ Scanning Repo & Generating Report...");
        await generateDailyReport(message.channel);
        return;
    }

    const contextId = message.thread_ts || message.channel;
    let history = CONVERSATIONS[contextId] || [];
    if (history.length > 20) history = history.slice(history.length - 20);

    try {
        const speakerName = await getOrRegisterUser(message.user);
        console.log(`🗣️ Speaker identified as: ${speakerName}`);

        let mem = { project_name: "Lab Manager", role_mohab: "Full Stack", role_ziad: "Frontend", role_kareem: "Backend" };
        try { const f = JSON.parse(fs.readFileSync('memory.json', 'utf8')); mem = { ...mem, ...f }; } catch (e) { }

        // --- CONSTRUCT MESSAGES FOR GROQ ---
        const messages = [
            {
                role: "system",
                content: `You are Shehab, the Project Manager.
                
                WHO YOU ARE TALKING TO:
                You are speaking with **${speakerName}**.
                
                CONTEXT:
                - Project: ${mem.project_name}
                - Team: Mohab (${mem.role_mohab}), Ziad (${mem.role_ziad}), Kareem (${mem.role_kareem}).
                
                TOOLS: You have tools to check GitHub (get_prs, get_issues, get_file_tree, read_file), create Jira tasks (create_ticket), and update memory.
                
                INSTRUCTIONS:
                - If asked "Do you know me?", answer "Yes, you are ${speakerName}."
                - Use tools whenever needed.
                `
            },
            ...history,
            { role: "user", content: message.text }
        ];

        // --- CALL GROQ ---
        const completion = await groq.chat.completions.create({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: messages,
            tools: TOOLS_DEFINITION,
            tool_choice: "auto"
        });

        const responseMessage = completion.choices[0].message;
        let finalReply = responseMessage.content;
        let toolCalls = responseMessage.tool_calls;

        // --- SAVE USER MESSAGE TO HISTORY ---
        history.push({ role: "user", content: message.text });

        // --- HANDLE TOOL CALLS ---
        if (toolCalls) {
            // Only handle the first tool call for simplicity in this loop
            // (Llama usually does one at a time for these tasks)
            const toolCall = toolCalls[0];
            const fnName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            console.log(`Tool: ${fnName}`);

            if (fnName === "get_prs") {
                await safeSay("👀 Checking PRs...");
                finalReply = await getPullRequests();
            }
            else if (fnName === "get_issues") {
                await safeSay("📋 Checking Issue Backlog...");
                finalReply = await getIssues();
            }
            else if (fnName === "get_file_tree") {
                await safeSay("📂 Scanning file structure...");
                finalReply = await getFileTree();
            }
            else if (fnName === "read_file") {
                await safeSay(`📖 Reading ${args.path}...`);
                finalReply = await readFileContent(args.path);
            }
            else if (fnName === "create_ticket") {
                await safeSay("📝 Creating Ticket...");
                finalReply = await createJiraTask(args.summary);
            }
            else if (fnName === "update_memory") {
                await safeSay("💾 Saving...");
                finalReply = await updateProjectMemory(args.key, args.value);
            }

            await safeSay(finalReply);
        }

        // --- FAILSAFES (Regex Hunters) ---
        // (Kept strictly because you asked to maintain functionality, useful if Llama hallucinates text)
        if (finalReply && typeof finalReply === 'string') {
            if (finalReply.trim().startsWith('{') && finalReply.includes('"name":')) {
                try {
                    const raw = JSON.parse(finalReply);
                    // Map the raw JSON to the tool logic
                    if (raw.name === 'update_memory') {
                        await safeSay(`⚠️ (Auto-Fix) Updating Memory...`);
                        // Handle different JSON formats Llama might use (parameters vs args)
                        const params = raw.parameters || raw.arguments || raw;
                        finalReply = await updateProjectMemory(params.key, params.value);
                        await safeSay(finalReply);
                    }
                    else if (raw.name === 'create_ticket') {
                        await safeSay(`⚠️ (Auto-Fix) Creating Ticket...`);
                        const params = raw.parameters || raw.arguments || raw;
                        finalReply = await createJiraTask(params.summary);
                        await safeSay(finalReply);
                    }
                } catch (e) { console.log("JSON Parse fail:", e); }
            }
            if (finalReply.includes('get_file_tree') && !toolCalls) {
                await safeSay("⚠️ (Auto-Fix) Scanning file structure...");
                finalReply = await getFileTree();
                await safeSay(finalReply);
            }
            else if (finalReply.includes('get_issues') && !toolCalls) {
                await safeSay("⚠️ (Auto-Fix) Checking Issues...");
                finalReply = await getIssues();
                await safeSay(finalReply);
            }
            else if (finalReply.includes('read_file') && !toolCalls) {
                const match = finalReply.match(/read_file\s*\(\s*["'](.*?)["']\s*\)/);
                if (match) {
                    await safeSay(`⚠️ (Auto-Fix) Reading ${match[1]}...`);
                    finalReply = await readFileContent(match[1]);
                    await safeSay(finalReply);
                } else await safeSay(finalReply);
            }
            else if (finalReply.includes('create_ticket') && !toolCalls) {
                const match = finalReply.match(/create_ticket\s*\(\s*["'](.*?)["']\s*\)/);
                if (match) {
                    await safeSay(`⚠️ (Auto-Fix) Creating task: "${match[1]}"...`);
                    finalReply = await createJiraTask(match[1]);
                    await safeSay(finalReply);
                } else await safeSay(finalReply);
            }
            else if (finalReply.includes('get_prs') && !toolCalls) {
                await safeSay("⚠️ (Auto-Fix) Checking GitHub...");
                finalReply = await getPullRequests();
                await safeSay(finalReply);
            }
            else if (!toolCalls) {
                // If it wasn't a tool call and wasn't caught by failsafe, just say the text
                await safeSay(finalReply);
            }
        }

        // --- SAVE ASSISTANT REPLY TO HISTORY ---
        history.push({ role: "assistant", content: finalReply || "Done" });
        CONVERSATIONS[contextId] = history;

    } catch (error) {
        console.error("ERROR:", error);
        await safeSay(`System Error: ${error.message}`);
    }
});

(async () => { await app.start(); console.log('⚡️ Shehab V18 (Groq Edition) is Online'); })();