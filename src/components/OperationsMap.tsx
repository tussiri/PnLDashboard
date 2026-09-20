import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { Layers3, MapPin, X } from 'lucide-react'
import type { JobRow } from '../services/apiTypes'
import { money, percent } from '../utils'

/** Contract job row with a resolved coordinate pair (rows without coordinates are excluded by the caller). */
export type MapJob = JobRow & { latitude: number; longitude: number }
export const hasCoordinates = (job: JobRow): job is MapJob => typeof job.latitude === 'number' && typeof job.longitude === 'number' && Number.isFinite(job.latitude) && Number.isFinite(job.longitude)
const countryName = (code: string) => (code === 'CA' ? 'Canada' : code === 'US' ? 'United States' : code)
const marginOf = (job: JobRow) => (job.gross_margin_pct ?? (job.revenue ? (job.gross_profit / job.revenue) * 100 : 0))

type MapMode = 'sites' | 'revenue' | 'labor' | 'margin'
const modeLabels: Record<MapMode,string> = { sites:'Site clusters', revenue:'Revenue heat', labor:'Labor variance heat', margin:'Margin risk heat' }
const markerColor = (status:JobRow['status']) => status==='Critical'?'#d64b5d':status==='Watch'?'#e59b2f':'#198a68'

// Both plugins are distributed as Leaflet extensions that expect a browser-global
// `L`. Static ESM imports can be hoisted ahead of Leaflet in optimized production
// chunks, so establish the global first and load the extensions afterward.
;(globalThis as typeof globalThis & { L: typeof L }).L = L
const leafletPluginsReady = Promise.all([
  import('leaflet.markercluster'),
  import('leaflet.heat'),
])

function metricWeight(job:MapJob,mode:MapMode,jobs:MapJob[]){
  if(mode==='revenue') return job.revenue/Math.max(1,...jobs.map(row=>row.revenue))
  if(mode==='labor') return job.budget_labor?Math.max(0,job.labor_cost/job.budget_labor-1)/.2:0
  const margin=marginOf(job)/100
  return Math.max(0,.32-margin)/.2
}

export function OperationsMap({jobs,selected,onSelect,onOpenDetail,compact=false}:{jobs:MapJob[];selected:MapJob|null;onSelect:(job:MapJob|null)=>void;onOpenDetail:(job:MapJob)=>void;compact?:boolean}){
  const containerRef=useRef<HTMLDivElement|null>(null)
  const [mode,setMode]=useState<MapMode>('sites')
  const [loadError,setLoadError]=useState(false)
  useEffect(()=>{
    if(!containerRef.current||!jobs.length)return
    let disposed=false
    let map:L.Map|undefined
    let resizeObserver:ResizeObserver|undefined
    let resizeTimer:number|undefined
    const initialize=async()=>{
      try{
        await leafletPluginsReady
        if(disposed||!containerRef.current)return
        setLoadError(false)
        map=L.map(containerRef.current,{zoomControl:true,minZoom:2,maxZoom:14,worldCopyJump:true,preferCanvas:true})
        const activeMap=map
        const streets=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap contributors',maxZoom:19})
        const terrain=L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{attribution:'Map data &copy; OpenStreetMap contributors, SRTM | Map style &copy; OpenTopoMap',maxZoom:17})
        streets.addTo(activeMap)
        L.control.layers({Streets:streets,Terrain:terrain},undefined,{position:'bottomleft',collapsed:true}).addTo(activeMap)
        L.control.scale({imperial:true,metric:true,position:'bottomright'}).addTo(activeMap)
        if(mode==='sites'){
          const clusters=L.markerClusterGroup({chunkedLoading:true,showCoverageOnHover:false,spiderfyOnMaxZoom:true,maxClusterRadius:42})
          jobs.forEach(job=>{
            const icon=L.divIcon({className:'portfolio-map-icon',html:`<span style="--marker-color:${markerColor(job.status)}"></span>`,iconSize:[24,24],iconAnchor:[12,12]})
            const marker=L.marker([job.latitude,job.longitude],{icon,title:job.job_name})
            const margin=marginOf(job)
            const tooltip=document.createElement('div')
            const title=document.createElement('strong')
            title.textContent=job.job_name
            tooltip.append(title,document.createElement('br'),`${job.city}, ${job.state_province}, ${countryName(job.country_code)}`,document.createElement('br'),`${money(job.revenue)} · ${percent(margin)} margin`)
            if(job.geo_precision==='city_center'){const geo=document.createElement('em');geo.textContent='Approximate city center';tooltip.append(document.createElement('br'),geo)}
            marker.bindTooltip(tooltip,{direction:'top',offset:[0,-8]})
            marker.on('click',()=>onSelect(job));clusters.addLayer(marker)
          });clusters.addTo(activeMap)
        }else{
          const points=jobs.map(job=>[job.latitude,job.longitude,Math.min(1,Math.max(.08,metricWeight(job,mode,jobs)))] as [number,number,number])
          L.heatLayer(points,{radius:34,blur:26,maxZoom:8,minOpacity:.28,gradient:{.2:'#b9d4ff',.45:'#4f86ef',.7:'#f0ac3f',1:'#d64b5d'}}).addTo(activeMap)
          jobs.forEach(job=>L.circleMarker([job.latitude,job.longitude],{radius:4,weight:1,color:'#fff',fillColor:'#172033',fillOpacity:.8}).on('click',()=>onSelect(job)).addTo(activeMap))
        }
        activeMap.fitBounds(L.latLngBounds(jobs.map(job=>[job.latitude,job.longitude] as [number,number])).pad(compact?.12:.2),{animate:false,maxZoom:compact?4:5})
        resizeObserver=new ResizeObserver(()=>activeMap.invalidateSize({pan:false,animate:false}))
        resizeObserver.observe(containerRef.current)
        resizeTimer=window.setTimeout(()=>map?.invalidateSize(),0)
      }catch(error){
        console.error('Unable to initialize the operations map',error)
        if(!disposed)setLoadError(true)
      }
    }
    void initialize()
    return()=>{
      disposed=true
      if(resizeTimer!==undefined)window.clearTimeout(resizeTimer)
      resizeObserver?.disconnect()
      map?.remove()
    }
  },[jobs,mode,compact,onSelect])
  return <div className={`map-shell ${compact?'map-shell--compact':''} ${selected&&!compact?'map-shell--with-detail':''}`}><div className="leaflet-map-wrap">{!compact&&<div className="map-mode-control" aria-label="Map visualization"><Layers3 size={14}/>{(Object.keys(modeLabels) as MapMode[]).map(key=><button key={key} className={mode===key?'active':''} onClick={()=>setMode(key)}>{modeLabels[key]}</button>)}</div>}<div ref={containerRef} className="leaflet-map" aria-label={`Interactive operations map with ${jobs.length} sites across the United States and Canada`}/>{loadError&&<div className="empty-state map-load-error" role="alert">The map could not be initialized. Reload the page to try again.</div>}<div className="map-country-summary"><span>United States <b>{jobs.filter(j=>j.country_code==='US').length}</b></span><span>Canada <b>{jobs.filter(j=>j.country_code==='CA').length}</b></span>{jobs.some(j=>j.geo_precision==='city_center')&&<span title="Placed at the city centroid, not the site address">Approx. city center <b>{jobs.filter(j=>j.geo_precision==='city_center').length}</b></span>}</div></div>{selected&&<aside className="map-detail" aria-live="polite"><button className="icon-button map-detail__close" onClick={()=>onSelect(null)} aria-label="Close site details"><X size={16}/></button><span className={`status-badge status-badge--${selected.status.toLowerCase()}`}>{selected.status}</span><h3>{selected.job_name}</h3><p>{selected.parent_account} · {selected.city}, {selected.state_province}, {countryName(selected.country_code)}</p>{selected.geo_precision==='city_center'&&<small className="map-detail__geo">Approximate city center · placed from the city centroid, not the site address</small>}<dl><div><dt>Revenue</dt><dd>{money(selected.revenue)}</dd></div><div><dt>Gross margin</dt><dd>{percent(marginOf(selected))}</dd></div><div><dt>Labor variance</dt><dd className={selected.labor_variance===null?'':selected.labor_variance>0?'text-bad':'text-good'}>{selected.labor_variance===null?'No budget':money(selected.labor_variance)}</dd></div><div><dt>Open AR</dt><dd>{money(selected.ar_open)}</dd></div></dl><div className="map-detail__meta"><span>{selected.job_number}</span><span>{selected.branch}</span><span>{selected.manager_name}</span></div><button className="primary-button" onClick={()=>onOpenDetail(selected)}><MapPin size={14}/>Open job detail</button></aside>}</div>
}
