require('dotenv').config();
const OpenAI = require("openai");

// Import our tools
const { getPullRequests, getIssues, getFileTree, readFileContent, createNewFile, getPullRequestDiff } = require('../tools/github');
const { createJiraTask } = require('../tools/jira');
const { searchWeb } = require('../tools/web');

// Import Long-Term Memory
const memory = require('../memory/vector');

// --- GROQ CLIENT (using OpenAI SDK) ---
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const MODEL_ID = "meta-llama/llama-4-scout-17b-16e-instruct";

// --- TOOL DEFINITIONS ---
const TOOLS_DEF = [
    {
        type: "function",
        function: {
            name: "get_prs",
            description: "Get active Pull Requests from GitHub",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "get_issues",
            description: "Get Open Issues from GitHub (excluding PRs)",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "get_file_tree",
            description: "List files in the repo root directory",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a file's content from the GitHub repository",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Path to the file in the repo" }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_file",
            description: "Create a new file in the GitHub repository",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Path for the new file" },
                    content: { type: "string", description: "Content of the file" },
                    message: { type: "string", description: "Commit message" }
                },
                required: ["path", "content", "message"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_ticket",
            description: "Create a Jira Task ticket",
            parameters: {
                type: "object",
                properties: {
                    summary: { type: "string", description: "Summary/title of the task" }
                },
                required: ["summary"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_web",
            description: "Search the internet using DuckDuckGo",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "review_pr",
            description: "Get the code diff for a specific PR to review it for bugs, security issues, and code quality.",
            parameters: {
                type: "object",
                properties: {
                    pr_number: { type: "number", description: "The PR number to review (e.g., 35)" }
                },
                required: ["pr_number"]
            }
        }
    }
];

// --- TOOL EXECUTOR ---
async function executeTool(name, args) {
    console.log(`🧠 Brain using tool: ${name}`);

    switch (name) {
        case "get_prs":
            return await getPullRequests();
        case "get_issues":
            return await getIssues();
        case "get_file_tree":
            return await getFileTree();
        case "read_file":
            return await readFileContent(args.path);
        case "create_file":
            return await createNewFile(args.path, args.content, args.message);
        case "create_ticket":
            return await createJiraTask(args.summary);
        case "search_web":
            return await searchWeb(args.query);
        case "review_pr":
            const diff = await getPullRequestDiff(args.pr_number);
            return `[CODE DIFF FOR PR #${args.pr_number}]:\n${diff}\n\nINSTRUCTION: Analyze this code for 1. Bugs, 2. Security Risks (SQLi, XSS, etc), 3. Code Style issues. Be specific and reference file names and line changes.`;
        default:
            return `Unknown tool: ${name}`;
    }
}

// --- MAIN BRAIN FUNCTION ---
/**
 * Think and Act - The core agent loop.
 * @param {Array} history - Conversation history array.
 * @param {string} userMessage - The latest user message.
 * @param {string} systemPrompt - System prompt (required, passed from index.js).
 * @returns {Promise<string>} - The final response text.
 */
async function thinkAndAct(history, userMessage, systemPrompt) {
    // 1. RECALL: Check Long-Term Memory
    console.log("🧠 Searching memories...");
    let contextString = "";
    try {
        const pastMemories = await memory.recallMemory(userMessage);
        if (pastMemories) {
            console.log("💡 Found relevant memories!");
            contextString = `\n\n[RELEVANT PAST MEMORIES]:\n${pastMemories}\nUse these memories to answer if needed.`;
        }
    } catch (e) {
        console.log("Memory recall skipped:", e.message);
    }

    const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage + contextString }
    ];

    try {
        // First LLM call with tools enabled
        const completion = await groq.chat.completions.create({
            model: MODEL_ID,
            messages: messages,
            tools: TOOLS_DEF,
            tool_choice: "auto"
        });

        const responseMessage = completion.choices[0].message;
        const toolCalls = responseMessage.tool_calls;

        // If no tool calls, return the text directly
        if (!toolCalls || toolCalls.length === 0) {
            const reply = responseMessage.content || "I'm not sure how to respond.";
            // Save this interaction to memory
            memory.saveMemory(`User: ${userMessage}\nShehab: ${reply}`).catch(() => { });
            return reply;
        }

        // Execute each tool call and collect results
        const toolResults = [];
        for (const toolCall of toolCalls) {
            const fnName = toolCall.function.name;
            let args = {};
            try {
                args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                args = {};
            }

            const result = await executeTool(fnName, args);
            toolResults.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: fnName,
                content: result
            });
        }

        // Build new messages with tool results
        const followUpMessages = [
            ...messages,
            { role: "assistant", tool_calls: toolCalls },
            ...toolResults
        ];

        // Second LLM call to get final answer
        const followUp = await groq.chat.completions.create({
            model: MODEL_ID,
            messages: followUpMessages
        });

        const finalReply = followUp.choices[0].message.content || "Done.";

        // SAVE: Store the interaction in Long-Term Memory (runs in background)
        memory.saveMemory(`User: ${userMessage}\nShehab: ${finalReply}`).catch(() => { });

        return finalReply;

    } catch (error) {
        console.error("🧠 Brain Error:", error);
        return `Brain Error: ${error.message}`;
    }
}

module.exports = {
    thinkAndAct,
    TOOLS_DEF,
    executeTool
};
