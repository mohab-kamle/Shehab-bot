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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const jira = new JiraClient({
  protocol: 'https',
  host: process.env.JIRA_HOST,
  username: process.env.JIRA_EMAIL,
  password: process.env.JIRA_API_TOKEN,
  apiVersion: '2',
  strictSSL: true
});

// --- CHAT HISTORY ---
const CONVERSATIONS = {};

// --- TOOLS ---

// 1. GitHub
async function getPullRequests() {
  try {
    const { data } = await octokit.rest.pulls.list({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      state: 'open'
    });
    if (data.length === 0) return "No open PRs found.";
    return data.map(pr => `- #${pr.number}: ${pr.title} (by ${pr.user.login})`).join("\n");
  } catch (error) { return `GitHub Error: ${error.message}`; }
}

// 2. Jira (Now supports auto-tagging in summary)
async function createJiraTask(summary) {
  try {
    const issue = await jira.addNewIssue({
      fields: {
        project: { key: process.env.JIRA_PROJECT_KEY },
        summary: summary,
        issuetype: { name: 'Task' }
      }
    });
    return `Created Jira Ticket ${issue.key}: https://${process.env.JIRA_HOST}/browse/${issue.key}`;
  } catch (error) { return `Jira Error: ${error.message}`; }
}

// 3. Memory Updater
async function updateProjectMemory(key, value) {
  try {
    let currentMemory = {};
    try {
        currentMemory = JSON.parse(fs.readFileSync('memory.json', 'utf8'));
    } catch (e) { console.log("Memory missing, creating new."); }

    currentMemory[key] = value;
    fs.writeFileSync('memory.json', JSON.stringify(currentMemory, null, 2));
    
    return `✅ Memory Updated! Set '${key}' to: "${value}"`;
  } catch (error) {
    return `Failed to update memory: ${error.message}`;
  }
}

// --- MAIN BOT LOGIC ---
app.message(async ({ message, say }) => {
  if (message.subtype === 'bot_message') return;
  console.log(`Processing from ${message.user}: ${message.text}`);

  const contextId = message.thread_ts || message.channel;
  let history = CONVERSATIONS[contextId] || [];
  if (history.length > 20) history = history.slice(history.length - 20);

  try {
    // 1. LOAD MEMORY & DEFAULTS
    let mem = { 
        project_name: "Lab Manager", 
        role_mohab: "Full Stack Developer", 
        role_ziad: "Frontend Developer", 
        role_kareem: "Backend Developer" 
    };
    try {
        const fileData = JSON.parse(fs.readFileSync('memory.json', 'utf8'));
        mem = { ...mem, ...fileData }; // Merge defaults with actual file
    } catch (e) { }

    // 2. THE TEAM AWARE PROMPT
    const SYSTEM_PROMPT = {
      role: "user",
      parts: [{ text: `
        You are Shehab, the Project Manager for ${mem.project_name}.
        
        CURRENT TEAM ROLES (From Memory):
        - Mohab: ${mem.role_mohab}
        - Ziad: ${mem.role_ziad}
        - Kareem: ${mem.role_kareem}

        PROJECT STATE:
        - Goal: ${mem.sprint_goal || "Not set"}

        TOOLS:
        1. 'get_prs' -> Check GitHub.
        2. 'create_ticket' -> Add to Jira (REQUIRES CONFIRMATION).
        3. 'update_memory' -> Update goals OR roles (e.g., key='role_ziad', value='Full Stack').

        RULES:
        1. **AUTO-ASSIGNMENT:** When a user suggests a task, analyze it.
           - If it's Frontend/UI -> Assign to Ziad.
           - If it's Backend/API/DB -> Assign to Kareem.
           - If it's Complex/Architectural -> Assign to Mohab.
           - **How to Assign:** Prepend the name to the summary. Example: "[Ziad] Fix CSS Button".

        2. **CONFIRMATION:** Always ask: "Shall I create a task for [Name]: 'Task Summary'?"
        
        3. **ROLE CHANGES:** If told "Ziad is now Full Stack", use 'update_memory' with key='role_ziad'.

        4. **FALLBACK:** If tool fails, print: create_ticket("[Ziad] Task Name")
      `}]
    };

    const chat = model.startChat({
      history: [SYSTEM_PROMPT, ...history], 
      tools: [{
          functionDeclarations: [
            { name: "get_prs", description: "Get GitHub PRs" },
            { name: "create_ticket", description: "Create Jira task", parameters: { type: "OBJECT", properties: { summary: { type: "STRING" } }, required: ["summary"] } },
            { name: "update_memory", description: "Update memory", parameters: { type: "OBJECT", properties: { key: { type: "STRING" }, value: { type: "STRING" } }, required: ["key", "value"] } }
          ]
      }]
    });

    const result = await chat.sendMessage(message.text);
    const response = await result.response;
    const textResponse = response.text();
    history.push({ role: "user", parts: [{ text: message.text }] });

    // --- EXECUTION ---
    const functionCallPart = response.candidates?.[0]?.content?.parts?.find(p => p.functionCall);
    let finalReply = textResponse;

    if (functionCallPart) {
      const call = functionCallPart.functionCall;
      
      if (call.name === "get_prs") {
        await say("👀 Checking GitHub...");
        finalReply = await getPullRequests();
      } 
      else if (call.name === "create_ticket") {
        await say("📝 Action Confirmed. Writing to Jira...");
        finalReply = await createJiraTask(call.args.summary);
      }
      else if (call.name === "update_memory") {
        await say("💾 Updating Team Memory...");
        finalReply = await updateProjectMemory(call.args.key, call.args.value);
      }
      
      await say(finalReply);
    } 
    // FAILSAFES (Regex Hunters)
    else if (textResponse.includes('update_memory')) {
        const match = textResponse.match(/update_memory\s*\(\s*["'](.*?)["']\s*,\s*["'](.*?)["']\s*\)/);
        if (match) {
             await say(`⚠️ (Auto-Fix) Updating ${match[1]}...`);
             finalReply = await updateProjectMemory(match[1], match[2]);
             await say(finalReply);
        } else await say(textResponse);
    }
    else if (textResponse.includes('create_ticket')) {
        const match = textResponse.match(/create_ticket\s*\(\s*["'](.*?)["']\s*\)/);
        if (match) {
            await say(`⚠️ (Auto-Fix) Creating task...`);
            finalReply = await createJiraTask(match[1]);
            await say(finalReply);
        } else await say(textResponse);
    }
    else if (textResponse.includes('get_prs')) {
         await say("⚠️ (Auto-Fix) Checking GitHub...");
         finalReply = await getPullRequests();
         await say(finalReply);
    } 
    else {
      await say(textResponse);
    }

    history.push({ role: "model", parts: [{ text: finalReply }] });
    CONVERSATIONS[contextId] = history;

  } catch (error) {
    console.error(error);
    await say(`Error: ${error.message}`);
  }
});

(async () => { await app.start(); console.log('⚡️ Shehab V5 (Team Lead) is Online'); })();