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
            `https://${JIRA_HOST}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=20&fields=summary,status,assignee,created,updated`,
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

/**
 * Get stale Jira tickets (in Development for 5+ days)
 */
async function getStaleJiraTickets() {
    try {
        // Get tickets in "Development" or "In Progress" status
        const jql = `project = ${PROJECT_KEY} AND status in ("Development", "In Progress") ORDER BY updated ASC`;
        const response = await axios.get(
            `https://${JIRA_HOST}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=20&fields=summary,status,assignee,created,updated`,
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                }
            }
        );

        const issues = response.data.issues || [];
        return issues.map(issue => {
            const updated = new Date(issue.fields.updated);
            const daysStale = Math.floor((Date.now() - updated) / (1000 * 60 * 60 * 24));
            return {
                key: issue.key,
                summary: issue.fields.summary,
                status: issue.fields.status.name,
                assignee: issue.fields.assignee?.displayName || 'Unassigned',
                assigneeId: issue.fields.assignee?.accountId || null,
                days_stale: daysStale
            };
        }).filter(t => t.days_stale >= 5); // Only return tickets stale 5+ days
    } catch (e) {
        console.error("Jira stale check error:", e.response?.status || e.message);
        return [];
    }
}

module.exports = { createJiraTask, createJiraTaskWithAssignee, getOpenJiraIssues, getStaleJiraTickets };


