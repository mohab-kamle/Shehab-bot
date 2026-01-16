const cron = require('node-cron');
const memory = require('../utils/memory');
const { getPullRequests, getIssues } = require('../tools/github');

/**
 * Generate and send a status report to the configured channel.
 * @param {Object} slackApp - The Slack Bolt app instance
 */
async function generateReport(slackApp) {
    const channel = memory.get('report_channel');
    if (!channel) {
        console.log("⚠️ No report channel set. Use 'set report channel' first.");
        return;
    }

    console.log("📊 Generating Daily Report...");

    try {
        const prs = await getPullRequests();
        const issues = await getIssues();

        const report = `📊 *Daily Status Report*\n\n*Open PRs:*\n${prs}\n\n*Open Issues:*\n${issues}`;

        await slackApp.client.chat.postMessage({
            channel: channel,
            text: report
        });

        console.log("✅ Daily Report sent!");
    } catch (e) {
        console.error("❌ Report Error:", e.message);
    }
}

/**
 * Start the scheduler for automated reports.
 * @param {Object} slackApp - The Slack Bolt app instance
 */
function startScheduler(slackApp) {
    // Every 2 days at 11:00 AM
    cron.schedule('0 11 */2 * *', () => generateReport(slackApp));
    console.log("📅 Scheduler started: Reports every 2 days at 11:00 AM");

    // One-time test run 1 minute after startup
    setTimeout(() => {
        console.log("🧪 Running one-time test report...");
        generateReport(slackApp);
    }, 60 * 1000); // 1 minute
    console.log("⏰ Test report scheduled in 1 minute");
}

module.exports = { startScheduler, generateReport };
