import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, 'agent.log');
const LLM_LOG_FILE = path.join(LOG_DIR, 'llm.log');

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

ensureLogDir();
fs.writeFileSync(LLM_LOG_FILE, '', 'utf8');

function log(message) {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
    console.log(logEntry);
}

function logLLM(message) {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LLM_LOG_FILE, logEntry, 'utf8');
    console.log(logEntry);
}

export { log, logLLM };
