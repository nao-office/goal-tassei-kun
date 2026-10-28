window.GoalManagementSync=(function(){
  'use strict';
  const GOAL_HEADERS=['ゴールID','テーマ','期間','定性ゴール','定量ゴール（値・条件）','単位','達成期限','未来の景色','在り方（BE）','ゴールの理由','状態','作成日','最終更新日','最終確認日','メモ'];
  const HISTORY_HEADERS=['変更日時（JST）','ゴールID','操作','テーマ','期間','定性ゴール','定量ゴール（値・条件）','単位','達成期限','未来の景色','在り方（BE）','ゴールの理由','状態','変更理由','変更前の更新日時','記録元'];
  const HISTORY_SYNC_HEADERS=[...HISTORY_HEADERS,'変更ID','変更前スナップショット（JSON）','変更後スナップショット（JSON）'];
  const CHECK_HEADERS=['確認日時（JST）','ゴールID','テーマ','期間','確認結果','確認メモ'];
  const IDEA_HEADERS=['材料ID','記録日（JST）','テーマ','期間','項目','会話で明らかになった内容','状態','次に確認したい質問','関連ゴールID','出典・会話日','最終更新日（JST）','メモ'];
  const LEGACY_GOAL_ID='__goal-tassei-legacy-vision__';
  const goalKeys=['theme','period','qualitative','quantitative','unit','deadline','scene','be','why','status','created','updated','checked','memo'];
  const ideaKeys=['date','theme','period','field','content','state','question','goalId','source','updated','memo'];
  const MAX_ROWS=5001;
  const cell=value=>String(value??'');
  const meaningful=value=>cell(value).trim()!=='';
  function clone(value){return JSON.parse(JSON.stringify(value));}
  function goalRow(goal){
    return [goal.id,goal.theme,goal.period,goal.qualitative,goal.quantitative,goal.unit,goal.deadline,
      goal.scene,goal.be,goal.why,goal.status,goal.created,goal.updated,goal.checked,goal.memo].map(cell);
  }
  function legacyRow(goal){
    return [LEGACY_GOAL_ID,'旧形式VISION・BE','',goal.title,'','','',goal.scene,goal.identity,goal.why,
      '旧形式','','','',''].map(cell);
  }
  function ideaRow(idea){
    return [idea.id,idea.date,idea.theme,idea.period,idea.field,idea.content,idea.state,idea.question,
      idea.goalId,idea.source,idea.updated,idea.memo].map(cell);
  }
  function goalFromRow(row){
    return {id:cell(row[0]),theme:cell(row[1]),period:cell(row[2]),qualitative:cell(row[3]),
      quantitative:cell(row[4]),unit:cell(row[5]),deadline:cell(row[6]),scene:cell(row[7]),
      be:cell(row[8]),why:cell(row[9]),status:cell(row[10])||'進行中',created:cell(row[11]),
      updated:cell(row[12]),checked:cell(row[13]),memo:cell(row[14])};
  }
  function ideaFromRow(row){
    return {id:cell(row[0]),date:cell(row[1]),theme:cell(row[2]),period:cell(row[3]),field:cell(row[4]),
      content:cell(row[5]),state:cell(row[6])||'要確認',question:cell(row[7]),goalId:cell(row[8]),
      source:cell(row[9]),updated:cell(row[10]),memo:cell(row[11])};
  }
  function goalRows(data){
    const records=(data.goals||[]).filter(goal=>goal&&goal.id&&goal.id!==LEGACY_GOAL_ID).map(goalRow);
    if(Object.values(data.goal||{}).some(meaningful))records.push(legacyRow(data.goal));
    return records;
  }
  function mapRecords(rows,width,name){
    const records=new Map();
    for(const [offset,raw] of (rows||[]).slice(1,MAX_ROWS).entries()){
      const row=Array.from({length:width},(_,index)=>cell(raw?.[index]));
      const id=row[0];
      if(!id)continue;
      if(records.has(id))throw Error(name+'に同じIDが複数あります：'+id);
      records.set(id,{row,index:offset+2});
    }
    return records;
  }
  function historySnapshot(row){
    const result={};
    ['theme','period','qualitative','quantitative','unit','deadline','scene','be','why','status']
      .forEach((key,index)=>result[key]=cell(row[index+3]));
    return result;
  }
  function parseJsonCell(value,label){
    if(!meaningful(value))return null;
    try{
      const parsed=JSON.parse(value);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('形式');
      return parsed;
    }catch(error){throw Error(label+'のJSONが壊れているため同期を中止しました');}
  }
  function historyFromRow(row){
    const before=parseJsonCell(row[17],'変更前スナップショット');
    const after=parseJsonCell(row[18],'変更後スナップショット');
    return {at:cell(row[0]),id:cell(row[1]),action:cell(row[2]),theme:cell(row[3]),period:cell(row[4]),
      qualitative:cell(row[5]),quantitative:cell(row[6]),unit:cell(row[7]),deadline:cell(row[8]),
      scene:cell(row[9]),be:cell(row[10]),why:cell(row[11]),status:cell(row[12]),reason:cell(row[13]),
      previousUpdated:cell(row[14]),source:cell(row[15]),eventId:cell(row[16]),
      beforeSnapshot:before,afterSnapshot:after||historySnapshot(row)};
  }
  function historySignature(item){
    if(item.eventId)return item.eventId;
    return [item.at,item.id,item.action,item.reason,item.previousUpdated,
      JSON.stringify(item.afterSnapshot||{})].map(cell).join('\u0001');
  }
  function historyRow(item){
    const snapshot=item.afterSnapshot||item;
    const row=[item.at,item.id,item.action,snapshot.theme,snapshot.period,snapshot.qualitative,
      snapshot.quantitative,snapshot.unit,snapshot.deadline,snapshot.scene,snapshot.be,snapshot.why,
      snapshot.status,item.reason,item.previousUpdated,item.source,item.eventId||'',
      JSON.stringify(item.beforeSnapshot||{}),JSON.stringify(snapshot)];
    return row.map(cell);
  }
  function checkFromRow(row){
    return {at:cell(row[0]),id:cell(row[1]),theme:cell(row[2]),period:cell(row[3]),
      result:cell(row[4]),note:cell(row[5])};
  }
  function checkSignature(item){return [item.at,item.id,item.result,item.note].map(cell).join('\u0001');}
  function checkRow(item){
    return [item.at,item.id,item.theme,item.period,item.result,item.note].map(cell);
  }
  function indexHistory(rows){
    return new Set((rows||[]).slice(1,MAX_ROWS).filter(row=>cell(row[1])).map(row=>historySignature(historyFromRow(row))));
  }
  function indexChecks(rows){
    return new Set((rows||[]).slice(1,MAX_ROWS).filter(row=>cell(row[1])).map(row=>checkSignature(checkFromRow(row))));
  }
  function normalizeGoal(goal){
    const record={id:cell(goal.id)};
    goalKeys.forEach(key=>record[key]=cell(goal[key]));
    if(!record.status)record.status='進行中';
    return record;
  }
  function normalizeIdea(idea){
    const record={id:cell(idea.id)};
    ideaKeys.forEach(key=>record[key]=cell(idea[key]));
    if(!record.state)record.state='要確認';
    return record;
  }
  function canonicalGoal(goal){return JSON.stringify(goalRow(normalizeGoal(goal)));}
  function canonicalIdea(idea){return JSON.stringify(ideaRow(normalizeIdea(idea)));}
  function canonicalLegacy(goal){return JSON.stringify(legacyRow(goal||{}));}
  function recordGroups(kind,localRecords,baselineRows,remoteRows,fromRow,toRow,canonical){
    const local=new Map(localRecords.map(record=>[record.id,record]));
    mapRecords(baselineRows,toRow.width,kind+'の同期基準');
    const remote=mapRecords(remoteRows,toRow.width,kind);
    const groups=[];
    for(const id of new Set([...local.keys(),...remote.keys()])){
      const device=local.get(id)||null,sheet=remote.get(id)||null;
      const deviceValue=device?canonical(device):null;
      const sheetValue=sheet?canonical(fromRow(sheet.row)):null;
      if(device&&sheet&&deviceValue===sheetValue){
        groups.push({kind,id,status:'一致',local:device,remote:fromRow(sheet.row),values:[]});
        continue;
      }
      if(!device&&sheet){groups.push({kind,id,status:'Sheetsだけに存在',local:null,remote:fromRow(sheet.row),values:[]});continue;}
      if(device&&!sheet){groups.push({kind,id,status:'端末だけに存在',local:device,remote:null,values:[]});continue;}
      const status=device&&sheet?'競合':device?'端末だけに存在':'Sheetsだけに存在';
      groups.push({kind,id,status,local:device,remote:fromRow(sheet.row),values:[]});
    }
    return groups;
  }
  function recordsFromLocal(data){
    const goals=(data.goals||[]).filter(goal=>goal&&goal.id&&goal.id!==LEGACY_GOAL_ID).map(normalizeGoal);
    if(Object.values(data.goal||{}).some(meaningful)){
      goals.push({id:LEGACY_GOAL_ID,...Object.fromEntries(goalKeys.map(key=>[key,'']))});
      const legacy=goals[goals.length-1];
      legacy.theme='旧形式VISION・BE';legacy.period='';legacy.qualitative=cell(data.goal.title);
      legacy.scene=cell(data.goal.scene);legacy.be=cell(data.goal.identity);legacy.why=cell(data.goal.why);legacy.status='旧形式';
    }
    return goals;
  }
  function baselineFromRows(rows){
    return {version:1,goals:clone(rows.goals),history:clone(rows.history),checks:clone(rows.checks),ideas:clone(rows.ideas)};
  }
  function preview(data,baseline,rows){
    const goals=recordGroups('goal',recordsFromLocal(data),baseline?.goals||[],rows.goals,
      row=>row[0]===LEGACY_GOAL_ID?{...goalFromRow(row)}:goalFromRow(row),
      {width:GOAL_HEADERS.length},record=>JSON.stringify(record.id===LEGACY_GOAL_ID?legacyRow({
        title:record.qualitative,scene:record.scene,identity:record.be,why:record.why
      }):goalRow(record)));
    const localIdeas=(data.goalIdeas||[]).filter(idea=>idea?.id).map(normalizeIdea);
    const ideas=recordGroups('idea',localIdeas,baseline?.ideas||[],rows.ideas,ideaFromRow,
      {width:IDEA_HEADERS.length},record=>JSON.stringify(ideaRow(record)));
    const knownHistory=indexHistory(rows.history),knownChecks=indexChecks(rows.checks);
    const localHistory=(data.goalHistory||[]).filter(item=>item&&item.id&&item.at);
    const localChecks=(data.goalChecks||[]).filter(item=>item&&item.id&&item.at);
    const historyToUpload=localHistory.filter(item=>!knownHistory.has(historySignature(item)));
    const checksToUpload=localChecks.filter(item=>!knownChecks.has(checkSignature(item)));
    const remoteHistory=(rows.history||[]).slice(1,MAX_ROWS).filter(row=>cell(row[1])).map(historyFromRow);
    const remoteChecks=(rows.checks||[]).slice(1,MAX_ROWS).filter(row=>cell(row[1])).map(checkFromRow);
    const localHistorySignatures=new Set(localHistory.map(historySignature));
    const localCheckSignatures=new Set(localChecks.map(checkSignature));
    return {
      goals,ideas,
      history:{toImport:remoteHistory.filter(item=>!localHistorySignatures.has(historySignature(item))),toUpload:historyToUpload},
      checks:{toImport:remoteChecks.filter(item=>!localCheckSignatures.has(checkSignature(item))),toUpload:checksToUpload}
    };
  }
  function applyRemote(data,rows,choices,groups){
    const staged=clone(data);
    if(!Array.isArray(staged.goals))staged.goals=[];
    if(!Array.isArray(staged.goalHistory))staged.goalHistory=[];
    if(!Array.isArray(staged.goalChecks))staged.goalChecks=[];
    if(!Array.isArray(staged.goalIdeas))staged.goalIdeas=[];
    const initial=preview(data,null,rows);
    const combined=groups||initial;
    const importGoals=new Map();
    for(const group of combined.goals){
      if(group.status==='一致'||!group.remote)continue;
      if(group.status==='Sheetsだけに存在'||choices['goal\u0001'+group.id]==='sheets'||group.status==='Sheetsで変更'&&choices['goal\u0001'+group.id]==='sheets'){
        importGoals.set(group.id,group.remote);
      }
    }
    for(const [id,remote] of importGoals){
      if(id===LEGACY_GOAL_ID){
        staged.goal={...staged.goal,title:remote.qualitative,scene:remote.scene,identity:remote.be,why:remote.why};
      }else{
        const index=staged.goals.findIndex(goal=>goal.id===id);
        if(index<0)staged.goals.push(remote);else staged.goals[index]=remote;
      }
    }
    for(const group of combined.ideas){
      if(!group.remote)continue;
      if(group.status==='Sheetsだけに存在'||choices['idea\u0001'+group.id]==='sheets'){
        const index=staged.goalIdeas.findIndex(idea=>idea.id===group.id);
        if(index<0)staged.goalIdeas.push(group.remote);else staged.goalIdeas[index]=group.remote;
      }
    }
    const historyKnown=new Set(staged.goalHistory.map(historySignature));
    for(const item of combined.history.toImport){
      const signature=historySignature(item);
      if(!historyKnown.has(signature)){staged.goalHistory.push(item);historyKnown.add(signature);}
    }
    const checkKnown=new Set(staged.goalChecks.map(checkSignature));
    for(const item of combined.checks.toImport){
      const signature=checkSignature(item);
      if(!checkKnown.has(signature)){staged.goalChecks.push(item);checkKnown.add(signature);}
    }
    return staged;
  }
  function clearedLocalValues(groups,choices){
    const cleared=[];
    const goalFields=[
      ['テーマ','theme'],['期間','period'],['定性ゴール','qualitative'],['定量ゴール','quantitative'],
      ['単位','unit'],['達成期限','deadline'],['未来の景色','scene'],['在り方（BE）','be'],
      ['ゴールの理由','why'],['状態','status'],['作成日','created'],['最終更新日','updated'],
      ['最終確認日','checked'],['メモ','memo']
    ];
    const legacyFields=[['旧MY GOAL','qualitative'],['未来の景色','scene'],['在り方（BE）','be'],['ゴールの理由','why']];
    const ideaFields=[
      ['記録日','date'],['テーマ','theme'],['期間','period'],['項目','field'],['候補内容','content'],
      ['状態','state'],['次に確認したい質問','question'],['関連ゴールID','goalId'],
      ['出典・会話日','source'],['最終更新日','updated'],['メモ','memo']
    ];
    for(const group of [...groups.goals,...groups.ideas]){
      if(choices[choiceKey(group)]!=='sheets'||!group.local||!group.remote)continue;
      const fields=group.kind==='idea'?ideaFields:group.id===LEGACY_GOAL_ID?legacyFields:goalFields;
      for(const [label,key] of fields){
        const localValue=group.local[key],remoteValue=group.remote[key];
        if(meaningful(localValue)&&!meaningful(remoteValue)){
          cleared.push({kind:group.kind,id:group.id,label,localValue,remoteValue});
        }
      }
    }
    return cleared;
  }
  function choiceKey(group){return group.kind+'\u0001'+group.id;}
  function writePlan(data,rows,groups,choices){
    const remoteGoals=mapRecords(rows.goals,GOAL_HEADERS.length,'ゴール一覧');
    const remoteIdeas=mapRecords(rows.ideas,IDEA_HEADERS.length,'ゴールの種');
    const goals=[],ideas=[],destructive=[];
    for(const group of groups.goals){
      if(choices[choiceKey(group)]!=='device'||!group.local)continue;
      const row=group.id===LEGACY_GOAL_ID?legacyRow(data.goal||{}):
        goalRow((data.goals||[]).find(goal=>goal.id===group.id)||group.local);
      const current=remoteGoals.get(group.id)?.row;
      if(current)row.forEach((value,index)=>{
        if(!meaningful(value)&&meaningful(current[index]))destructive.push({
          kind:'goal',id:group.id,label:GOAL_HEADERS[index],localValue:value,remoteValue:current[index]
        });
      });
      goals.push({id:group.id,row,index:remoteGoals.get(group.id)?.index||null});
    }
    for(const group of groups.ideas){
      if(choices[choiceKey(group)]!=='device'||!group.local)continue;
      const row=ideaRow((data.goalIdeas||[]).find(idea=>idea.id===group.id)||group.local);
      const current=remoteIdeas.get(group.id)?.row;
      if(current)row.forEach((value,index)=>{
        if(!meaningful(value)&&meaningful(current[index]))destructive.push({
          kind:'idea',id:group.id,label:IDEA_HEADERS[index],localValue:value,remoteValue:current[index]
        });
      });
      ideas.push({id:group.id,row,index:remoteIdeas.get(group.id)?.index||null});
    }
    const knownHistory=indexHistory(rows.history),knownChecks=indexChecks(rows.checks);
    const goalGroups=new Map(groups.goals.map(group=>[group.id,group]));
    const canUploadHistory=item=>{
      const group=goalGroups.get(item.id);
      return !group||group.status==='一致'||choices[choiceKey(group)]==='device';
    };
    const history=(data.goalHistory||[]).filter(item=>item?.id&&item.at&&canUploadHistory(item)
      &&!knownHistory.has(historySignature(item)));
    const checks=(data.goalChecks||[]).filter(item=>item?.id&&item.at&&canUploadHistory(item)
      &&!knownChecks.has(checkSignature(item)));
    if(history.length&& !HISTORY_SYNC_HEADERS.every((header,index)=>cell(rows.history[0]?.[index]).trim()===header)){
      throw Error('変更履歴タブに必要な追加列がありません。既存の列は変更せず、Q:S列に表示された見出しを追加してから再確認してください');
    }
    return {goals,ideas,history:history.map(historyRow),checks:checks.map(checkRow),destructive};
  }
  function headers(name,rows){
    const expected=name==='goals'?GOAL_HEADERS:name==='history'?HISTORY_HEADERS:name==='checks'?CHECK_HEADERS:IDEA_HEADERS;
    if(!rows?.length||expected.some((value,index)=>cell(rows[0]?.[index]).trim()!==value)){
      throw Error('ゴール同期で使う「'+({goals:'ゴール一覧',history:'ゴール履歴',checks:'ゴール確認履歴',ideas:'ゴールの種'}[name])+'」タブの見出しが想定と異なります。変更・書き込みは行いません');
    }
  }
  async function request(url,token,options={}){
    const response=await fetch(url,{...options,headers:{Authorization:'Bearer '+token,...(options.headers||{})}});
    if(!response.ok){
      let reason='';
      try{reason=(await response.json()).error?.message||'';}catch(error){}
      throw Error('Google Sheets API '+response.status+(reason?'：'+reason:''));
    }
    return response.json();
  }
  const root=id=>'https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(id)+'/values/';
  async function read(id,token,name,end){
    const response=await request(root(id)+encodeURIComponent("'"+name+"'!A1:"+end)+'?valueRenderOption=FORMATTED_VALUE',token);
    return response.values||[];
  }
  async function load(sheetId,token){
    const [goals,history,checks,ideas]=await Promise.all([
      read(sheetId,token,'ゴール一覧','S'+MAX_ROWS),
      read(sheetId,token,'ゴール履歴','S'+MAX_ROWS),
      read(sheetId,token,'ゴール確認履歴','F'+MAX_ROWS),
      read(sheetId,token,'ゴールの種','L'+MAX_ROWS)
    ]);
    const rows={goals,history,checks,ideas};
    Object.keys(rows).forEach(name=>headers(name,rows[name]));
    return rows;
  }
  async function updateRows(sheetId,token,name,items,width){
    const existing=items.filter(item=>item.index);
    if(existing.length){
      const body={valueInputOption:'RAW',data:existing.map(item=>({
        range:"'"+name+"'!A"+item.index+':'+String.fromCharCode(64+width)+item.index,values:[item.row]
      }))};
      await request('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(sheetId)+'/values:batchUpdate',
        token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    }
    const additions=items.filter(item=>!item.index);
    for(let offset=0;offset<additions.length;offset+=50){
      await request(root(sheetId)+encodeURIComponent("'"+name+"'!A1:"+String.fromCharCode(64+width))
        +':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',token,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({values:additions.slice(offset,offset+50).map(item=>item.row)})
        });
    }
    return existing.length+additions.length;
  }
  async function appendRows(sheetId,token,name,end,rows){
    for(let offset=0;offset<rows.length;offset+=50){
      await request(root(sheetId)+encodeURIComponent("'"+name+"'!A1:"+end)
        +':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',token,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({values:rows.slice(offset,offset+50)})
        });
    }
    return rows.length;
  }
  async function commit({sheetId,token,data,rows,groups,choices,confirmedClears=false}){
    if(!token)throw Error('Googleの書き込み許可が必要です');
    const live=await load(sheetId,token);
    if(JSON.stringify(live)!==JSON.stringify(rows))throw Error('差分確認後にゴール関連タブが変更されました。書き込まず、もう一度差分を確認してください');
    const plan=writePlan(data,live,groups,choices);
    if(plan.destructive.length&&!confirmedClears)throw Error('既存のSheets値を空欄にする確認が必要です。書き込みは行っていません');
    let completed=0,stage='ゴール一覧';
    try{
      completed+=await updateRows(sheetId,token,'ゴール一覧',plan.goals,GOAL_HEADERS.length);
      stage='ゴールの種';completed+=await updateRows(sheetId,token,'ゴールの種',plan.ideas,IDEA_HEADERS.length);
      stage='ゴール履歴';completed+=await appendRows(sheetId,token,'ゴール履歴','S',plan.history);
      stage='ゴール確認履歴';completed+=await appendRows(sheetId,token,'ゴール確認履歴','F',plan.checks);
      const result=await load(sheetId,token);
      return {rows:result,count:completed,plan};
    }catch(error){
      throw Error(stage+'で停止しました。完了が確認できた記録は少なくとも'+completed+'件です。Google Sheetsの内容を再確認してください。無条件の再送信は行わないでください。'+error.message);
    }
  }
  return {load,preview,applyRemote,clearedLocalValues,baselineFromRows,writePlan,commit,goalRow,legacyRow,historyRow,historyFromRow,
    goalHeaders:GOAL_HEADERS,historyHeaders:HISTORY_HEADERS,historySyncHeaders:HISTORY_SYNC_HEADERS,
    checkHeaders:CHECK_HEADERS,ideaHeaders:IDEA_HEADERS,legacyGoalId:LEGACY_GOAL_ID,choiceKey};
})();
