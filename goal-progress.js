/* Goal Tassei Kun: actions and weekly reflection, browser-local data. */
window.GoalProgress = (function () {
  'use strict';
  var mode = 'actions', editing = '', selectedWeek = '', selectedGoal = '';
  var STATUSES = ['未着手','進行中','完了','保留'];
  function text(v, max) { return typeof v === 'string' ? v.slice(0, max || 4000) : ''; }
  function html(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function now() { return new Date().toISOString(); }
  function uid() { return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  function today() { return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
  function weekMonday(date) { var d = new Date((/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today()) + 'T12:00:00+09:00'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay()+6)%7); return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
  function empty() { return {actions:[], actionHistory:[], reviews:[], reviewHistory:[]}; }
  var actionKeys = ['id','goalId','title','minimum','due','priority','status','expected','facts','gap','technical','adaptive','createdAt','updatedAt','completedAt'];
  var reviewKeys = ['id','week','goalId','facts','gap','technical','adaptive','learning','focus','keyAction','minimum','createdAt','updatedAt'];
  function cleanRecord(source, keys) {
    var result = {}; keys.forEach(function(k){result[k] = text(source[k],k==='id'||k==='goalId'?180:4000);});
    return result;
  }
  function normalize(p) {
    var base = empty();
    if (!p || typeof p !== 'object' || Array.isArray(p)) return base;
    [['actions',actionKeys,1000],['reviews',reviewKeys,520]].forEach(function(spec){
      base[spec[0]] = (Array.isArray(p[spec[0]]) ? p[spec[0]] : []).slice(0,spec[2]).filter(function(x){return x && typeof x==='object' && !Array.isArray(x);}).map(function(x){return cleanRecord(x,spec[1]);}).filter(function(x){return x.id;});
    });
    [['actionHistory',actionKeys,2500],['reviewHistory',reviewKeys,1500]].forEach(function(spec){
      base[spec[0]] = (Array.isArray(p[spec[0]]) ? p[spec[0]] : []).slice(-spec[2]).filter(function(x){return x && typeof x==='object' && !Array.isArray(x);}).map(function(x){
        return {at:text(x.at,100),id:text(x.id,180),reason:text(x.reason,1000),before:x.before&&typeof x.before==='object'?cleanRecord(x.before,spec[1]):null,after:x.after&&typeof x.after==='object'?cleanRecord(x.after,spec[1]):null};
      });
    });
    return base;
  }
  function goalName(g) { return [g.period, g.theme, g.qualitative || (g.quantitative ? g.quantitative+(g.unit?' '+g.unit:'') : '')].filter(Boolean).join('｜').slice(0,135); }
  function goalSelect(goals, selected, name) {
    var found = goals.some(function(g){return g.id===selected;});
    var out = '<select name="'+name+'"><option value="">ゴールを指定しない</option>';
    if(selected && !found) out += '<option value="'+html(selected)+'" selected>以前のゴール（同期先に存在しません）</option>';
    goals.filter(function(g){return g.status!=='終了';}).forEach(function(g){out+='<option value="'+html(g.id)+'"'+(selected===g.id?' selected':'')+'>'+html(goalName(g))+'</option>';});
    return out + '</select>';
  }
  function input(label,name,val,type) {
    return '<div class="pg-field"><label>'+html(label)+(type==='textarea'?'<textarea name="'+name+'" maxlength="4000" rows="2">'+html(val)+'</textarea>':'<input name="'+name+'" type="'+(type||'text')+'" maxlength="4000" value="'+html(val)+'">')+'</label></div>';
  }
  function area(label,name,val,placeholder) {
    return '<div class="pg-field"><label>'+html(label)+'<textarea name="'+name+'" maxlength="4000" rows="3" placeholder="'+html(placeholder||'')+'">'+html(val)+'</textarea></label></div>';
  }
  function button(label, action, extra, className) {
    return '<button type="button" class="button '+(className||'outline')+'" data-progress-action="'+action+'" '+(extra||'')+'>'+label+'</button>';
  }
  function itemGoal(goals,id) { return goals.find(function(g){return g.id===id;}); }
  function renderActionForm(data) {
    var p=data.progress, a=p.actions.find(function(x){return x.id===editing;})||{};
    var fields = '<div class="pg-columns">'+input('アクション名（100%自分で実行できる行動）','title',a.title||'')+
      '<div class="pg-field"><label>関連するゴール'+goalSelect(data.goals||[],a.goalId||'','goalId')+'</label></div>'+
      input('忙しくても実行する最低限のライン','minimum',a.minimum||'')+
      input('期限','due',a.due||'','date')+
      '<div class="pg-field"><label>優先度<select name="priority">'+['最重要','高','通常'].map(function(x){return '<option'+((a.priority||'通常')===x?' selected':'')+'>'+x+'</option>';}).join('')+'</select></label></div>'+
      '<div class="pg-field"><label>進捗<select name="status">'+STATUSES.map(function(x){return '<option'+((a.status||'未着手')===x?' selected':'')+'>'+x+'</option>';}).join('')+'</select></label></div></div>';
    fields+=area('成果指標・完了条件','expected',a.expected||'','何をもって完了とする？');
    fields+='<details class="pg-details"><summary>現状と課題も記録する</summary>'+area('事実・現在地','facts',a.facts||'')+area('GOALとのGAP','gap',a.gap||'')+area('技術課題（知識・方法・仕組み）','technical',a.technical||'')+area('適応課題（習慣・向き合い方・選択）','adaptive',a.adaptive||'')+'</details>';
    if(a.id) fields+=input('変更理由（変更履歴に記録）','reason','','text');
    return '<section class="form-panel" id="pg-action-form"><div class="panelh"><h3>'+(a.id?'アクションを編集':'新しいアクションを登録')+'</h3><span class="chip blue">自分でコントロールできる一歩</span></div>'+
      '<p class="smallmuted">ゴールに関連付けられます。新しいゴールをGoogle Sheetsから同期した後でも選択可能です。</p>'+fields+
      '<div class="foot-actions">'+button(a.id?'変更を保存':'アクションを追加','save-action','','dark')+(a.id?button('編集をやめる','cancel-edit'):'')+'</div></section>';
  }
  function renderActions(ctx) {
    var data=ctx.data,p=data.progress,active=p.actions.filter(function(a){return a.status!=='完了';});
    var due=active.filter(function(a){return a.due && a.due<today();}).length;
    var cards=p.actions.slice().sort(function(a,b){return (a.status==='完了')-(b.status==='完了') || (a.priority==='最重要'?-1:0)-(b.priority==='最重要'?-1:0) || (a.due||'9999').localeCompare(b.due||'9999');});
    var result='<div class="pg-metrics"><div><b>'+active.length+'</b><span>進行中・未着手</span></div><div><b>'+p.actions.filter(function(a){return a.status==='完了';}).length+'</b><span>完了したアクション</span></div><div><b>'+due+'</b><span>期限を過ぎたアクション</span></div></div>';
    result+=renderActionForm(data);
    result+='<section class="form-panel"><div class="panelh"><h3>アクション一覧</h3><span class="chip gray">'+cards.length+'件</span></div>';
    if(!cards.length)result+='<p class="empty">最初のアクションを登録しよう。売上や相手の返事ではなく、あなた自身が実行できる行動を設定してね。</p>';
    cards.forEach(function(a){
      var g=itemGoal(data.goals||[],a.goalId);
      result+='<article class="pg-action-card"><div class="pg-card-title"><strong>'+html(a.title)+'</strong><span class="chip '+(a.status==='完了'?'':'gray')+'">'+html(a.status)+'</span></div>';
      if(g)result+='<div class="smallmuted">🎯 '+html(goalName(g))+'</div>';
      else if(a.goalId)result+='<div class="smallmuted">関連ゴール：次回のGoogle同期で再確認</div>';
      if(a.minimum)result+='<p class="pg-mini"><b>最低限の完了ライン：</b>'+html(a.minimum)+'</p>';
      if(a.expected)result+='<p class="pg-mini"><b>完了条件：</b>'+html(a.expected)+'</p>';
      result+='<div class="smallmuted">優先度 '+html(a.priority||'通常')+' ・ 期限 '+html(a.due||'未設定')+'</div><div class="foot-actions">'+
        button('編集','edit','data-id="'+html(a.id)+'"')+
        button(a.status==='完了'?'未着手に戻す':'完了にする','toggle','data-id="'+html(a.id)+'"','secondary')+
        button('今日のワークに使う →','today','data-id="'+html(a.id)+'"','dark')+
        '</div></article>';
    });
    result+='</section></div>';return result;
  }
  function selectedReview(data) {
    var week=selectedWeek||weekMonday(today());
    return data.progress.reviews.find(function(r){return r.week===week && r.goalId===selectedGoal;})||{};
  }
  function renderReview(ctx) {
    var data=ctx.data,p=data.progress,week=selectedWeek||weekMonday(today()),r=selectedReview(data);
    var htmlPart='<section class="form-panel"><div class="panelh"><h3>週次ゴールレビュー</h3><span class="chip">VISION → GAP → ACTION</span></div>';
    htmlPart+='<p class="smallmuted">日々の朝・夜の記録を見ながら、事実と課題を整理しよう。同じ週・同じゴールの更新は履歴を残します。</p>';
    htmlPart+='<div class="pg-columns"><div class="pg-field"><label>対象週（月曜日）<input type="date" id="pg-week" value="'+html(week)+'"></label></div><div class="pg-field"><label>対象ゴール'+goalSelect(data.goals||[],selectedGoal,'reviewGoalId')+'</label></div></div>';
    var dates=Object.keys(data.entries||{}).filter(function(d){return d>=week && d<=shiftWeek(week,6);}).sort();
    htmlPart+='<details class="pg-details"><summary>この週の朝・夜の記録（'+dates.length+'日）</summary><div class="pg-daily">';
    dates.forEach(function(d){var e=data.entries[d]; htmlPart+='<div><b>'+html(d)+'</b> '+html(e.valuableAction||e.minimumAction||'記録あり')+(e.achievement?'<p>'+html(e.achievement)+'</p>':'')+(e.growth?'<p>成長：'+html(e.growth)+'</p>':'')+'</div>';});
    htmlPart+=(dates.length?'':'<p class="empty">この週の朝・夜の記録はありません。</p>')+'</div></details>';
    htmlPart+=area('① 今週、実際にできたこと（事実）','facts',r.facts||'');
    htmlPart+=area('② ゴールと現状のGAP','gap',r.gap||'');
    htmlPart+=area('③ 技術課題（方法・スキル・仕組み）','technical',r.technical||'');
    htmlPart+=area('④ 適応課題（習慣・思考・意思決定）','adaptive',r.adaptive||'');
    htmlPart+=area('⑤ 学び・以前の自分との差分','learning',r.learning||'');
    htmlPart+=area('⑥ 次週のフォーカス領域','focus',r.focus||'');
    htmlPart+=area('⑦ 最重要アクション（自分で実行できること）','keyAction',r.keyAction||'');
    htmlPart+=input('⑧ 最低限の完了ライン','minimum',r.minimum||'');
    if(r.id)htmlPart+=input('更新理由（変更履歴に記録）','reason','','text');
    htmlPart+='<div class="foot-actions">'+button(r.id?'週次レビューを更新':'週次レビューを保存','save-review','','dark')+
      (r.keyAction?button('最重要アクションを今日の朝ワークへ','review-to-today','','secondary'):'')+'</div></section>';
    htmlPart+='<section class="form-panel"><div class="panelh"><h3>過去の週次レビュー</h3><span class="chip gray">'+p.reviews.length+'件</span></div>';
    p.reviews.slice().sort(function(a,b){return b.week.localeCompare(a.week);}).slice(0,35).forEach(function(x){
      var g=itemGoal(data.goals||[],x.goalId);
      htmlPart+='<div class="pg-week-card"><div><b>'+html(x.week)+' の週</b><span class="smallmuted">　'+html(g?goalName(g):'全体レビュー')+'</span></div>'+
        '<p>'+html(x.learning||x.facts||x.keyAction||'記録済み')+'</p>'+button('開く','open-review','data-week="'+html(x.week)+'" data-goal-id="'+html(x.goalId)+'"')+'</div>';
    });
    if(!p.reviews.length)htmlPart+='<p class="empty">初回の週次レビューを保存すると、ここから振り返れます。</p>';
    return htmlPart+'</section>';
  }
  function shiftWeek(week,days) { var d=new Date(week+'T12:00:00+09:00');d.setUTCDate(d.getUTCDate()+days); return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
  function renderHistory(data) {
    var items=data.progress.actionHistory.map(function(x){return Object.assign({kind:'アクション'},x);}).concat(data.progress.reviewHistory.map(function(x){return Object.assign({kind:'週次レビュー'},x);}));
    items.sort(function(a,b){return b.at.localeCompare(a.at);});
    if(!items.length)return '<section class="form-panel"><p class="empty">変更履歴はまだありません。</p></section>';
    return '<section class="form-panel"><div class="panelh"><h3>アクション・週次レビューの変更履歴</h3><span class="chip gray">'+items.length+'件</span></div>'+
      '<p class="smallmuted">更新のたびに変更前後のスナップショットを保存します。ゴール自体の変更履歴は「ゴール設定」に表示されます。</p>'+
      items.slice(0,80).map(function(x){return '<div class="pg-week-card"><div class="smallmuted">'+html(x.at)+'　'+x.kind+'</div><strong>'+html((x.after||x.before||{}).title||(x.after||x.before||{}).week||'変更')+'</strong>'+
      '<p>変更前：'+html(x.before?(x.before.title||x.before.keyAction||x.before.facts||'登録済み')+' / '+(x.before.status||x.before.week||''):'なし')+'</p>'+
      '<p>変更後：'+html(x.after?(x.after.title||x.after.keyAction||x.after.facts||'登録済み')+' / '+(x.after.status||x.after.week||''):'なし')+'</p>'+
      (x.reason?'<p>理由：'+html(x.reason)+'</p>':'')+'</div>';}).join('')+'</section>';
  }
  function render(ctx) {
    var d=ctx.data;if(!d.progress)d.progress=empty();
    var e=(d.entries||{})[today()]||{}, next = e.valuableAction || e.minimumAction;
    return '<div class="topline"><div><div class="eyebrow">GOAL → GAP → ACTION</div><h1 class="heading">アクションと週次レビュー</h1><p class="subtitle">グループセッションが終わっても、自分で行動を続ける仕組み。</p></div></div>'+
      '<div class="pg-today"><div><b>今日の最重要アクション</b><p>'+html(next||'朝のワークで今日の一歩を決めよう')+'</p></div>'+button('朝のワークへ →','open-morning','','secondary')+'</div>'+
      '<div class="goal-filter-bar">'+[['actions','アクション'],['review','週次レビュー'],['history','変更履歴']].map(function(x){return '<button type="button" class="'+(mode===x[0]?'active':'')+'" data-progress-action="mode" data-mode="'+x[0]+'">'+x[1]+'</button>';}).join('')+'</div>'+
      (mode==='actions'?renderActions(ctx):mode==='review'?renderReview(ctx):renderHistory(d));
  }
  function values(form,names) {
    var out={};names.forEach(function(n){ var e=form.querySelector('[name="'+n+'"]');out[n]=e?text(e.value):''; });return out;
  }
  function capture(ctx,event) {
    var el=event.target.closest('[data-progress-action]'); if(!el)return false;
    var p=ctx.data.progress,kind=el.dataset.progressAction,id=el.dataset.id;
    if(kind==='mode'){mode=el.dataset.mode;ctx.render();return true;}
    if(kind==='open-morning'){ctx.go('morning');return true;}
    if(kind==='cancel-edit'){editing='';ctx.render();return true;}
    if(kind==='edit'){editing=id;ctx.render();document.getElementById('pg-action-form').scrollIntoView({behavior:'smooth'});return true;}
    if(kind==='save-action'){
      var form=document.getElementById('pg-action-form'),v=values(form,['title','goalId','minimum','due','priority','status','expected','facts','gap','technical','adaptive','reason']);
      if(!v.title.trim()){ctx.toast('アクション名を入力してね');return true;}
      if(v.due && !/^\d{4}-\d{2}-\d{2}$/.test(v.due)){ctx.toast('期限の形式を確認してください');return true;}
      var old=p.actions.find(function(a){return a.id===editing;}),before=old?Object.assign({},old):null;
      var after=Object.assign({},old||{id:uid(),createdAt:now()},v,{updatedAt:now(),completedAt:v.status==='完了'?(old&&old.completedAt||now()):''});
      delete after.reason;
      if(old){p.actions[p.actions.indexOf(old)]=after;}else p.actions.push(after);
      p.actionHistory.push({at:now(),id:after.id,reason:v.reason||(old?'更新':'新規登録'),before:before,after:Object.assign({},after)});
      editing='';ctx.save();ctx.render();ctx.toast('アクションを保存したよ');return true;
    }
    if(kind==='toggle'){
      var a=p.actions.find(function(x){return x.id===id;});if(!a)return true;
      var beforeToggle=Object.assign({},a);a.status=a.status==='完了'?'未着手':'完了';a.updatedAt=now();a.completedAt=a.status==='完了'?now():'';
      p.actionHistory.push({at:now(),id:a.id,reason:'進捗を更新',before:beforeToggle,after:Object.assign({},a)});
      ctx.save();ctx.render();ctx.toast('進捗を更新したよ');return true;
    }
    if(kind==='today'){
      var a=p.actions.find(function(x){return x.id===id;});if(!a)return true;
      ctx.toMorning(a.title,a.minimum,a.id,a.goalId);return true;
    }
    if(kind==='open-review'){
      selectedWeek=el.dataset.week;selectedGoal=el.dataset.goalId||'';mode='review';ctx.render();return true;
    }
    if(kind==='save-review'){
      var form=document.getElementById('pg-review-form'); if(!form)return true;
      var w=values(form,['facts','gap','technical','adaptive','learning','focus','keyAction','minimum','reason']);
      if(!Object.keys(w).some(function(k){return k!=='reason' && w[k].trim();})){ctx.toast('今週の事実や気づきを1つ入力してね');return true;}
      var week=selectedWeek||weekMonday(today()),oldR=selectedReview(ctx.data),beforeR=oldR.id?Object.assign({},oldR):null;
      var review=Object.assign({},oldR.id?oldR:{id:uid(),createdAt:now()},w,{week:week,goalId:selectedGoal,updatedAt:now()});
      delete review.reason;
      if(oldR.id)p.reviews[p.reviews.indexOf(oldR)]=review;else p.reviews.push(review);
      p.reviewHistory.push({at:now(),id:review.id,reason:w.reason||(oldR.id?'週次レビュー更新':'初回レビュー'),before:beforeR,after:Object.assign({},review)});
      ctx.save();ctx.render();ctx.toast('週次レビューを保存したよ');return true;
    }
    if(kind==='review-to-today'){
      var r=selectedReview(ctx.data);if(r.keyAction)ctx.toMorning(r.keyAction,r.minimum,'',r.goalId);return true;
    }
    return false;
  }
  function change(ctx,event) {
    if(event.target.id==='pg-week'){selectedWeek=weekMonday(event.target.value);ctx.render();return true;}
    if(event.target.matches('[name="reviewGoalId"]')){selectedGoal=event.target.value;ctx.render();return true;}
    return false;
  }
  return {empty:empty,normalize:normalize,render:render,capture:capture,change:change};
})();