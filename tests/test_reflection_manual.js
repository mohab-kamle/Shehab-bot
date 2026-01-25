// tests/test_reflection_manual.js
const { reflectOnProject } = require('../src/agent/reflection');
const { getRecentCommits, getCommitDiff } = require('../src/tools/github');

async function testGitHubTools() {
    console.log("Testing GitHub Tools...");
    const commits = await getRecentCommits(2);
    console.log("Recent Commits:", commits);

    if (commits.length > 0) {
        console.log("Fetching diff for first commit...");
        const diff = await getCommitDiff(commits[0].sha);
        console.log("Diff preview:", diff.substring(0, 200));
    }
}

async function testReflection() {
    console.log("\nTesting Reflection System...");
    const result = await reflectOnProject();
    console.log("Reflection Result:", JSON.stringify(result, null, 2));
}

(async () => {
    await testGitHubTools();
    await testReflection();
})();
