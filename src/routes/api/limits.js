import { rateLimit } from '../../security.js';
export const detailLimit=rateLimit({windowMs:60_000,max:60,name:'detail'});
export const actionLimit=rateLimit({windowMs:60_000,max:20,name:'incident-action'});
export const agentLimit=rateLimit({windowMs:10*60_000,max:12,name:'agent-chat'});
