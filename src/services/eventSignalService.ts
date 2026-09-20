export type SignalStatus='Approved'|'Review'
export type SignalMode='sample'|'live'

export interface ForecastEventSignal{
  id:string
  scope:string
  clients:string[]
  verticals:string[]
  signal:string
  source:string
  effectiveWindow:string
  lift:number
  confidence:number
  status:SignalStatus
  mode:SignalMode
  asOf:string
}

export interface EventSignalProvider{
  listSignals():Promise<ForecastEventSignal[]>
}

export const sampleEventSignals:ForecastEventSignal[]=[
  {id:'amazon-promo',scope:'Amazon',clients:['Amazon'],verticals:['Industrial'],signal:'Promotional demand window',source:'Client calendar',effectiveWindow:'Planning window',lift:8.5,confidence:91,status:'Approved',mode:'sample',asOf:'2026-08-30'},
  {id:'ups-peak',scope:'UPS',clients:['UPS'],verticals:['Industrial'],signal:'Peak parcel volume',source:'Client + industry calendar',effectiveWindow:'Peak season',lift:6.4,confidence:88,status:'Approved',mode:'sample',asOf:'2026-08-30'},
  {id:'health-season',scope:'Healthcare',clients:[],verticals:['Healthcare'],signal:'Seasonal infection pressure',source:'Public health feed',effectiveWindow:'Seasonal',lift:3.1,confidence:76,status:'Review',mode:'sample',asOf:'2026-08-30'},
  {id:'education-calendar',scope:'Education',clients:[],verticals:['Education'],signal:'Campus closure calendar',source:'Customer calendar',effectiveWindow:'Break periods',lift:-1.2,confidence:94,status:'Approved',mode:'sample',asOf:'2026-08-30'},
  {id:'vendor-rate',scope:'All verticals',clients:[],verticals:[],signal:'Local wage and vendor-rate change',source:'Economic + contract feed',effectiveWindow:'Effective-date driven',lift:2.3,confidence:82,status:'Review',mode:'sample',asOf:'2026-08-30'},
]

export function signalApplies(signal:ForecastEventSignal,client:string,vertical:string){
  if(signal.clients.length&&client!=='All clients'&&!signal.clients.includes(client))return false
  if(signal.verticals.length&&vertical!=='Portfolio'&&!signal.verticals.some(item=>vertical.includes(item)))return false
  return client==='All clients'||signal.clients.length===0||signal.clients.includes(client)
}

export function approvedEventLift(client:string,vertical:string){
  const applicable=sampleEventSignals.filter(signal=>signal.status==='Approved'&&signalApplies(signal,client,vertical))
  if(!applicable.length)return 0
  return applicable.reduce((sum,signal)=>sum+signal.lift*signal.confidence/100,0)/Math.max(1,applicable.length)
}

export class SampleEventSignalProvider implements EventSignalProvider{
  async listSignals(){return sampleEventSignals}
}

