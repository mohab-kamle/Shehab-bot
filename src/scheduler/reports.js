const cron = require('node-cron');
const OpenAI = require('openai');
const memory = require('../utils/memory');
const { getPullRequests, getIssues } = require('../tools/github');
const { createJiraTaskWithAssignee, getOpenJiraIssues } = require('../tools/jira');
const { TEAM, PROJECT, findBestAssignee } = require('../config/team');
require('dotenv').config();

// Direct Groq client for report generation (no tools)
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const MODEL_ID = "meta-llama/llama-4-scout-17b-16e-instruct";

// System prompt for PM analysis
const PM_SYSTEM_PROMPT = `You are Shehab, a Senior Technical PM for ${PROJECT.name}.

PROJECT GOAL: ${PROJECT.goal}
METHODOLOGY: ${PROJECT.methodology}

TEAM:
- Ziad (Frontend): React, UI/UX, CSS
- Mohab (Full Stack/DevOps): Docker, APIs, Infrastructure
- Kareem (Backend): Node.js, Database, Server-side

YOUR TASK:
Analyze the project status and create a detailed PM report. Be like a real human PM who:
1. Prioritizes based on Agile best practices
2. Identifies blockers and risks
3. Suggests actionable tasks for team members
4. Gives a health score (1-10) for the project

OUTPUT FORMAT (use exactly this structure):
📊 **Daily Status Report**

**🎯 Project Health: X/10**
[Brief assessment]

**🔥 Priority Items:**
1. [Most critical item - mention who should handle it]
2. [Second priority]

**📋 Suggested Tasks:**
- @ziad: [frontend task if any]
- @mohab: [fullstack/devops task if any]  
- @kareem: [backend task if any]

**⚠️ Risks/Blockers:**
[Any concerns]

**💡 PM Notes:**
[Your analysis and recommendations]

Be concise but insightful. Tag team members with their Slack handles.`;

/**
 * Generate an AI-analyzed PM report
 */
async function generateSmartReport(slackApp) {
    const channel = memory.get('report_channel');
    if (!channel) {
        console.log("⚠️ No report channel set. Use 'set report channel' first.");
        return;
    }

    console.log("📊 Generating Smart PM Report...");

    try {
        // Gather all project data
        const prs = await getPullRequests();
        const issues = await getIssues();
        const jiraIssues = await getOpenJiraIssues();

        // Format Jira issues
        const jiraSummary = jiraIssues.length > 0
            ? jiraIssues.map(i => `- [${i.key}] ${i.fields.summary} (Status: ${i.fields.status.name})`).join('\n')
            : 'No open Jira issues.';

        // Create context for the AI
        const projectContext = `
=== CURRENT PROJECT STATUS ===

GITHUB PULL REQUESTS:
${prs}

GITHUB ISSUES:
${issues}

JIRA TICKETS:
${jiraSummary}

=== END STATUS ===

Based on this data, create your PM report. Remember to tag team members:
- <@${TEAM.ziad.slackId}> for Ziad (Frontend)
- <@${TEAM.mohab.slackId}> for Mohab (Full Stack/DevOps)
- <@${TEAM.kareem.slackId}> for Kareem (Backend)
`;

        // Get AI analysis (direct call, no tools)
        const completion = await groq.chat.completions.create({
            model: MODEL_ID,
            messages: [
                { role: "system", content: PM_SYSTEM_PROMPT },
                { role: "user", content: projectContext }
            ]
        });

        const report = completion.choices[0].message.content || "Unable to generate report.";

        // Send the report to Slack
        await slackApp.client.chat.postMessage({
            channel: channel,
            text: report,
            unfurl_links: false
        });

        console.log("✅ Smart PM Report sent!");

        // Parse the report for suggested tasks and create Jira tickets
        await createSuggestedTasks(report, slackApp, channel);

    } catch (e) {
        console.error("❌ Report Error:", e.message);
        await slackApp.client.chat.postMessage({
            channel: channel,
            text: `⚠️ Report generation failed: ${e.message}`
        });
    }
}

/**
 * Parse report and create Jira tasks from suggestions
 */
async function createSuggestedTasks(report, slackApp, channel) {
    // Look for task patterns like "@ziad: do something" or "@kareem: fix something"
    const taskPatterns = [
        { pattern: /@ziad[:\s]+([^@\n]+)/gi, member: TEAM.ziad },
        { pattern: /@mohab[:\s]+([^@\n]+)/gi, member: TEAM.mohab },
        { pattern: /@kareem[:\s]+([^@\n]+)/gi, member: TEAM.kareem }
    ];

    const createdTasks = [];

    for (const { pattern, member } of taskPatterns) {
        let match;
        while ((match = pattern.exec(report)) !== null) {
            const taskText = match[1].trim();
            // Skip if it's too short or just a placeholder
            if (taskText.length < 10 || taskText.includes('[') || taskText.toLowerCase().includes('no task')) {
                continue;
            }

            const result = await createJiraTaskWithAssignee(
                taskText,
                member.jiraAccountId,
                `Auto-generated from PM Report for ${member.name}`
            );

            if (result.includes('✅')) {
                createdTasks.push(`${member.name}: ${result}`);
            }
        }
    }

    // Notify about created tasks
    if (createdTasks.length > 0) {
        await slackApp.client.chat.postMessage({
            channel: channel,
            text: `🎫 *Auto-created Jira Tasks:*\n${createdTasks.join('\n')}`
        });
        console.log(`✅ Created ${createdTasks.length} Jira tasks`);
    }
}

/**
 * Start the scheduler for automated reports
 */
function startScheduler(slackApp) {
    // Every 2 days at 11:00 AM
    cron.schedule('0 11 */2 * *', () => generateSmartReport(slackApp));
    console.log("📅 Scheduler started: Smart PM Reports every 2 days at 11:00 AM");

    // One-time test run 10 seconds after startup (DELETE THIS AFTER TESTING)
    setTimeout(() => {
        console.log("🧪 Running one-time test report...");
        generateSmartReport(slackApp);
    }, 10 * 1000);
    console.log("⏰ Test report scheduled in 10 seconds");
}

module.exports = { startScheduler, generateSmartReport };
