require('dotenv').config();
const { App } = require('@slack/bolt');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Octokit } = require("octokit");
const JiraClient = require("jira-client");
const cron = require('node-cron');
const fs = require('fs');

// --- 1. CONFIGURATION ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});
// --- DEBUG SNIFFER ---
// This prints ANY event Slack sends to the console
app.use(async ({ logger, body, next }) => {
  console.log(`📨 PACKET RECEIVED: Type=${body.event?.type}, Text='${body.event?.text}'`);
  await next();
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

let memory = JSON.parse(fs.readFileSync('memory.json', 'utf8'));

// --- 2. TOOLS ---
async function getPullRequests() {
  try {
    const { data } = await octokit.rest.pulls.list({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      state: 'open'
    });
    if (data.length === 0) return "No open PRs found.";
    return data.map(pr => `- #${pr.number}: ${pr.title} (${pr.user.login})`).join("\n");
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
    return `Created Jira Ticket ${issue.key}`;
  } catch (error) { return `Jira Error: ${error.message}`; }
}

// --- 3. SYSTEM PROMPT ---
const SYSTEM_PROMPT = `
You are Shehab, the PM for 'Lab Manager'. 
Current Goal: ${memory.sprint_goal}.
Tone: Direct, pragmatic, concise. You are the boss.
Tools: Use 'get_prs' for code checks. Use 'create_ticket' for new tasks.
`;

// --- 4. CRON JOB (Daily Standup at 10 AM) ---
cron.schedule('0 10 * * *', async () => {
    try {
        const CHANNEL_ID = process.env.SLACK_CHANNEL_ID; 
        const chat = model.startChat();
        const msg = await chat.sendMessage(SYSTEM_PROMPT + " It is 10 AM. Ask for a brief standup.");
        await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: CHANNEL_ID,
            text: msg.response.text()
        });
    } catch (e) { console.error("Cron failed", e); }
});

// --- 5. MAIN CHAT LOGIC ---
// --- NEW UNIVERSAL LISTENER (DMs + Mentions) ---
// --- ROBUST LISTENER (Manual Parsing) ---
app.message(async ({ message, say }) => {
  // 1. Ignore other bots
  if (message.subtype === 'bot_message') return;
  console.log(`Processing: ${message.text}`);

  try {
    // 2. Start Chat
    const chat = model.startChat({
      history: [{ role: "user", parts: [{ text: SYSTEM_PROMPT }] }],
      tools: [{
          functionDeclarations: [
            { name: "get_prs", description: "Get open GitHub PRs" },
            { name: "create_ticket", description: "Create Jira task", parameters: { type: "OBJECT", properties: { summary: { type: "STRING" } }, required: ["summary"] } }
          ]
      }]
    });

    // 3. Send Message to Gemini
    const result = await chat.sendMessage(message.text);
    const response = await result.response; // Wait for the response object
    
    // --- THE FIX: Manually find the function call in the data ---
    const candidates = response.candidates;
    const parts = candidates ? candidates[0].content.parts : [];
    const functionCallPart = parts.find(part => part.functionCall);

    // 4. Handle Tool Calls
    if (functionCallPart) {
      const call = functionCallPart.functionCall; // Extract the raw call
      
      let toolResult = "";
      if (call.name === "get_prs") {
        await say("👀 Checking GitHub...");
        toolResult = await getPullRequests();
      } else if (call.name === "create_ticket") {
        await say(`📝 Updating Jira with task: ${call.args.summary}...`);
        toolResult = await createJiraTask(call.args.summary);
      }
      
      // 5. Send result back to Gemini
      const result2 = await chat.sendMessage([
        {
          functionResponse: {
            name: call.name,
            response: { output: toolResult }
          }
        }
      ]);
      await say(result2.response.text());
    } else {
      // No tool needed, just reply text
      await say(response.text());
    }

  } catch (error) {
    console.error("CRASH REPORT:", error);
    await say(`I crashed. Error: ${error.message}`);
  }
});

(async () => { await app.start(); console.log('⚡️ Shehab is Online'); })();