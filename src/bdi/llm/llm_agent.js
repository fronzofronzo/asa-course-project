import "dotenv/config";
import fs from 'fs';
import path from 'path';
import OpenAI from "openai";
import { missionState, hasMission, getMissionSnapshot, resetMissionState } from './mission-state.js';

// ─── LLM File Logger ──────────────────────────────────────────────────────────

const LLM_LOG_FILE = path.resolve('./logs/llm.log');

function llmLog(level, message) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}\n`;
    try {
        fs.appendFileSync(LLM_LOG_FILE, entry, 'utf8');
    } catch {
        // logs dir may not exist yet — create and retry
        fs.mkdirSync(path.dirname(LLM_LOG_FILE), { recursive: true });
        fs.appendFileSync(LLM_LOG_FILE, entry, 'utf8');
    }
    console.log(`[LLM] [${level}] ${message}`);
}

// LiteLLM configuration
const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unittn.it/v1";
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

const client = apiKey
    ? new OpenAI({ baseURL, apiKey })
    : null;

// Injected by initLLMModule — provide current agent/world state to tools
let _getMe = () => ({ id: null, name: null, x: null, y: null, score: 0 });
let _getWorld = () => ({ parcels: [], agents: [] });
let _getMap = () => ({ deliveryTiles: [], spawnTiles: [], walkable: new Set(), width: null });

// Rolling stats for EV calculation in evaluate_mission
const gameStats = {
    startTime: Date.now(),
    avgReward: 10,
    avgCollectTime: 5,
};

function updateRolling(prev, newVal, n = 20) {
    return prev + (newVal - prev) / n;
}

function pointsPerSecond() {
    const elapsed = (Date.now() - gameStats.startTime) / 1000;
    return elapsed > 10 ? _getMe().score / elapsed : 1;
}

// ─── Standard Tools ──────────────────────────────────────────────────────────

function calculate(expression) {
    try {
        return String(eval(expression));
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

function getCurrentTime(location) {
    try {
        const normalized = location.trim().toLowerCase();
        const supported = {
            rome: { city: "Rome", timeZone: "Europe/Rome" },
            roma: { city: "Rome", timeZone: "Europe/Rome" },
        };
        const config = supported[normalized];
        if (!config) return "Error: only Rome/Roma supported.";
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-GB", {
            timeZone: config.timeZone,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        return `Current time in ${config.city}: ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} (${config.timeZone}).`;
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

function getMyPosition() {
    const me = _getMe();
    if (me.x === null) return "Error: agent position not available yet.";
    return JSON.stringify({ id: me.id, name: me.name, x: me.x, y: me.y, score: me.score });
}

function getWorldState() {
    const me = _getMe();
    if (me.x === null) return "Error: agent position not available yet.";
    const world = _getWorld();
    const carried = world.parcels.filter(p => p.carriedBy === me.id);
    return JSON.stringify({
        position: { x: me.x, y: me.y },
        score: me.score,
        carried_parcels: carried.map(p => ({ id: p.id, reward: p.reward })),
        nearby_agents: world.agents.map(a => ({ id: a.id, name: a.name, x: a.x, y: a.y })),
        active_mission: hasMission() ? getMissionSnapshot() : null,
    });
}

function getParcels() {
    const me = _getMe();
    if (me.x === null) return "Error: agent position not available yet.";
    const world = _getWorld();
    let free = world.parcels.filter(p => !p.carriedBy);
    if (missionState.rewardCap !== null) {
        free = free.filter(p => p.reward <= missionState.rewardCap);
    }
    if (free.length === 0) return "No eligible free parcels visible right now.";
    const withDist = free.map(p => ({
        id: p.id, x: p.x, y: p.y, reward: p.reward,
        distance: Math.abs(p.x - me.x) + Math.abs(p.y - me.y),
    }));
    withDist.sort((a, b) => a.distance - b.distance);
    return JSON.stringify(withDist);
}

function getDeliveryTiles() {
    const map = _getMap();
    if (!map || map.width === null) return "Map not received yet. Wait a moment and retry.";
    if (map.deliveryTiles.length === 0) return "No delivery tiles found on this map.";
    const me = _getMe();
    const agentPos = { x: Math.round(me.x ?? 0), y: Math.round(me.y ?? 0) };
    const withDist = map.deliveryTiles.map(t => ({
        x: t.x, y: t.y,
        distance: Math.abs(t.x - agentPos.x) + Math.abs(t.y - agentPos.y),
        blacklisted: missionState.blacklistedDeliveryTiles.has(`${t.x},${t.y}`),
        preferred: missionState.preferredDeliveryTiles?.some(p => p.x === t.x && p.y === t.y) ?? false,
    }));
    withDist.sort((a, b) => a.distance - b.distance);
    return JSON.stringify(withDist);
}

// ─── Mission Write Tool ───────────────────────────────────────────────────────

function commitMission(input) {
    try {
        const update = JSON.parse(input);
        const { type } = update;

        if (type === 'stack') {
            const n = parseInt(update.stackSize ?? update.n);
            if (isNaN(n) || n < 1) return 'Error: stackSize must be a positive integer.';
            missionState.stackSize = n;
            missionState.stackExact = update.stackExact ?? false;
            const mode = missionState.stackExact ? `exactly ${n}` : `>= ${n}`;
            return `Beliefs updated: deliver ${mode} parcels.`;

        } else if (type === 'visit') {
            const map = _getMap();
            if (map.width === null) return 'Error: map not loaded yet — retry in a moment.';
            const tiles = (update.visitTargets ?? []).map(t => ({ x: Math.round(t.x), y: Math.round(t.y) }));
            const walkable = tiles.filter(t => map.walkable.has(`${t.x},${t.y}`));
            if (walkable.length === 0) return `Error: none of ${JSON.stringify(tiles)} are walkable on this map.`;
            missionState.visitTargets = walkable;
            missionState.visitBonus = update.visitBonus ?? 1000;
            missionState.visitConsumed = false;
            return `Beliefs updated: visit targets ${JSON.stringify(walkable)} (bonus=${missionState.visitBonus}).`;

        } else if (type === 'preferred_delivery') {
            const map = _getMap();
            if (map.width === null) return 'Error: map not loaded yet — retry in a moment.';
            const deliveryKeys = new Set(map.deliveryTiles.map(t => `${t.x},${t.y}`));
            const tiles = (update.tiles ?? []).map(t => ({ x: Math.round(t.x), y: Math.round(t.y) }));
            const valid = tiles.filter(t => deliveryKeys.has(`${t.x},${t.y}`));
            if (valid.length === 0) return `Error: none of ${JSON.stringify(tiles)} are delivery tiles. Available: ${JSON.stringify(map.deliveryTiles)}`;
            missionState.preferredDeliveryTiles = valid;
            missionState.preferredDeliveryMultiplier = update.multiplier ?? 1;
            return `Beliefs updated: preferred delivery tiles ${JSON.stringify(valid)} (multiplier: ${missionState.preferredDeliveryMultiplier}x).`;

        } else if (type === 'blacklist_tile') {
            const key = `${Math.round(update.x)},${Math.round(update.y)}`;
            missionState.blacklistedDeliveryTiles.add(key);
            return `Beliefs updated: delivery tile (${update.x},${update.y}) blacklisted.`;

        } else if (type === 'reward_cap') {
            const cap = parseFloat(update.cap);
            if (isNaN(cap) || cap <= 0) return 'Error: cap must be a positive number.';
            missionState.rewardCap = cap;
            return `Beliefs updated: reward cap set to ${cap}.`;

        } else if (type === 'forbidden_tile') {
            const key = `${Math.round(update.x)},${Math.round(update.y)}`;
            missionState.forbiddenTiles.add(key);
            return `Beliefs updated: tile (${update.x},${update.y}) forbidden for routing.`;

        } else {
            return `Error: unknown type '${type}'. Valid: stack, visit, preferred_delivery, blacklist_tile, reward_cap, forbidden_tile`;
        }
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

function getMissionStateStr() {
    return JSON.stringify(getMissionSnapshot());
}

function resetMission() {
    resetMissionState();
    return "All mission constraints cleared. BDI back to standard behavior.";
}

function evaluateMission(input) {
    try {
        const params = JSON.parse(input);
        const { type } = params;
        const decay = parseFloat(process.env.DECAY_RATE ?? "0.1");
        const avgReward = gameStats.avgReward;
        const avgCollect = gameStats.avgCollectTime;
        const pps = pointsPerSecond();

        let ev, guadagnoMissione, guadagnoStandard, raccomandazione;

        if (type === "stack") {
            const n = params.n ?? 3;
            const m = params.multiplier ?? 1;
            const tempoTotale = n * avgCollect;
            const decayMedio = Math.min(0.99, decay * (n / 2) * avgCollect);
            guadagnoMissione = n * avgReward * m * (1 - decayMedio);
            guadagnoStandard = pps * tempoTotale;
            ev = guadagnoMissione - guadagnoStandard;

        } else if (type === "preferred_tile") {
            const m = params.multiplier ?? 1;
            const extraSteps = params.extra_steps ?? 5;
            const avgCarried = avgReward;
            guadagnoMissione = avgCarried * m;
            guadagnoStandard = avgCarried + decay * avgCarried * extraSteps;
            ev = guadagnoMissione - guadagnoStandard;

        } else if (type === "blacklist") {
            ev = -Infinity;
            guadagnoMissione = 0;
            guadagnoStandard = avgReward;

        } else if (type === "reward_cap") {
            const cap = params.cap ?? 10;
            const fracAboveCap = Math.max(0, 1 - cap / (avgReward * 2));
            guadagnoMissione = avgReward * (1 - fracAboveCap);
            guadagnoStandard = avgReward;
            ev = guadagnoMissione - guadagnoStandard;

        } else if (type === "forbidden_tile") {
            const extraSteps = params.extra_steps ?? 3;
            const penaltyAvoided = params.penalty ?? 50;
            const probEnter = params.prob_enter ?? 0.2;
            const costoDetour = decay * avgReward * extraSteps;
            guadagnoMissione = penaltyAvoided * probEnter;
            guadagnoStandard = costoDetour;
            ev = guadagnoMissione - guadagnoStandard;

        } else if (type === "visit_tile") {
            // One-time visit bonus: EV = bonus - opportunity_cost_of_travel
            const bonus = params.bonus ?? 1000;
            const tiles = params.tiles ?? [];
            const me = _getMe();
            let minDist = params.distance ?? 20;
            if (tiles.length > 0 && me.x !== null) {
                minDist = Math.min(...tiles.map(t => Math.abs(t.x - me.x) + Math.abs(t.y - me.y)));
            }
            guadagnoMissione = bonus;
            guadagnoStandard = pps * minDist;
            ev = guadagnoMissione - guadagnoStandard;

        } else if (type === "flat_bonus") {
            // Flat additive bonus per delivery: EV = bonus - opportunity_cost_of_constraint
            // For stack_exact(N): cost = waiting extra time (avg (N-1) collect cycles) vs delivering immediately
            const pts = params.pts ?? 500;
            const n = params.n ?? 3;
            const extraWait = (n - 1) * avgCollect;
            guadagnoMissione = pts;
            guadagnoStandard = pps * extraWait;
            ev = guadagnoMissione - guadagnoStandard;

        } else {
            return `Error: unknown type '${type}'. Valid: stack, preferred_tile, blacklist, reward_cap, forbidden_tile, visit_tile, flat_bonus`;
        }

        const evRounded = isFinite(ev) ? parseFloat(ev.toFixed(2)) : -999;
        raccomandazione = (!isFinite(ev) || ev <= 0)
            ? `RIFIUTA (EV = ${evRounded})`
            : `ACCETTA (EV = +${evRounded})`;

        return JSON.stringify({
            ev: evRounded,
            guadagno_con_missione: isFinite(guadagnoMissione) ? parseFloat(guadagnoMissione.toFixed(2)) : 0,
            guadagno_standard: parseFloat(guadagnoStandard.toFixed(2)),
            punti_al_secondo_attuale: parseFloat(pps.toFixed(3)),
            raccomandazione,
        });
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

const TOOLS = {
    evaluate_mission: evaluateMission,
    commit_mission: commitMission,
    get_my_position: getMyPosition,
    get_world_state: getWorldState,
    get_mission_state: getMissionStateStr,
    reset_mission: resetMission,
    calculate,
};

// ─── LLM Helpers ─────────────────────────────────────────────────────────────

async function callModel(messages, { temperature = 0 } = {}) {
    if (!client) throw new Error("LLM client not initialized — missing LITELLM_API_KEY");
    const response = await client.chat.completions.create({ model: MODEL, messages, temperature });
    return response.choices?.[0]?.message?.content ?? "";
}

function extractAction(text) {
    const actionMatch = text.match(/^Action:\s*(.+)$/im);
    if (!actionMatch) return null;
    const actionInputMatch = text.match(/^Action Input:\s*(.*)$/im);
    return {
        action: actionMatch[1].trim(),
        actionInput: actionInputMatch ? actionInputMatch[1].trim() : "",
    };
}

function extractFinalAnswer(text) {
    const match = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return match ? match[1].trim() : null;
}

function hasBothActionAndFinalAnswer(text) {
    return /^Action:\s*.+$/im.test(text) && /^Final Answer:\s*[\s\S]*$/im.test(text);
}

function countActions(text) {
    const matches = text.match(/^Action:\s*.+$/gim);
    return matches ? matches.length : 0;
}

// ─── Agent Prompt ─────────────────────────────────────────────────────────────

const AGENT_PROMPT = `
You are the belief-revision module of a DeliverooJS BDI agent.
Role: evaluate incoming missions and write accepted missions to agent beliefs.
You do NOT control movement. The BDI deliberation loop reads beliefs and acts autonomously.

== FLOW (2–3 steps maximum) ==
Step 1: call evaluate_mission to compute EV
Step 2a: EV > 0  → call commit_mission → Final Answer "Mission accepted: <brief description>"
Step 2b: EV <= 0 → Final Answer "Mission rejected: EV = <X> — <reason>"
If commit_mission returns Error: → Final Answer "Mission rejected: <error>"

== READ TOOLS ==
- evaluate_mission({"type":"...", ...}): compute expected value. ALWAYS call first.
  Types:
    {"type":"stack",          "n":3,   "multiplier":1}        — benefit of delivering >= N parcels
    {"type":"flat_bonus",     "pts":500, "n":3}               — flat bonus for delivering exactly N
    {"type":"visit_tile",     "bonus":1000, "tiles":[...]}    — one-time tile visit bonus
    {"type":"preferred_tile", "multiplier":5, "extra_steps":4}
    {"type":"blacklist"}
    {"type":"reward_cap",     "cap":10}
    {"type":"forbidden_tile", "extra_steps":3, "penalty":50, "prob_enter":0.2}

- get_my_position(): agent current position and score
- get_world_state(): carried parcels, nearby agents, active mission snapshot

== WRITE TOOL ==
- commit_mission({"type":"...", ...}): atomically write mission to agent beliefs. Call ONCE after EV > 0.
  Types:
    {"type":"stack",              "stackSize":3, "stackExact":false}
    {"type":"stack",              "stackSize":3, "stackExact":true}   ← for "exactly N"
    {"type":"visit",              "visitTargets":[{"x":11,"y":12},{"x":12,"y":12}], "visitBonus":1000}
    {"type":"preferred_delivery", "tiles":[{"x":2,"y":18}], "multiplier":5}
    {"type":"blacklist_tile",     "x":2, "y":18}
    {"type":"reward_cap",         "cap":10}
    {"type":"forbidden_tile",     "x":4, "y":7}
  Returns "Beliefs updated: ..." on success, "Error: ..." on failure (then reject mission).

- reset_mission(): clear all active mission constraints
- get_mission_state(): inspect current belief state
- calculate(expression): math helper

== MISSION TYPE SELECTION ==
"deliver exactly N parcels"   → evaluate: flat_bonus {pts, n}       → commit: stack {stackSize:N, stackExact:true}
"deliver N or more parcels"   → evaluate: stack {n, multiplier}     → commit: stack {stackSize:N, stackExact:false}
"go to / visit coordinates"   → evaluate: visit_tile {bonus, tiles} → commit: visit {visitTargets, visitBonus}
"deliver at tile X,Y"         → evaluate: preferred_tile            → commit: preferred_delivery {tiles, multiplier}
"avoid / blacklist tile"       → evaluate: blacklist                 → commit: blacklist_tile {x, y}
"skip parcels above reward X" → evaluate: reward_cap                → commit: reward_cap {cap}
"route around tile"           → evaluate: forbidden_tile            → commit: forbidden_tile {x, y}

== OUTPUT FORMAT — choose exactly one ==

FORMAT 1 — use a tool:
Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input>

FORMAT 2 — final answer:
Thought: I have all the information needed.
Final Answer: <answer>

Rules: one action per message, never Action and Final Answer together, never invent tool results.
`.trim();

// ─── Conversation Memory ──────────────────────────────────────────────────────

const messages = [{ role: "system", content: AGENT_PROMPT }];

// ─── Agent Loop ───────────────────────────────────────────────────────────────

async function runAgentTurn(userInput, maxIterations = 12) {
    llmLog('TURN_START', `input="${userInput.substring(0, 200)}"`);
    const turnMessages = [
        { role: "system", content: AGENT_PROMPT },
        ...messages.slice(1),
        { role: "user", content: userInput },
    ];

    for (let i = 0; i < maxIterations; i++) {
        llmLog('ITER', `iteration=${i + 1}/${maxIterations}`);

        const assistantMessage = await callModel(turnMessages, { temperature: 0 });
        llmLog('OUTPUT', `\n${assistantMessage}`);

        turnMessages.push({ role: "assistant", content: assistantMessage });

        if (countActions(assistantMessage) > 1) {
            llmLog('WARN', 'Multiple actions in one message — executing only first');
        }
        if (hasBothActionAndFinalAnswer(assistantMessage)) {
            llmLog('WARN', 'Action and Final Answer together — executing Action first');
        }

        const parsedAction = extractAction(assistantMessage);

        if (parsedAction) {
            const { action, actionInput } = parsedAction;
            let observation;

            if (TOOLS[action]) {
                llmLog('TOOL', `${action}(${actionInput})`);
                observation = await TOOLS[action](actionInput);
            } else {
                observation = `Error: unknown tool '${action}'. Available: ${Object.keys(TOOLS).join(", ")}`;
            }

            llmLog('OBS', observation);
            turnMessages.push({
                role: "user",
                content:
                    `Observation: ${observation}\n\n` +
                    `Continue solving the original request. ` +
                    `If information is still missing, choose the next Action. ` +
                    `If all information has been observed, give the Final Answer. ` +
                    `Output only one Action or one Final Answer.`,
            });
            continue;
        }

        const finalAnswer = extractFinalAnswer(assistantMessage);

        if (finalAnswer) {
            llmLog('ANSWER', finalAnswer);
            messages.push({ role: "user", content: userInput });
            messages.push({ role: "assistant", content: finalAnswer });
            return finalAnswer;
        }

        const observation = "Error: invalid format. Output either one Action or one Final Answer.";
        llmLog('WARN', `Invalid format at iteration ${i + 1} — injecting correction`);
        turnMessages.push({ role: "user", content: `Observation: ${observation}` });
    }

    const fallback = "Could not complete within maximum iterations.";
    llmLog('WARN', `Max iterations (${maxIterations}) reached for input: "${userInput.substring(0, 120)}"`);
    messages.push({ role: "user", content: userInput });
    messages.push({ role: "assistant", content: fallback });
    return fallback;
}

// ─── Mission Queue ────────────────────────────────────────────────────────────

const pendingMissions = [];
let busy = false;

async function drainMissions() {
    while (pendingMissions.length > 0 && !busy) {
        const { name, msg } = pendingMissions.shift();
        busy = true;
        try {
            await runAgentTurn(
                `[MISSION RECEIVED from ${name}]: "${msg}". ` +
                `Call evaluate_mission first to compute EV. If EV > 0, accept by calling the appropriate setup tool(s). ` +
                `If EV <= 0 or mission gives negative reward, reject with Final Answer explaining why.`
            );
        } finally {
            busy = false;
        }
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Wire the LLM module into the BDI agent.
 * @param {object} socket   — the agent's DjsConnect socket
 * @param {() => {id,name,x,y,score}} getMe   — live agent state
 * @param {() => {parcels,agents}} getWorld   — live world state (arrays)
 * @param {() => {deliveryTiles,spawnTiles,walkable,width}} getMap — live map state
 */
export function initLLMModule(socket, getMe, getWorld, getMap) {
    if (!client) {
        llmLog('WARN', 'No LITELLM_API_KEY — module loaded but LLM calls will fail');
    }

    _getMe = getMe;
    _getWorld = getWorld;
    _getMap = getMap;

    // Update rolling reward average on each sensing event
    socket.onSensing(({ parcels }) => {
        const free = (parcels ?? []).filter(p => !p.carriedBy);
        if (free.length > 0) {
            const avg = free.reduce((s, p) => s + p.reward, 0) / free.length;
            gameStats.avgReward = updateRolling(gameStats.avgReward, avg);
        }
    });

    // Process mission messages from admin only (ADMIN_ID env var; if unset, accept all)
    socket.onMsg(async (id, name, msg, reply) => {
        const adminId = process.env.ADMIN_ID;
        if (adminId && id !== adminId) {
            llmLog('INFO', `Ignoring message from ${name} (id=${id}) — not admin`);
            return;
        }
        llmLog('MISSION', `from=${name} id=${id} msg="${msg}"`);
        if (reply) {
            const agentName = _getMe().name ?? 'BDI+LLM agent';
            try { reply(`${agentName} received your message, evaluating...`); } catch {}
        }
        pendingMissions.push({ name, msg });
        if (!busy) await drainMissions();
    });

    llmLog('INFO', 'LLM module initialized — listening for mission messages');
}
