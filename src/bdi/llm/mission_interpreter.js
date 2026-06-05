import 'dotenv/config'
import OpenAI from 'openai'
import { logLLM } from '../logger.js'

const baseURL = process.env.LITELLM_BASE_URL ?? 'https://llm.bears.disi.unitn.it/v1'
const apiKey  = process.env.LITELLM_API_KEY
const MODEL   = process.env.LOCAL_MODEL ?? 'llama-3.3-70b-lmstudio'
const DECAY   = parseFloat(process.env.DECAY_RATE) || 0.1

let client = null
if (!apiKey) {
    logLLM('[MissionInterpreter] WARNING: LITELLM_API_KEY not set — LLM features disabled')
} else {
    client = new OpenAI({ baseURL, apiKey })
}

// ─── ReAct helpers ───────────────────────────────────────────────────────────

async function callModel(messages, { temperature = 0 } = {}) {
    const response = await client.chat.completions.create({ model: MODEL, messages, temperature })
    return response.choices?.[0]?.message?.content ?? ''
}

function extractAction(text) {
    const actionMatch = text.match(/^Action:\s*(.+)$/im)
    if (!actionMatch) return null
    const actionInputMatch = text.match(/^Action Input:\s*(.*)$/im)
    return {
        action: actionMatch[1].trim(),
        actionInput: actionInputMatch ? actionInputMatch[1].trim() : '',
    }
}

function extractFinalAnswer(text) {
    const match = text.match(/^Final Answer:\s*([\s\S]*)$/im)
    return match ? match[1].trim() : null
}

// ─── Standard tools ───────────────────────────────────────────────────────────

function calculate(expression) {
    try {
        // LLM often wraps the input in quotes ("4*2") or adds spaces/unit suffixes — strip them
        // so eval sees a bare arithmetic expression, not a string literal.
        let expr = String(expression).trim().replace(/^["'`]+|["'`]+$/g, '').trim()
        expr = expr.replace(/(pts?|points?)\s*$/i, '').trim() // drop trailing "pt"/"pts"/"points"
        if (!/^[\d\s+\-*/().]+$/.test(expr)) {
            return `Error: not a pure arithmetic expression: "${expr}". Use only numbers and + - * / ( ).`
        }
        const result = eval(expr)
        if (typeof result !== 'number' || !isFinite(result)) {
            return `Error: expression did not evaluate to a finite number: "${expr}"`
        }
        return String(result)
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function getAgentState(beliefs, getState) {
    try {
        const { x, y, score } = getState()
        if (x === null) return 'Error: agent position not available yet'
        return JSON.stringify({
            x, y, score,
            mapInfo: {
                deliveryTilesCount: beliefs.map.deliveryTiles.length,
                spawnTilesCount: beliefs.map.spawnTiles.length,
            },
        })
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function setTileUtility(input, beliefs) {
    try {
        const { x, y, utility } = JSON.parse(input)
        if (typeof x !== 'number' || typeof y !== 'number' || typeof utility !== 'number') {
            return 'Error: x, y, and utility must be numbers. Expected JSON: {"x": N, "y": N, "utility": N}'
        }
        if (utility <= 0) {
            return 'Error: utility must be a positive number — do not call this for negative-reward missions'
        }
        const key = `${Math.round(x)},${Math.round(y)}`
        beliefs.tileUtilities.set(key, utility)
        return `Tile utility set: (${Math.round(x)},${Math.round(y)}) = ${utility}`
    } catch (e) {
        return `Error: invalid JSON input. Expected: {"x": N, "y": N, "utility": N}. Got: ${input}`
    }
}

function replyToSender(message, replyFn) {
    if (!replyFn) return 'Error: no reply channel available'
    try {
        replyFn(message)
        return `Replied: ${message}`
    } catch (e) {
        return `Error: reply failed: ${e.message}`
    }
}

// ─── L2 Mission tools ─────────────────────────────────────────────────────────

function setStackRequirement(input, beliefs) {
    try {
        const { min, max } = JSON.parse(input)
        if (min !== null && min !== undefined && (!Number.isInteger(min) || min < 1)) {
            return 'Error: min must be a positive integer or null'
        }
        if (max !== null && max !== undefined && (!Number.isInteger(max) || max < 1)) {
            return 'Error: max must be a positive integer or null'
        }
        beliefs.missionConstraints.stack.setMinMax(min ?? null, max ?? null)
        return `Stack constraint set: min=${min ?? 'none'} max=${max ?? 'none'}`
    } catch (e) {
        return `Error: invalid JSON. Expected: {"min": N or null, "max": N or null}. Got: ${input}`
    }
}

function setPreferredDeliveryTiles(input, beliefs) {
    try {
        const { tiles, multiplier } = JSON.parse(input)
        if (!Array.isArray(tiles) || tiles.length === 0) {
            return 'Error: tiles must be a non-empty array of {x, y} objects'
        }
        for (const t of tiles) {
            if (typeof t.x !== 'number' || typeof t.y !== 'number') {
                return 'Error: each tile must have numeric x and y'
            }
        }
        beliefs.missionConstraints.preferred.set(tiles, multiplier ?? 1)
        const tileStr = beliefs.missionConstraints.preferred.tiles.map(t => `(${t.x},${t.y})`).join(', ')
        return `Preferred delivery tiles set: ${tileStr} with multiplier ${multiplier ?? 1}`
    } catch (e) {
        return `Error: invalid JSON. Expected: {"tiles": [{x,y},...], "multiplier": N}. Got: ${input}`
    }
}

function blacklistDeliveryTile(input, beliefs) {
    try {
        const { x, y } = JSON.parse(input)
        if (typeof x !== 'number' || typeof y !== 'number') {
            return 'Error: x and y must be numbers'
        }
        beliefs.missionConstraints.blacklist.add(x, y)
        return `Delivery tile (${Math.round(x)},${Math.round(y)}) blacklisted`
    } catch (e) {
        return `Error: invalid JSON. Expected: {"x": N, "y": N}. Got: ${input}`
    }
}

function setRewardCap(input, beliefs) {
    try {
        const cap = parseFloat(input)
        if (isNaN(cap) || cap <= 0) return 'Error: cap must be a positive number'
        beliefs.missionConstraints.rewardCap.set(cap)
        return `Reward cap set: skip parcels with reward > ${cap}`
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function addForbiddenTile(input, beliefs) {
    try {
        const { x, y } = JSON.parse(input)
        if (typeof x !== 'number' || typeof y !== 'number') {
            return 'Error: x and y must be numbers'
        }
        beliefs.missionConstraints.forbidden.add(x, y)
        return `Tile (${Math.round(x)},${Math.round(y)}) added to forbidden set — pathfinding will avoid it`
    } catch (e) {
        return `Error: invalid JSON. Expected: {"x": N, "y": N}. Got: ${input}`
    }
}

function setMovementFreeze(input, beliefs, coordinationCtx) {
    const val = input.trim().toLowerCase().replace(/^["']+|["']+$/g, '')
    if (!['true', 'false'].includes(val)) return 'Error: input must be "true" (red light / stop) or "false" (green light / go)'
    beliefs.missionConstraints.redLight.set(val === 'true')
    // On green light: relay to slave and clear coordination state
    if (val === 'false' && coordinationCtx?.sendToPeer) {
        if (beliefs.missionConstraints.coordination.isActive()) {
            coordinationCtx.sendToPeer({ type: 'coord_cmd', mission: 'release_coordination' })
        }
        beliefs.missionConstraints.coordination.reset()
    }
    return val === 'true'
        ? 'Red light active: movement frozen. Agent will not move until green light.'
        : 'Green light: movement resumed. Coordination released. Relayed to peer if applicable.'
}

function getMissionState(beliefs) {
    const c = beliefs.missionConstraints
    return JSON.stringify({ ...c.toJSON(), hasMission: c.hasMission() })
}

function resetMission(beliefs) {
    beliefs.missionConstraints.reset()
    return 'Mission reset — all constraints cleared, returning to standard play'
}

// ─── L3 Coordination tools (master only) ─────────────────────────────────────

function getPeerInfo(beliefs, getState, coordinationCtx) {
    try {
        const { x, y } = getState()
        const peerId = coordinationCtx?.getPeerAgentId?.() ?? null
        const peerName = process.env.PEER_AGENT_NAME ?? null
        let peer = null
        // Prefer the agent matching PEER_AGENT_NAME or PEER_AGENT_ID over any random NPC
        for (const [, a] of beliefs.agents) {
            if ((peerName && a.name === peerName) || (peerId && a.id === peerId)) {
                peer = a; break
            }
        }
        // Fallback: first sensed agent
        if (!peer) for (const [, a] of beliefs.agents) { peer = a; break }
        return JSON.stringify({
            peerId: peer?.id ?? peerId ?? 'unknown (not in sensing range)',
            peerName: peer?.name ?? 'unknown',
            peerPosition: peer ? { x: peer.x, y: peer.y } : null,
            myPosition: { x, y },
            hint: 'If peerId is unknown, set PEER_AGENT_ID in .env or wait for peer to come into sensing range',
        })
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function setRendezvous(input, beliefs, coordinationCtx) {
    try {
        const { x, y, maxDist = 3 } = JSON.parse(input)
        if (typeof x !== 'number' || typeof y !== 'number') return 'Error: x and y must be numbers'
        if (!coordinationCtx?.sendToPeer) return 'Error: not configured as master (sendToPeer unavailable)'
        beliefs.missionConstraints.coordination.setRendezvous(x, y, maxDist)
        beliefs.tileUtilities.set(`${Math.round(x)},${Math.round(y)}`, 1000)
        coordinationCtx.notifyBeliefChanged?.()
        coordinationCtx.sendToPeer({ type: 'coord_cmd', mission: 'meet_and_wait', params: { x, y, maxDist } })
        return `Rendezvous set at (${x},${y}) maxDist=${maxDist}. Command sent to peer. Navigating there now.`
    } catch (e) {
        return `Error: invalid JSON. Expected: {"x":N,"y":N,"maxDist":3}. Got: ${input}`
    }
}

function initiateHandoff(_input, beliefs, coordinationCtx) {
    if (!coordinationCtx?.sendToPeer) return 'Error: not configured as master (sendToPeer unavailable)'
    beliefs.missionConstraints.coordination.setHandoff('passer')
    coordinationCtx.sendToPeer({ type: 'coord_cmd', mission: 'parcel_handoff', params: { role: 'receiver' } })
    return 'Handoff initiated. I am passer, peer is receiver. I will pick up a parcel, then freeze in place until peer arrives in sensing range, then drop for peer to deliver.'
}

function setOddRowFreeze(beliefs, _getState, coordinationCtx) {
    try {
        if (!coordinationCtx?.sendToPeer) return 'Error: not configured as master (sendToPeer unavailable)'
        beliefs.missionConstraints.coordination.setOddRowWait()
        const target = coordinationCtx?.findNearestOddRowTile?.()
        if (target) {
            beliefs.tileUtilities.set(`${target.x},${target.y}`, 1000)
            coordinationCtx.notifyBeliefChanged?.()
        }
        coordinationCtx.sendToPeer({ type: 'coord_cmd', mission: 'odd_row_wait' })
        return `Odd row freeze set. My target: (${target?.x ?? '?'},${target?.y ?? '?'}). Command sent to peer. Both agents will navigate to odd-y tile then freeze.`
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function evaluateMission(input, beliefs, getGameStats, getState) {
    try {
        const params = JSON.parse(input)
        const stats = getGameStats()
        const normalizedStats = {
            avgReward:       stats.avgReward ?? 10,
            avgCollectTime:  (stats.movementDuration ?? 500) / 1000 * 5,
            decay:           DECAY,
            // Cap pps using game-config avgReward (constant, unaffected by mission bonuses)
            // avgDeliveryReward inflates when coordination bonuses (500/700pts) hit the rolling window
            pps: Math.min(
                stats.pointsPerSecond ?? 1,
                (stats.avgReward ?? 10) / ((stats.movementDuration ?? 500) / 1000 * 15)
            ),
            movDurationSec:  (stats.movementDuration ?? 500) / 1000,
            position:        getState ? getState() : { x: 0, y: 0 },
        }

        const result = beliefs.missionConstraints.computeEV(params, normalizedStats)
        if (!result) {
            return `Error: unknown mission type "${params.type}". Valid: stack | preferred_tile | blacklist | reward_cap | forbidden_tile | red_light | meet_and_wait | parcel_handoff | odd_row_wait`
        }

        const { ev, guadagnoMissione: missionGain, guadagnoStandard: standardGain } = result
        const n = params.n ?? params.min ?? 3

        const noteMap = {
            stack:          `Stack ${n} parcels (multiplier ${params.multiplier ?? 1}x). Estimated collection time: ${(n * normalizedStats.avgCollectTime).toFixed(1)}s`,
            preferred_tile: `Deliver at preferred tile (${params.multiplier ?? 1}x reward, ~${params.extra_steps ?? 3} extra steps vs nearest tile)`,
            blacklist:      'Blacklisted tile yields 0 pts — always reject',
            reward_cap:     `Cap ${params.cap ?? 10}: ~${(Math.max(0, 1 - (params.cap ?? 10) / (normalizedStats.avgReward * 2)) * 100).toFixed(0)}% of parcels above cap will be skipped`,
            forbidden_tile: `Avoid tile: saves ~${((params.penalty ?? 50) * (params.prob_enter ?? 0.3)).toFixed(1)} penalty pts, costs ~${(DECAY * normalizedStats.avgReward * (params.extra_steps ?? 2)).toFixed(1)} pts in detours`,
            red_light:      `Stop all movement. Bonus on compliance: ${params.bonus ?? 10000} pts. EV = full bonus (zero opportunity cost assumed).`,
            meet_and_wait:  `Both agents converge on (${params.x ?? '?'},${params.y ?? '?'}) within dist ${params.maxDist ?? 3}. Bonus ${params.bonus ?? 500} pts vs opp cost ${missionGain > 0 ? (missionGain - ev).toFixed(1) : '?'} pts.`,
            parcel_handoff: `Passer drops parcel at handoff tile; receiver delivers. Bonus ${params.bonus ?? 200} pts vs ~${standardGain.toFixed(1)} pts opp cost (${params.extra_steps ?? 8} extra steps).`,
            odd_row_wait:   `All agents freeze on odd row. Bonus ${params.bonus ?? 700} pts vs ~${standardGain.toFixed(1)} pts lost (${params.wait_seconds ?? 30}s freeze).`,
        }

        const rec = ev > 0
            ? `ACCEPT (EV = +${ev.toFixed(2)})`
            : `REJECT (EV = ${isFinite(ev) ? ev.toFixed(2) : '-Infinity'})`

        return JSON.stringify({ ev: isFinite(ev) ? ev : -999999, missionGain, standardGain, note: noteMap[params.type] ?? '', recommendation: rec })
    } catch (e) {
        return `Error: ${e.message}. Input was: ${input}`
    }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const MISSION_SYSTEM_PROMPT = `
You are an AI assistant embedded in a BDI agent playing a parcel delivery game (Deliveroo.js).
Your ONLY job is to interpret special mission messages, evaluate them, and configure the agent's behaviour.

== GAME CONTEXT ==
Grid-based game. Coordinates: right=x+1, up=y+1. Agent collects parcels from spawn tiles, delivers to delivery tiles.
Parcel rewards decay over time — act fast. Standard play: pick nearest parcel, deliver to nearest tile.
This agent may operate in a MASTER role coordinating a partner slave agent.

== MISSION TYPES ==

TYPE 1 — ATOMIC: One-shot action (GOTO or answer a question).
TYPE 2 — INTERMEDIATE: Persistent strategy change. Requires evaluate_mission then L2 setter tools.
  Examples: stack N parcels, deliver only at tile (x,y), avoid tile (x,y), skip high-reward parcels.
TYPE 3 — COORDINATION: Requires both agents to act together. Always accept — bonuses are large fixed values.
  Examples: meet at (x,y), parcel handoff between agents, all agents freeze on odd row.

== TOOLS ==

STANDARD:
1. get_agent_state — Input: "" — Returns: {x, y, score, mapInfo}
2. calculate — Input: math expression string — Returns: computed result
3. set_tile_utility — Input: {"x":N,"y":N,"utility":N} — Directs BDI to go to tile (positive utility only)
4. reply_to_sender — Input: plain text string — Sends reply to mission sender

INTERMEDIATE MISSION EVALUATION:
5. evaluate_mission — Input: JSON with "type" field — Returns EV analysis and recommendation
   Types and params:
   - {"type":"stack", "n":3, "multiplier":2.0}
   - {"type":"preferred_tile", "multiplier":5, "extra_steps":3}
   - {"type":"blacklist"}
   - {"type":"reward_cap", "cap":10}
   - {"type":"forbidden_tile", "extra_steps":2, "penalty":50, "prob_enter":0.3}
   - {"type":"red_light", "bonus":10000}
   - {"type":"meet_and_wait", "bonus":500, "x":N, "y":N, "wait_seconds":10}   — include target coords so EV accounts for travel time
   - {"type":"parcel_handoff", "bonus":200, "extra_steps":8}                  — estimate of extra steps vs direct delivery
   - {"type":"odd_row_wait", "bonus":700, "steps_to_odd_row":3, "wait_seconds":30} — estimate wait duration

INTERMEDIATE MISSION SETUP (call ONLY after evaluate_mission recommends ACCEPT):
6. set_stack_requirement — Input: {"min":N or null, "max":N or null}
7. set_preferred_delivery_tiles — Input: {"tiles":[{"x":N,"y":N},...], "multiplier":M}
8. blacklist_delivery_tile — Input: {"x":N,"y":N}
9. set_reward_cap — Input: number string, e.g. "10.5"
10. add_forbidden_tile — Input: {"x":N,"y":N}
11. set_movement_freeze — Input: "true" or "false" — freeze/unfreeze movement; also relays to peer if coordination active
12. get_mission_state — Input: "" — Returns current constraints snapshot
13. reset_mission — Input: "" — Clears all constraints

COORDINATION MISSION SETUP (TYPE 3 — master role only):
14. get_peer_info — Input: "" — Returns peer agent id, name, position
15. set_rendezvous — Input: {"x":N,"y":N,"maxDist":3} — Both agents navigate to (x,y) within maxDist, then freeze
16. initiate_handoff — Input: "" (no params needed) — I become passer (pick up parcel, freeze in place, drop when peer arrives); peer becomes receiver (navigate to me, pick up, deliver)
17. set_odd_row_freeze — Input: "" — Both agents navigate to nearest odd-y tile, then freeze until "green light"

== MISSION HANDLING RULES ==

RULE 1 — Always call get_agent_state first.

RULE 2 — GOTO mission ("move to (x,y) and get +N pts"):
  - This rule applies ONLY when the message rewards GOING to a tile.
  - A message about what happens when you DELIVER at a tile ("deliver in (x,y) and you get 0 pts",
    "no reward / penalty when delivering at (x,y)") is NOT a GOTO — it is a BLACKLIST mission → use RULE 4
    with {"type":"blacklist"}. Do NOT reject it as zero-reward.
  - ALWAYS resolve every math expression with the calculate tool BEFORE deciding — never compute in your head.
    Step A: if the coordinates contain math (e.g. x=4*2, y=(1+3)*3), call calculate for EACH coordinate.
    Step B: if the REWARD contains math (e.g. "-2*(-5)pts", "(3-1)*4pts"), call calculate on the reward expression too.
            The sign is only known AFTER evaluating — e.g. -2*(-5) = +10 is POSITIVE, do NOT reject on the leading minus.
    Step C: only once x, y and reward are all numeric, decide:
            - reward > 0 → call set_tile_utility with the computed reward, then Final Answer.
            - reward ≤ 0 → Final Answer "Mission rejected: negative/zero reward".

RULE 3 — Knowledge/question mission: answer and call reply_to_sender, then Final Answer.

RULE 4 — INTERMEDIATE mission (stack / preferred tile / blacklist / reward cap / forbidden tile):
  Step 1: call evaluate_mission with the appropriate type and params.
  Step 2a: if EV > 0 → call the relevant L2 setter tool(s), then call get_mission_state to confirm, then Final Answer "accepted".
  Step 2b: if EV ≤ 0 → Final Answer "rejected: {reason from EV analysis}".

RULE 5 — Stack missions:
  "exactly N" → set_stack_requirement({"min":N,"max":N})
  "at least N" → set_stack_requirement({"min":N,"max":null})
  "at most N" → set_stack_requirement({"min":null,"max":N})

RULE 6 — Utility value for set_tile_utility MUST equal the exact numerical reward stated (e.g. "+10pts" → utility 10).

RULE 7 — RED LIGHT / STOP missions ("stop", "freeze", "don't move", "wait until I say go"):
  Step 1: evaluate_mission({"type":"red_light","bonus":<N>}) where N is the stated bonus (default 10000).
  Step 2: EV is always positive — call set_movement_freeze("true"), then Final Answer "accepted".
  When a follow-up "green light" / "go" / "resume" message arrives: call set_movement_freeze("false").

RULE 8 — MEET AND WAIT coordination mission:
  Step 1: evaluate_mission({"type":"meet_and_wait","bonus":500})
  Step 2: call get_peer_info to confirm peer is known.
  Step 3: call set_rendezvous({"x":N,"y":N,"maxDist":3}) with the stated coordinates.
  Step 4: Final Answer "accepted — both agents converging on (x,y)".
  When a follow-up "go" / "resume" message arrives: call set_movement_freeze("false") to release both agents.

RULE 9 — PARCEL HANDOFF coordination mission:
  Step 1: evaluate_mission({"type":"parcel_handoff","bonus":200})
  Step 2: call initiate_handoff("") — no params needed.
  Step 3: Final Answer "accepted — I will pick up a parcel, freeze in place, drop when peer is nearby; peer will collect and deliver".

RULE 10 — ODD ROW / RED-LIGHT-GREEN-LIGHT coordination mission:
  Step 1: evaluate_mission({"type":"odd_row_wait","bonus":700})
  Step 2: call set_odd_row_freeze("") — this picks the nearest odd-y tile and commands peer automatically.
  Step 3: Final Answer "accepted — both agents navigating to odd row and freezing".
  When a follow-up "go" / "resume" / "green light" message arrives: call set_movement_freeze("false").

== OUTPUT FORMAT — choose exactly one per message ==

FORMAT A — use a tool:
Thought: <brief reasoning>
Action: <tool_name>
Action Input: <tool input>

FORMAT B — mission complete:
Thought: <brief reasoning>
Final Answer: <outcome summary>

Never output Action and Final Answer in the same message. Never write "Action: None". Do not invent tool results.
`.trim()

// ─── Slave directive ──────────────────────────────────────────────────────────

const SLAVE_DIRECTIVE = `
You are the SLAVE agent. The MASTER orchestrates ALL TYPE 3 COORDINATION missions that
involve both agents acting together: "meet at (x,y)" (meet_and_wait), "parcel handoff
between agents" (parcel_handoff), and "all agents freeze on odd row" (odd_row_wait).
If the message is one of these coordination missions, do NOT call any setup tool and do NOT
call evaluate_mission — the master will command you via the peer channel. Respond with:
Final Answer: "Coordination mission — deferring to master; awaiting peer commands."
Handle everything else yourself, normally and independently: TYPE 1 (atomic GOTO / questions)
and TYPE 2 (stack, preferred tile, blacklist, reward cap, forbidden tile, single-agent
red-light/stop). A plain "stop/freeze until I say go" (red_light, RULE 7) is NOT coordination
— handle it yourself by freezing your own movement.
`.trim()

// ─── Main export ──────────────────────────────────────────────────────────────

export async function interpretMission(
    senderName, msg, beliefs, getState, replyFn,
    getGameStats = () => ({ avgReward: 10, movementDuration: 500, capacity: 5, pointsPerSecond: 1 }),
    coordinationCtx = null,
    role = 'master'
) {
    if (!client) {
        logLLM('[MissionInterpreter] No LLM client — skipping mission interpretation')
        return
    }

    logLLM(`[MissionInterpreter] Interpreting mission from ${senderName}: "${msg}"`)

    const TOOLS = {
        get_agent_state:               (_input) => getAgentState(beliefs, getState),
        calculate:                     (input)  => calculate(input),
        set_tile_utility:              (input)  => setTileUtility(input, beliefs),
        reply_to_sender:               (input)  => replyToSender(input, replyFn),
        evaluate_mission:              (input)  => evaluateMission(input, beliefs, getGameStats, getState),
        set_stack_requirement:         (input)  => setStackRequirement(input, beliefs),
        set_preferred_delivery_tiles:  (input)  => setPreferredDeliveryTiles(input, beliefs),
        blacklist_delivery_tile:       (input)  => blacklistDeliveryTile(input, beliefs),
        set_reward_cap:                (input)  => setRewardCap(input, beliefs),
        add_forbidden_tile:            (input)  => addForbiddenTile(input, beliefs),
        set_movement_freeze:           (input)  => setMovementFreeze(input, beliefs, coordinationCtx),
        get_mission_state:             (_input) => getMissionState(beliefs),
        reset_mission:                 (_input) => resetMission(beliefs),
        // L3 coordination tools (master only)
        get_peer_info:                 (_input) => getPeerInfo(beliefs, getState, coordinationCtx),
        set_rendezvous:                (input)  => setRendezvous(input, beliefs, coordinationCtx),
        initiate_handoff:              (input)  => initiateHandoff(input, beliefs, coordinationCtx),
        set_odd_row_freeze:            (_input) => setOddRowFreeze(beliefs, getState, coordinationCtx),
    }

    const messages = [
        { role: 'system', content: MISSION_SYSTEM_PROMPT },
        ...(role === 'slave' ? [{ role: 'system', content: SLAVE_DIRECTIVE }] : []),
        { role: 'user',   content: `[MISSION from ${senderName}]: "${msg}"` },
    ]

    for (let i = 0; i < 10; i++) {
        logLLM(`[MissionInterpreter] --- iteration ${i + 1} ---`)

        const assistantText = await callModel(messages, { temperature: 0 })
        logLLM(`[MissionInterpreter] output:\n${assistantText}`)
        messages.push({ role: 'assistant', content: assistantText })

        const finalAnswer = extractFinalAnswer(assistantText)
        if (finalAnswer !== null) {
            logLLM(`[MissionInterpreter] Final Answer: ${finalAnswer}`)
            return
        }

        const parsed = extractAction(assistantText)
        if (parsed === null) {
            messages.push({
                role: 'user',
                content: 'Observation: Error: invalid format. Output exactly one Action (with Action Input) or one Final Answer.',
            })
            continue
        }

        const { action, actionInput } = parsed
        let observation
        if (TOOLS[action]) {
            try {
                observation = await TOOLS[action](actionInput)
            } catch (e) {
                observation = `Error: tool threw: ${e.message}`
            }
        } else {
            observation = `Error: unknown tool '${action}'. Available: ${Object.keys(TOOLS).join(', ')}`
        }

        logLLM(`[MissionInterpreter] tool=${action} input="${actionInput}" → ${observation}`)
        messages.push({
            role: 'user',
            content: `Observation: ${observation}\n\nContinue. If all tool calls are done, give Final Answer. Output exactly one Action or one Final Answer.`,
        })
    }

    logLLM('[MissionInterpreter] WARNING: max iterations reached without Final Answer')
}
