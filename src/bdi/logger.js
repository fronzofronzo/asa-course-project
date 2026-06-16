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
function utilityLogFile() { return path.join(LOG_DIR, `utility-${agentId}.log`); }

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
    fs.writeFileSync(utilityLogFile(), '', 'utf8');

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

/**
 * Write a timestamped entry to the agent log file and stdout.
 * Uses the original console.log to avoid double-writing after the patch in setLoggerName.
 * @param {string} message
 */
function log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile(), logEntry, 'utf8');
    _origLog(logEntry);  // use original — console.log may be patched and would double-write
}

/**
 * Write a timestamped entry to the LLM log file and stdout.
 * Separate from the main agent log to keep ReAct traces isolated.
 * @param {string} message
 */
function logLLM(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(llmLogFile(), logEntry, 'utf8');
    _origLog(logEntry);
}

/**
 * Append one loop-iteration snapshot of all generated options and their utilities
 * to a dedicated utility log file (utility-<agentId>.log).
 * @param {{ x:number, y:number }} agentPos
 * @param {{ type:string, id:string, utility:number }[]} options  desires from generateOptions, sorted desc
 * @param {string|null} chosenId  id of the currently selected intention, if any
 */
function logOptions(agentPos, options, chosenId = null) {
    const timestamp = new Date().toISOString();
    const header = `[${timestamp}] iter @(${Math.round(agentPos.x)},${Math.round(agentPos.y)}) — ${options.length} option(s)`;
    const lines = options.map(o => {
        const mark = o.id === chosenId ? ' <- chosen' : '';
        return `    ${o.type.padEnd(7)} ${String(o.id).padEnd(20)} U=${Number(o.utility).toFixed(2)}${mark}`;
    });
    const entry = [header, ...lines].join('\n') + '\n';
    fs.appendFileSync(utilityLogFile(), entry, 'utf8');
}

export { log, logLLM, setLoggerName, logOptions };
