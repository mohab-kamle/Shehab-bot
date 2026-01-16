// Team configuration - hardcoded team members with their IDs
const TEAM = {
    ziad: {
        name: 'Ziad Mohamed',
        role: 'Frontend Developer',
        skills: ['react', 'frontend', 'ui', 'css', 'javascript', 'components'],
        slackId: 'U09JU0R35C2',
        jiraAccountId: '712020:f8754adc-d79f-4072-93d9-bfac615f00d9'
    },
    mohab: {
        name: 'Mohab Kamle',
        role: 'Full Stack / DevOps',
        skills: ['fullstack', 'devops', 'docker', 'deploy', 'api', 'infrastructure', 'backend', 'frontend'],
        slackId: 'U09JQFXPY0M',
        jiraAccountId: '712020:b1554cdf-fc51-4e4a-9b8a-cc20ca3cde5f'
    },
    kareem: {
        name: 'Kareem Mamdouh',
        role: 'Backend Developer',
        skills: ['backend', 'database', 'api', 'server', 'nodejs', 'express', 'sql'],
        slackId: 'U09JRSYTGCW',
        jiraAccountId: '712020:eeb1ced4-ddd5-4fe1-a954-af0e28aca947'
    }
};

// Project configuration
const PROJECT = {
    name: 'Lab Manager System',
    goal: 'Launch the Medical LIMS system by end of Q2 2026',
    methodology: 'Agile/Scrum'
};

/**
 * Get team member by key
 */
function getMember(key) {
    return TEAM[key.toLowerCase()] || null;
}

/**
 * Get all team members
 */
function getAllMembers() {
    return Object.values(TEAM);
}

/**
 * Find best assignee based on keywords in text
 */
function findBestAssignee(text) {
    const lowerText = text.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const [key, member] of Object.entries(TEAM)) {
        let score = 0;
        for (const skill of member.skills) {
            if (lowerText.includes(skill)) {
                score++;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestMatch = member;
        }
    }

    return bestMatch;
}

module.exports = { TEAM, PROJECT, getMember, getAllMembers, findBestAssignee };
