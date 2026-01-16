require('dotenv').config();
const { Octokit } = require("octokit");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;

/**
 * List open Pull Requests.
 */
async function getPullRequests() {
    try {
        const { data } = await octokit.rest.pulls.list({ owner: OWNER, repo: REPO, state: 'open' });
        if (!data.length) return "No open PRs.";

        return data.map(pr => {
            const date = new Date(pr.created_at).toISOString().split('T')[0]; // YYYY-MM-DD
            return `- [PR #${pr.number}] ${pr.title} (Author: ${pr.user.login})\n  Created: ${date}\n  Summary: ${pr.body ? pr.body.substring(0, 100).replace(/[\r\n]+/g, ' ') : "No description"}...`;
        }).join("\n\n");
    } catch (e) { return `GitHub Error: ${e.message}`; }
}

/**
 * List open Issues (excluding PRs).
 */
async function getIssues() {
    try {
        const { data } = await octokit.rest.issues.listForRepo({
            owner: OWNER,
            repo: REPO,
            state: 'open'
        });
        const realIssues = data.filter(issue => !issue.pull_request);
        if (realIssues.length === 0) return "No open Issues.";
        return realIssues.map(i => `- [Issue #${i.number}] ${i.title}`).join("\n");
    } catch (e) {
        return `Could not fetch issues: ${e.message}`;
    }
}

/**
 * List files in the root directory.
 */
async function getFileTree() {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: OWNER,
            repo: REPO,
            path: ''
        });
        return data.map(f => ` - ${f.type}: ${f.name}`).join("\n");
    } catch (e) {
        return `Could not read file tree: ${e.message}`;
    }
}

/**
 * Read file content, truncated to 3000 chars.
 * @param {string} path 
 */
async function readFileContent(path) {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: OWNER,
            repo: REPO,
            path: path
        });

        if (Array.isArray(data)) {
            return "Error: Path points to a directory, not a file.";
        }

        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return content.substring(0, 3000) + (content.length > 3000 ? "... (truncated)" : "");
    } catch (e) {
        return `Could not read file: ${path}. Error: ${e.message}`;
    }
}

/**
 * Create a new file in the default branch.
 * @param {string} path 
 * @param {string} content 
 * @param {string} message 
 */
async function createNewFile(path, content, message) {
    try {
        // Encode content to Base64
        const contentEncoded = Buffer.from(content).toString('base64');

        await octokit.rest.repos.createOrUpdateFileContents({
            owner: OWNER,
            repo: REPO,
            path: path,
            message: message,
            content: contentEncoded
        });

        return `✅ File created successfully: ${path}`;
    } catch (e) {
        return `Failed to create file: ${path}. Error: ${e.message}`;
    }
}

/**
 * Get the code diff for a specific PR (for code review).
 * @param {number} prNumber
 */
async function getPullRequestDiff(prNumber) {
    try {
        const { data } = await octokit.rest.pulls.get({
            owner: OWNER,
            repo: REPO,
            pull_number: prNumber,
            mediaType: {
                format: "diff" // Ask GitHub for the raw code changes
            }
        });

        // If the diff is huge, truncate it to avoid crashing the Brain
        if (data.length > 15000) {
            return `[WARNING] Diff is too large (${data.length} chars). Here are the first 15,000 chars:\n\n${data.substring(0, 15000)}...`;
        }
        return data;
    } catch (e) {
        return `GitHub Diff Error: ${e.message}`;
    }
}

module.exports = {
    getPullRequests,
    getIssues,
    getFileTree,
    readFileContent,
    createNewFile,
    getPullRequestDiff
};
