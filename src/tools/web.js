const { search } = require('duck-duck-scrape');

/**
 * Search the web using DuckDuckGo.
 * @param {string} query - The search query.
 * @returns {Promise<string>} - Formatted search results (top 3) or error message.
 */
async function searchWeb(query) {
    try {
        console.log(`🌍 Searching: ${query}`);
        const results = await search(query, { safeSearch: 0 });

        if (!results.results || results.results.length === 0) {
            return "No results found.";
        }

        return results.results
            .slice(0, 3)
            .map(r => `Title: ${r.title}\nDescription: ${r.description}\nLink: ${r.url}`)
            .join("\n\n");
    } catch (error) {
        return `Search Error: ${error.message}`;
    }
}

module.exports = { searchWeb };
