// Temporary script to fetch Jira user account IDs (GDPR compliant)
require('dotenv').config();
const axios = require('axios');

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

async function searchUsers(query) {
    try {
        const response = await axios.get(
            `https://${JIRA_HOST}/rest/api/3/user/search?query=${encodeURIComponent(query)}`,
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                }
            }
        );
        return response.data;
    } catch (e) {
        console.log(`Error: ${e.response?.data?.errorMessages || e.message}`);
        return [];
    }
}

async function getAssignableUsers() {
    try {
        const response = await axios.get(
            `https://${JIRA_HOST}/rest/api/3/user/assignable/search?project=${PROJECT_KEY}`,
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                }
            }
        );
        return response.data;
    } catch (e) {
        console.log(`Error: ${e.response?.data?.errorMessages || e.message}`);
        return [];
    }
}

async function main() {
    console.log("🔍 Fetching Jira users...\n");

    // Search for each team member
    const names = ['ziad', 'mohab', 'kareem'];

    for (const name of names) {
        console.log(`\n👤 Searching for "${name}":`);
        const users = await searchUsers(name);
        if (users.length > 0) {
            users.forEach(user => {
                console.log(`   ✅ ${user.displayName}`);
                console.log(`      Account ID: ${user.accountId}`);
            });
        } else {
            console.log(`   No users found`);
        }
    }

    console.log("\n\n📋 All assignable users for project " + PROJECT_KEY + ":");
    const assignable = await getAssignableUsers();
    if (assignable.length > 0) {
        assignable.forEach(user => {
            console.log(`   ${user.displayName} -> ${user.accountId}`);
        });
    } else {
        console.log("   No assignable users found");
    }
}

main();
