/**
 * reflection.js - Shehab's "Subconscious" Thought System
 * 
 * This module allows Shehab to periodically:
 * 1. Analyze the state of the repo (Issues, PRs, Recent Code).
 * 2. "Think" about what's happening (Synthesis).
 * 3. Store these thoughts in Long-Term Memory (Experience).
 * 4. Optionally post a meaningful insight to Slack.
 */

const OpenAI = require('openai');
const memory = require('../memory/vector');
const { getPullRequests, getIssues, getRecentCommits, getCommitDiff } = require('../tools/github');
require('dotenv').config();

const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const REFLECTION_PROMPT = `
You are Shehab's internal thought process. You are analyzing the current state of your project.

GOAL: Synthesize disparate data points (commits, PRs, issues) into a COHERENT NARRATIVE about the project's health and direction.

INPUT DATA:
- Recent Commits (What actually changed)
- Open PRs (Work in progress)
- Open Issues (Bugs/Features)
- Recent Memories (Context)

INSTRUCTIONS:
1. Look for PATTERNS. (e.g., "3 commits about 'auth' + 1 issue about 'login' = We are fixing the login flow.")
2. Identify RISKS. (e.g., "Big refactor in 'core.js' but no PR reviews yet.")
3. Identify WINS. (e.g., "Finally fixed that persistent race condition.")
4. BE SPECIFIC. Quote file names and commit messages.

OUTPUT FORMAT (JSON ONLY):
{
    "internal_thought": "A concise summary of what's happening to store in memory. Focus on the 'Why' and 'How'.",
    "public_status": "A message to post to Slack for the team. Be insightful, helpful, and concise. IF NOTHING INTERESTING IS HAPPENING, SET THIS TO null. Don't spam.",
    "mood_update": "Optional mood string (e.g., 'focused', 'worried', 'celebratory') based on analysis."
}
`;

/**
 * Run the reflection cycle.
 * @returns {Object} The thought result.
 */
async function reflectOnProject() {
    console.log("🧠 Shehab is reflecting...");

    try {
        // 1. Gather Sensory Data
        const [prs, issues, commits] = await Promise.all([
            getPullRequests(),
            getIssues(),
            getRecentCommits(3) // Get last 3 commits
        ]);

        // 2. Deep Dive: Get diffs for recent commits to understand *substance*
        let deepCodeContext = "";
        if (commits.length > 0) {
            deepCodeContext = "RECENT CODE CHANGES:\n";
            for (const c of commits) {
                const diff = await getCommitDiff(c.sha);
                deepCodeContext += `\n[Commit by ${c.author}: "${c.message}"]\nDiff Summary:\n${diff.substring(0, 1000)}...\n`;
            }
        }

        // 3. Recall Context
        const recentMemories = await memory.recallMemory("Current project status and recent blocking issues");

        // 4. Construct the Prompt
        const context = `
        [OPEN PULL REQUESTS]:
        ${prs}

        [OPEN ISSUES]:
        ${issues}

        ${deepCodeContext}

        [RELEVANT MEMORIES]:
        ${recentMemories}
        `;

        // 5. Think (LLM Call)
        const completion = await groq.chat.completions.create({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [
                { role: "system", content: REFLECTION_PROMPT },
                { role: "user", content: context }
            ],
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(completion.choices[0].message.content);

        // 6. Store Thought
        if (result.internal_thought) {
            await memory.saveMemory(`Reflection: ${result.internal_thought}`);
            console.log(`🧠 Stored thought: "${result.internal_thought.substring(0, 50)}..."`);
        }

        return result;

    } catch (e) {
        console.error("❌ Reflection Error:", e.message);
        return null;
    }
}

module.exports = { reflectOnProject };
