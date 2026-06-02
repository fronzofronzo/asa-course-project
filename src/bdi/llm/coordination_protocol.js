/**
 * Programmatic coordination protocol handler.
 *
 * [COORD:*] messages are exchanged between team agents and must NOT enter the
 * LLM queue — they are handled here synchronously, updating constraint state
 * and releasing/activating freezes without burning LLM iterations.
 *
 * Call tryHandleCoordMessage() at the top of onMsg in agent.js.
 * Returns true if the message was consumed; false if it should go to the LLM.
 */

import { logLLM } from '../logger.js';

// ─── Protocol message constants ───────────────────────────────────────────────

export const COORD = {
    /** Sender announces it has arrived within rendezvous radius. */
    RENDEZVOUS_ARRIVED:  '[COORD:RENDEZVOUS_ARRIVED]',
    /** Pickup agent announces the handoff tile where it dropped a parcel. */
    HANDOFF_READY:       '[COORD:HANDOFF_READY]',
    /** Delivery agent announces it successfully delivered the handoff parcel. */
    HANDOFF_DONE:        '[COORD:HANDOFF_DONE]',
    /** Initiator broadcasts a rendezvous mission so partner can activate too. */
    RENDEZVOUS_MISSION:  '[COORD:RENDEZVOUS_MISSION]',
    /** Initiator broadcasts a handoff mission so partner can set its role. */
    HANDOFF_MISSION:     '[COORD:HANDOFF_MISSION]',
};

/**
 * Try to handle a coordination protocol message.
 *
 * @param {string}  msg       - Raw message text received.
 * @param {string}  senderId  - ID of the sender agent.
 * @param {object}  beliefs   - Agent's BeliefSet (has .missionConstraints).
 * @param {object}  socket    - Socket client (for emitSay replies).
 * @param {string}  myId      - Own agent ID.
 * @returns {boolean} true if consumed, false if caller should handle normally.
 */
export function tryHandleCoordMessage(msg, senderId, beliefs, socket, myId) {
    const c = beliefs.missionConstraints;

    // ── [COORD:RENDEZVOUS_ARRIVED] ──────────────────────────────────────────
    if (msg.startsWith(COORD.RENDEZVOUS_ARRIVED)) {
        if (!c.rendezvous.isActive()) return true; // stale, ignore
        const wasNew = c.rendezvous.markTeammateArrival();
        if (wasNew) {
            logLLM(`[CoordProtocol] Teammate ${senderId} arrived at rendezvous.`);
            if (c.rendezvous.isFulfilled()) {
                // Both here — release movement freeze
                c.redLight.set(false);
                logLLM('[CoordProtocol] Rendezvous FULFILLED — movement resumed. Bonus claimed.');
            }
        }
        return true;
    }

    // ── [COORD:HANDOFF_READY:{x},{y}] ────────────────────────────────────────
    if (msg.startsWith(COORD.HANDOFF_READY)) {
        // Payload: "[COORD:HANDOFF_READY] x,y"
        const payload = msg.slice(COORD.HANDOFF_READY.length).trim();
        const parts   = payload.split(',');
        const hx      = parseInt(parts[0]);
        const hy      = parseInt(parts[1]);
        if (!isNaN(hx) && !isNaN(hy) && c.handoff.isActive() && c.handoff.role === 'delivery') {
            c.handoff.handoffTile = { x: hx, y: hy };
            // Inject handoff tile as a navigation target in the BDI
            beliefs.tileUtilities.set(`${hx},${hy}`, c.handoff.bonus);
            logLLM(`[CoordProtocol] Handoff tile set to (${hx},${hy}) — navigating there.`);
        }
        return true;
    }

    // ── [COORD:HANDOFF_DONE] ─────────────────────────────────────────────────
    if (msg.startsWith(COORD.HANDOFF_DONE)) {
        if (c.handoff.isActive()) {
            logLLM('[CoordProtocol] Handoff DONE — clearing constraint.');
            c.handoff.reset();
        }
        return true;
    }

    // ── [COORD:RENDEZVOUS_MISSION] ───────────────────────────────────────────
    // Partner initiating a rendezvous — auto-activate on receiving side.
    if (msg.startsWith(COORD.RENDEZVOUS_MISSION)) {
        // Payload: "[COORD:RENDEZVOUS_MISSION] x,y,radius,bonus"
        const payload = msg.slice(COORD.RENDEZVOUS_MISSION.length).trim();
        const parts   = payload.split(',');
        const cx      = parseInt(parts[0]);
        const cy      = parseInt(parts[1]);
        const radius  = parseInt(parts[2]) || 3;
        const bonus   = parseInt(parts[3]) || 500;
        if (!isNaN(cx) && !isNaN(cy)) {
            c.rendezvous.set({ x: cx, y: cy }, radius, bonus, senderId);
            // Inject navigation target
            beliefs.tileUtilities.set(`${cx},${cy}`, bonus);
            logLLM(`[CoordProtocol] Auto-accepted rendezvous at (${cx},${cy}) r=${radius} from ${senderId}.`);
        }
        return true;
    }

    // ── [COORD:HANDOFF_MISSION] ──────────────────────────────────────────────
    // Initiator assigns delivery role to partner.
    // Payload: "[COORD:HANDOFF_MISSION] role,parcelId,handoffX,handoffY,bonus"
    if (msg.startsWith(COORD.HANDOFF_MISSION)) {
        const payload   = msg.slice(COORD.HANDOFF_MISSION.length).trim();
        const parts     = payload.split(',');
        const role      = parts[0]; // 'pickup' or 'delivery'
        const parcelId  = parts[1] === 'null' ? null : parts[1];
        const hx        = parseInt(parts[2]);
        const hy        = parseInt(parts[3]);
        const bonus     = parseInt(parts[4]) || 200;
        if ((role === 'pickup' || role === 'delivery') && !isNaN(hx) && !isNaN(hy)) {
            const tile = { x: hx, y: hy };
            c.handoff.set(role, parcelId, senderId, tile, bonus);
            if (role === 'delivery') {
                beliefs.tileUtilities.set(`${hx},${hy}`, bonus);
            }
            logLLM(`[CoordProtocol] Auto-accepted handoff role="${role}" from ${senderId}.`);
        }
        return true;
    }

    return false; // not a coord message
}
