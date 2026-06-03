import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';

let agentId = 'agent';
let initialized = false;

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function logFile()    { return path.join(LOG_DIR, `agent-${agentId}.log`); }
function llmLogFile() { return path.join(LOG_DIR, `llm-${agentId}.log`); }

/**
 * Call once when the agent name becomes known (onYou callback).
 * Truncates the log files for this session.
 */
function setLoggerName(name) {
    if (initialized) return;
    agentId = name;
    initialized = true;
    ensureLogDir();
    fs.writeFileSync(logFile(),    '', 'utf8');
    fs.writeFileSync(llmLogFile(), '', 'utf8');
}

ensureLogDir();

function log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile(), logEntry, 'utf8');
    console.log(logEntry);
}

function logLLM(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(llmLogFile(), logEntry, 'utf8');
    console.log(logEntry);
}

export { log, logLLM, setLoggerName };
