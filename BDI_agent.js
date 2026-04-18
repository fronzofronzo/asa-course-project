import 'dotenv/config'
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect()

/**
 * @type {{id:string, name:string, x:string, y:string, score:number}}
 */
const me = {id:'', name:'', x:-1, y:-1, score:0}

socket.onYou( (id, name, x, y, score) => {
    me.id = id;
    me.name = name;
    me.x = x ? x : -1;
    me.y = y ? y : -1;
    me.score = score;
})

/**
 * Map of parcel ID to parcel information
 * @type {Map<string, {id: string, x: number, y: number, reward: number, carriedBy?:string}>}
 */
const parcels = new Map()

socket.onSensing((parcelsData) => {
    // Clear and repopulate the parcels map
    parcels.clear()
    if (parcelsData && Array.isArray(parcelsData)) {
        for (const parcel of parcelsData) {
            parcels.set(parcel.id, {
                id: parcel.id,
                x: parcel.x,
                y: parcel.y,
                reward: parcel.reward,
                carriedBy: parcel.carriedBy
            })
        }
    }
})

