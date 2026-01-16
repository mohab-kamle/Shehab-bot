require('dotenv').config();
const gh = require('../src/tools/github');

async function test() {
    console.log("Testing getIssues...");
    const issues = await gh.getIssues();
    console.log("Issues:", issues.substring(0, 100)); // Print start of issues

    console.log("Testing getFileTree...");
    const tree = await gh.getFileTree();
    console.log("Tree length:", tree.length);
}

test().catch(console.error);
