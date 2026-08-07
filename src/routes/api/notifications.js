import express from 'express';
import { requireSameOrigin } from '../../security.js';
import { actionLimit } from './limits.js';
import { notificationStatus,updateNotificationSettings } from '../../database.js';
import { sendTelegramText,telegramState } from '../../notifier.js';
const router=express.Router();

router.get('/notifications',(req,res)=>{res.set('Cache-Control','no-store');res.json({telegram:telegramState(),recent:notificationStatus()})});
router.post('/notifications/settings',requireSameOrigin,actionLimit,(req,res)=>{const settings=updateNotificationSettings(req.body||{});res.json({ok:true,telegram:telegramState(),settings})});
router.post('/notifications/test',requireSameOrigin,actionLimit,async(req,res)=>{const result=await sendTelegramText('🛡️ <b>VPS Sentinel</b>\nТест уведомлений прошёл успешно.',{eventType:'test'});res.status(result.sent?200:503).json(result)});

export default router;
