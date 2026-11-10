const test=require('node:test'),assert=require('node:assert/strict');
const {merge,create}=require('./tab-storage.js');
const copy=v=>JSON.parse(JSON.stringify(v));
function fixture(){
 const store=new Map(),storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),key:i=>[...store.keys()][i],get length(){return store.size;}};
 let held=false;
 const locks={async request(_name,options,fn){if(held){if(options.ifAvailable)return fn(null);await new Promise(resolve=>{const timer=setInterval(()=>{if(!held){clearInterval(timer);resolve();}},1);});}held=true;try{return await fn({});}finally{held=false;}}};
 let seq=0;
 const make=data=>create({storage,locks,key:'record',raw:storage.getItem('record'),data,id:()=>String(++seq)});
 return {store,storage,make};
}
test('two tabs cannot write simultaneously even before a storage event is delivered',async()=>{
 const f=fixture(),a=f.make({}),b=f.make({});assert.equal(await a.acquire(),true);assert.equal(await b.acquire(),false);
 a.write({fromA:'retained'});assert.throws(()=>b.write({fromB:'draft'}),{code:'TAB_CHANGED'});
 assert.deepEqual(JSON.parse(f.storage.getItem('record')),{fromA:'retained'});a.release();await new Promise(r=>setTimeout(r,0));assert.equal(await b.acquire(),true);
 assert.throws(()=>b.write({fromB:'draft'}),{code:'TAB_CHANGED'},'ownership alone cannot overwrite a stale snapshot');b.release();
});
test('one-click handover merges independent fields and keeps exact originals before committing',async()=>{
 const f=fixture(),base={entries:{today:{a:'old',b:'old'}}};f.storage.setItem('record',JSON.stringify(base));const a=f.make(base),b=f.make(base);
 await a.acquire();a.write({entries:{today:{a:'A',b:'old'}}});a.release();await new Promise(r=>setTimeout(r,0));await b.acquire();
 const remote=f.storage.getItem('record'),local=copy(base);local.entries.today.b='B';
 const prepared=b.prepare(local,JSON.parse(remote),remote,[]);b.commit(prepared);
 assert.deepEqual(JSON.parse(f.storage.getItem('record')).entries.today,{a:'A',b:'B'});assert.equal(b.rescues().length,1);assert.equal(b.rescues()[0].otherTabRaw,remote);assert.equal(b.rescues()[0].thisTab.entries.today.b,'B');b.release();
});
test('same-field edits are archived and local input wins only on explicit handover',()=>{
 const conflicts=[],base={a:'old'},result=merge(base,{a:'mine'},{a:'other'},[],conflicts);
 assert.deepEqual(result,{a:'mine'});assert.deepEqual(conflicts,[{path:['a'],base:'old',local:'mine',otherTab:'other'}]);
});
test('entity merge retains independent additions and untouched edits without using array indices',()=>{
 const base={goals:[{id:'one',title:'old',why:'old'}]},local={goals:[{id:'one',title:'local',why:'old'},{id:'two',title:'new'}]},remote={goals:[{id:'three',title:'other'},{id:'one',title:'old',why:'remote'}]};
 assert.deepEqual(merge(base,local,remote).goals,[{id:'three',title:'other'},{id:'one',title:'local',why:'remote'},{id:'two',title:'new'}]);
});
test('histories for the same record never overwrite each other',()=>{
 const old={id:'one',at:'1'},left={id:'one',at:'2'},right={id:'one',at:'3'};
 const result=merge({goalHistory:[old]},{goalHistory:[old,left]},{goalHistory:[old,right]});assert.deepEqual(result.goalHistory,[old,right,left]);
});
test('edit/delete conflicts retain both variants in rescue details',()=>{
 const c=[];assert.deepEqual(merge({a:{x:1}},{a:{x:2}},{},[],c),{a:{x:2}});assert.equal(c.length,1);assert.equal(c[0].otherTab,undefined);
 const c2=[];assert.deepEqual(merge({a:{x:1}},{},{a:{x:2}},[],c2),{});assert.deepEqual(c2[0].otherTab,{x:2});
});
test('quota failure while writing recovery fails before modifying shared records or baseline',async()=>{
 const f=fixture(),a=f.make({});await a.acquire();f.storage.setItem('record','{"remote":1}');const before=f.storage.getItem('record');
 const set=f.storage.setItem;f.storage.setItem=(k,v)=>{if(k.includes('tab-rescue:'))throw Error('quota');return set(k,v);};
 assert.throws(()=>a.prepare({local:1},{remote:1},before,[{value:'unsaved form'}]),/quota/);assert.equal(f.storage.getItem('record'),before);assert.equal(a.ready(),false);a.release();
});
test('a legacy/unguarded write between preparation and commit is never overwritten',async()=>{
 const f=fixture(),a=f.make({});await a.acquire();const p=a.prepare({local:1},{},null,[]);f.storage.setItem('record','{"legacy":1}');assert.throws(()=>a.commit(p),{code:'TAB_CHANGED'});assert.equal(f.storage.getItem('record'),'{"legacy":1}');a.release();
});
test('unsupported lock environments fail closed',async()=>{
 const f=fixture(),a=create({storage:f.storage,locks:null,key:'record',raw:null,data:{}});await assert.rejects(a.acquire(),{code:'TAB_UNSUPPORTED'});assert.throws(()=>a.write({x:1}),{code:'TAB_CHANGED'});assert.equal(f.storage.getItem('record'),null);
});
test('handover does not release a writer until in-flight synchronization is complete',async()=>{
 const f=fixture();let busy=true;const a=create({storage:f.storage,locks:{request:async(_n,_o,fn)=>fn({})},key:'record',raw:null,data:{},busy:()=>busy});await a.acquire();a.changed({key:'record:edit-request'});assert.equal(a.state().owned,true);assert.equal(a.ready(),false);a.write({finished:'remote sync'});busy=false;await new Promise(r=>setTimeout(r,120));assert.equal(a.state().owned,false);assert.deepEqual(JSON.parse(f.storage.getItem('record')),{finished:'remote sync'});
});

test('independently opened new-day forms merge typed fields rather than default blank/unchecked values',()=>{
 const base={entries:{}},local={entries:{today:{fit:'',normal:'B',minimumDone:false,lessonNotes:{}}}},remote={entries:{today:{fit:'A',normal:'',minimumDone:true,lessonNotes:{lesson:{reflection:'other'}}}}};
 const conflicts=[],result=merge(base,local,remote,[],conflicts);assert.deepEqual(result.entries.today,{fit:'A',normal:'B',minimumDone:true,lessonNotes:{lesson:{reflection:'other'}}});assert.deepEqual(conflicts,[]);
});

test('a failed handover remains paused even when canonical bytes did not change',async()=>{
 const f=fixture(),a=f.make({});await a.acquire();await a.request();const set=f.storage.setItem;f.storage.setItem=(k,v)=>{if(k.includes('tab-rescue:'))throw Error('quota');set(k,v);};assert.throws(()=>a.prepare({typed:'draft'},{},null,[]),/quota/);assert.equal(a.ready(),false);assert.throws(()=>a.write({typed:'draft'}),{code:'TAB_CHANGED'});f.storage.setItem=set;const p=a.prepare({typed:'draft'},{},null,[]);a.commit(p);assert.equal(a.ready(),true);a.release();
});

test('all manual and automatic sync entry points stop before work when tab is stale',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),inline=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 for(const name of ['autoCommit','autoSyncTick','saveLocalChangesToSheets','saveGoalManagementChanges','importReviewedSheetsData','importGoalManagementData','applyReviewedSync','fetchSheetRows','startGoogleSync','restoreBackupFile']){
  const start=inline.search(new RegExp('  (?:async )?function '+name+'\\(')),rest=inline.slice(start),end=rest.slice(1).search(/\n  (?:async )?function /),source=end<0?rest:rest.slice(0,end+1);let notices=0;
  const c={tabGuard:{ready:()=>false},updateAutoSyncNotice:()=>notices++,document:{addEventListener:()=>{}}};vm.createContext(c);vm.runInContext(source,c);await c[name]();assert.equal(notices,1,name);
 }
});
