const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c={window:{},Blob};vm.createContext(c);vm.runInContext(fs.readFileSync('archive-tools.js','utf8'),c);const A=c.window.GoalArchiveTools;
const data=()=>({entries:{'2026-11-08':{valuableAction:'前の行動',valuableDone:true,lessonId:'lesson-a'}},progress:{actions:[{id:'old',title:'残す'}],sheetActions:[]}});
function draft(kind='work'){return A.draft({versionId:'fixture',payload:{kind,id:kind==='work'?'2026-11-07':'old',values:kind==='work'?{valuableAction:'コピーする行動',valuableDone:'FALSE',lessonId:'lesson-b'}:{title:'コピーするアクション',status:'完了'}}});}
test('copy is isolated, preserves source and only carries editable text, not achievement status',()=>{
 const d=draft(),before=data(),json=JSON.stringify(before),out=A.apply(before,d,'2026-11-08','new','2026-11-08');
 assert.equal(out.entries['2026-11-08'].valuableAction,'前の行動\nコピーする行動');assert.equal(out.entries['2026-11-08'].valuableDone,true);assert.equal(out.entries['2026-11-08'].lessonId,'lesson-a');
 assert.equal(JSON.stringify(before),json);assert.ok(!('valuableDone' in d.values));
});
test('action copy gets a new ID and incomplete state, never replaces original',()=>{
 const before=data(),out=A.apply(before,draft('action'),'2026-11-08','new','2026-11-08');
 assert.equal(out.progress.actions.length,2);assert.equal(out.progress.actions[0].title,'残す');assert.equal(out.progress.actions[1].id,'new');assert.equal(out.progress.actions[1].status,'未着手');assert.equal(before.progress.actions.length,1);
 assert.throws(()=>A.apply(before,draft('action'),'2026-11-08','old','2026-11-08'));
});
test('append exceeding 4000 chars is rejected without changing anything',()=>{
 const before=data();before.entries['2026-11-08'].valuableAction='あ'.repeat(4000);const json=JSON.stringify(before);
 assert.throws(()=>A.apply(before,draft(),'2026-11-08','new','now'),/4000/);assert.equal(JSON.stringify(before),json);
});
test('null, oversized payloads, invalid dates, unsupported keys and empty action names fail closed',()=>{
 assert.throws(()=>A.draft({payload:{values:null}}));assert.throws(()=>A.draft({payload:{kind:'work',values:{valuableAction:'a'.repeat(4001)}}}));
 assert.throws(()=>A.apply(data(),draft(),'2026-02-30','new','now'));let d=draft();d.values.constructor='bad';assert.throws(()=>A.apply(data(),d,'2026-11-08','new','now'));
 d=draft('action');d.values.title='';assert.throws(()=>A.apply(data(),d,'2026-11-08','new','now'));
});
test('raw archive backups retain incomplete rows, timestamps, sources and are cloned without truncation',()=>{
 const b=[{schemaVersion:1,sheetId:'fixture',fetchedAt:'2026-11-08T00:00:00Z',tabExists:true,rows:[['header'],['partial','1',true,4]]}];
 const out=A.bundles(b);assert.equal(JSON.stringify(out),JSON.stringify(b));out[0].rows[1][0]='changed';assert.equal(b[0].rows[1][0],'partial');
});
test('malformed backup rows, metadata, excessive rows and unexpected fields are rejected',()=>{
 const b={schemaVersion:1,sheetId:'fixture',fetchedAt:'2026-11-08',tabExists:true,rows:[]};
 for(const bad of [{...b,extra:1},{...b,fetchedAt:'no'},{...b,rows:[Array(11).fill('x')]},{...b,rows:[[{}]]},{...b,rows:Array(10002).fill([])},{...b,tabExists:false,rows:[['x']]}])assert.throws(()=>A.bundles([bad]));
});
