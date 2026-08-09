import http from 'node:http';import path from 'node:path';import {config} from './config.js';
const socketPath=process.env.INTEGRATION_BROKER_SOCKET||path.join(config.stateDir,'integration-config.sock');
function request(method,route,payload){return new Promise((resolve,reject)=>{const body=payload?JSON.stringify(payload):'',req=http.request({socketPath,path:route,method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:20000},res=>{let raw='';res.on('data',chunk=>raw=(raw+chunk).slice(-40000));res.on('end',()=>{let data={};try{data=JSON.parse(raw)}catch{}if((res.statusCode||500)>=400)return reject(Object.assign(new Error(data.error||'integration_broker_failed'),{status:res.statusCode}));resolve(data)})});req.on('timeout',()=>req.destroy(new Error('integration_broker_timeout')));req.on('error',reject);req.end(body)})}
export const integrationStatus=()=>request('GET','/status');
export const configureIntegration=payload=>request('POST','/configure',payload);

export const updateJobStatus=()=>request('GET','/update/status');
export const startUpdateJob=()=>request('POST','/update/start',{});
