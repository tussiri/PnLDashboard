export type ForecastTarget = 'Revenue' | 'Gross profit' | 'Labor cost' | 'Subcontractor cost'
export type ForecastModelName = 'Event-aware regression' | 'Seasonal naive' | 'Linear trend' | 'Damped trend' | 'Weighted ensemble'

export interface FinancialHistoryPoint { period:string; value:number }
export interface ForecastPoint extends FinancialHistoryPoint { kind:'actual'|'forecast'; lower80?:number; upper80?:number; lower95?:number; upper95?:number }
export interface ModelScore { model:ForecastModelName; wape:number; rmse:number; bias:number; coverage95:number }
export interface BacktestFold { origin:string; horizon:number; wape:number; bias:number; actual:number; predicted:number }
export interface ForecastScenario { contractGrowth:number; laborInflation:number; supplyInflation:number; churn:number }
export interface ForecastResult { target:ForecastTarget; champion:ForecastModelName; history:FinancialHistoryPoint[]; series:ForecastPoint[]; scores:ModelScore[]; folds:BacktestFold[]; drivers:{name:string;impact:number;direction:'positive'|'negative'}[]; trainedThrough:string; residualStd:number }
export interface ForecastContext { client:string; vertical:string; eventLift:number; signalsEnabled:boolean }
export interface SubcontractSiteForecast { site:string;client:string;vertical:string;invoiceMonths:number;lastInvoice:number;threeMonthAverage:number;trend:number;eventLift:number;nextQuarter:number;confidence:number }

const addMonths=(period:string,months:number)=>{const [year,month]=period.split('-').map(Number);const date=new Date(Date.UTC(year,month-1+months,1));return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`}

export function createFinancialHistory(target:ForecastTarget):FinancialHistoryPoint[]{
  const start='2022-09'
  return Array.from({length:48},(_,index)=>{
    const season=[-.035,-.02,.012,.075,-.04,-.01,.005,.018,.026,.04,.015,-.012][index%12]
    const calendarPulse=eventPulse(index)
    const revenue=1_780_000*(1+index*.0064)*(1+season+calendarPulse*.034)+Math.sin(index*1.71)*31_000
    const value=target==='Revenue'?revenue:target==='Gross profit'?revenue*(.272+Math.sin(index*.43)*.012):target==='Labor cost'?revenue*(.485+Math.cos(index*.51)*.009):revenue*(.126+Math.sin(index*.37)*.008)*(1+calendarPulse*.075)
    return {period:addMonths(start,index),value:Math.round(value)}
  })
}

type ModelFn=(train:number[],horizon:number)=>number[]

const eventPulse=(index:number)=>{const month=index%12;if(month===9||month===10)return 1;if(month===5||month===6)return .72;if(month===11)return .5;return 0}

function solve(matrix:number[][],vector:number[]){const n=vector.length,a=matrix.map((row,i)=>[...row,vector[i]]);for(let i=0;i<n;i++){let pivot=i;for(let r=i+1;r<n;r++)if(Math.abs(a[r][i])>Math.abs(a[pivot][i]))pivot=r;[a[i],a[pivot]]=[a[pivot],a[i]];const divisor=Math.abs(a[i][i])<1e-9?1e-9:a[i][i];for(let c=i;c<=n;c++)a[i][c]/=divisor;for(let r=0;r<n;r++){if(r===i)continue;const factor=a[r][i];for(let c=i;c<=n;c++)a[r][c]-=factor*a[i][c]}}return a.map(row=>row[n])}

const eventAware:ModelFn=(train,horizon)=>{
  const feature=(index:number)=>[1,index/48,Math.sin(index*Math.PI/6),Math.cos(index*Math.PI/6),eventPulse(index)]
  const x=train.map((_,index)=>feature(index)),p=x[0].length,xtx=Array.from({length:p},()=>Array(p).fill(0)),xty=Array(p).fill(0)
  x.forEach((row,r)=>row.forEach((value,i)=>{xty[i]+=value*train[r];row.forEach((other,j)=>{xtx[i][j]+=value*other})}))
  for(let i=1;i<p;i++)xtx[i][i]+=.08
  const beta=solve(xtx,xty)
  return Array.from({length:horizon},(_,h)=>Math.max(0,feature(train.length+h).reduce((sum,value,i)=>sum+value*beta[i],0)))
}

const linear:ModelFn=(train,horizon)=>{
  const n=train.length,xMean=(n-1)/2,yMean=train.reduce((a,b)=>a+b,0)/n
  const slope=train.reduce((sum,y,x)=>sum+(x-xMean)*(y-yMean),0)/train.reduce((sum,_,x)=>sum+(x-xMean)**2,0)
  const intercept=yMean-slope*xMean
  return Array.from({length:horizon},(_,h)=>Math.max(0,intercept+slope*(n+h)))
}

const seasonal:ModelFn=(train,horizon)=>{
  const recent=train.slice(-12),prior=train.slice(-24,-12)
  const growth=prior.length===12?Math.min(1.18,Math.max(.88,recent.reduce((a,b)=>a+b,0)/prior.reduce((a,b)=>a+b,0))):1
  return Array.from({length:horizon},(_,h)=>Math.max(0,recent[h%12]*growth**(Math.floor(h/12)+1)))
}

const damped:ModelFn=(train,horizon)=>{
  let level=train[0],trend=train[1]-train[0]
  const alpha=.38,beta=.16,phi=.92
  for(let i=1;i<train.length;i++){const previous=level;level=alpha*train[i]+(1-alpha)*(level+phi*trend);trend=beta*(level-previous)+(1-beta)*phi*trend}
  return Array.from({length:horizon},(_,h)=>Math.max(0,level+trend*phi*(1-phi**(h+1))/(1-phi)))
}

const ensemble:ModelFn=(train,horizon)=>{const a=seasonal(train,horizon),b=linear(train,horizon),c=damped(train,horizon);return a.map((_,i)=>a[i]*.45+b[i]*.25+c[i]*.30)}
const models:Record<ForecastModelName,ModelFn>={'Event-aware regression':eventAware,'Seasonal naive':seasonal,'Linear trend':linear,'Damped trend':damped,'Weighted ensemble':ensemble}

function scoreModel(history:number[],model:ModelFn):Omit<ModelScore,'model'>{
  const errors:{actual:number;predicted:number;error:number}[]=[]
  for(let origin=24;origin<=history.length-3;origin+=3){const predicted=model(history.slice(0,origin),3);for(let h=0;h<3;h++){const actual=history[origin+h];errors.push({actual,predicted:predicted[h],error:predicted[h]-actual})}}
  const abs=errors.reduce((s,e)=>s+Math.abs(e.error),0),actualTotal=errors.reduce((s,e)=>s+Math.abs(e.actual),0)
  const rmse=Math.sqrt(errors.reduce((s,e)=>s+e.error**2,0)/errors.length)
  const bias=errors.reduce((s,e)=>s+e.error,0)/actualTotal*100
  const sigma=Math.sqrt(errors.reduce((s,e)=>s+e.error**2,0)/Math.max(1,errors.length-1))
  const coverage95=errors.filter(e=>Math.abs(e.error)<=1.96*sigma).length/errors.length*100
  return {wape:abs/actualTotal*100,rmse,bias,coverage95}
}

function scenarioFactor(target:ForecastTarget,scenario:ForecastScenario,h:number,context?:ForecastContext){
  const progress=(h+1)/12
  const event=context?.signalsEnabled?context.eventLift/100:0
  if(target==='Revenue')return 1+((scenario.contractGrowth-scenario.churn)/100)*progress+event
  if(target==='Gross profit')return 1+((scenario.contractGrowth-scenario.churn-scenario.laborInflation*.62-scenario.supplyInflation*.14)/100)*progress+event*.38
  if(target==='Labor cost')return 1+((scenario.contractGrowth+scenario.laborInflation-scenario.churn*.35)/100)*progress+event*.68
  return 1+((scenario.contractGrowth+scenario.laborInflation*.55+scenario.supplyInflation*.2-scenario.churn*.35)/100)*progress+event*.82
}

export function buildForecast(target:ForecastTarget,horizon:number,scenario:ForecastScenario,context?:ForecastContext):ForecastResult{
  const history=createFinancialHistory(target),values=history.map(row=>row.value)
  const scores=(Object.entries(models) as [ForecastModelName,ModelFn][]).map(([model,fn])=>({model,...scoreModel(values,fn)})).sort((a,b)=>a.wape-b.wape)
  const champion=scores[0].model,fn=models[champion]
  const raw=fn(values,horizon),residualStd=scores[0].rmse
  const forecast=raw.map((value,h)=>{const adjusted=value*scenarioFactor(target,scenario,h,context),spread=residualStd*Math.sqrt(1+(h+1)/12);return {period:addMonths(history.at(-1)!.period,h+1),value:Math.round(adjusted),kind:'forecast' as const,lower80:Math.max(0,Math.round(adjusted-1.282*spread)),upper80:Math.round(adjusted+1.282*spread),lower95:Math.max(0,Math.round(adjusted-1.96*spread)),upper95:Math.round(adjusted+1.96*spread)}})
  const folds=Array.from({length:6},(_,index)=>{const origin=values.length-18+index*3,predicted=fn(values.slice(0,origin),3),actual=values.slice(origin,origin+3);const a=actual.reduce((s,v)=>s+v,0),p=predicted.reduce((s,v)=>s+v,0);return {origin:history[origin-1].period,horizon:3,wape:actual.reduce((s,v,i)=>s+Math.abs(v-predicted[i]),0)/a*100,bias:(p-a)/a*100,actual:a,predicted:p}})
  const drivers=target==='Revenue'?[{name:'Contract starts & expansion',impact:36,direction:'positive' as const},{name:'Client events & demand',impact:24,direction:'positive' as const},{name:'Seasonality',impact:22,direction:'positive' as const},{name:'Customer churn',impact:18,direction:'negative' as const}]:target==='Gross profit'?[{name:'Labor-rate inflation',impact:33,direction:'negative' as const},{name:'Contract growth',impact:27,direction:'positive' as const},{name:'Client / vertical events',impact:22,direction:'positive' as const},{name:'Supply inflation',impact:18,direction:'negative' as const}]:target==='Labor cost'?[{name:'Hourly-rate inflation',impact:35,direction:'negative' as const},{name:'Scheduled hours',impact:27,direction:'negative' as const},{name:'Client event demand',impact:23,direction:'negative' as const},{name:'Productivity gains',impact:15,direction:'positive' as const}]:[{name:'Prior approved invoices',impact:39,direction:'negative' as const},{name:'Client event demand',impact:26,direction:'negative' as const},{name:'Vendor rate trend',impact:21,direction:'negative' as const},{name:'Vertical seasonality',impact:14,direction:'negative' as const}]
  return {target,champion,history,series:[...history.map(row=>({...row,kind:'actual' as const})),...forecast],scores,folds,drivers,trainedThrough:history.at(-1)!.period,residualStd}
}

export function createSubcontractSiteForecasts(client='All clients'):SubcontractSiteForecast[]{
  const sites=[['Amazon','Joliet Fulfillment Campus','Industrial',184200,5.6,8.5,36],['Amazon','Puget Sound Fulfillment Hub','Industrial',161800,4.2,8.5,32],['UPS','Dallas Parcel Operations','Industrial',142500,3.8,6.4,30],['Meridian Health','North Texas Medical Center','Healthcare',118400,2.7,3.1,34],['Summit Education','Front Range University','Education',84700,1.9,-1.2,28]] as const
  return sites.filter(row=>client==='All clients'||row[0]===client).map(([account,site,vertical,lastInvoice,trend,eventLift,months],index)=>{const threeMonthAverage=Math.round(lastInvoice/(1+trend/100)*.985);return {site,client:account,vertical,invoiceMonths:months,lastInvoice,threeMonthAverage,trend,eventLift,nextQuarter:Math.round(threeMonthAverage*3*(1+trend/100+eventLift/100)),confidence:Math.max(72,94-index*4)}})
}
