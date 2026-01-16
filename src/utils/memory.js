const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'memory.json');

/**
 * Read the memory file.
 * @returns {Object}
 */
function readMemory() {
    try {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

/**
 * Write to the memory file.
 * @param {Object} data 
 */
function writeMemory(data) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get a value from memory.
 * @param {string} key 
 * @returns {any}
 */
function get(key) {
    const mem = readMemory();
    return mem[key];
}

/**
 * Set a value in memory.
 * @param {string} key 
 * @param {any} value 
 */
function set(key, value) {
    const mem = readMemory();
    mem[key] = value;
    writeMemory(mem);
}

/**
 * Get cached user name or return null.
 * @param {string} userId 
 * @returns {string|null}
 */
function getCachedUserName(userId) {
    const mem = readMemory();
    if (!mem.users) return null;
    return mem.users[userId] || null;
}

/**
 * Cache a user name.
 * @param {string} userId 
 * @param {string} name 
 */
function cacheUserName(userId, name) {
    const mem = readMemory();
    if (!mem.users) mem.users = {};
    mem.users[userId] = name;
    writeMemory(mem);
}

module.exports = {
    readMemory,
    writeMemory,
    get,
    set,
    getCachedUserName,
    cacheUserName
};
