// tests/debug_jira.js
require('dotenv').config();
const axios = require('axios');

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

async function debugJira() {
    console.log(`🔍 Debugging Jira Connection to: ${JIRA_HOST}`);
    console.log(`📧 Email: ${JIRA_EMAIL}`);

    const headers = {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    // 1. Test Server Info (Does the host exist?)
    try {
        console.log("\n1️⃣ Testing /rest/api/3/serverInfo...");
        const r1 = await axios.get(`https://${JIRA_HOST}/rest/api/3/serverInfo`, { headers });
        console.log("✅ Server Info:", r1.data.baseUrl);
    } catch (e) {
        console.error("❌ Server Info Failed:", e.response?.status, e.response?.statusText);
        if (e.response?.status === 410) console.log("   -> 410 Gone on serverInfo suggests the instance might be moved or deleted?");
    }

    // 2. Test User (Is Auth working?)
    try {
        console.log("\n2️⃣ Testing /rest/api/3/myself...");
        const r2 = await axios.get(`https://${JIRA_HOST}/rest/api/3/myself`, { headers });
        console.log("✅ Authenticated as:", r2.data.displayName);
    } catch (e) {
        console.error("❌ Auth Failed:", e.response?.status, e.response?.statusText);
    }

    // 3. Test Search via POST (Maybe GET is deprecated/limited?)
    try {
        console.log("\n3️⃣ Testing /rest/api/3/search (POST)...");
        const r3 = await axios.post(
            `https://${JIRA_HOST}/rest/api/3/search`,
            {
                jql: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY created DESC`,
                maxResults: 1
            },
            { headers }
        );
        console.log(`✅ Search POST success: Found ${r3.data.total} issues.`);
    } catch (e) {
        console.error("❌ Search POST Failed:", e.response?.status, e.response?.statusText, e.response?.data);
    }
}

debugJira();
