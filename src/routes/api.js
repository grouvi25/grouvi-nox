import express from 'express';
import { requireAuth } from '../auth.js';
import coreRoutes from './api/core.js';
import incidentRoutes from './api/incidents.js';
import agentRoutes from './api/agent.js';
import serviceRoutes from './api/services.js';
import notificationRoutes from './api/notifications.js';
import discoveryRoutes from './api/discovery.js';
import updateRoutes from './api/updates.js';
export function createApiRouter({authMiddleware=requireAuth}={}){
  const router=express.Router();router.use(authMiddleware);router.use(coreRoutes);router.use(incidentRoutes);router.use(agentRoutes);router.use(serviceRoutes);router.use(notificationRoutes);router.use(discoveryRoutes);router.use(updateRoutes);return router;
}
export default createApiRouter();
