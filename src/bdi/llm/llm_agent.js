import "dotenv/config";
import OpenAI from "openai";
import { missionState, hasMission, getMissionSnapshot, resetMissionState } from './mission-state.js';

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

// ─── L2 Mission Tools ─────────────────────────────────────────────────────────

function setStackRequirement(input) {
    const n = parseInt(input);
    if (isNaN(n) || n < 1) return "Error: input must be a positive integer (e.g. 3).";
    missionState.stackSize = n;
    return `Stack requirement set: BDI will deliver only when carrying >= ${n} parcels.`;
}

function setPreferredDeliveryTiles(input) {
    try {
        const { tiles, multiplier } = JSON.parse(input);
        if (!Array.isArray(tiles) || tiles.length === 0) {
            return 'Error: tiles must be a non-empty array, e.g. {"tiles":[{"x":1,"y":2}],"multiplier":5}';
        }
        missionState.preferredDeliveryTiles = tiles.map(t => ({ x: Math.round(t.x), y: Math.round(t.y) }));
        missionState.preferredDeliveryMultiplier = multiplier ?? 1;
        return `Preferred delivery tiles set: ${JSON.stringify(missionState.preferredDeliveryTiles)} (multiplier: ${missionState.preferredDeliveryMultiplier}x). BDI will only deliver at these tiles.`;
    } catch {
        return 'Error: expected JSON like {"tiles":[{"x":1,"y":2}],"multiplier":5}';
    }
}

function blacklistDeliveryTile(input) {
    try {
        const { x, y } = JSON.parse(input);
        const key = `${Math.round(x)},${Math.round(y)}`;
        missionState.blacklistedDeliveryTiles.add(key);
        return `Tile (${Math.round(x)},${Math.round(y)}) blacklisted. BDI will not deliver there.`;
    } catch {
        return 'Error: expected JSON like {"x":1,"y":2}';
    }
}

function setRewardCap(input) {
    const cap = parseFloat(input);
    if (isNaN(cap) || cap <= 0) return "Error: input must be a positive number.";
    missionState.rewardCap = cap;
    return `Reward cap set to ${cap}. BDI will skip parcels with reward > ${cap}.`;
}

function addForbiddenTile(input) {
    try {
        const { x, y } = JSON.parse(input);
        const key = `${Math.round(x)},${Math.round(y)}`;
        missionState.forbiddenTiles.add(key);
        return `Tile (${Math.round(x)},${Math.round(y)}) added to forbidden tiles. BDI will route around it.`;
    } catch {
        return 'Error: expected JSON like {"x":4,"y":7}';
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

        } else {
            return `Error: unknown type '${type}'. Valid: stack, preferred_tile, blacklist, reward_cap, forbidden_tile`;
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
    calculate,
    get_current_time: getCurrentTime,
    get_my_position: getMyPosition,
    get_world_state: getWorldState,
    get_parcels: getParcels,
    get_delivery_tiles: getDeliveryTiles,
    evaluate_mission: evaluateMission,
    set_stack_requirement: setStackRequirement,
    set_preferred_delivery_tiles: setPreferredDeliveryTiles,
    blacklist_delivery_tile: blacklistDeliveryTile,
    set_reward_cap: setRewardCap,
    add_forbidden_tile: addForbiddenTile,
    get_mission_state: getMissionStateStr,
    reset_mission: resetMission,
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
You are the mission-evaluation module of a DeliverooJS BDI agent.
Your ONLY role: receive mission messages, evaluate their expected value (EV), and configure constraints.
You do NOT move the agent. The BDI loop handles all movement and execution automatically.

== INFORMATION TOOLS ==
- calculate(expression): evaluate math expressions
- get_current_time(location): current time in Rome
- get_my_position(): current position and score
- get_world_state(): position, carried parcels, nearby agents, active mission
- get_parcels(): visible free parcels filtered by reward cap if active
- get_delivery_tiles(): all delivery tiles with distance, blacklist status, preferred status

== MISSION TOOLS ==
- evaluate_mission({"type": "...", ...}): compute EV before accepting. ALWAYS call this first.
  Types and required params:
    {"type":"stack", "n":3, "multiplier":2}
    {"type":"preferred_tile", "multiplier":5, "extra_steps":4}
    {"type":"blacklist"}
    {"type":"reward_cap", "cap":10}
    {"type":"forbidden_tile", "extra_steps":3, "penalty":50, "prob_enter":0.2}

- set_stack_requirement(N): BDI delivers only when carrying >= N parcels
- set_preferred_delivery_tiles({"tiles":[{"x":1,"y":2}], "multiplier":5}): BDI only delivers at these tiles
- blacklist_delivery_tile({"x":1,"y":2}): BDI never delivers at this tile
- set_reward_cap(cap): BDI skips parcels with reward above this value
- add_forbidden_tile({"x":4,"y":7}): BDI routes around this tile in navigation
- get_mission_state(): show all active constraints
- reset_mission(): clear all constraints

== MISSION HANDLING RULES ==
When [MISSION RECEIVED from X]: "message text"
1. Call evaluate_mission FIRST with appropriate type and params
2. If EV > 0: accept — call the appropriate setup tool(s), then Final Answer "Mission accepted"
3. If EV <= 0 or blacklist: reject — Final Answer "Mission rejected, EV = X"
4. A blacklist mission always has EV = -Infinity — always reject
5. After set_preferred_delivery_tiles: call get_delivery_tiles to verify tiles exist on map.
   If none have "preferred": true — call reset_mission, Final Answer "Mission rejected: preferred tiles not on map"

== OUTPUT FORMAT — choose exactly one ==

FORMAT 1 — use a tool:
Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input, or omit this line for no-arg tools>

FORMAT 2 — final answer:
Thought: I have enough information to answer.
Final Answer: <answer>

Rules:
- Output exactly one action at a time.
- Never output two actions in the same message.
- Never output Action and Final Answer together.
- Never write Action: None.
- Do not invent tool results.
- Only give Final Answer when all required tool calls have been observed.
`.trim();

// ─── Conversation Memory ──────────────────────────────────────────────────────

const messages = [{ role: "system", content: AGENT_PROMPT }];

// ─── Agent Loop ───────────────────────────────────────────────────────────────

async function runAgentTurn(userInput, maxIterations = 12) {
    const turnMessages = [
        { role: "system", content: AGENT_PROMPT },
        ...messages.slice(1),
        { role: "user", content: userInput },
    ];

    for (let i = 0; i < maxIterations; i++) {
        console.log(`--- LLM iteration ${i + 1} ---`);

        const assistantMessage = await callModel(turnMessages, { temperature: 0 });
        console.log(`[LLM output]:\n${assistantMessage}\n`);

        turnMessages.push({ role: "assistant", content: assistantMessage });

        if (countActions(assistantMessage) > 1) {
            console.log(`[Warning: multiple actions in one message — executing only first]`);
        }
        if (hasBothActionAndFinalAnswer(assistantMessage)) {
            console.log("[Warning: Action and Final Answer together — executing Action first]");
        }

        const parsedAction = extractAction(assistantMessage);

        if (parsedAction) {
            const { action, actionInput } = parsedAction;
            let observation;

            if (TOOLS[action]) {
                console.log(`[LLM tool: ${action}("${actionInput}")]`);
                observation = await TOOLS[action](actionInput);
            } else {
                observation = `Error: unknown tool '${action}'. Available: ${Object.keys(TOOLS).join(", ")}`;
            }

            console.log(`[Observation: ${observation}]\n`);
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
            console.log(`[LLM Final Answer]: ${finalAnswer}\n`);
            messages.push({ role: "user", content: userInput });
            messages.push({ role: "assistant", content: finalAnswer });
            return finalAnswer;
        }

        const observation = "Error: invalid format. Output either one Action or one Final Answer.";
        turnMessages.push({ role: "user", content: `Observation: ${observation}` });
    }

    const fallback = "Could not complete within maximum iterations.";
    console.log(`[LLM]: ${fallback}\n`);
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
        console.warn('[LLM Module] No LITELLM_API_KEY — module loaded but LLM calls will fail');
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
            console.log(`[LLM Module] Ignoring message from ${name} (not admin)`);
            return;
        }
        console.log(`\n[MISSION] Message from ${name}: ${msg}`);
        if (reply) {
            const agentName = _getMe().name ?? 'BDI+LLM agent';
            try { reply(`${agentName} received your message, evaluating...`); } catch {}
        }
        pendingMissions.push({ name, msg });
        if (!busy) await drainMissions();
    });

    console.log('[LLM Module] Initialized and listening for mission messages');
}
