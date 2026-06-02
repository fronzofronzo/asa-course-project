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
        return String(eval(expression))
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function getAgentState(beliefs, getState) {
    try {
        const { x, y, score } = getState()
        if (x === null) return 'Error: agent position not available yet'
        const teammates = [...beliefs.teammates.values()].map(t => ({
            id: t.id,
            name: t.name,
            lastKnownX: t.lastKnownX,
            lastKnownY: t.lastKnownY,
        }))
        return JSON.stringify({
            x, y, score,
            teamId: beliefs.myTeamId ?? null,
            teammates,  // always present — use these IDs for L3 coordination missions
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

// ─── Coordination tools ───────────────────────────────────────────────────────

function getNearbyAgents(beliefs, getState) {
    try {
        const { x, y } = getState()
        if (x === null) return 'Error: agent position not available yet'

        if (beliefs.teammates.size === 0) {
            return 'No teammates known yet — agents have not been in sensing range of each other. ' +
                   'Accept the mission anyway if EV > 0; the partner ID will be available once they meet.'
        }

        // Build result from persistent teammates, enriched with live position if in range
        const livePositions = new Map(
            [...beliefs.agents.values()].map(a => [a.id, { x: a.x, y: a.y, inRange: true }])
        )

        return JSON.stringify(
            [...beliefs.teammates.values()].map(t => {
                const live = livePositions.get(t.id)
                const tx   = live ? live.x : t.lastKnownX
                const ty   = live ? live.y : t.lastKnownY
                return {
                    id:         t.id,
                    name:       t.name,
                    teamId:     t.teamId,
                    x:          tx,
                    y:          ty,
                    inRange:    live ? true : false,
                    dist:       tx != null
                        ? Math.abs(Math.round(tx) - Math.round(x)) + Math.abs(Math.round(ty) - Math.round(y))
                        : null,
                }
            })
        )
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function sendToAgent(input, socket) {
    try {
        const { agentId, message } = JSON.parse(input)
        if (!agentId || typeof message !== 'string') {
            return 'Error: expected JSON {"agentId":"...","message":"..."}'
        }
        socket.emitSay(agentId, message)
        return `Message sent to agent ${agentId}: "${message}"`
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function setRendezvous(input, beliefs, socket) {
    try {
        const { x, y, radius, bonus, partnerId } = JSON.parse(input)
        if (typeof x !== 'number' || typeof y !== 'number') {
            return 'Error: x and y must be numbers. Expected: {"x":N,"y":N,"radius":3,"bonus":500,"partnerId":"..."}'
        }
        const cx = Math.round(x), cy = Math.round(y)
        const r  = radius ?? 3
        const b  = bonus  ?? 500
        beliefs.missionConstraints.rendezvous.set({ x: cx, y: cy }, r, b, partnerId ?? null)
        // Inject GOTO goal into BDI tileUtilities
        beliefs.tileUtilities.set(`${cx},${cy}`, b)
        // Broadcast to partner if ID provided
        if (partnerId) {
            const payload = `${cx},${cy},${r},${b}`
            socket.emitSay(partnerId, `[COORD:RENDEZVOUS_MISSION] ${payload}`)
        }
        logLLM(`[MissionInterpreter] Rendezvous set: center=(${cx},${cy}) r=${r} bonus=${b} partner=${partnerId}`)
        return `Rendezvous activated: navigate to neighborhood of (${cx},${cy}) within radius ${r}. BDI will head there automatically.`
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function setHandoffRole(input, beliefs, socket) {
    try {
        const { role, parcelId, partnerId, handoffX, handoffY, bonus } = JSON.parse(input)
        if (role !== 'pickup' && role !== 'delivery') {
            return 'Error: role must be "pickup" or "delivery"'
        }
        if (typeof handoffX !== 'number' || typeof handoffY !== 'number') {
            return 'Error: handoffX and handoffY must be numbers'
        }
        const hx = Math.round(handoffX), hy = Math.round(handoffY)
        const b  = bonus ?? 200
        beliefs.missionConstraints.handoff.set(role, parcelId ?? null, partnerId ?? null, { x: hx, y: hy }, b)
        // Inject handoff tile as nav goal for delivery role
        if (role === 'delivery') {
            beliefs.tileUtilities.set(`${hx},${hy}`, b)
        }
        // Tell partner their complementary role
        if (partnerId) {
            const partnerRole = role === 'pickup' ? 'delivery' : 'pickup'
            const payload = `${partnerRole},${parcelId ?? 'null'},${hx},${hy},${b}`
            socket.emitSay(partnerId, `[COORD:HANDOFF_MISSION] ${payload}`)
        }
        logLLM(`[MissionInterpreter] Handoff set: role=${role} parcel=${parcelId} tile=(${hx},${hy}) partner=${partnerId}`)
        return `Handoff role="${role}" activated. Tile=(${hx},${hy}). ${role === 'pickup' ? 'Pick up parcel and drop at handoff tile.' : 'Navigate to handoff tile, pick up, and deliver.'}`
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function setMovementFreeze(input, beliefs) {
    const val = input.trim().toLowerCase().replace(/^["']+|["']+$/g, '')
    if (!['true', 'false'].includes(val)) return 'Error: input must be "true" (red light / stop) or "false" (green light / go)'
    beliefs.missionConstraints.redLight.set(val === 'true')
    return val === 'true'
        ? 'Red light active: movement frozen. Agent will not move until green light.'
        : 'Green light: movement resumed. Agent is free to act.'
}

function getMissionState(beliefs) {
    const c = beliefs.missionConstraints
    return JSON.stringify({ ...c.toJSON(), hasMission: c.hasMission() })
}

function resetMission(beliefs) {
    beliefs.missionConstraints.reset()
    return 'Mission reset — all constraints cleared, returning to standard play'
}

function evaluateMission(input, beliefs, getGameStats) {
    try {
        const params = JSON.parse(input)
        const stats = getGameStats()
        const normalizedStats = {
            avgReward:       stats.avgReward ?? 10,
            avgCollectTime:  (stats.movementDuration ?? 500) / 1000 * 5,
            decay:           DECAY,
            pps:             stats.pointsPerSecond ?? 1,
        }

        const result = beliefs.missionConstraints.computeEV(params, normalizedStats)
        if (!result) {
            return `Error: unknown mission type "${params.type}". Valid: stack | preferred_tile | blacklist | reward_cap | forbidden_tile | red_light | rendezvous | handoff`
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
            rendezvous:     `Meet at target. Bonus: ${params.bonus ?? 500} pts. Estimated detour: ${params.estimated_steps ?? 10} steps each way.`,
            handoff:        `Parcel handoff between agents. Bonus: ${params.bonus ?? 200} pts. Extra steps to handoff tile: ${params.extra_steps ?? 5}.`,
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

== MISSION TYPES ==

TYPE 1 — ATOMIC: One-shot action (GOTO or answer a question).
TYPE 2 — INTERMEDIATE: Persistent strategy change. Requires evaluate_mission then L2 setter tools.
  Examples: stack N parcels, deliver only at tile (x,y), avoid tile (x,y), skip high-reward parcels.

== TOOLS ==

STANDARD:
1. get_agent_state — Input: "" — Returns: {x, y, score, teamId, teammates:[{id,name,x,y}], mapInfo} — teammates list is persistent (survives out-of-range); use it for all L3 coordination
2. calculate — Input: math expression string — Returns: computed result
3. set_tile_utility — Input: {"x":N,"y":N,"utility":N} — Directs BDI to go to tile (positive utility only)
4. reply_to_sender — Input: plain text string — Sends reply to mission sender

INTERMEDIATE MISSION EVALUATION:
5. evaluate_mission — Input: JSON with "type" field — Returns EV analysis and recommendation
   Types and params:
   - {"type":"stack", "n":3, "multiplier":2.0}           — deliver N parcels at once for multiplier reward
   - {"type":"preferred_tile", "multiplier":5, "extra_steps":3}  — deliver at specific tiles for bonus
   - {"type":"blacklist"}                                  — EV always -Infinity (always reject)
   - {"type":"reward_cap", "cap":10}                       — skip high-reward parcels
   - {"type":"forbidden_tile", "extra_steps":2, "penalty":50, "prob_enter":0.3}
   - {"type":"red_light", "bonus":10000}
   - {"type":"rendezvous", "bonus":500, "estimated_steps":10}
   - {"type":"handoff", "bonus":200, "extra_steps":5}

INTERMEDIATE MISSION SETUP (call ONLY after evaluate_mission recommends ACCEPT):
6. set_stack_requirement — Input: {"min":N or null, "max":N or null}
   - "exactly N": {"min":N,"max":N}   — "at least N": {"min":N,"max":null}   — "at most N": {"min":null,"max":N}
7. set_preferred_delivery_tiles — Input: {"tiles":[{"x":N,"y":N},...], "multiplier":M}
8. blacklist_delivery_tile — Input: {"x":N,"y":N} — Never deliver here
9. set_reward_cap — Input: number string, e.g. "10.5" — Skip parcels above this reward
10. add_forbidden_tile — Input: {"x":N,"y":N} — Pathfinding avoids this tile
11. set_movement_freeze — Input: "true" or "false" — "true" = red light (freeze all movement), "false" = green light (resume movement)
12. get_mission_state — Input: "" — Returns current constraints snapshot
13. reset_mission — Input: "" — Clears all constraints

COORDINATION TOOLS (Level 3 — multi-agent missions):
14. get_nearby_agents — Input: "" — Returns [{id, name, x, y, dist}] sorted by distance — ALWAYS call this first for coordination missions to get partner agent ID
15. send_to_agent — Input: {"agentId":"...","message":"..."} — Send a free-text message to a specific agent
16. set_rendezvous — Input: {"x":N,"y":N,"radius":3,"bonus":500,"partnerId":"..."} — Activates rendezvous: BDI navigates to (x,y), freezes on arrival, resumes when partner also arrives. Broadcasts to partner automatically.
17. set_handoff_role — Input: {"role":"pickup"|"delivery","parcelId":"..."|null,"partnerId":"...","handoffX":N,"handoffY":N,"bonus":200} — Configure parcel handoff. Pickup agent collects parcel and drops at handoff tile. Delivery agent navigates there and delivers. Broadcasts role to partner automatically.

== MISSION HANDLING RULES ==

RULE 1 — Always call get_agent_state first.

RULE 2 — GOTO mission ("move to (x,y) and get +N pts"):
  - If coordinates contain math (e.g. x=4*2), call calculate first.
  - If reward > 0: call set_tile_utility, then Final Answer.
  - If reward ≤ 0: Final Answer "Mission rejected: negative/zero reward".

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

RULE 8 — RENDEZVOUS missions ("move both agents to neighborhood of (x,y)", "meet at (x,y)"):
  Step 1: get_agent_state — read "teammates" field directly. NEVER call get_nearby_agents for this.
  Step 2: evaluate_mission({"type":"rendezvous","bonus":<N>,"estimated_steps":<D>}) where D ≈ distance to target.
  Step 3a: EV > 0 AND teammates non-empty → set_rendezvous({"x":...,"y":...,"radius":3,"bonus":<N>,"partnerId":"<teammates[0].id>"}).
  Step 3b: EV > 0 AND teammates empty → set_rendezvous with partnerId=null; reply "accepted, awaiting teammate contact".
  Step 3c: EV ≤ 0 → reject.
  Agent auto-navigates to center. Freezes on arrival. Resumes when partner signals (handled automatically).

RULE 9 — HANDOFF missions ("agent A picks up, agent B delivers", "pass parcel to teammate"):
  Step 1: get_agent_state — read "teammates" field directly. NEVER call get_nearby_agents for this.
  Step 2: evaluate_mission({"type":"handoff","bonus":<N>,"extra_steps":5}).
  Step 3a: EV > 0 AND teammates non-empty → decide role ('pickup' if closer to parcels, else 'delivery').
    set_handoff_role({"role":"pickup"|"delivery","parcelId":null,"partnerId":"<teammates[0].id>","handoffX":<N>,"handoffY":<N>,"bonus":<N>}).
    Use center of map as handoffX/Y if positions unknown.
  Step 3b: EV > 0 AND teammates empty → set_handoff_role with partnerId=null; reply "accepted, awaiting teammate contact".
  Step 3c: EV ≤ 0 → reject.
  Partner's complementary role is broadcast automatically.

RULE 10 — COLLECTIVE RED LIGHT ("all agents to odd row", "all agents must X"):
  Step 1: evaluate_mission({"type":"red_light","bonus":<N>}).
  Step 2: call set_tile_utility to navigate to nearest odd-row tile (y % 2 === 1).
  Step 3: call set_movement_freeze("true") after arrival (or immediately if mission says stop first).
  Step 4: if teammates known → send_to_agent each partner with the mission text so they handle it too.

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

// ─── Main export ──────────────────────────────────────────────────────────────

export async function interpretMission(senderName, msg, beliefs, getState, replyFn, getGameStats = () => ({ avgReward: 10, movementDuration: 500, capacity: 5, pointsPerSecond: 1 }), socket = null) {
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
        evaluate_mission:              (input)  => evaluateMission(input, beliefs, getGameStats),
        set_stack_requirement:         (input)  => setStackRequirement(input, beliefs),
        set_preferred_delivery_tiles:  (input)  => setPreferredDeliveryTiles(input, beliefs),
        blacklist_delivery_tile:       (input)  => blacklistDeliveryTile(input, beliefs),
        set_reward_cap:                (input)  => setRewardCap(input, beliefs),
        add_forbidden_tile:            (input)  => addForbiddenTile(input, beliefs),
        set_movement_freeze:           (input)  => setMovementFreeze(input, beliefs),
        // L3 coordination tools (socket required)
        get_nearby_agents:             (_input) => getNearbyAgents(beliefs, getState),
        send_to_agent:                 (input)  => socket ? sendToAgent(input, socket) : 'Error: no socket available',
        set_rendezvous:                (input)  => socket ? setRendezvous(input, beliefs, socket) : 'Error: no socket available',
        set_handoff_role:              (input)  => socket ? setHandoffRole(input, beliefs, socket) : 'Error: no socket available',
        get_mission_state:             (_input) => getMissionState(beliefs),
        reset_mission:                 (_input) => resetMission(beliefs),
    }

    const messages = [
        { role: 'system', content: MISSION_SYSTEM_PROMPT },
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
