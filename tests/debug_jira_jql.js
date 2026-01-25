// tests/debug_jira_jql.js
require('dotenv').config();
const axios = require('axios');

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

async function testJqlEndpoint() {
    console.log("🔍 Testing /rest/api/3/search/jql endpoint...");

    // Try GET
    try {
        console.log("\n1️⃣ Attempting GET /rest/api/3/search/jql...");
        const jql = `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY created DESC`;
        const r1 = await axios.get(`https://${JIRA_HOST}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}`, { headers });
        console.log("✅ GET Success! Issues found:", r1.data.issues?.length || r1.data.total);
        if (r1.data.issues && r1.data.issues.length > 0) {
            console.log("👉 First Issue Structure:", JSON.stringify(r1.data.issues[0], null, 2));
        }
    } catch (e) {
        console.log("❌ GET Failed:", e.response?.status, e.response?.data); // Only log status/data so we don't spam
    }

    // Try POST
    try {
        console.log("\n2️⃣ Attempting POST /rest/api/3/search/jql...");
        const r2 = await axios.post(
            `https://${JIRA_HOST}/rest/api/3/search/jql`,
            {
                jql: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY created DESC`,
                maxResults: 1
            },
            { headers }
        );
        console.log("✅ POST Success! Issues found:", r2.data.issues?.length || r2.data.total);
    } catch (e) {
        console.log("❌ POST Failed:", e.response?.status, e.response?.data);
    }

    // Try standard POST /rest/api/3/search again just in case (sanity check)
    // Sometimes it's the specific params?
}

testJqlEndpoint();
