require('dotenv').config();
const OpenAI = require("openai");

// Import our tools
const { getPullRequests, getIssues, getFileTree, readFileContent, createNewFile } = require('../tools/github');
const { createJiraTask } = require('../tools/jira');
const { searchWeb } = require('../tools/web');

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
        default:
            return `Unknown tool: ${name}`;
    }
}

// --- MAIN BRAIN FUNCTION ---
/**
 * Think and Act - The core agent loop.
 * @param {Array} history - Conversation history array.
 * @param {string} userMessage - The latest user message.
 * @param {string} systemPrompt - Optional system prompt override.
 * @returns {Promise<string>} - The final response text.
 */
async function thinkAndAct(history, userMessage, systemPrompt = null) {
    const defaultSystemPrompt = `
    You are Shehab, Senior PM for Lab manager (Medical LIMS).
    IDENTITY: Pragmatic, Agile, Gen Z friendly.
    RULES:
    1. Fix bugs (create_file) ONLY if explicitly asked.
    2. When analyzing images, just REPLY with the description. Do NOT create files.
    3. Search unknowns (search_web) for tech concepts only.
    4. NEVER search for internal PRs, Tickets, or Vision Errors.
    5. If a tool fails, just tell the user. Be proactive but safe.
    TOOLS: GitHub, Jira, DuckDuckGo.
    `;

    const messages = [
        { role: "system", content: systemPrompt || defaultSystemPrompt },
        ...history,
        { role: "user", content: userMessage }
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
            return responseMessage.content || "I'm not sure how to respond.";
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

        return followUp.choices[0].message.content || "Done.";

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
