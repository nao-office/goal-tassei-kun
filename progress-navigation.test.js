// Navigation confirmation uses synthetic forms only; no user storage or network.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inline=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name){const m=new RegExp('  (?:async )?function '+name+'\\(').exec(inline);assert.ok(m,name);const rest=inline.slice(m.index),end=rest.slice(1).search(/\n  (?:async )?function /);return end<0?rest:rest.slice(0,end+1);}
function fixture(){
  const c={window:{},document:{getElementById:()=>({scrollIntoView(){}})}};vm.createContext(c);vm.runInContext(fs.readFileSync('goal-progress.js','utf8'),c);
  const P=c.window.GoalProgress,data={goals:[],entries:{},progress:P.empty()},counts={confirm:0,render:0,save:0,go:0,morning:0};let allow=false;
  const ctx={data,confirmDiscard(){counts.confirm++;return allow;},render(){counts.render++;},save(){counts.save++;return true;},toast(){},go(){counts.go++;},toMorning(){counts.morning++;}};
  return {P,data,ctx,counts,allow:v=>allow=v,click:(kind,extra={})=>P.capture(ctx,{target:{closest:()=>({dataset:{progressAction:kind,...extra}})}})};
}
for(const kind of ['mode','open-morning','cancel-edit','edit','idea-to-action','plan-today','plan-this-week','toggle','today','open-review','review-to-today'])test('cancel '+kind+' keeps drafts and records without side effects',()=>{
  const f=fixture();f.data.progress.actions=[{id:'a1',title:'行動',status:'未着手'}];f.data.progress.actionIdeas=[{id:'a1',title:'候補'}];f.data.progress.weekPlans=[{id:'a1',keyAction:'計画'}];
  const before=JSON.stringify(f.data);assert.equal(f.click(kind,{id:'a1',mode:'review',week:'2026-11-09',goalId:'g1'}),true);
  assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.counts,{confirm:1,render:0,save:0,go:0,morning:0});
});
test('week and goal cancellation restores the selector as well as the review context',()=>{
  const f=fixture();f.allow(true);f.click('open-review',{week:'2026-11-09',goalId:'g1'});f.allow(false);f.counts.render=0;
  const week={id:'pg-week',value:'2026-11-16',matches:()=>false};assert.equal(f.P.change(f.ctx,{target:week}),true);assert.equal(week.value,'2026-11-09');
  const goal={value:'g2',matches:s=>s==='[name="reviewGoalId"]'};assert.equal(f.P.change(f.ctx,{target:goal}),true);assert.equal(goal.value,'g1');assert.equal(f.counts.render,0);
});
test('approved week/goal changes render exactly once and unrelated changes never ask',()=>{
  const f=fixture();f.allow(true);f.P.change(f.ctx,{target:{id:'pg-week',value:'2026-11-16'}});f.P.change(f.ctx,{target:{value:'g2',matches:()=>true}});
  assert.equal(f.counts.confirm,2);assert.equal(f.counts.render,2);
  assert.equal(f.P.change(f.ctx,{target:{matches:()=>false}}),false);assert.equal(f.counts.confirm,2);
});
test('only editor fields count as unsaved, not review navigation selectors',()=>{
  const fields=[{id:'pg-week',value:'changed',defaultValue:'old'},{name:'reviewGoalId',value:'changed',defaultValue:'old'}];let prompts=0,allow=false;
  const c={document:{querySelectorAll:()=>fields},confirm:()=>{prompts++;return allow;}};vm.createContext(c);
  vm.runInContext(source('unsavedFormEdits')+source('confirmDiscardFormEdits')+source('warnBeforeUnload'),c);
  assert.equal(c.confirmDiscardFormEdits(),true);assert.equal(prompts,0);
  fields.push({tagName:'TEXTAREA',value:'書きかけ',defaultValue:''});
  assert.equal(c.confirmDiscardFormEdits(),false);assert.equal(prompts,1);
  allow=true;assert.equal(c.confirmDiscardFormEdits(),true);assert.equal(prompts,2);
  let prevented=0;const event={preventDefault:()=>prevented++};c.warnBeforeUnload(event);assert.equal(prevented,1);assert.equal(event.returnValue,'');
  fields.pop();c.warnBeforeUnload({preventDefault:()=>prevented++});assert.equal(prevented,1);
});
test('main navigation cancellation changes neither date, tab, sync review nor scroll',()=>{
  const calls=[];let allow=false;
  const c={tab:'sync',activeDate:'2026-11-01',followToday:false,observedToday:'2026-11-01',confirmDiscardFormEdits:()=>allow,jstToday:()=>{calls.push('date');return '2026-11-13';},clearManualSyncReview:()=>calls.push('clear'),render:()=>calls.push('render'),scrollTo:()=>calls.push('scroll'),autoSyncTick:()=>calls.push('sync')};
  vm.createContext(c);vm.runInContext(source('go'),c);c.go('progress');assert.deepEqual(calls,[]);assert.equal(c.tab,'sync');assert.equal(c.activeDate,'2026-11-01');
  allow=true;c.go('progress');assert.equal(c.tab,'progress');assert.equal(c.activeDate,'2026-11-13');assert.deepEqual(calls,['date','clear','render','scroll','sync']);
});
