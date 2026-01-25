// tests/test_report_manual.js
const { generateSmartReport } = require('../src/scheduler/reports');
const memory = require('../src/utils/memory');

// Mock Slack App
const mockSlackApp = {
    client: {
        chat: {
            postMessage: async (msg) => {
                console.log("\n[MOCK SLACK POST]");
                console.log("Channel:", msg.channel);
                console.log("Text:\n", msg.text);
            }
        }
    }
};

// Set a dummy report channel if not set
if (!memory.get('report_channel')) {
    memory.set('report_channel', 'C12345678');
}

async function run() {
    console.log("🚀 Testing Smart Report Generation...");
    await generateSmartReport(mockSlackApp);
}

run();
