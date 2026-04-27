## Project
Node.js autonomous agent for Deliveroo.js (grid parcel delivery game).
Two parts: BDI agent (Part 1) + LLM agent with coordination (Part 2).

## Stack
• Node.js + Socket.IO client
• PDDL planner (external, automated planning)
• Anthropic API (server-provided endpoint + token for LLM agent)
• No frontend; agent = CLI process

## Repo structure

/src
  /bdi
    beliefs.js       # belief store + revision
    deliberation.js  # desire gen + intention selection
    planner.js       # A* pathfinding + plan library
    pddl.js          # PDDL planner integration
    agent.js         # BDI main loop
  /llm
    context.js       # LLM memory/context builder
    planner.js       # LLM planner + ReAct loop
    tools.js         # tool catalog + execution
    agent.js         # LLM main loop
  /coord
    protocol.js      # BDI<->LLM message channel
  config.js
  index.js           # entry point, spawns both agents


## Game mechanics (key facts)
• Grid: tile types 0=blocked 1=spawn 2=delivery 3=walkable
• Moves: up/down/left/right (NOT diagonal); each move fixed duration
• Mid-move position: ±0.6 then ±0.4 — both tiles locked during transition
• Parcel reward decays over time; score only at delivery tile put_down
• pick_up/put_down: one parcel per call, must be on same tile
• Sensing: Manhattan dist < sensing_distance; outside = unknown
• Opponent on tile = blocked (move returns failure + penalty)

## Utility function (implement exactly)

U(p) = reward(p)
     - decay * steps_to_p
     - decay * steps_to_delivery(p)
     - decay * steps_to_p * carried_count

Only pursue if U > threshold. Recalculate on every belief update.

## BDI implementation checklist
• [ ] Socket.IO connect; parse map → walkability graph + delivery set + spawn set (static beliefs)
• [ ] Belief store with timestamps; stale removal (reward ≤ 0); uncertain agent positions
• [ ] A* on walkability graph; Manhattan heuristic; precompute BFS distances from all delivery tiles at startup
• [ ] Plan library: GoToAndPickUp, GoToAndDeliver, Explore (→ nearest unvisited spawn tile)
• [ ] Deliberation: pick highest-U intention; only switch if new_U > current_U + ε
• [ ] Replanning triggers: action failure, target parcel gone, opponent blocks path, belief divergence
• [ ] PDDL integration: domain (move/pick_up/put_down), problem from current beliefs; cache plan, replan on significant change

## LLM agent checklist
• [ ] Context builder: objective (NL) + position + parcels + opponents + carried + map summary + tool catalog + history (last k only)
• [ ] Structured plan output: JSON array of {tool, args}; validate before execution
• [ ] ReAct loop: Thought → Action → Observation → repeat/replan
• [ ] Replanning triggers: objective change, env change, action failure, plan complete
• [ ] Reflexion: post-execution reflection → improved next plan

## Tool catalog (LLM agent)
⁠ js
move_to(x, y)          // pathfind + execute moves
pick_up()              // at current tile
put_down()             // at current tile
get_parcels()          // visible parcels list
get_position()         // own {x,y}
get_carried()          // carried parcels list
send_message(id, msg)  // to BDI agent
 ⁠

## Coordination protocol
⁠ js
// message shape
{ type: "belief"|"intention"|"request", sender: "bdi"|"llm", content: {} }
 ⁠
• Belief sharing: broadcast sensing data → doubles observable area
• Intention sharing: on commit, broadcast target parcel; other agent skips it
• Task allocation: closest agent (or higher U) claims parcel; other acknowledges

## Coordination strategies (test both, pick best by score)
1. Simple: closest-agent-wins
2. Zone split: divide map; each agent owns half
3. Dynamic auction: both compute U, highest wins
4. Relay: agent A picks up, drops midway, agent B delivers

## Key implementation notes
• Async safety: sensing arrives async; belief updates + planning loop must not race → use async/await + queued updates
• Budget LLM calls: only call on meaningful state change, NOT every tick
• Dynamic obstacles: re-run A* if path blocked mid-execution
• Cluster bonus: multiple parcels adjacent → pick all before delivering
• Delivery urgency: total carried reward > threshold → deliver immediately, skip new parcels

## Config (config.js)
⁠ js
module.exports = {
  host: "http://localhost:8080",   // or Azure/UniTN URL
  token_bdi: "YOUR_TOKEN",
  token_llm: "YOUR_TOKEN",
  llm_endpoint: "SERVER_PROVIDED",
  decay_rate: null,                // read from server on connect
  action_duration: null,           // read from server on connect
  utility_threshold: 0,
  intention_switch_epsilon: 5,
  history_window: 10,              // LLM context: last k observations
}
 ⁠

## Setup
⁠ bash
git clone https://github.com/unitn-ASA/Deliveroo.js.git
cd Deliveroo.js && npm install && npm run build && npm start
# open http://localhost:8080 → create tokens

git clone https://github.com/unitn-ASA/DeliverooAgent.js
# place your code; configure config.js
node index.js
 ⁠

## Servers
• Local: http://localhost:8080 (preferred for testing)
• Azure: https://deliveroojs.azurewebsites.net/ (slow under load)
• UniTN (VPN): https://deliveroojs.bears.disi.unitn.it/

## Deliverables
• JS code (full implementation)
• Report ≤10 pages: architecture diagrams, belief revision, utility tuning, planning approach, coordination protocol, experimental results
• Oral presentation
• Submit ≥1 week before exam