import { DeliverPlan }  from './DeliverPlan.js';
import { PickupPlan }   from './PickupPlan.js';
import { GotoPlan }     from './GotoPlan.js';
import { ExplorePlan }  from './ExplorePlan.js';

// DELIVER/PICKUP/GOTO are mutually exclusive by intention.type; ExplorePlan is the fallback (intention === null)
export const plans = [DeliverPlan, PickupPlan, GotoPlan, ExplorePlan];
