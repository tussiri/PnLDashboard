import { describe,expect,it } from 'vitest'
import { buildForecast,createFinancialHistory,createSubcontractSiteForecasts } from './forecastEngine'

const baseline={contractGrowth:3,laborInflation:4,supplyInflation:2,churn:1}

describe('financial forecast engine',()=>{
  it('uses a sufficient history and returns a validated champion',()=>{
    expect(createFinancialHistory('Revenue')).toHaveLength(48)
    const result=buildForecast('Revenue',12,baseline)
    expect(result.scores).toHaveLength(5)
    expect(result.champion).toBe(result.scores[0].model)
    expect(result.folds).toHaveLength(6)
    expect(result.series.filter(point=>point.kind==='forecast')).toHaveLength(12)
  })
  it('produces ordered prediction intervals',()=>{
    const forecast=buildForecast('Gross profit',12,baseline).series.filter(point=>point.kind==='forecast')
    expect(forecast.every(point=>point.lower95!<=point.lower80!&&point.lower80!<=point.value&&point.value<=point.upper80!&&point.upper80!<=point.upper95!)).toBe(true)
  })
  it('changes revenue forecasts when scenario assumptions change',()=>{
    const base=buildForecast('Revenue',12,baseline).series.at(-1)!.value
    const upside=buildForecast('Revenue',12,{...baseline,contractGrowth:8,churn:0}).series.at(-1)!.value
    expect(upside).toBeGreaterThan(base)
  })
  it('forecasts subcontractor costs from invoice history and approved event lift',()=>{
    const rows=createSubcontractSiteForecasts('Amazon')
    expect(rows).toHaveLength(2)
    expect(rows.every(row=>row.invoiceMonths>=24&&row.nextQuarter>row.threeMonthAverage*3)).toBe(true)
    const withoutSignals=buildForecast('Subcontractor cost',12,baseline,{client:'Amazon',vertical:'Industrial',eventLift:8.5,signalsEnabled:false}).series.at(-1)!.value
    const withSignals=buildForecast('Subcontractor cost',12,baseline,{client:'Amazon',vertical:'Industrial',eventLift:8.5,signalsEnabled:true}).series.at(-1)!.value
    expect(withSignals).toBeGreaterThan(withoutSignals)
  })
})
