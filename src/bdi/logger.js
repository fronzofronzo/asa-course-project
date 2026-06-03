import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';

let agentId = 'agent';
let initialized = false;

// Keep original console methods before any patching
const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function logFile()    { return path.join(LOG_DIR, `agent-${agentId}.log`); }
function llmLogFile() { return path.join(LOG_DIR, `llm-${agentId}.log`); }

function serialize(args) {
    return args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ');
}

/**
 * Call once when the agent name becomes known (onYou callback).
 * Truncates log files and redirects console output to the agent log file.
 */
function setLoggerName(name) {
    if (initialized) return;
    agentId = name;
    initialized = true;
    ensureLogDir();
    fs.writeFileSync(logFile(),    '', 'utf8');
    fs.writeFileSync(llmLogFile(), '', 'utf8');

    // Tee console.log → stdout + agent log file
    console.log = (...args) => {
        _origLog(...args);
        fs.appendFileSync(logFile(), serialize(args) + '\n', 'utf8');
    };

    // Tee console.warn → stdout + agent log file
    console.warn = (...args) => {
        _origWarn(...args);
        fs.appendFileSync(logFile(), '[WARN] ' + serialize(args) + '\n', 'utf8');
    };
}

ensureLogDir();

function log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile(), logEntry, 'utf8');
    _origLog(logEntry);  // use original — console.log may be patched and would double-write
}

function logLLM(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(llmLogFile(), logEntry, 'utf8');
    _origLog(logEntry);
}

export { log, logLLM, setLoggerName };
