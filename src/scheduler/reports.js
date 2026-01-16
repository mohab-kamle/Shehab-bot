const cron = require('node-cron');
const OpenAI = require('openai');
const memory = require('../utils/memory');
const { getPullRequests, getIssues } = require('../tools/github');
const { createJiraTaskWithAssignee, getOpenJiraIssues } = require('../tools/jira');
const { TEAM, PROJECT } = require('../config/team');
const { calculateMood, getProjectStress } = require('../agent/life');
require('dotenv').config();

// Direct Groq client for report generation (no tools)
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const MODEL_ID = "meta-llama/llama-4-scout-17b-16e-instruct";

/**
 * Format text for Slack
 */
function formatForSlack(text) {
    if (!text) return "";
    let clean = text
        .replace(/\*\*(.*?)\*\*/g, "*$1*")
        .replace(/^#+\s+(.*$)/gm, "*$1*")
        .replace(/^\s*[\*\-]\s+/gm, "• ");

    clean = clean
        .replace(/@ziad/gi, `<@${TEAM.ziad.slackId}>`)
        .replace(/@mohab/gi, `<@${TEAM.mohab.slackId}>`)
        .replace(/@kareem/gi, `<@${TEAM.kareem.slackId}>`);

    return clean;
}

// Base PM System Prompt
const BASE_PM_PROMPT = `You are Shehab, a Senior Technical PM for ${PROJECT.name}.

PROJECT GOAL: ${PROJECT.goal}
METHODOLOGY: ${PROJECT.methodology}

TEAM (use these EXACT Slack mentions):
- <@${TEAM.ziad.slackId}> = Ziad (Frontend: React, UI/UX, CSS)
- <@${TEAM.mohab.slackId}> = Mohab (Full Stack/DevOps: Docker, APIs, Infrastructure)
- <@${TEAM.kareem.slackId}> = Kareem (Backend: Node.js, Database, Server-side)

YOUR TASK:
Analyze the project status and create a detailed PM report using SLACK FORMATTING:
- Use *bold* (single asterisks) NOT **bold**
- Use bullet points with •
- Tag team members using their EXACT Slack mentions above

OUTPUT FORMAT:
📊 *Daily Status Report*

*🎯 Project Health: X/10*
[Brief assessment]

*🔥 Priority Items:*
• [Most critical item]
• [Second priority]

*📋 Suggested Tasks:*
• <@${TEAM.ziad.slackId}>: [frontend task if any]
• <@${TEAM.mohab.slackId}>: [fullstack/devops task if any]
• <@${TEAM.kareem.slackId}>: [backend task if any]

*⚠️ Risks/Blockers:*
[Any concerns]

*💡 PM Notes:*
[Your analysis and recommendations]

Be concise but insightful.`;

/**
 * Generate an AI-analyzed PM report with dynamic mood
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

        // Get stress data from life.js
        const { stalePRs, staleTickets } = await getProjectStress();

        // Count issues for mood calculation
        const issueCount = (issues.match(/\[Issue/g) || []).length;

        // Calculate mood using life.js
        const mood = calculateMood(issueCount, stalePRs, staleTickets);
        console.log(`🎭 Mood: ${mood.level} ${mood.emoji} (Issues: ${issueCount}, Stale PRs: ${stalePRs}, Stale Tickets: ${staleTickets})`);

        // Dynamic prompt with mood
        const DYNAMIC_PROMPT = BASE_PM_PROMPT + "\n\n" + mood.prompt;

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

STALE ITEMS (needs attention):
- Stale PRs (3+ days old): ${stalePRs}
- Stale Jira tickets (5+ days in Development): ${staleTickets}

=== END STATUS ===

Based on this data, create your PM report.
`;

        // Get AI analysis with dynamic mood
        const completion = await groq.chat.completions.create({
            model: MODEL_ID,
            messages: [
                { role: "system", content: DYNAMIC_PROMPT },
                { role: "user", content: projectContext }
            ]
        });

        const report = completion.choices[0].message.content || "Unable to generate report.";
        const formattedReport = formatForSlack(report);

        // Send the report to Slack
        await slackApp.client.chat.postMessage({
            channel: channel,
            text: formattedReport,
            unfurl_links: false
        });

        console.log("✅ Smart PM Report sent!");

        // Parse the report for suggested tasks and create Jira tickets
        await createSuggestedTasks(report, slackApp, channel);

    } catch (e) {
        console.error("❌ Report Error:", e.message);
    }
}

/**
 * Parse report and create Jira tasks from suggestions
 */
async function createSuggestedTasks(report, slackApp, channel) {
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
    // Every 2 days at 11:00 AM - Smart PM Report
    cron.schedule('0 11 */2 * *', () => generateSmartReport(slackApp));
    console.log("📅 Scheduler: Smart PM Reports every 2 days at 11:00 AM");
}

module.exports = { startScheduler, generateSmartReport };
