import {describe,expect,it} from 'vitest'
import {approvedEventLift,sampleEventSignals,signalApplies} from './eventSignalService'

describe('forecast event signal governance',()=>{
  it('uses only approved signals in the modeled lift',()=>{
    expect(approvedEventLift('Amazon','Industrial / e-commerce')).toBeCloseTo(8.5*.91)
    expect(approvedEventLift('Meridian Health','Healthcare')).toBe(0)
  })
  it('scopes client-specific signals without hiding portfolio signals',()=>{
    const amazon=sampleEventSignals.find(signal=>signal.id==='amazon-promo')!
    expect(signalApplies(amazon,'Amazon','Industrial / e-commerce')).toBe(true)
    expect(signalApplies(amazon,'UPS','Industrial / parcel logistics')).toBe(false)
    expect(signalApplies(amazon,'All clients','Portfolio')).toBe(true)
  })
})
