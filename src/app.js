import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders, rateLimit } from './security.js';
import { currentSession } from './auth.js';
import authRoutes from './routes/auth.js';
import { createApiRouter } from './routes/api.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.join(__dirname,'..','public');
export function createApp({sessionResolver=currentSession,apiAuth}={}) {
  const app=express();
  app.disable('x-powered-by');app.disable('etag');app.set('trust proxy',1);
  app.use(securityHeaders);app.use(rateLimit({windowMs:60_000,max:600,name:'global'}));app.use(express.json({limit:'32kb'}));
  app.get('/healthz',(req,res)=>res.json({ok:true,uptime:process.uptime()}));
  app.use('/auth',authRoutes);app.use('/api',createApiRouter(apiAuth?{authMiddleware:apiAuth}:undefined));
  const sendPage=file=>(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(publicDir,file))};
  app.get('/',(req,res,next)=>sessionResolver(req)?sendPage('index.html')(req,res,next):res.redirect(302,'/login'));
  app.get('/login',sendPage('login.html'));app.get('/enroll',sendPage('enroll.html'));
  app.use(express.static(publicDir,{index:false,dotfiles:'deny',etag:true,lastModified:true,maxAge:0,setHeaders(res,filePath){res.setHeader('Cache-Control',filePath.endsWith('.html')?'no-store':'no-cache')}}));
  app.use((req,res)=>res.status(404).json({error:'not_found'}));
  app.use((err,req,res,next)=>{void next;console.error('[error]',err?.message||err);res.status(500).json({error:'internal_error'})});
  return app;
}
