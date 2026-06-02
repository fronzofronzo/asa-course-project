import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';

// Derive agent identifier from TOKEN JWT payload (name field) — no extra env var needed
function agentIdFromToken() {
    try {
        const token = process.env.TOKEN ?? '';
        const payload = token.split('.')[1] ?? '';
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return decoded.name ?? decoded.id ?? 'agent';
    } catch {
        return 'agent';
    }
}

const AGENT_ID    = agentIdFromToken();
const LOG_FILE    = path.join(LOG_DIR, `agent-${AGENT_ID}.log`);
const LLM_LOG_FILE = path.join(LOG_DIR, `llm-${AGENT_ID}.log`);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(LLM_LOG_FILE, '', 'utf8');

function log(message) {
    const entry = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
    console.log(entry);
}

function logLLM(message) {
    const entry = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LLM_LOG_FILE, entry, 'utf8');
    console.log(entry);
}

export { log, logLLM };
