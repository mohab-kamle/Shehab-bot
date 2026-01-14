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
async function getPullRequests() {
  try {
    const { data } = await octokit.rest.pulls.list({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      state: 'open'
    });
    if (!data || data.length === 0) return "No open PRs found.";
    return data.map(pr => `- #${pr.number}: ${pr.title} (by ${pr.user.login})`).join("\n");
  } catch (error) { return `GitHub Error: ${error.message}`; }
}

async function createJiraTask(summary) {
  try {
    const issue = await jira.addNewIssue({
      fields: {
        project: { key: process.env.JIRA_PROJECT_KEY },
        summary: summary,
        issuetype: { name: 'Task' }
      }
    });
    // CRITICAL: Ensure this returns a string
    return `✅ Ticket Created: ${issue.key}\nLink: https://${process.env.JIRA_HOST}/browse/${issue.key}`;
  } catch (error) { return `❌ Jira Error: ${error.message}`; }
}

async function updateProjectMemory(key, value) {
  try {
    let currentMemory = {};
    try {
        currentMemory = JSON.parse(fs.readFileSync('memory.json', 'utf8'));
    } catch (e) { } // Ignore read errors

    currentMemory[key] = value;
    fs.writeFileSync('memory.json', JSON.stringify(currentMemory, null, 2));
    return `💾 Memory Updated! Set '${key}' to: "${value}"`;
  } catch (error) { return `Failed to update memory: ${error.message}`; }
}

// --- MAIN LOGIC ---
app.message(async ({ message, say }) => {
  if (message.subtype === 'bot_message') return;
  console.log(`User: ${message.text}`);

  // Helper to prevent "no_text" errors
  const safeSay = async (text) => {
      if (!text || text.trim() === "") {
          console.log("Empty text detected, skipping send.");
          return;
      }
      await say(text);
  };

  const contextId = message.thread_ts || message.channel;
  let history = CONVERSATIONS[contextId] || [];
  if (history.length > 20) history = history.slice(history.length - 20);

  try {
    // 1. Load Memory
    let mem = { project_name: "Lab Manager", role_mohab: "Full Stack", role_ziad: "Frontend", role_kareem: "Backend" };
    try {
        const fileData = JSON.parse(fs.readFileSync('memory.json', 'utf8'));
        mem = { ...mem, ...fileData };
    } catch (e) { }

    // 2. System Prompt
    const SYSTEM_PROMPT = {
      role: "user",
      parts: [{ text: `
        You are Shehab, Project Manager for ${mem.project_name}.
        TEAM: Mohab (${mem.role_mohab}), Ziad (${mem.role_ziad}), Kareem (${mem.role_kareem}).
        
        TOOLS: 'get_prs', 'create_ticket', 'update_memory'.
        
        RULES:
        - Auto-assign tasks by adding "[Name]" to the summary.
        - CONFIRM before creating tasks.
        - If tool fails, output text: create_ticket("[Name] Task")
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
    
    // Get text safely
    let textResponse = "";
    try { textResponse = response.text(); } catch (e) { textResponse = ""; }
    
    // Save user message
    history.push({ role: "user", parts: [{ text: message.text }] });

    // --- EXECUTION ---
    const functionCallPart = response.candidates?.[0]?.content?.parts?.find(p => p.functionCall);
    let finalReply = textResponse;

    if (functionCallPart) {
      // NATIVE TOOL CALL
      const call = functionCallPart.functionCall;
      console.log(`Tool Call: ${call.name}`);

      if (call.name === "get_prs") {
        await safeSay("👀 Checking GitHub...");
        finalReply = await getPullRequests();
      } 
      else if (call.name === "create_ticket") {
        await safeSay("📝 creating ticket...");
        finalReply = await createJiraTask(call.args.summary);
      }
      else if (call.name === "update_memory") {
        await safeSay("💾 Updating...");
        finalReply = await updateProjectMemory(call.args.key, call.args.value);
      }
      
      await safeSay(finalReply);
    } 
    // FAILSAFE: REGEX HUNTERS
    else if (textResponse.includes('create_ticket')) {
        const match = textResponse.match(/create_ticket\s*\(\s*["'](.*?)["']\s*\)/);
        if (match) {
            await safeSay(`⚠️ (Auto-Fix) Creating task: "${match[1]}"...`);
            finalReply = await createJiraTask(match[1]);
            await safeSay(finalReply);
        } else {
            await safeSay(textResponse);
        }
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
      // NORMAL CHAT
      if (finalReply) {
          await safeSay(finalReply);
      } else {
          // If Gemini sent NOTHING (just internal thought), send a default so we don't crash
          await safeSay("✅ Done.");
      }
    }

    history.push({ role: "model", parts: [{ text: finalReply || "Done" }] });
    CONVERSATIONS[contextId] = history;

  } catch (error) {
    console.error("CRITICAL ERROR:", error);
    await safeSay(`System Error: ${error.message}`);
  }
});

(async () => { await app.start(); console.log('⚡️ Shehab V7 (Safe Mode) is Online'); })();