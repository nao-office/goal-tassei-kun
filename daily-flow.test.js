const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
const inline=html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(inline);
function source(name){const start=inline.indexOf('  function '+name+'(');const end=inline.indexOf('\n  function ',start+1);return inline.slice(start,end);}
function fixture(extra={}){
 const ctx={observedToday:'2026-11-03',activeDate:'2026-11-03',followToday:true,document:{hidden:false},editingControlFocused:()=>false,jstToday:()=> '2026-11-04',renders:0,render(){this.renders++},...extra};
 // Use a closure because browser functions are called without a receiver.
 ctx.render=()=>ctx.renders++;
 vm.createContext(ctx);vm.runInContext(source('checkDayRollover'),ctx);return ctx;
}
test('midnight advances today without altering stored records',()=>{const entries={'2026-11-03':{tomorrow:'test'}};const c=fixture({data:{entries}});c.checkDayRollover();assert.equal(c.activeDate,'2026-11-04');assert.equal(entries['2026-11-03'].tomorrow,'test');assert.equal(c.renders,1);c.checkDayRollover();assert.equal(c.renders,1);});
test('editing and hidden pages defer rollover until safe',()=>{for(const props of [{document:{hidden:true}},{editingControlFocused:()=>true}]){const c=fixture(props);c.checkDayRollover();assert.equal(c.activeDate,'2026-11-03');assert.equal(c.observedToday,'2026-11-03');c.document.hidden=false;c.editingControlFocused=()=>false;c.checkDayRollover();assert.equal(c.activeDate,'2026-11-04');}});
test('historical date stays selected through midnight',()=>{const c=fixture({followToday:false,activeDate:'2026-10-20'});c.checkDayRollover();assert.equal(c.activeDate,'2026-10-20');});
test('previous action only replaces today after explicit confirmation',()=>{
 const current={valuableAction:'existing'};let saves=0;
 const c={txt:x=>String(x??'').trim(),data:{entries:{yesterday:{tomorrow:'next'}}},dayShift:()=> 'yesterday',activeDate:'today',entry:()=>current,confirm:()=>false,save:()=>saves++,scheduleAutoSave:()=>{},render:()=>{}};
 vm.createContext(c);vm.runInContext(source('usePreviousAction'),c);c.usePreviousAction();assert.equal(current.valuableAction,'existing');assert.equal(saves,0);c.confirm=()=>true;c.usePreviousAction();assert.equal(current.valuableAction,'next');assert.equal(saves,1);
});
test('sync notice distinguishes offline and disabled states without a Sheets request',()=>{
 const el={};const c={document:{getElementById:()=>el},autoSyncEnabled:false,storageError:false,esc:x=>x,button:()=>'<button>確認</button>'};
 vm.createContext(c);vm.runInContext(source('updateAutoSyncNotice'),c);c.updateAutoSyncNotice();assert.equal(el.hidden,false);assert.match(el.innerHTML,/自動同期オフ/);
 Object.assign(c,{autoSyncEnabled:true,autoWriteToken:true,autoTokenExpiresAt:Date.now()+60000,googleToken:'test',autoPending:()=>1,autoSyncBlocked:false,autoAuthBusy:false,navigator:{onLine:false}});c.updateAutoSyncNotice();assert.match(el.innerHTML,/オフライン/);assert.match(el.innerHTML,/ゴールはGoogle連携で手動同期/);
});
