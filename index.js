require('dotenv').config();
const { App } = require('@slack/bolt');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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
// Get IDs from Slack Profile -> Three Dots -> Copy Member ID
const TEAM_IDS = {
    "Mohab": "U09JQFXPY0M",
    "Ziad": "U09JU0R35C2",
    "Kareem": "U09JRSYTGCW"
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
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
    let clean = text.replace(/\*\*(.*?)\*\*/g, "*$1*").replace(/^#+\s+(.*$)/gm, "*$1*").replace(/^\s*[\*\-]\s+/gm, "• ");

    // DYNAMIC TAGGING
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch (e) { }
    const users = mem.users || {};

    for (const [id, name] of Object.entries(users)) {
        const regex = new RegExp(`\\b${name}\\b`, 'gi');
        clean = clean.replace(regex, `<@${id}>`);
    }

    // Also include your hardcoded TEAM_IDS as fallback if you want
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

// --- REPORT ENGINE ---
async function generateDailyReport(channelId) {
    console.log("Generating Report...");
    try {
        const [prs, issues, files] = await Promise.all([getPullRequests(), getIssues(), getFileTree()]);

        // Pass the REAL DATE to the prompt
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

        const result = await model.generateContent(prompt);
        let report = result.response.text();

        // Convert Formatting
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
    // Runs at 10:00 AM server time
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

    // 1. If we already know this person, return their name
    if (mem.users[userId]) return mem.users[userId];

    // 2. If new, ask Slack for their real name
    try {
        const userInfo = await app.client.users.info({ user: userId });
        const realName = userInfo.user.real_name || userInfo.user.name;

        // 3. Save to Memory
        mem.users[userId] = realName;
        fs.writeFileSync('memory.json', JSON.stringify(mem, null, 2));

        console.log(`✨ Met a new person: ${realName} (${userId})`);
        return realName;
    } catch (error) {
        console.error("Who is this?", error);
        return "Unknown User";
    }
}
// --- MAIN HANDLER ---
app.message(async ({ message, say }) => {
    if (message.subtype === 'bot_message') return;

    const safeSay = async (text) => {
        if (!text || text.trim() === "") return;
        // Convert formatting before sending normal replies too!
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
        let mem = { project_name: "Lab Manager", role_mohab: "Full Stack", role_ziad: "Frontend", role_kareem: "Backend" };
        try { const f = JSON.parse(fs.readFileSync('memory.json', 'utf8')); mem = { ...mem, ...f }; } catch (e) { }

        // 1. IDENTIFY THE SPEAKER
        const speakerName = await getOrRegisterUser(message.user);

        const SYSTEM_PROMPT = {
            role: "user",
            parts: [{
                text: `
        You are Shehab, Project Manager.
        
        CURRENT CONTEXT:
        - You are talking to: ${speakerName}
        - Project Name: ${mem.project_name}
        TEAM: Mohab (${mem.role_mohab}), Ziad (${mem.role_ziad}), Kareem (${mem.role_kareem}).
        TOOLS: 'get_prs', 'get_issues', 'get_file_tree', 'read_file', 'create_ticket', 'update_memory'.
        IMPORTANT: Use the tools directly. If you cannot, print the function call text like: get_file_tree()
      `}]
        };

        const chat = model.startChat({
            history: [SYSTEM_PROMPT, ...history],
            tools: [{
                functionDeclarations: [
                    { name: "get_prs", description: "Get PRs" },
                    { name: "get_issues", description: "Get Open Issues" },
                    { name: "get_file_tree", description: "List files in repo root" },
                    { name: "read_file", description: "Read file content", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] } },
                    { name: "create_ticket", description: "Create Jira task", parameters: { type: "OBJECT", properties: { summary: { type: "STRING" } }, required: ["summary"] } },
                    { name: "update_memory", description: "Update memory", parameters: { type: "OBJECT", properties: { key: { type: "STRING" }, value: { type: "STRING" } }, required: ["key", "value"] } }
                ]
            }]
        });

        const result = await chat.sendMessage(message.text);
        const response = await result.response;
        let textResponse = "";
        try { textResponse = response.text(); } catch (e) { textResponse = ""; }

        history.push({ role: "user", parts: [{ text: message.text }] });

        const functionCallPart = response.candidates?.[0]?.content?.parts?.find(p => p.functionCall);
        let finalReply = textResponse;

        if (functionCallPart) {
            const call = functionCallPart.functionCall;
            console.log(`Tool: ${call.name}`);

            if (call.name === "get_prs") {
                await safeSay("👀 Checking PRs...");
                finalReply = await getPullRequests();
            }
            else if (call.name === "get_issues") {
                await safeSay("📋 Checking Issue Backlog...");
                finalReply = await getIssues();
            }
            else if (call.name === "get_file_tree") {
                await safeSay("📂 Scanning file structure...");
                finalReply = await getFileTree();
            }
            else if (call.name === "read_file") {
                await safeSay(`📖 Reading ${call.args.path}...`);
                finalReply = await readFileContent(call.args.path);
            }
            else if (call.name === "create_ticket") {
                await safeSay("📝 Creating Ticket...");
                finalReply = await createJiraTask(call.args.summary);
            }
            else if (call.name === "update_memory") {
                await safeSay("💾 Saving...");
                finalReply = await updateProjectMemory(call.args.key, call.args.value);
            }
            await safeSay(finalReply);
        }
        // FAILSAFES
        else if (textResponse.includes('get_file_tree')) {
            await safeSay("⚠️ (Auto-Fix) Scanning file structure...");
            finalReply = await getFileTree();
            await safeSay(finalReply);
        }
        else if (textResponse.includes('get_issues')) {
            await safeSay("⚠️ (Auto-Fix) Checking Issues...");
            finalReply = await getIssues();
            await safeSay(finalReply);
        }
        else if (textResponse.includes('read_file')) {
            const match = textResponse.match(/read_file\s*\(\s*["'](.*?)["']\s*\)/);
            if (match) {
                await safeSay(`⚠️ (Auto-Fix) Reading ${match[1]}...`);
                finalReply = await readFileContent(match[1]);
                await safeSay(finalReply);
            } else await safeSay(textResponse);
        }
        else if (textResponse.includes('create_ticket')) {
            const match = textResponse.match(/create_ticket\s*\(\s*["'](.*?)["']\s*\)/);
            if (match) {
                await safeSay(`⚠️ (Auto-Fix) Creating task: "${match[1]}"...`);
                finalReply = await createJiraTask(match[1]);
                await safeSay(finalReply);
            } else await safeSay(textResponse);
        }
        else if (textResponse.includes('update_memory')) {
            const match = textResponse.match(/update_memory\s*\(\s*["'](.*?)["']\s*,\s*["'](.*?)["']\s*\)/);
            if (match) {
                await safeSay(`⚠️ (Auto-Fix) Updating ${match[1]}...`);
                finalReply = await updateProjectMemory(match[1], match[2]);
                await safeSay(finalReply);
            } else await safeSay(textResponse);
        }
        else if (textResponse.includes('get_prs')) {
            await safeSay("⚠️ (Auto-Fix) Checking GitHub...");
            finalReply = await getPullRequests();
            await safeSay(finalReply);
        }
        else {
            await safeSay(finalReply || "✅ Done.");
        }

        history.push({ role: "model", parts: [{ text: finalReply || "Done" }] });
        CONVERSATIONS[contextId] = history;

    } catch (error) {
        console.error("ERROR:", error);
        await safeSay(`System Error: ${error.message}`);
    }
});

(async () => { await app.start(); console.log('⚡️ Shehab V10 (Formatted & Tagged) is Online'); })();