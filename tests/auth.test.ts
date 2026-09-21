import { describe,it,expect } from 'vitest';
import { signInitData,validateInitData } from '../packages/backend/auth.js';
import { utcIntervals,validateIntervals } from '../packages/backend/scheduling.js';
const now=Date.UTC(2026,8,19,12,0,0);
const payload=(extra:Record<string,string>={})=>signInitData({auth_date:String(now/1000),user:'{"id":9007199254740993,"first_name":"Анна + % &","last_name":"Тест"}',...extra});
describe('MAX signed identity',()=>{
  it('verifies Unicode and preserves full int64 identifier',()=>{const result=validateInitData(payload(),undefined,now);expect(result.id).toBe('9007199254740993');expect(result.name).toBe('Анна + % & Тест');});
  it('rejects tampered user and hash',()=>{expect(()=>validateInitData(payload().replace('9007199254740993','9007199254740994'),undefined,now)).toThrow();expect(()=>validateInitData(payload().replace(/hash=./,'hash=z'),undefined,now)).toThrow();});
  it('rejects duplicate and missing required parameters',()=>{expect(()=>validateInitData(`${payload()}&auth_date=${now/1000}`,undefined,now)).toThrow();expect(()=>validateInitData(signInitData({user:'{"id":1}'}),undefined,now)).toThrow();});
  it('enforces absolute expiry and future skew',()=>{expect(()=>validateInitData(payload({auth_date:String(now/1000-3600)}),undefined,now)).toThrow();expect(()=>validateInitData(payload({auth_date:String(now/1000+61)}),undefined,now)).toThrow();expect(validateInitData(payload(),undefined,now+10000).expiresAt.getTime()).toBe(now+3600000);});
  it('does not accept milliseconds as auth_date',()=>{expect(()=>validateInitData(payload({auth_date:String(now)}),undefined,now)).toThrow();});
});
describe('weekly intervals and time zones',()=>{
  it('subtracts a break and computes 420 available minutes',()=>{const ranges=utcIntervals('2026-09-21','Europe/Moscow',[{kind:'work',start:'09:00',end:'17:00'},{kind:'break',start:'12:00',end:'13:00'}]);expect(ranges.reduce((n,[s,e])=>n+(e-s)/60000,0)).toBe(420);expect(ranges.length).toBe(2);});
  it('rejects intersecting work intervals and a break outside a shift',()=>{expect(()=>validateIntervals([{kind:'work',start:'09:00',end:'12:00'},{kind:'work',start:'11:00',end:'14:00'}])).toThrow();expect(()=>validateIntervals([{kind:'work',start:'09:00',end:'12:00'},{kind:'break',start:'11:00',end:'13:00'}])).toThrow();});
  it('rejects nonexistent and ambiguous DST boundaries',()=>{expect(()=>utcIntervals('2026-03-29','Europe/Berlin',[{kind:'work',start:'02:30',end:'04:00'}])).toThrow();expect(()=>utcIntervals('2026-10-25','Europe/Berlin',[{kind:'work',start:'02:30',end:'04:00'}])).toThrow();});
  it('allows adjacent nonoverlapping intervals',()=>{expect(utcIntervals('2026-09-21','Europe/Moscow',[{kind:'work',start:'09:00',end:'12:00'},{kind:'work',start:'12:00',end:'14:00'}]).length).toBe(2);});
});
