import "dotenv/config";
import OpenAI from "openai";
import { MissionConstraints } from './constraints/MissionConstraints.js';
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

// LiteLLM configuration
const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

if (!apiKey) {
    console.error("Error: missing LITELLM_API_KEY in .env file");
    process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

const deliverooUrl = process.env.HOST;
const deliverooToken = process.env.TOKEN;

if (!deliverooToken || !deliverooUrl) {
    console.error("Error: missing deliveroojs url or token in .env file");
    process.exit(1);
}

const socket = DjsConnect(deliverooUrl, deliverooToken);

const me = { id: null, name: null, x: null, y: null, score: 0 };

const world = {
    parcels: [],
    agents: [],
};

// ─── L2 Mission State ────────────────────────────────────────────────────────
const mission = new MissionConstraints();

// ─── Map State ────────────────────────────────────────────────────────────────
const mapState = {
    walkable: new Set(),      // "x,y" keys of walkable tiles
    deliveryTiles: [],        // [{x, y}] type=2
    spawnTiles: [],           // [{x, y}] type=1
    ready: false,
};

socket.onMap((_width, _height, tiles) => {
    mapState.walkable.clear();
    mapState.deliveryTiles = [];
    mapState.spawnTiles = [];
    for (const t of tiles) {
        if (t.type !== 0) mapState.walkable.add(`${t.x},${t.y}`);
        if (t.type === 2) mapState.deliveryTiles.push({ x: t.x, y: t.y });
        if (t.type === 1) mapState.spawnTiles.push({ x: t.x, y: t.y });
    }
    mapState.ready = true;
    console.log(`[MAP] ${mapState.walkable.size} walkable, ${mapState.deliveryTiles.length} delivery, ${mapState.spawnTiles.length} spawn tiles`);
});

// ─── Game Stats (for EV calculation) ─────────────────────────────────────────
const gameStats = {
    startTime: Date.now(),
    avgReward: 10,       // rolling average of visible parcel rewards
    avgCollectTime: 5,   // rolling average seconds to reach + pick up a parcel
    lastPickupTime: null,
};

function updateRolling(prev, newVal, n = 20) {
    return prev + (newVal - prev) / n;
}

function pointsPerSecond() {
    const elapsed = (Date.now() - gameStats.startTime) / 1000;
    return elapsed > 10 ? me.score / elapsed : 1;
}

function hasMission() { return mission.hasMission(); }

// ─── Socket Handlers ──────────────────────────────────────────────────────────
socket.onYou(({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
});

let busy = false;
let sensingTick = 0;
const AUTONOMOUS_EVERY = 5; // call LLM every N sensing events to avoid flooding

socket.onSensing(async ({ agents, parcels }) => {
    world.parcels = parcels ?? [];
    world.agents = (agents ?? []).filter(a => a.id !== me.id);

    // Update rolling average reward
    const free = world.parcels.filter(p => !p.carriedBy);
    if (free.length > 0) {
        const avg = free.reduce((s, p) => s + p.reward, 0) / free.length;
        gameStats.avgReward = updateRolling(gameStats.avgReward, avg);
    }

    // Autonomous game loop — only when a mission is active
    sensingTick++;
    if (!hasMission()) return;
    if (sensingTick % AUTONOMOUS_EVERY !== 0) return;
    if (busy) return;

    busy = true;
    try {
        const carried = world.parcels.filter(p => p.carriedBy === me.id);
        const stackOk = mission.stack.isReady(carried);
        const prompt = stackOk && carried.length > 0
            ? "Autonomous turn: you have parcels to deliver. Check mission constraints and deliver them."
            : "Autonomous turn: pick up the nearest eligible parcel (respecting reward cap and stack size), or explore if none visible.";
        await runAgentTurn(prompt);
    } finally {
        busy = false;
        await drainMissions(); // process any missions that arrived while busy
    }
});

// ─── Mission Queue ────────────────────────────────────────────────────────────
// Messages may arrive while busy. Queue them; drain after each turn.
const pendingMissions = [];

async function drainMissions() {
    while (pendingMissions.length > 0 && !busy) {
        const { name, msg } = pendingMissions.shift();
        busy = true;
        try {
            await runAgentTurn(
                `[MISSION RECEIVED from ${name}]: "${msg}". ` +
                `First call evaluate_mission to compute EV. If EV > 0, accept by calling the appropriate L2 setup tool(s). ` +
                `If EV <= 0 or mission gives negative reward, reject with a Final Answer explaining why.`
            );
        } finally {
            busy = false;
        }
    }
}

// Receive special missions from the game chat — follows 4reply pattern
socket.onMsg(async (_id, name, msg, reply) => {
    console.log(`\n[MISSION] Message from ${name}: ${msg}`);
    // Reply immediately with agent name (don't wait for LLM processing)
    if (reply) {
        const agentName = me.name ?? "LLM agent";
        try { reply(`${agentName} received your message, evaluating...`); } catch {}
    }
    pendingMissions.push({ name, msg });
    // Process now if not busy; otherwise drainMissions() called after current turn
    if (!busy) await drainMissions();
});

// ─── Standard Tools ──────────────────────────────────────────────────────────

function calculate(expression) {
    console.log("---- CALCULATE ----");
    try {
        return String(eval(expression));
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

function getCurrentTime(location) {
    console.log("---- GET CURRENT TIME ----");
    try {
        const normalized = location.trim().toLowerCase();
        const supportedLocations = {
            rome: { city: "Rome", timeZone: "Europe/Rome" },
            roma: { city: "Rome", timeZone: "Europe/Rome" },
        };
        const config = supportedLocations[normalized];
        if (!config) return "Error: Current time is only supported for Rome/Roma in this demo.";
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-GB", {
            timeZone: config.timeZone,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        return `The current local time in ${config.city} is ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} (${config.timeZone}).`;
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

async function getMyPosition() {
    console.log("---- GET MY POSITION ----");
    if (me.x === null || me.y === null) return "Error: agent position is not available yet.";
    return JSON.stringify({ id: me.id, name: me.name, x: me.x, y: me.y, score: me.score });
}

async function move(direction) {
    console.log("---- MOVE ----");
    const normalized = direction.trim().toLowerCase();
    if (!["up", "down", "left", "right"].includes(normalized)) {
        return `Error: invalid direction '${direction}'. Valid: up, down, left, right.`;
    }
    try {
        const result = await socket.emitMove(normalized);
        if (result) return `Successfully moved ${normalized}. New position: ${JSON.stringify(result)}.`;
        return `Error: failed to move ${normalized}.`;
    } catch (error) {
        return `Error: moving ${normalized} failed: ${error.message}`;
    }
}

async function getWorldState() {
    console.log("---- GET WORLD STATE ----");
    if (me.x === null || me.y === null) return "Error: agent position not available yet.";
    const carried = world.parcels.filter(p => p.carriedBy === me.id);
    return JSON.stringify({
        position: { x: me.x, y: me.y },
        score: me.score,
        carried_parcels: carried.map(p => ({ id: p.id, reward: p.reward })),
        nearby_agents: world.agents.map(a => ({ id: a.id, name: a.name, x: a.x, y: a.y })),
        active_mission: hasMission() ? JSON.parse(getMissionState()) : null,
    });
}

// Returns free parcels, filtered by reward cap if active
async function getParcels() {
    console.log("---- GET PARCELS ----");
    if (me.x === null || me.y === null) return "Error: agent position not available yet.";

    let free = mission.filterParcels(world.parcels.filter(p => !p.carriedBy));

    if (free.length === 0) return "No eligible free parcels visible right now.";

    const withDist = free.map(p => ({
        id: p.id, x: p.x, y: p.y, reward: p.reward,
        distance: Math.abs(p.x - me.x) + Math.abs(p.y - me.y),
    }));
    withDist.sort((a, b) => a.distance - b.distance);
    return JSON.stringify(withDist);
}

// BFS on the real map — returns sequence of directions or null if unreachable
function bfsPath(sx, sy, tx, ty) {
    const goalKey = `${tx},${ty}`;
    const startKey = `${sx},${sy}`;
    if (startKey === goalKey) return [];
    if (!mapState.walkable.has(goalKey)) return null;
    if (!mapState.walkable.has(startKey)) return null;

    const dirs = [
        { d: "up",    dx: 0,  dy: 1  },
        { d: "down",  dx: 0,  dy: -1 },
        { d: "right", dx: 1,  dy: 0  },
        { d: "left",  dx: -1, dy: 0  },
    ];

    const queue = [{ x: sx, y: sy, path: [] }];
    const visited = new Set([startKey]);

    while (queue.length) {
        const { x, y, path } = queue.shift();
        for (const { d, dx, dy } of dirs) {
            const nx = x + dx, ny = y + dy;
            const key = `${nx},${ny}`;
            if (mission.isForbidden(key)) continue;
            if (!mapState.walkable.has(key) || visited.has(key)) continue;
            const newPath = [...path, d];
            if (key === goalKey) return newPath;
            visited.add(key);
            queue.push({ x: nx, y: ny, path: newPath });
        }
    }
    return null; // unreachable
}

// Navigate to (x,y) — uses BFS on real map when available, greedy fallback otherwise
async function navigateTo(args) {
    console.log("---- NAVIGATE TO ----");
    let tx, ty;
    try {
        const parsed = JSON.parse(args);
        tx = parsed.x; ty = parsed.y;
    } catch {
        return 'Error: navigate_to expects JSON like {"x": 3, "y": 5}';
    }
    if (typeof tx !== "number" || typeof ty !== "number") return "Error: x and y must be numbers.";

    tx = Math.round(tx); ty = Math.round(ty);

    if (mission.isForbidden(`${tx},${ty}`)) {
        return `Error: target tile (${tx},${ty}) is forbidden. Choose a different destination.`;
    }

    // BFS path when map is available
    if (mapState.ready) {
        const path = bfsPath(Math.round(me.x), Math.round(me.y), tx, ty);
        if (path === null) {
            return `Error: tile (${tx},${ty}) is unreachable or not walkable. Available delivery tiles: ${JSON.stringify(mapState.deliveryTiles.slice(0,5))}`;
        }
        for (const dir of path) {
            const result = await socket.emitMove(dir);
            if (!result) {
                // Obstacle mid-path — replan from current position
                const replan = bfsPath(Math.round(me.x), Math.round(me.y), tx, ty);
                if (!replan) return `Error: path to (${tx},${ty}) blocked mid-way at (${Math.round(me.x)},${Math.round(me.y)}).`;
                for (const d2 of replan) await socket.emitMove(d2);
                return `Arrived at (${tx}, ${ty}) after replanning.`;
            }
        }
        return `Arrived at (${tx}, ${ty}).`;
    }

    // Greedy fallback (no map yet)
    const dirDelta = { up: [0,1], down: [0,-1], right: [1,0], left: [-1,0] };
    const MAX_STEPS = 100;
    let steps = 0;
    while (steps < MAX_STEPS) {
        const cx = Math.round(me.x), cy = Math.round(me.y);
        if (cx === tx && cy === ty) return `Arrived at (${tx}, ${ty}).`;
        const dx = tx - cx, dy = ty - cy;
        const candidates = [];
        if (Math.abs(dx) >= Math.abs(dy)) {
            if (dx !== 0) candidates.push(dx > 0 ? "right" : "left");
            if (dy !== 0) candidates.push(dy > 0 ? "up" : "down");
        } else {
            if (dy !== 0) candidates.push(dy > 0 ? "up" : "down");
            if (dx !== 0) candidates.push(dx > 0 ? "right" : "left");
        }
        for (const d of ["up","down","left","right"]) if (!candidates.includes(d)) candidates.push(d);
        let moved = false;
        for (const dir of candidates) {
            const [ddx, ddy] = dirDelta[dir];
            if (mission.isForbidden(`${cx+ddx},${cy+ddy}`)) continue;
            const result = await socket.emitMove(dir);
            steps++;
            if (result) { moved = true; break; }
        }
        if (!moved) return `Error: stuck at (${Math.round(me.x)},${Math.round(me.y)}).`;
    }
    return `Error: could not reach (${tx},${ty}) within ${MAX_STEPS} steps.`;
}

// Pick up parcels — respects reward cap and stack size constraint
async function pickUp() {
    console.log("---- PICK UP ----");

    const carried = world.parcels.filter(p => p.carriedBy === me.id);
    const err = mission.checkPickup(carried, { me, world });
    if (err) return err;

    try {
        const result = await socket.emitPickup();
        if (result && result.length > 0) {
            // Update collect time stats
            if (gameStats.lastPickupTime !== null) {
                const elapsed = (Date.now() - gameStats.lastPickupTime) / 1000;
                gameStats.avgCollectTime = updateRolling(gameStats.avgCollectTime, elapsed);
            }
            gameStats.lastPickupTime = Date.now();
            return `Picked up ${result.length} parcel(s): ${JSON.stringify(result.map(p => ({ id: p.id, reward: p.reward })))}.`;
        }
        return "No parcels to pick up at current position.";
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

// Put down parcels — respects blacklist and stack size constraint
async function putDown() {
    console.log("---- PUT DOWN ----");

    const cx = Math.round(me.x), cy = Math.round(me.y);
    const tileKey = `${cx},${cy}`;
    const carried = world.parcels.filter(p => p.carriedBy === me.id);
    const err = mission.checkPutdown(tileKey, carried, { me, world });
    if (err) return err;

    try {
        const result = await socket.emitPutdown();
        if (result && result.length > 0) {
            return `Delivered ${result.length} parcel(s): ${JSON.stringify(result.map(p => ({ id: p.id, reward: p.reward })))}.`;
        }
        return "No parcels to put down, or not on a delivery tile.";
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

// Returns real delivery tiles from the map — use this before navigate_to for delivery
function getDeliveryTiles() {
    console.log("---- GET DELIVERY TILES ----");
    if (!mapState.ready) return "Map not received yet. Wait a moment and retry.";
    if (mapState.deliveryTiles.length === 0) return "No delivery tiles found on this map.";

    const agentPos = { x: Math.round(me.x), y: Math.round(me.y) };
    const withDist = mapState.deliveryTiles.map(t => mission.decorateDeliveryTile({
        x: t.x, y: t.y,
        distance: Math.abs(t.x - agentPos.x) + Math.abs(t.y - agentPos.y),
    }));
    withDist.sort((a, b) => a.distance - b.distance);
    return JSON.stringify(withDist);
}

// ─── L2 Mission Tools ─────────────────────────────────────────────────────────

function setStackRequirement(input) {
    console.log("---- SET STACK REQUIREMENT ----");
    const n = parseInt(input);
    if (isNaN(n) || n < 1) return "Error: input must be a positive integer (e.g. 3).";
    mission.stack.set(n);
    return `Stack requirement set: will only deliver when carrying >= ${n} parcels.`;
}

function setPreferredDeliveryTiles(input) {
    console.log("---- SET PREFERRED DELIVERY TILES ----");
    try {
        const parsed = JSON.parse(input);
        const { tiles, multiplier } = parsed;
        if (!Array.isArray(tiles) || tiles.length === 0) {
            return 'Error: tiles must be a non-empty array, e.g. {"tiles":[{"x":1,"y":2}],"multiplier":5}';
        }
        mission.preferred.set(tiles, multiplier ?? 1);
        return `Preferred delivery tiles set: ${JSON.stringify(mission.preferred.tiles)} (multiplier: ${mission.preferred.multiplier}x). Navigate to one of these tiles to deliver.`;
    } catch {
        return 'Error: expected JSON like {"tiles":[{"x":1,"y":2}],"multiplier":5}';
    }
}

function blacklistDeliveryTile(input) {
    console.log("---- BLACKLIST DELIVERY TILE ----");
    try {
        const { x, y } = JSON.parse(input);
        mission.blacklist.add(x, y);
        return `Tile (${Math.round(x)},${Math.round(y)}) blacklisted. put_down will refuse to deliver there.`;
    } catch {
        return 'Error: expected JSON like {"x":1,"y":2}';
    }
}

function setRewardCap(input) {
    console.log("---- SET REWARD CAP ----");
    const cap = parseFloat(input);
    if (isNaN(cap) || cap <= 0) return "Error: input must be a positive number.";
    mission.rewardCap.set(cap);
    return `Reward cap set to ${cap}. pick_up and get_parcels will skip parcels with reward > ${cap}.`;
}

function addForbiddenTile(input) {
    console.log("---- ADD FORBIDDEN TILE ----");
    try {
        const { x, y } = JSON.parse(input);
        mission.forbidden.add(x, y);
        return `Tile (${Math.round(x)},${Math.round(y)}) added to forbidden tiles. navigate_to will route around it.`;
    } catch {
        return 'Error: expected JSON like {"x":4,"y":7}';
    }
}

function getMissionState() {
    console.log("---- GET MISSION STATE ----");
    return JSON.stringify({ ...mission.toJSON(), hasMission: mission.hasMission() });
}

function resetMission() {
    console.log("---- RESET MISSION ----");
    mission.reset();
    return "All mission constraints cleared. Back to standard behavior.";
}

// Compute expected value of a mission before accepting it
function evaluateMission(input) {
    console.log("---- EVALUATE MISSION ----");
    try {
        const params = JSON.parse(input);
        const decay = parseFloat(process.env.DECAY_RATE ?? "0.1");
        const stats = {
            avgReward: gameStats.avgReward,
            avgCollectTime: gameStats.avgCollectTime,
            decay,
            pps: pointsPerSecond(),
        };

        const result = mission.computeEV(params, stats);
        if (!result) {
            return `Error: unknown type '${params.type}'. Valid: stack, preferred_tile, blacklist, reward_cap, forbidden_tile`;
        }

        const { ev, guadagnoMissione, guadagnoStandard } = result;
        const evRounded = isFinite(ev) ? parseFloat(ev.toFixed(2)) : -999;
        const raccomandazione = (!isFinite(ev) || ev <= 0)
            ? `RIFIUTA (EV = ${evRounded})`
            : `ACCETTA (EV = +${evRounded})`;

        return JSON.stringify({
            ev: evRounded,
            guadagno_con_missione: isFinite(guadagnoMissione) ? parseFloat(guadagnoMissione.toFixed(2)) : 0,
            guadagno_standard: parseFloat(guadagnoStandard.toFixed(2)),
            punti_al_secondo_attuale: parseFloat(stats.pps.toFixed(3)),
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
    move,
    get_world_state: getWorldState,
    get_parcels: getParcels,
    navigate_to: navigateTo,
    pick_up: pickUp,
    put_down: putDown,
    get_delivery_tiles: getDeliveryTiles,
    // L2 mission tools
    evaluate_mission: evaluateMission,
    set_stack_requirement: setStackRequirement,
    set_preferred_delivery_tiles: setPreferredDeliveryTiles,
    blacklist_delivery_tile: blacklistDeliveryTile,
    set_reward_cap: setRewardCap,
    add_forbidden_tile: addForbiddenTile,
    get_mission_state: getMissionState,
    reset_mission: resetMission,
};

// ─── LLM Helpers ─────────────────────────────────────────────────────────────

async function callModel(messages, { temperature = 0 } = {}) {
    const response = await client.chat.completions.create({
        model: MODEL,
        messages,
        temperature,
    });
    return response.choices?.[0]?.message?.content ?? "";
}

function extractAction(text) {
    const actionMatch = text.match(/^Action:\s*(.+)$/im);
    if (!actionMatch) return null;
    const actionInputMatch = text.match(/^Action Input:\s*(.*)$/im);
    // Action Input is optional — default to empty string for no-arg tools
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
You are an AI agent connected to a DeliverooJS environment. Your goal is to collect parcels and deliver them to earn points.

== STANDARD TOOLS ==
- calculate(expression): evaluate a math expression
- get_current_time(location): current time in Rome/Roma
- get_my_position(): your current x, y, score
- move(direction): one step — up, down, left, right
- get_world_state(): position, score, carried parcels, nearby agents, active mission
- get_parcels(): free visible parcels sorted by distance (already filtered by reward cap if active)
- navigate_to({"x": N, "y": N}): multi-step navigation to a tile using real map pathfinding (avoids forbidden tiles automatically)
- pick_up(): pick up parcels at current tile (enforces reward cap and stack size)
- put_down(): deliver parcels at current tile (enforces blacklist and stack size)
- get_delivery_tiles(): returns all real delivery tiles on the map with distance, blacklist status, and preferred status — ALWAYS call this before navigating to deliver, especially when a preferred_tile mission is active

== L2 MISSION TOOLS ==
Use these when you receive a special mission via [MISSION RECEIVED].

- evaluate_mission({"type": "...", ...}): compute EV before accepting. ALWAYS call this first.
  Types and required params:
    {"type":"stack", "n":3, "multiplier":2}
    {"type":"preferred_tile", "multiplier":5, "extra_steps":4}
    {"type":"blacklist"}
    {"type":"reward_cap", "cap":10}
    {"type":"forbidden_tile", "extra_steps":3, "penalty":50, "prob_enter":0.2}

- set_stack_requirement(N): hold until carrying N parcels, then deliver (for stack missions)
- set_preferred_delivery_tiles({"tiles":[{"x":1,"y":2}], "multiplier":5}): only deliver at these tiles
- blacklist_delivery_tile({"x":1,"y":2}): never deliver at this tile
- set_reward_cap(10): skip parcels with reward above this value
- add_forbidden_tile({"x":4,"y":7}): route around this tile in navigation
- get_mission_state(): show all active constraints
- reset_mission(): clear all constraints

== MOVEMENT RULES ==
- move(up) = y+1, move(down) = y-1, move(right) = x+1, move(left) = x-1
- navigate_to handles multi-step paths — prefer it over repeated move calls
- pick_up requires being on the same tile as the parcel
- put_down scores points only on delivery tiles (type=2)

== GAME RULES ==
- Parcel rewards decay over time — act quickly
- Parcels on the same tile can all be picked up in one pick_up call

== MISSION HANDLING RULES ==
- When you receive [MISSION RECEIVED]: call evaluate_mission FIRST
- If EV > 0: accept — call the appropriate setup tool(s), then give Final Answer "Mission accepted"
- If EV <= 0 or negative reward: reject — give Final Answer "Mission rejected, EV = X"
- A blacklist mission always has EV = -infinity — always reject
- After accepting a stack mission: put_down will automatically refuse until stack is full
- After accepting a preferred_tile mission: ALWAYS call get_delivery_tiles immediately after set_preferred_delivery_tiles. If ALL returned tiles have "preferred": false, the mission coordinates do not exist on this map — call reset_mission then give Final Answer "Mission rejected: preferred tiles (X,Y) do not exist on this map". Only keep the mission if at least one tile has "preferred": true
- reset_mission() cancels all active constraints and returns to standard play

== AUTONOMOUS TURN (when you get "Autonomous turn: ...") ==
- Call get_world_state to see current state and active mission
- If carrying parcels and stack OK: navigate to delivery tile and put_down
- If stack not full yet: get_parcels, navigate to nearest, pick_up
- If no parcels visible: explore by moving toward center or unexplored area

== OUTPUT FORMAT — choose exactly one ==

FORMAT 1 — use a tool:
Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input, or omit this line entirely for tools with no arguments>

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
        console.log(`--- Agent iteration ${i + 1} ---`);

        const assistantMessage = await callModel(turnMessages, { temperature: 0 });
        console.log(`Assistant output:\n${assistantMessage}\n`);

        turnMessages.push({ role: "assistant", content: assistantMessage });

        const actionCount = countActions(assistantMessage);
        const mixedOutput = hasBothActionAndFinalAnswer(assistantMessage);

        if (actionCount > 1) {
            console.log(`[Warning: ${actionCount} actions in one message — executing only the first.]\n`);
        }
        if (mixedOutput) {
            console.log("[Warning: Action and Final Answer in same message — executing Action first.]\n");
        }

        const parsedAction = extractAction(assistantMessage);

        if (parsedAction) {
            const { action, actionInput } = parsedAction;
            let observation;

            if (TOOLS[action]) {
                console.log(`[System executing tool: ${action}("${actionInput}")]`);
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
            console.log(`Assistant: ${finalAnswer}\n`);
            messages.push({ role: "user", content: userInput });
            messages.push({ role: "assistant", content: finalAnswer });
            return;
        }

        const observation = "Error: invalid format. Output either one Action or one Final Answer.";
        console.log(`[Observation: ${observation}]\n`);
        turnMessages.push({ role: "user", content: `Observation: ${observation}` });
    }

    const fallback = "Could not complete the request within the maximum number of iterations.";
    console.log(`Assistant: ${fallback}\n`);
    messages.push({ role: "user", content: userInput });
    messages.push({ role: "assistant", content: fallback });
}

// ─── Terminal Interface ───────────────────────────────────────────────────────
const rl = readline.createInterface({ input, output });

console.log("LLM Agent started — DeliverooJS + L2 Mission Support");
console.log("Commands: /memory  /reset  /mission  /exit");
console.log();

while (true) {
    const userInput = await rl.question("You: ");
    const command = userInput.trim().toLowerCase();

    if (command === "/exit" || command === "exit") break;

    if (command === "/memory") {
        console.dir(messages, { depth: null });
        console.log();
        continue;
    }

    if (command === "/reset") {
        messages.splice(1);
        console.log("Conversation memory reset.\n");
        continue;
    }

    if (command === "/mission") {
        console.log(getMissionState());
        console.log();
        continue;
    }

    if (userInput.trim() === "") continue;

    busy = true;
    try {
        await runAgentTurn(userInput);
    } finally {
        busy = false;
        await drainMissions(); // process any missions that arrived while user turn ran
    }

    console.log(`Memory: ${messages.length} messages.\n`);
}

rl.close();
console.log("\nChat ended.");
