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

// --- MEMORY STORAGE ---
// Format: { 'channel_id': [ { role: 'user', parts: [...] }, ... ] }
const CONVERSATIONS = {};

// --- TOOLS ---
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

// --- MAIN BOT LOGIC ---
app.message(async ({ message, say }) => {
  if (message.subtype === 'bot_message') return; // Ignore self
  console.log(`Processing from ${message.user}: ${message.text}`);

  // 1. Context ID (Use Thread TS if available, otherwise Channel ID)
  // This ensures he remembers the specific thread or DM conversation.
  const contextId = message.thread_ts || message.channel;

  // 2. Load History (or create empty)
  let history = CONVERSATIONS[contextId] || [];

  // Limit memory to last 10 turns to prevent crashing
  if (history.length > 20) history = history.slice(history.length - 20);

  try {
    // 3. Define the System Prompt (Always injected fresh)
    const SYSTEM_PROMPT = {
      role: "user",
      parts: [{ text: `
        You are Shehab, the Project Manager.
        Tools: 'get_prs' (GitHub) and 'create_ticket' (Jira).
        CONTEXT: You are in a Slack chat.
        CRITICAL: If asked to create a task, YOU MUST USE THE TOOL.
        If you cannot use the tool, format your answer exactly like this: create_ticket("Task Name Here")
      `}]
    };

    // 4. Start Chat with History
    const chat = model.startChat({
      history: [SYSTEM_PROMPT, ...history], // Inject Prompt + Past Memory
      tools: [{
          functionDeclarations: [
            { name: "get_prs", description: "Get GitHub PRs" },
            { name: "create_ticket", description: "Create Jira task", parameters: { type: "OBJECT", properties: { summary: { type: "STRING" } }, required: ["summary"] } }
          ]
      }]
    });

    // 5. Send Message
    const result = await chat.sendMessage(message.text);
    const response = await result.response;
    const textResponse = response.text();

    // 6. SAVE MEMORY (User's question)
    history.push({ role: "user", parts: [{ text: message.text }] });

    // --- TOOL HANDLING (Hunter Logic) ---
    const functionCallPart = response.candidates?.[0]?.content?.parts?.find(p => p.functionCall);
    let finalReply = textResponse;

    if (functionCallPart) {
      // Native Tool Use
      const call = functionCallPart.functionCall;
      if (call.name === "get_prs") {
        await say("👀 Checking GitHub...");
        const data = await getPullRequests();
        finalReply = data;
        await say(data);
      } else if (call.name === "create_ticket") {
        await say("📝 Writing to Jira...");
        const data = await createJiraTask(call.args.summary);
        finalReply = data;
        await say(data);
      }
    } 
    else if (textResponse.includes('create_ticket')) {
        // Regex Fix
        const match = textResponse.match(/create_ticket\s*\(\s*["'](.*?)["']\s*\)/);
        if (match && match[1]) {
            await say(`⚠️ (Auto-Fix) Creating task: "${match[1]}"...`);
            const data = await createJiraTask(match[1]);
            finalReply = data;
            await say(data);
        } else {
            await say(textResponse);
        }
    }
    else if (textResponse.includes('get_prs')) {
         await say("⚠️ (Auto-Fix) Checking GitHub...");
         const data = await getPullRequests();
         finalReply = data;
         await say(data);
    } 
    else {
      // Normal Chat
      await say(textResponse);
    }

    // 7. SAVE MEMORY (Bot's Reply)
    // We save the final reply so he remembers what he said/did
    history.push({ role: "model", parts: [{ text: finalReply }] });
    CONVERSATIONS[contextId] = history; // Update global store

  } catch (error) {
    console.error(error);
    await say(`Error: ${error.message}`);
  }
});

(async () => { await app.start(); console.log('⚡️ Shehab (with Memory) is Online'); })();