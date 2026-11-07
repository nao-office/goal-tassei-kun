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
 const c={txt:x=>String(x??'').trim(),data:{entries:{yesterday:{tomorrow:'next'}}},dayShift:()=> 'yesterday',activeDate:'today',entry:()=>current,confirm:()=>false,save:()=>{saves++;return true;},scheduleAutoSave:()=>{},render:()=>{}};
 vm.createContext(c);vm.runInContext(source('usePreviousAction'),c);c.usePreviousAction();assert.equal(current.valuableAction,'existing');assert.equal(saves,0);c.confirm=()=>true;c.usePreviousAction();assert.equal(current.valuableAction,'next');assert.equal(saves,1);
});
test('sync notice distinguishes offline and disabled states without a Sheets request',()=>{
 const el={};const c={document:{getElementById:id=>id==='autoSyncNotice'?el:null},autoSyncEnabled:false,autoWriteToken:false,autoSyncBlocked:false,storageError:false,navigator:{onLine:true},esc:x=>x,button:()=>'<button>確認</button>',syncEvidenceLines:()=>['端末保存','Sheets送信','Sheets側の確認','ゴールはGoogle連携で手動同期']};
 vm.createContext(c);vm.runInContext(source('updateAutoSyncNotice'),c);c.updateAutoSyncNotice();assert.equal(el.hidden,false);assert.match(el.innerHTML,/自動同期オフ/);
 Object.assign(c,{autoSyncEnabled:true,autoWriteToken:true,autoTokenExpiresAt:Date.now()+60000,googleToken:'test',autoPending:()=>1,autoSyncBlocked:false,autoAuthBusy:false,navigator:{onLine:false}});c.updateAutoSyncNotice();assert.match(el.innerHTML,/オフライン/);assert.match(el.innerHTML,/ゴールはGoogle連携で手動同期/);
});

test('growth history groups months and keeps each day closed with original navigation',()=>{
 const c={data:{entries:{'2026-11-03':{growth:'<成長>',valuableAction:'新しい行動'},'2026-10-29':{achievement:'できたこと'}},lessons:[]},txt:x=>String(x??'').trim(),hasMorning:e=>!!e.valuableAction,header:()=>'',esc:x=>String(x).replaceAll('<','&lt;').replaceAll('>','&gt;'),formatDate:d=>d,statusTag:()=>'<span>記録済み</span>'};
 vm.createContext(c);vm.runInContext(source('renderHistory'),c);const before=JSON.stringify(c.data);const out=c.renderHistory();
 assert.match(out,/2026年11月/);assert.match(out,/2026年10月/);
 assert.equal((out.match(/class="ui-item"/g)||[]).length,2);
 assert.match(out,/data-date="2026-11-03"/);assert.match(out,/data-review-date="2026-11-03"/);
 assert.match(out,/&lt;成長&gt;/);assert.equal(JSON.stringify(c.data),before);
});

function goalFixture(data){
 const c={data,GOAL_PERIODS:['1か月','3か月','1年','3年','5年'],goalPeriodFilter:'all',goalThemeFilter:'all',syncConfig:{sheetId:''},header:()=>'',esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),renderGoalEditor:g=>'<div data-editor="'+(g?g.id:'new')+'"></div>',goalField:()=>'',button:(label,action,style,attrs='')=>'<button data-action="'+action+'" '+attrs+'>'+label+'</button>'};
 vm.createContext(c);
 for(const name of ['goalThemeName','groupGoalsByTheme','activeGoalIdeas','renderGoalIdeaCard','renderGoalIdeas','renderGoal'])vm.runInContext(source(name),c);
 return c;
}
test('goals group by genre across periods and preserve filters, editors and stored data',()=>{
 const c=goalFixture({goals:[
  {id:'g1',period:'1か月',theme:'仕事・キャリア',qualitative:'<目標>',why:'理由',status:'進行中'},
  {id:'g2',period:'1年',theme:'仕事・キャリア',qualitative:'長期目標'},
  {id:'g3',period:'1か月',theme:'家族・人間関係',qualitative:'家族の目標'},
  {id:'g4',period:'1か月',theme:'アプリ開発・事業',qualitative:'開発の目標'},
  {id:'g5',period:'1か月',theme:'仕事・キャリア',status:'終了'}
 ],goalHistory:[],goalChecks:[],goalIdeas:[]});
 const before=JSON.stringify(c.data),out=c.renderGoal();
 assert.ok(out.indexOf('現在のゴール')<out.indexOf('会話で育てるゴールの種'));
 assert.match(out,/<details class="goal-card ui-item"><summary>/);assert.match(out,/&lt;目標&gt;/);
 assert.match(out,/data-editor="g1"/);assert.match(out,/data-goal-filter="3か月"/);
 const groups=out.split('<details class="ui-group goal-theme-group">').slice(1);
 assert.equal(groups.length,3);assert.match(groups[0],/<summary><span>仕事・キャリア<\/span>/);
 assert.match(groups[0],/2件のゴール/);assert.match(groups[0],/data-editor="g1"/);assert.match(groups[0],/data-editor="g2"/);
 assert.doesNotMatch(groups[0],/data-editor="g3"/);assert.doesNotMatch(out,/data-editor="g5"/);
 assert.match(groups[1],/<summary><span>アプリ開発・事業<\/span>/);assert.match(groups[2],/<summary><span>家族・人間関係<\/span>/);
 c.goalPeriodFilter='1年';c.goalThemeFilter='仕事・キャリア';const filtered=c.renderGoal();
 assert.match(filtered,/data-editor="g2"/);assert.doesNotMatch(filtered,/data-editor="g[134]"/);
 assert.equal(JSON.stringify(c.data),before);
});
test('all pending goal ideas remain reachable by genre, including records beyond the first twelve',()=>{
 const goalIdeas=Array.from({length:14},(_,i)=>({id:'idea-'+i,theme:i%2?'家族・人間関係':'アプリ開発・事業',content:'材料'+i,state:'要確認',date:'2026-11-03',question:'次の質問',source:'会話'}));
 goalIdeas.push({id:'career',theme:'仕事・キャリア',content:'<script>危険</script>'},{id:'custom',theme:'趣味・学び',content:'自由なジャンル'},{id:'unset',theme:'',content:'未分類'},{id:'done',theme:'家族・人間関係',state:'ゴール反映済み'},{id:'hold',theme:'家族・人間関係',state:'保留'});
 const c=goalFixture({goalIdeas}),before=JSON.stringify(c.data),out=c.renderGoalIdeas();
 const groups=out.split('<details class="ui-group goal-theme-group">').slice(1);
 assert.equal(groups.length,5);assert.match(groups[0],/<summary><span>仕事・キャリア<\/span>/);
 assert.match(groups[1],/7件の材料/);assert.match(groups[1],/data-idea-id="idea-12"/);assert.doesNotMatch(groups[1],/data-idea-id="idea-13"/);
 assert.match(groups[2],/data-idea-id="idea-13"/);assert.match(out,/趣味・学び/);assert.match(out,/ジャンル未設定/);
 assert.equal((out.match(/data-idea-id=/g)||[]).length,17);
 assert.doesNotMatch(out,/data-idea-id="(?:done|hold)"/);assert.doesNotMatch(out,/<script>/);assert.match(out,/&lt;script&gt;/);
 assert.match(out,/<details class="goal-card goal-idea-card ui-item"><summary>/);assert.match(out,/次の質問/);assert.match(out,/出典：会話/);
 assert.equal(JSON.stringify(c.data),before);
});
test('goal ideas distinguish an empty collection from a collection with no pending items',()=>{
 const c=goalFixture({goalIdeas:[]});assert.match(c.renderGoalIdeas(),/最初|材料を1つ発見/);
 c.data.goalIdeas=[{id:'done',state:'ゴール反映済み'}];assert.match(c.renderGoalIdeas(),/今、確認・深掘りする材料はありません/);
});
