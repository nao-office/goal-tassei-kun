const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const inline=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(inline);
function source(name){
  const start=inline.indexOf('  function '+name+'(');
  assert.notEqual(start,-1,name);
  const end=inline.indexOf('\n  function ',start+1);
  return inline.slice(start,end);
}
const fields=['fit','normal','futureAction','valuableAction','minimumAction','withoutAction'];
function fixture(){
  const c={activeDate:'2026-11-04',tab:'morning',storageError:false,
    data:{entries:{'2026-11-03':{tomorrow:'前夜の一歩'},'2026-11-04':Object.fromEntries(fields.map(k=>[k,'保存済み '+k]))},goalIdeas:[{id:'seed',theme:'仕事',field:'理由',question:'なぜ大切？',content:'前の会話',state:'要確認'}]},
    jstToday:()=> '2026-11-04',featuredGoal:()=>null,goalHeadline:()=>'',goalIntro:()=>'',header:()=>'',
    saves:0,schedules:0,renders:0,confirmations:[],toasts:[],destinations:[],allow:false,
    GoalProgress:{capture:()=>false},progressCtx:()=>({}),navigator:{},fieldNames:fields};
  c.save=()=>{c.saves++;return true;};c.scheduleAutoSave=()=>c.schedules++;
  c.render=()=>c.renders++;c.confirm=q=>{c.confirmations.push(q);return c.allow;};
  c.showToast=x=>c.toasts.push(x);c.go=(...x)=>c.destinations.push(x);
  const handlers={};c.document={addEventListener:(event,fn)=>handlers[event]=fn};
  vm.createContext(c);
  for(const name of ['isoJst','dayShift','formatDate','esc','txt','entry','isPlanned','button','field','renderPreviousAction','usePreviousAction','renderMorning','activeGoalIdeas','renderMorningGoalIdea','goalIdeaPrompt'])vm.runInContext(source(name),c);
  for(const event of ['input','click'])vm.runInContext(inline.split('\n').find(line=>line.startsWith("  document.addEventListener('"+event+"',")&&line.endsWith("});")),c);
  c.click=(action,extra={})=>handlers.click({target:{closest:selector=>(selector==='[data-action]'||selector==='[data-action="'+action+'"]')?{dataset:{action,...extra}}:null}});
  c.input=(key,value)=>handlers.input({target:{matches:selector=>selector==='[data-entry]',dataset:{entry:key},value}});
  return c;
}
test('morning starts with previous action and changes prompt, then all existing fields, then optional deepening',()=>{
  const c=fixture(),before=JSON.stringify(c.data),out=c.renderMorning();
  const markers=['前日に決めた、次の一歩','ほかにやることはある？ 変更する？',...fields.map(k=>'id="'+k+'"'),'今日のゴール深掘り（任意）','data-action="confirm-morning"'];
  let previous=-1;
  for(const marker of markers){const position=out.indexOf(marker);assert.ok(position>previous,marker);previous=position;}
  for(const key of fields){assert.equal(out.split('data-entry="'+key+'"').length-1,1);assert.match(out,new RegExp('保存済み '+key));}
  assert.equal(out.split('前日に決めた、次の一歩').length-1,1);
  assert.doesNotMatch(out,/<details|disabled|hidden/);
  assert.equal(JSON.stringify(c.data),before);assert.equal(c.saves,0);
});
test('empty or whitespace previous records never gate fields or create a copy action',()=>{
  for(const prior of [undefined,{}, {tomorrow:'  \n '}]){
    const c=fixture();c.data.entries['2026-11-03']=prior;
    const out=c.renderMorning();assert.match(out,/まだ記録されていません/);
    assert.doesNotMatch(out,/data-action="use-previous-action"/);
    for(const key of fields)assert.ok(out.includes('data-entry="'+key+'"'));
    const before=JSON.stringify(c.data);c.click('use-previous-action');assert.equal(JSON.stringify(c.data),before);assert.equal(c.saves,0);
  }
});
test('historical mornings use their own prior date across month and year boundaries',()=>{
  for(const [date,previous] of [['2026-11-01','2026-10-31'],['2027-01-01','2026-12-31']]){
    const c=fixture();c.activeDate=date;c.data.entries[date]={};c.data.entries[previous]={tomorrow:'その日の前夜'};
    const out=c.renderMorning();assert.match(out,/その日の前夜/);assert.doesNotMatch(out,/前夜の一歩/);assert.match(out,/data-action="today"/);
    c.click('use-previous-action');assert.equal(c.data.entries[date].valuableAction,'その日の前夜');assert.equal(c.data.entries['2026-11-04'].valuableAction,'保存済み valuableAction');
  }
});
test('copy remains explicit, cancellable and restricted to valuableAction including repeated clicks',()=>{
  const c=fixture(),before=JSON.stringify(c.data);c.renderMorning();c.click('use-previous-action');
  assert.equal(JSON.stringify(c.data),before);assert.equal(c.saves,0);assert.equal(c.confirmations.length,1);
  c.allow=true;c.click('use-previous-action');
  const expected=JSON.parse(before);expected.entries[c.activeDate].valuableAction='前夜の一歩';
  assert.equal(JSON.stringify(c.data),JSON.stringify(expected));assert.equal(c.saves,1);assert.equal(c.schedules,1);
  c.allow=false;c.click('use-previous-action');assert.equal(c.saves,1);assert.equal(c.confirmations.length,3);
});
test('copy to blank value needs no overwrite confirmation and never supplies minimum or other answers',()=>{
  const c=fixture();c.data.entries[c.activeDate]={};c.click('use-previous-action');
  assert.deepEqual(c.data.entries[c.activeDate],{valuableAction:'前夜の一歩'});assert.equal(c.confirmations.length,0);
});
test('all six existing answers remain directly editable and survive rerendering',()=>{
  const c=fixture();for(const key of fields)c.input(key,'変更 '+key);
  const out=c.renderMorning();for(const key of fields)assert.ok(out.includes('変更 '+key));
  assert.equal(c.saves,6);assert.equal(c.schedules,6);assert.equal(c.data.entries['2026-11-03'].tomorrow,'前夜の一歩');
});
test('optional question selects one eligible seed and safely escapes stored content',()=>{
  const c=fixture();c.data.goalIdeas=[{id:'hold',question:'保留質問',state:'保留',updated:'9999'},{id:'done',question:'完了質問',state:'ゴール反映済み'},{id:'empty',question:'  '},{id:'new',question:'<script>質問</script>',theme:'<テーマ>',content:'<内容>',updated:'2026-11-04'},{id:'old',question:'古い質問',updated:'2026-11-01'}];
  const before=JSON.stringify(c.data),out=c.renderMorning();
  assert.match(out,/&lt;script&gt;質問&lt;\/script&gt;/);assert.match(out,/&lt;テーマ&gt;/);assert.match(out,/&lt;内容&gt;/);
  assert.doesNotMatch(out,/保留質問|完了質問|古い質問|<script>/);assert.equal(out.split('data-action="copy-goal-question"').length-1,1);
  assert.equal(JSON.stringify(c.data),before);
});
test('prior action text is escaped rather than treated as markup',()=>{
  const c=fixture();c.data.entries['2026-11-03'].tomorrow='<img src=x onerror=alert(1)>';
  assert.match(c.renderMorning(),/&lt;img/);assert.doesNotMatch(c.renderMorning(),/<img/);
});
test('no pending question hides only optional section and confirmation never requires deepening',()=>{
  const c=fixture();c.data.goalIdeas=[];const out=c.renderMorning();assert.doesNotMatch(out,/今日のゴール深掘り/);
  c.click('confirm-morning');assert.deepEqual(c.destinations,[['home']]);assert.equal(c.saves,1);
  c.data.entries[c.activeDate].minimumAction='';c.click('confirm-morning');assert.equal(c.destinations.length,1);assert.match(c.toasts.at(-1),/最低限の完了ライン/);
});
test('copied conversation prompt follows morning order and keeps seed provisional',async()=>{
  const c=fixture(),before=JSON.stringify(c.data);let copied;
  c.navigator.clipboard={writeText:async text=>{copied=text;}};
  c.click('copy-goal-question',{ideaId:'seed'});await Promise.resolve();
  assert.match(copied,/まず前日の「明日の一歩」を確認/);assert.match(copied,/4つの問いの後、希望する場合だけ/);assert.match(copied,/1問深掘り/);assert.match(copied,/既に答えた問いは繰り返さない/);assert.match(copied,/未確定の内容は勝手に正式なゴールとして扱わない/);assert.match(copied,/次の質問：なぜ大切？/);
  assert.equal(JSON.stringify(c.data),before);assert.equal(c.saves,0);
});
test('unavailable and rejected clipboard remain non-destructive',async()=>{
  const c=fixture(),before=JSON.stringify(c.data);c.click('copy-goal-question',{ideaId:'seed'});assert.match(c.toasts.at(-1),/会話で伝えて/);
  c.navigator.clipboard={writeText:()=>Promise.reject(Error('denied'))};c.click('copy-goal-question',{ideaId:'seed'});await new Promise(resolve=>setImmediate(resolve));assert.match(c.toasts.at(-1),/コピーできませんでした/);assert.equal(JSON.stringify(c.data),before);assert.equal(c.saves,0);
});
