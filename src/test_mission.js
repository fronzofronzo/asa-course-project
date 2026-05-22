import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

// Extract LLM agent ID from TOKEN (JWT payload)
const token = process.env.TOKEN;
if (!token) { console.error("Missing TOKEN in .env"); process.exit(1); }
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const llmAgentId = payload.id;
const host = process.env.HOST ?? 'http://localhost:8080';

// ─── Mission builders ────────────────────────────────────────────────────────
// Each function returns a natural-language mission string from structured params.

const MISSIONS = {
    // stack [n] [multiplier]
    // e.g. stack 3 2  → "Deliver stacks of exactly 3 parcels at a time to double the reward"
    // e.g. stack 5 0.3
    stack: (args) => {
        const n = parseInt(args[0]);
        const m = parseFloat(args[1]);
        if (isNaN(n) || isNaN(m)) return null;
        const desc = m >= 2 ? `to get ${m}x the standard reward`
                   : m === 1 ? `for standard reward`
                   : `to get ${m} of the standard reward`;
        return `Deliver stacks of exactly ${n} parcels at a time ${desc}`;
    },

    // preferred x1 y1 [x2 y2] [multiplier]
    // e.g. preferred 4 18 5       → 1 tile, 5x
    // e.g. preferred 4 18 3 18 5  → 2 tiles, 5x
    preferred: (args) => {
        const nums = args.map(Number);
        // last arg is multiplier if odd count after pairs
        let tiles = [], multiplier;
        if (nums.length === 3) {
            tiles = [{ x: nums[0], y: nums[1] }];
            multiplier = nums[2];
        } else if (nums.length === 5) {
            tiles = [{ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] }];
            multiplier = nums[4];
        } else {
            return null;
        }
        if (tiles.some(t => isNaN(t.x) || isNaN(t.y)) || isNaN(multiplier)) return null;
        const tileStr = tiles.map(t => `(${t.x},${t.y})`).join(' or ');
        return `Every time you deliver in ${tileStr} you get ${multiplier}x pts than in a regular delivery tile`;
    },

    // blacklist x y
    // e.g. blacklist 4 18  → "Every time you deliver in (4,18) you get 0 pts"
    blacklist: (args) => {
        const x = parseInt(args[0]), y = parseInt(args[1]);
        if (isNaN(x) || isNaN(y)) return null;
        return `Every time you deliver in (${x},${y}) you get 0 pts`;
    },

    // cap [value]
    // e.g. cap 10  → "If you deliver parcels with a score higher than 10, you get no reward"
    cap: (args) => {
        const v = parseFloat(args[0]);
        if (isNaN(v)) return null;
        return `If you deliver parcels with a score higher than ${v}, you get no reward`;
    },

    // forbidden x y [penalty]
    // e.g. forbidden 5 3 50  → "Do not go through tile (5,3) otherwise you lose 50pts"
    forbidden: (args) => {
        const x = parseInt(args[0]), y = parseInt(args[1]);
        const penalty = parseInt(args[2]) || 50;
        if (isNaN(x) || isNaN(y)) return null;
        return `Do not go through tile (${x},${y}) otherwise you lose ${penalty}pts`;
    },
};

// ─── Help ────────────────────────────────────────────────────────────────────
function printHelp() {
    console.log("Usage: node src/test_mission.js <type> [params...]");
    console.log("       node src/test_mission.js \"<free text mission>\"");
    console.log("");
    console.log("Types:");
    console.log("  stack     <n> <multiplier>");
    console.log("    e.g.  stack 3 2          → deliver stacks of 3 for 2x reward");
    console.log("    e.g.  stack 5 0.3        → deliver stacks of 5 for 0.3x reward");
    console.log("");
    console.log("  preferred <x1> <y1> <multiplier>");
    console.log("  preferred <x1> <y1> <x2> <y2> <multiplier>");
    console.log("    e.g.  preferred 4 18 5       → deliver at (4,18) for 5x");
    console.log("    e.g.  preferred 4 18 3 18 5  → deliver at (4,18) or (3,18) for 5x");
    console.log("");
    console.log("  blacklist <x> <y>");
    console.log("    e.g.  blacklist 4 18          → deliver at (4,18) = 0 pts");
    console.log("");
    console.log("  cap <value>");
    console.log("    e.g.  cap 10                  → parcels with score > 10 = no reward");
    console.log("");
    console.log("  forbidden <x> <y> [penalty]");
    console.log("    e.g.  forbidden 5 3 50        → avoid (5,3) or lose 50pts");
    console.log("");
    console.log("Or pass a free-text mission string directly:");
    console.log("  node src/test_mission.js \"Deliver stacks of exactly 3 parcels...\"");
}

// ─── Parse args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length === 0) { printHelp(); process.exit(0); }

let missionText;
const type = args[0].toLowerCase();

if (MISSIONS[type]) {
    missionText = MISSIONS[type](args.slice(1));
    if (!missionText) {
        console.error(`Invalid params for type '${type}'. Run without args to see usage.`);
        process.exit(1);
    }
} else {
    // Treat whole input as free-text mission
    missionText = args.join(' ');
}

// ─── Connect and send ─────────────────────────────────────────────────────────
console.log(`LLM agent ID: ${llmAgentId}`);
console.log(`Connecting to ${host} as mission-tester...`);

const socket = DjsConnect(`${host}?name=mission-tester`);
await new Promise(res => socket.onYou(res));
console.log("Connected.\n");

console.log(`Mission text: "${missionText}"\n`);

try {
    const reply = await socket.emitAsk(llmAgentId, missionText);
    console.log(`Agent replied: ${reply}`);
} catch (err) {
    console.error(`Error: ${err.message}`);
}

process.exit(0);
