require('dotenv').config();
const JiraClient = require("jira-client");

const jira = new JiraClient({
    protocol: 'https',
    host: process.env.JIRA_HOST,
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
    apiVersion: '2',
    strictSSL: true
});

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
    } catch (error) {
        return `❌ Jira Error: ${error.message}`;
    }
}

module.exports = { createJiraTask };
