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

// Using 1.5 Flash for speed/quota safety
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

// --- GITHUB TOOLS (Enhanced) ---

// 1. Get Active PRs
async function getPullRequests() {
  try {
    const { data } = await octokit.rest.pulls.list({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      state: 'open'
    });
    if (!data || data.length === 0) return "No open PRs.";
    return data.map(pr => `- [PR #${pr.number}] ${pr.title} (Author: ${pr.user.login})`).join("\n");
  } catch (error) { return `GitHub Error: ${error.message}`; }
}

// 2. Get Open Issues (The Backlog)
async function getIssues() {
  try {
    const { data } = await octokit.rest.issues.listForRepo({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      state: 'open'
    });
    // Filter out PRs (GitHub API returns PRs as issues)
    const realIssues = data.filter(issue => !issue.pull_request);
    if (realIssues.length === 0) return "No open Issues.";
    return realIssues.map(i => `- [Issue #${i.number}] ${i.title} (Labels: ${i.labels.map(l=>l.name).join(', ')})`).join("\n");
  } catch (e) { return "Could not fetch issues."; }
}

// 3. See Repo Structure (Files & Folders)
async function getFileTree() {
  try {
    // Get root content
    const { data } = await octokit.rest.repos.getContent({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      path: ''
    });
    // Return list of file names/types
    return data.map(f => ` - ${f.type}: ${f.name}`).join("\n");
  } catch (e) { return "Could not read file tree."; }
}

// 4. Read Specific File Code
async function readFileContent(path) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      path: path
    });
    // Content is base64 encoded
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return content.substring(0, 2000) + "... (truncated)"; // Limit size for AI
  } catch (e) { return `Could not read file: ${path}`; }
}

// --- JIRA & MEMORY TOOLS ---
async function createJiraTask(summary) {
  try {
    const issue = await jira.addNewIssue({
      fields: {
        project: { key: process.env.JIRA_PROJECT_KEY },
        summary: summary,
        issuetype: { name: 'Task' }
      }
    });
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

// --- DAILY REPORT ENGINE ---
async function generateDailyReport(channelId) {
    console.log("Generating Daily Insight...");
    try {
        // 1. GATHER INTEL
        const [prs, issues, files] = await Promise.all([
            getPullRequests(),
            getIssues(),
            getFileTree()
        ]);
        
        let mem = {};
        try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch(e){}

        // 2. THE ARCHITECT PROMPT
        const prompt = `
        You are Shehab, Technical Project Manager.
        Analyze the project state to assign daily tasks.

        TEAM:
        - Mohab (${mem.role_mohab || "Full Stack"})
        - Ziad (${mem.role_ziad || "Frontend"})
        - Kareem (${mem.role_kareem || "Backend"})

        REPO STATE:
        1. Open PRs (Work in Progress):
        ${prs}

        2. Open Issues (Backlog):
        ${issues}

        3. File Structure (Architecture):
        ${files}

        INSTRUCTIONS:
        - Create a "Daily Plan" for the team.
        - Assign 1 specific task to EACH person (Mohab, Ziad, Kareem).
        - PRIORITY 1: Review/Merge PRs.
        - PRIORITY 2: Work on Open Issues.
        - PRIORITY 3 (If no work): Look at the File Structure and suggest an improvement (e.g., "Kareem, add tests for /controllers" or "Ziad, optimize /public/images").
        - Be direct and professional. Use emojis.
        `;

        const result = await model.generateContent(prompt);
        const report = result.response.text();

        await app.client.chat.postMessage({
            channel: channelId,
            text: "☀️ *Daily Project Pulse*",
            blocks: [
                { type: "section", text: { type: "mrkdwn", text: "☀️ *Morning Team! Here is today's plan:* \n\n" + report } }
            ]
        });
        return true;
    } catch (error) {
        console.error("Report Failed:", error);
        return false;
    }
}

// --- SCHEDULE LOOP (Every 60s) ---
setInterval(async () => {
    const now = new Date();
    // Runs at 10:00 AM server time
    if (now.getHours() === 10 && now.getMinutes() === 0 && lastReportDate !== now.toDateString()) {
        let mem = {};
        try { mem = JSON.parse(fs.readFileSync('memory.json', 'utf8')); } catch(e){}
        if (mem.report_channel) {
            await generateDailyReport(mem.report_channel);
            lastReportDate = now.toDateString();
        }
    }
}, 60000);


// --- MAIN HANDLER (With ALL Failsafes) ---
app.message(async ({ message, say }) => {
  if (message.subtype === 'bot_message') return;

  const safeSay = async (text) => {
      if (!text || text.trim() === "") return;
      await say(text);
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
    try { const f = JSON.parse(fs.readFileSync('memory.json', 'utf8')); mem = {...mem, ...f}; } catch (e) { }

    const SYSTEM_PROMPT = {
      role: "user",
      parts: [{ text: `
        You are Shehab, Project Manager.
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
      // --- NATIVE TOOL CALL ---
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
    // --- TEXT FAILSAFES (The Hunters) ---
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
         } else {
             await safeSay(textResponse);
         }
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

(async () => { await app.start(); console.log('⚡️ Shehab V9 (Architect) is Online'); })();