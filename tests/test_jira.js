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

(async () => {
  console.log(`Connecting to: ${process.env.JIRA_HOST}...`);
  try {
    const issue = await jira.addNewIssue({
      fields: {
        project: { key: process.env.JIRA_PROJECT_KEY },
        summary: "TEST TICKET - IGNORE ME",
        issuetype: { name: 'Task' } 
      }
    });
    console.log(`✅ SUCCESS! Created ${issue.key}`);
  } catch (error) {
    console.error(`❌ FAILED: ${error.message}`);
    if(error.statusCode === 401) console.log("-> Check your Email/Token.");
    if(error.statusCode === 404) console.log("-> Check your JIRA_HOST (no https!) or Project Key.");
  }
})();