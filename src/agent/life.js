/**
 * life.js - Shehab's Autonomous Behaviors
 * 
 * This module represents Shehab's "living" capabilities:
 * - Dynamic mood based on project health
 * - Proactive nudges for stale work
 * - Real-time reactions to GitHub events
 */

const cron = require('node-cron');
const express = require('express');
const memory = require('../utils/memory');
const { getPullRequestsRaw } = require('../tools/github');
const { getStaleJiraTickets } = require('../tools/jira');
const { reflectOnProject } = require('./reflection');
const { TEAM, PROJECT } = require('../config/team');

// ============================================
// MOOD SYSTEM
// ============================================

/**
 * Calculate Shehab's current mood based on project health
 * @param {number} issueCount - Number of open issues
 * @param {number} stalePRs - Number of PRs open 3+ days
 * @param {number} staleTickets - Number of tickets stuck 5+ days
 * @returns {Object} Mood level and prompt modifier
 */
function calculateMood(issueCount, stalePRs, staleTickets) {
    const stressScore = issueCount + (stalePRs * 2) + (staleTickets * 2);

    if (stressScore >= 10) {
        return {
            level: "stressed",
            emoji: "😤",
            prompt: "TONE: You are STRESSED and URGENT. There are too many issues piling up. Be strict and demand action. No emojis. Short sentences."
        };
    } else if (stressScore === 0) {
        return {
            level: "happy",
            emoji: "🎉",
            prompt: "TONE: You are HAPPY and CELEBRATORY! 🎉 Zero issues! Use party emojis. Congratulate the team. Be excited!"
        };
    } else if (stressScore <= 3) {
        return {
            level: "chill",
            emoji: "😎",
            prompt: "TONE: You are RELAXED. Things are under control. Be casual and friendly. Light humor is okay."
        };
    } else {
        return {
            level: "focused",
            emoji: "🎯",
            prompt: "TONE: You are FOCUSED and PROFESSIONAL. There's work to do but it's manageable. Be pragmatic."
        };
    }
}

/**
 * Get current project stress data for mood calculation
 */
async function getProjectStress() {
    try {
        const rawPRs = await getPullRequestsRaw();
        const staleTickets = await getStaleJiraTickets();
        const stalePRs = rawPRs.filter(pr => pr.days_old >= 3);

        return {
            stalePRs: stalePRs.length,
            staleTickets: staleTickets.length,
            stalePRList: stalePRs,
            staleTicketList: staleTickets
        };
    } catch (e) {
        console.error("Error getting project stress:", e.message);
        return { stalePRs: 0, staleTickets: 0, stalePRList: [], staleTicketList: [] };
    }
}

// ============================================
// NUDGE SYSTEM (Proactive DMs)
// ============================================

const OpenAI = require('openai');
require('dotenv').config();

const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const NUDGE_PROMPT = `You are Shehab, a laid-back but effective PM. 
You're DMing a teammate about stale work. Be:
- Casual and friendly (like a coworker, not a manager)
- Supportive, not naggy
- Brief (1-3 sentences max)
- Sometimes use a bit of humor or a gentle roast
- Occasionally be dramatic but playfully

DON'T:
- Be robotic or formal
- Use the same message every time
- Sound passive-aggressive

Generate ONLY the DM message, nothing else.`;

/**
 * Generate a personalized nudge message using AI
 */
async function generateNudgeMessage(context) {
    try {
        const completion = await groq.chat.completions.create({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [
                { role: "system", content: NUDGE_PROMPT },
                { role: "user", content: context }
            ]
        });
        return completion.choices[0].message.content;
    } catch (e) {
        console.error("Nudge generation error:", e.message);
        return null; // Fall back to not sending if AI fails
    }
}

/**
 * Check for stale work and send private DMs to team members
 * @param {Object} slackApp - Slack Bolt app instance
 */
async function checkStaleWork(slackApp) {
    console.log("👀 Checking for stale work...");

    try {
        const { stalePRList, staleTicketList } = await getProjectStress();

        // Nudge about stale PRs (3+ days)
        for (const pr of stalePRList) {
            const member = findTeamMemberByGitHub(pr.author);
            if (member) {
                const context = `DM ${member.name} (${member.role}) about their PR #${pr.number} titled "${pr.title}" which has been open for ${pr.days_old} days. Ask if they need help or if it's waiting for review.`;
                const message = await generateNudgeMessage(context);

                if (message) {
                    await slackApp.client.chat.postMessage({
                        channel: member.slackId,
                        text: message
                    });
                    console.log(`📩 Sent AI nudge to ${member.name} about PR #${pr.number}`);
                }
            }
        }

        // Nudge about stale Jira tickets (5+ days in Development)
        for (const ticket of staleTicketList) {
            const member = Object.values(TEAM).find(m => m.jiraAccountId === ticket.assigneeId);
            if (member) {
                const context = `DM ${member.name} (${member.role}) about Jira ticket ${ticket.key} titled "${ticket.summary}" which has been in "${ticket.status}" status for ${ticket.days_stale} days. Check if everything is okay or if they need help.`;
                const message = await generateNudgeMessage(context);

                if (message) {
                    await slackApp.client.chat.postMessage({
                        channel: member.slackId,
                        text: message
                    });
                    console.log(`📩 Sent AI nudge to ${member.name} about ticket ${ticket.key}`);
                }
            }
        }

        if (stalePRList.length === 0 && staleTicketList.length === 0) {
            console.log("✨ No stale work found! Team is on track.");
        }

    } catch (e) {
        console.error("❌ Nudge check error:", e.message);
    }
}

/**
 * Execute the autonomous reflection cycle and utilize the output.
 */
async function runReflection(slackApp) {
    const channel = memory.get('report_channel');
    if (!channel) return;

    const thought = await reflectOnProject();
    if (thought && thought.public_status) {
        await slackApp.client.chat.postMessage({
            channel: channel,
            text: `💭 *Shehab's Thought of the Day:*\n${thought.public_status}`
        });
    }
}

/**
 * Find team member by GitHub username
 */
function findTeamMemberByGitHub(githubUsername) {
    return Object.values(TEAM).find(m =>
        m.name.toLowerCase().includes(githubUsername.toLowerCase()) ||
        githubUsername.toLowerCase().includes(m.name.split(' ')[0].toLowerCase())
    );
}

// ============================================
// GITHUB WEBHOOK SERVER (Real-time Reactions)
// ============================================

/**
 * Create and configure the GitHub webhook server
 * @param {Object} slackApp - Slack Bolt app instance
 * @returns {Object} Express server instance
 */
function createWebhookServer(slackApp) {
    const server = express();
    server.use(express.json());

    server.post('/github-webhook', async (req, res) => {
        try {
            const event = req.body;
            const channel = memory.get('report_channel');

            if (!channel) {
                console.log("⚠️ GitHub event received but no report channel set.");
                return res.status(200).send('OK');
            }

            // Handle PR Opened Event
            if (event.action === 'opened' && event.pull_request) {
                const pr = event.pull_request;
                const member = findTeamMemberByGitHub(pr.user.login);
                const authorMention = member ? `<@${member.slackId}>` : pr.user.login;

                await slackApp.client.chat.postMessage({
                    channel: channel,
                    text: `🚨 *New PR Alert!* ${authorMention} just opened *${pr.title}* (PR #${pr.number})\n_I'll keep an eye on it!_`
                });
                console.log(`🔔 Posted alert for new PR #${pr.number}`);
            }

            // Handle PR Merged Event
            if (event.action === 'closed' && event.pull_request?.merged) {
                const pr = event.pull_request;
                await slackApp.client.chat.postMessage({
                    channel: channel,
                    text: `🎉 *PR Merged!* PR #${pr.number} (*${pr.title}*) has been merged! Nice work! 🚀`
                });
                console.log(`🔔 Posted alert for merged PR #${pr.number}`);
            }

            // Handle Issue Opened Event
            if (event.action === 'opened' && event.issue && !event.pull_request) {
                const issue = event.issue;
                await slackApp.client.chat.postMessage({
                    channel: channel,
                    text: `🐛 *New Issue!* ${issue.user.login} opened: *${issue.title}* (Issue #${issue.number})`
                });
                console.log(`🔔 Posted alert for new issue #${issue.number}`);
            }

            res.status(200).send('OK');
        } catch (e) {
            console.error("Webhook error:", e.message);
            res.status(500).send('Error');
        }
    });

    // Health check endpoint
    server.get('/health', (req, res) => res.status(200).send('Shehab is alive! 🧠'));

    return server;
}

// ============================================
// LIFE SCHEDULER (Autonomous Behaviors)
// ============================================

/**
 * Start all autonomous behaviors
 * @param {Object} slackApp - Slack Bolt app instance
 */
function startLife(slackApp) {
    // Daily nudges at 2:00 PM
    cron.schedule('0 14 * * *', () => checkStaleWork(slackApp));
    console.log("💓 Life: Stale work nudges scheduled for 2:00 PM daily");

    // Daily Reflection at 10:00 AM
    cron.schedule('0 10 * * *', () => runReflection(slackApp));
    console.log("🧠 Life: Daily semantic reflection scheduled for 10:00 AM");

    // Start webhook server on port 3001
    const webhookServer = createWebhookServer(slackApp);
    webhookServer.listen(3001, () => {
        console.log("👂 Life: GitHub webhook server listening on port 3001");
    });

    console.log("🧬 Shehab's autonomous life systems are now active!");
}

module.exports = {
    calculateMood,
    getProjectStress,
    checkStaleWork,
    createWebhookServer,
    startLife,
    runReflection,
    findTeamMemberByGitHub
};
