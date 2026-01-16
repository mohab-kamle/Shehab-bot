require('dotenv').config();
const axios = require('axios');

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

/**
 * Create a Jira task (basic - no assignee)
 * @param {string} summary - Task title
 * @returns {Promise<string>}
 */
async function createJiraTask(summary) {
    return createJiraTaskWithAssignee(summary, null, null);
}

/**
 * Create a Jira task with optional assignee and description
 * @param {string} summary - Task title
 * @param {string|null} assigneeAccountId - Jira account ID or null
 * @param {string|null} description - Task description or null
 * @returns {Promise<string>}
 */
async function createJiraTaskWithAssignee(summary, assigneeAccountId = null, description = null) {
    try {
        const fields = {
            project: { key: PROJECT_KEY },
            summary: summary,
            issuetype: { name: 'Task' }
        };

        if (description) {
            fields.description = {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: description }]
                    }
                ]
            };
        }

        if (assigneeAccountId) {
            fields.assignee = { accountId: assigneeAccountId };
        }

        const response = await axios.post(
            `https://${JIRA_HOST}/rest/api/3/issue`,
            { fields },
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        const issueKey = response.data.key;
        return `✅ Ticket Created: ${issueKey} (https://${JIRA_HOST}/browse/${issueKey})`;
    } catch (error) {
        const errMsg = error.response?.data?.errors || error.response?.data?.errorMessages || error.message;
        console.error("Jira Error:", errMsg);
        return `❌ Jira Error: ${JSON.stringify(errMsg)}`;
    }
}

/**
 * Get open issues from Jira
 * @returns {Promise<Array>}
 */
async function getOpenJiraIssues() {
    try {
        const jql = `project = ${PROJECT_KEY} AND status != Done ORDER BY created DESC`;
        const response = await axios.get(
            `https://${JIRA_HOST}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=20`,
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                }
            }
        );
        return response.data.issues || [];
    } catch (e) {
        console.error("Jira fetch error:", e.response?.status || e.message);
        return [];
    }
}

module.exports = { createJiraTask, createJiraTaskWithAssignee, getOpenJiraIssues };
