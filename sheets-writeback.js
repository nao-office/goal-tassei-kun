/* Goal Tassei Kun: explicit, conflict-checked Google Sheets writeback.
   Nothing writes to Sheets until the user clicks the dedicated save button.
   The existing ChatGPT-maintained tabs retain their headers and unrelated cells. */
window.GoalWriteback=(function(){
  'use strict';
  const WORK_HEADERS=['日付','ゴール達成にふさわしい理由','ゴール側の自分の当たり前','未来の自分が喜ぶ行動','最も価値のある行動','最低限の完了ライン','行動しなかった未来','最低限を達成','価値のある行動を実行','今日できたこと','以前の自分との差分','明日の一歩','振り返り完了','ゴール','未来の景色','在り方（BE）','ゴールの理由','更新日時','復習した学びID','復習した学びテーマ','講義の学び：今日の気づき','講義の学び：明日の実践','講義の学び：復習完了','夜の記録更新日時'];
  const ACTION_HISTORY_HEADERS=['変更日時（JST）','操作','アクションID','関連ゴールID','テーマ','アクション名','最低限の完了ライン','完了条件・成果指標','予定開始日','期限','期間区分','優先度','状態','進捗メモ','技術課題','適応課題','作成日（JST）','最終更新日（JST）','完了日（JST）','記録元','変更理由'];
  const ACTION_HEADERS=['アクションID','関連ゴールID','テーマ','アクション名','最低限の完了ライン','完了条件・成果指標','予定開始日','期限','期間区分','優先度','状態','進捗メモ','技術課題','適応課題','作成日（JST）','最終更新日（JST）','完了日（JST）','記録元'];
  const WF={1:'fit',2:'normal',3:'futureAction',4:'valuableAction',5:'minimumAction',6:'withoutAction',7:'minimumDone',8:'valuableDone',9:'achievement',10:'growth',11:'tomorrow',12:'reviewed',18:'lessonId',19:'lessonTitle',20:'lessonReflection',21:'lessonNextStep',22:'lessonReviewed'};
  const AF={0:'id',1:'goalId',2:'theme',3:'title',4:'minimum',5:'expected',6:'start',7:'due',8:'horizon',9:'priority',10:'status',11:'note',12:'technical',13:'adaptive',14:'createdAt',15:'updatedAt',16:'completedAt',17:'source'};
  const BOOL=new Set([7,8,12,22]);
  const workDate=/^\d{4}-\d{2}-\d{2}$/;
  const READ_ONLY_SCOPE='https://www.googleapis.com/auth/spreadsheets.readonly';
  const WRITE_SCOPE='https://www.googleapis.com/auth/spreadsheets';
  function canAutoSync({enabled,approved,baseline,restoreGuard,blocked}){
    return Boolean(enabled&&approved&&baseline&&!restoreGuard&&!blocked);
  }
  function isBlank(value){
    return value===null||value===undefined||(typeof value==='string'&&value.trim()==='');
  }
  function reviewKey(field){return [field.kind,field.id,field.index].join('\u0001');}
  function reviewCounts(groups){
    const changed=groups.filter(group=>group.values.length);
    return {
      comparedRecords:groups.length,
      changedRecords:changed.length,
      equalRecords:groups.length-changed.length,
      changedFields:changed.reduce((count,group)=>count+group.values.length,0)
    };
  }
  function destructiveChanges(fields,choices){
    return fields.flatMap(field=>{
      const selected=choices[reviewKey(field)];
      if(selected!=='device'&&selected!=='sheets')return [];
      const selectedValue=selected==='device'?field.localValue:field.remoteValue;
      const destinationValue=selected==='device'?field.remoteValue:field.localValue;
      if(!isBlank(selectedValue)||isBlank(destinationValue))return [];
      return [{field,selected,destinationValue}];
    });
  }
  function confirmDestructiveChanges(changes,confirmFn){
    if(!changes.length)return true;
    const format=value=>value===null||value===undefined?'未設定'
      :typeof value==='string'&&value.trim()===''?(value===''?'空欄':'空欄（空白文字のみ）'):String(value);
    const details=changes.map(({field,selected,destinationValue},index)=>{
      const record=field.kind==='work'?'ワーク記録':'アクション';
      const date=field.kind==='work'?'日付：'+field.id:'アクションID：'+field.id;
      const destination=selected==='device'?'Google Sheets':'端末';
      return [
        `${index+1}. ${record} / ${date} / ${field.label||field.key||'項目'}`,
        `   端末の記録：${format(field.localValue)}`,
        `   Google Sheetsの記録：${format(field.remoteValue)}`,
        `   消去される場所と値：${destination}の「${format(destinationValue)}」`
      ].join('\n');
    }).join('\n\n');
    return confirmFn(
      `選択内容を反映すると、次の既存値${changes.length}件が消去されます。\n\n${details}\n\nこの値を消去して続けますか？`
    )===true;
  }
  function cell(v,isBool){
    if(isBool) return ['TRUE','true','1','yes','はい','済','達成'].includes(String(v??'').trim())?'TRUE':'FALSE';
    return String(v??'');
  }
  function localWorkValue(e,idx){return cell(e[WF[idx]],BOOL.has(idx));}
  function localActionValue(a,idx){return cell(a[AF[idx]],false);}
  function hasValue(v,boolean){return boolean?v==='TRUE':v!=='';}
  function normalizeArray(row,width){return Array.from({length:width},(_,i)=>String(row?.[i]??''));}
  function mapRows(rows,width){
    const result={};
    (rows||[]).slice(1).forEach((raw,n)=>{
      const r=normalizeArray(raw,width),id=r[0];
      if(!id)return;
      if(result[id])throw Error('シートに同じID／日付の行が複数あります：'+id);
      result[id]={index:n+2,values:r};
    });
    return result;
  }
  function baselineFromRows(workRows,actionRows){
    return {version:1,work:Object.fromEntries(Object.entries(mapRows(workRows,24)).map(([id,x])=>[id,x.values])),
      actions:Object.fromEntries(Object.entries(mapRows(actionRows,18)).map(([id,x])=>[id,x.values]))};
  }
  function validateHeader(rows,headers,name){
    if(!rows?.length||headers.some((v,i)=>String(rows[0]?.[i]??'').trim()!==v))throw Error(name+'の列見出しが想定と違います。書き込みを中止しました');
  }
  function differences(local,baseline,remote,kind){
    const fields=kind==='work'?WF:AF,isWork=kind==='work';
    const numberOfColumns=isWork?24:18;
    const output=[],conflicts=[];
    const known=baseline||{};
    for(const [id,item] of Object.entries(local||{})){
      if(!id||(isWork&&!workDate.test(id))||!item)continue;
      const old=Object.prototype.hasOwnProperty.call(known,id)?known[id]:null;
      const current=remote[id]?.values||null;
      for(const [indexText,key] of Object.entries(fields)){
        const ix=Number(indexText);
        if(!isWork&&ix===0)continue;
        const isBool=isWork&&BOOL.has(ix);
        const localValue=isWork?localWorkValue(item,ix):localActionValue(item,ix);
        const baseValue=old?cell(old[ix],isBool):null;
        const remoteValue=current?cell(current[ix],isBool):null;
        // Dates with no known baseline must never erase existing non-empty cells.
        const wanted=old?localValue!==baseValue:hasValue(localValue,isBool);
        if(!wanted)continue;
        if(current&&localValue===remoteValue)continue;
        if(old&&!current){conflicts.push(id+'（Google Sheets側で削除された行）');continue;}
        const safe=old?remoteValue===baseValue:!current||!hasValue(remoteValue,isBool);
        if(!safe){conflicts.push(id+'：'+(isWork?WORK_HEADERS[ix]:ACTION_HEADERS[ix]));continue;}
        output.push({id,index:ix,value:localValue});
      }
    }
    return {output,conflicts};
  }
  function preview(data,baseline,workRows,actionRows){
    const remoteWork=mapRows(workRows,24),remoteActions=mapRows(actionRows,18);
    const localActions=Object.fromEntries((data.progress?.actions||[]).filter(x=>x.id).map(x=>[x.id,x]));
    const groups=[];
    const reviewValue=(value,isBool)=>{
      const raw=String(value??'');
      return isBool&&raw.trim()?cell(raw,true):raw;
    };
    function collect(kind,local,base,remote,fields,isWork){
      const ids=new Set([...Object.keys(local||{}),...Object.keys(base||{}),...Object.keys(remote||{})]);
      for(const id of ids){
        const item=local?.[id]||null,old=base?.[id]||null,server=remote?.[id]?.values||null;
        const values=[];
        for(const [indexText,key] of Object.entries(fields)){
          const index=Number(indexText),isBool=isWork&&BOOL.has(index);
          const rawLocalValue=item?(isWork?localWorkValue(item,index):localActionValue(item,index)):null;
          const baseValue=old?reviewValue(old[index],isBool):null;
          const remoteValue=server?reviewValue(server[index],isBool):null;
          const localValue=isBool&&rawLocalValue==='FALSE'&&(!old||reviewValue(old[index],true)==='')?'':rawLocalValue;
          const deletionRisk=Boolean(old&&item&&!server);
          const localSet=localValue!==null&&hasValue(localValue,isBool);
          const remoteSet=remoteValue!==null&&hasValue(remoteValue,isBool);
          const baseSet=baseValue!==null&&hasValue(baseValue,isBool);
          const valueClearRisk=Boolean(old&&item&&server&&baseSet&&(!localSet||!remoteSet));
          const bothEmpty=(localValue===null||localValue==='')&&(remoteValue===null||remoteValue==='');
          if((localValue===remoteValue||bothEmpty)&&!deletionRisk&&!valueClearRisk)continue;
          const localChanged=item?(old?localValue!==baseValue:localSet):false;
          const remoteChanged=old?remoteValue!==baseValue:remoteSet;
          let status;
          if(deletionRisk||valueClearRisk)status='削除・空欄化の可能性';
          else if(localSet&&!remoteSet)status='端末だけに存在';
          else if(remoteSet&&!localSet)status='Sheetsだけに存在';
          else if(localChanged&&remoteChanged)status='両方で変更（競合）';
          else if(localChanged)status='端末で変更';
          else if(remoteChanged)status='Sheetsで変更';
          else status='内容が異なる';
          values.push({kind,id,index,key,label:isWork?WORK_HEADERS[index]:ACTION_HEADERS[index],
            localValue,remoteValue,baseValue,status});
        }
        if(!values.length){
          const localPresent=Object.values(fields).some(key=>{
            const value=item?.[key];
            return typeof value==='boolean'?value:String(value??'').trim()!=='';
          });
          const remotePresent=Boolean(server&&server.some(v=>String(v??'').trim()!==''));
          if(localPresent||remotePresent)groups.push({kind,id,status:'一致',values:[]});
        }else{
          groups.push({kind,id,status:values.some(v=>v.status==='両方で変更（競合）')?'両方で変更（競合）':values.some(v=>v.status==='削除・空欄化の可能性')?'削除・空欄化の可能性':values[0].status,values});
        }
      }
    }
    collect('work',data.entries,baseline?.work,remoteWork,WF,true);
    collect('action',localActions,baseline?.actions,remoteActions,AF,false);
    return groups;
  }
  function applyRemoteField(data,kind,id,index,value){
    const fields=kind==='work'?WF:AF,key=fields[index];
    if(!key)throw Error('同期対象外の項目です');
    if(kind==='work'){
      const item=data.entries[id]||(data.entries[id]={});
      if(BOOL.has(Number(index)))item[key]=value==='TRUE';
      else item[key]=String(value??'');
      if(!item.lessonNotes)item.lessonNotes={};
      if(key==='lessonReflection'||key==='lessonNextStep'||key==='lessonReviewed'){
        const lessonId=item.lessonId;
        if(lessonId){
          const note=item.lessonNotes[lessonId]||(item.lessonNotes[lessonId]={reflection:'',nextStep:'',reviewed:false});
          if(key==='lessonReflection')note.reflection=item[key];
          else if(key==='lessonNextStep')note.nextStep=item[key];
          else note.reviewed=item[key];
        }
      }
      return;
    }
    if(!data.progress)data.progress={actions:[]};
    if(!Array.isArray(data.progress.actions))data.progress.actions=[];
    let item=data.progress.actions.find(a=>a.id===id);
    if(!item){item={id};data.progress.actions.push(item);}
    item[key]=String(value??'');
  }
  function importInitial(data,workRows,actionRows){
    const staged=JSON.parse(JSON.stringify(data));
    if(!staged.entries||typeof staged.entries!=='object'||Array.isArray(staged.entries))staged.entries={};
    if(!staged.progress||typeof staged.progress!=='object')staged.progress={};
    if(!Array.isArray(staged.progress.actions))staged.progress.actions=[];
    if(!Array.isArray(staged.progress.sheetActions))staged.progress.sheetActions=[];
    const summary={workRecordsAdded:0,workRecordsUpdated:0,workFieldsImported:0,
      actionRecordsAdded:0,actionRecordsUpdated:0,actionFieldsImported:0,
      localFieldsKept:0,localRecordsKept:0};
    const localWorkHasData=item=>Object.entries(WF).some(([index,key])=>{
      if(BOOL.has(Number(index)))return item[key]===true;
      return String(item[key]??'').trim()!=='';
    })||String(item.linkedActionId??'').trim()!==''||String(item.goalSnapshot??'').trim()!==''
      ||Object.values(item.lessonNotes||{}).some(note=>note&&(String(note.reflection??'').trim()!==''
        ||String(note.nextStep??'').trim()!==''||note.reviewed===true));
    const nestedLessonValue=(item,key)=>{
      const note=item.lessonNotes?.[item.lessonId];
      if(key==='lessonReflection')return note?.reflection;
      if(key==='lessonNextStep')return note?.nextStep;
      if(key==='lessonReviewed')return note?.reviewed;
      return undefined;
    };
    const remoteWork=mapRows(workRows,24);
    for(const [id,row] of Object.entries(remoteWork)){
      if(!workDate.test(id))continue;
      const current=staged.entries[id]||null;
      const meaningfulLocal=Boolean(current&&localWorkHasData(current));
      const candidate=current?{...current}:{
        fit:'',normal:'',futureAction:'',valuableAction:'',minimumAction:'',withoutAction:'',
        minimumDone:false,valuableDone:false,achievement:'',growth:'',tomorrow:'',reviewed:false,
        lessonId:'',lessonTitle:'',lessonReflection:'',lessonNextStep:'',lessonReviewed:false,
        lessonNotes:{},linkedActionId:'',goalSnapshot:''
      };
      let importedFields=0,keptFields=0;
      for(const [indexText,key] of Object.entries(WF)){
        const index=Number(indexText),remoteValue=row.values[index];
        if(!remoteValue.trim())continue;
        const boolean=BOOL.has(index);
        const localValue=candidate[key],nestedValue=nestedLessonValue(candidate,key);
        const effectiveLocalValue=(nestedValue!==undefined&&nestedValue!==null&&String(nestedValue).trim()!=='')?nestedValue:localValue;
        const localHasValue=boolean?(meaningfulLocal||effectiveLocalValue===true):String(effectiveLocalValue??'').trim()!=='';
        if(meaningfulLocal&&localHasValue){
          const normalizedRemote=boolean?cell(remoteValue,true):remoteValue;
          const normalizedLocal=boolean?cell(effectiveLocalValue,true):String(effectiveLocalValue??'');
          if(normalizedLocal!==normalizedRemote)keptFields++;
          continue;
        }
        applyRemoteField({entries:{[id]:candidate}},'work',id,index,boolean?cell(remoteValue,true):remoteValue);
        importedFields++;
      }
      if(importedFields){
        staged.entries[id]=candidate;
        summary.workFieldsImported+=importedFields;
        summary.localFieldsKept+=keptFields;
        if(!current)summary.workRecordsAdded++;
        else summary.workRecordsUpdated++;
      }else if(keptFields){
        summary.localFieldsKept+=keptFields;
      }
      if(current&&meaningfulLocal)summary.localRecordsKept++;
    }

    const knownActions=new Set([
      ...staged.progress.actions,...staged.progress.sheetActions
    ].filter(item=>item&&item.id).map(item=>item.id));
    const remoteActions=mapRows(actionRows,18);
    for(const [id,row] of Object.entries(remoteActions)){
      if(knownActions.has(id)){
        const local=staged.progress.actions.find(item=>item.id===id)
          ||staged.progress.sheetActions.find(item=>item.id===id);
        let importedFields=0,keptFields=0;
        if(local){
          for(const [indexText,key] of Object.entries(AF)){
            const index=Number(indexText),remoteValue=row.values[index];
            if(index===0||!remoteValue.trim())continue;
            const localValue=String(local[key]??'');
            if(!localValue.trim()){
              local[key]=remoteValue;
              importedFields++;
            }else if(localValue!==remoteValue)keptFields++;
          }
        }
        if(importedFields){
          summary.actionFieldsImported+=importedFields;
          summary.actionRecordsUpdated++;
        }
        summary.localFieldsKept+=keptFields;
        if(keptFields)summary.localRecordsKept++;
        continue;
      }
      const action={id,status:row.values[10].trim()||'未着手'};
      let importedFields=0;
      for(const [indexText,key] of Object.entries(AF)){
        const index=Number(indexText);
        if(index===0||!row.values[index].trim())continue;
        action[key]=row.values[index];
        importedFields++;
      }
      if(!importedFields)continue;
      action.origin='Google Sheets';
      staged.progress.sheetActions.push(action);
      knownActions.add(id);
      summary.actionRecordsAdded++;
      summary.actionFieldsImported+=importedFields;
    }
    summary.recordsAdded=summary.workRecordsAdded+summary.actionRecordsAdded;
    summary.fieldsImported=summary.workFieldsImported+summary.actionFieldsImported;
    summary.recordsImported=summary.recordsAdded+summary.workRecordsUpdated+summary.actionRecordsUpdated;
    return {data:staged,summary};
  }
  function countPending(data,base){
    if(!base)return 0;
    const current=(v)=>Object.fromEntries(Object.entries(v||{}).map(([id,row])=>[id,{index:1,values:row}]));
    const work=differences(data.entries,base.work||{},current(base.work),'work');
    const actions=Object.fromEntries((data.progress?.actions||[]).filter(x=>x.id).map(x=>[x.id,x]));
    const changed=differences(actions,base.actions||{},current(base.actions),'action');
    if(work.conflicts.length||changed.conflicts.length)return Number.POSITIVE_INFINITY;
    return work.output.length+changed.output.length;
  }
  async function request(url,token,options={}){
    const headers={Authorization:'Bearer '+token,...(options.headers||{})};
    const response=await fetch(url,{...options,headers});
    if(!response.ok){
      let reason='';try{const j=await response.json();reason=j.error?.message||'';}catch(e){}
      throw Error('Google Sheets API '+response.status+(reason?'：'+reason:''));
    }
    return response.json();
  }
  const root=id=>'https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(id)+'/values/';
  async function read(id,token,name,end){
    const url=root(id)+encodeURIComponent("'"+name+"'!A1:"+end)+'?valueRenderOption=FORMATTED_VALUE';
    const json=await request(url,token);
    return json.values||[];
  }
  async function load(id,token){
    const [workRows,actionRows]=await Promise.all([read(id,token,'ワーク記録','X5001'),read(id,token,'アクション一覧','R1200')]);
    validateHeader(workRows,WORK_HEADERS,'ワーク記録');
    validateHeader(actionRows,ACTION_HEADERS,'アクション一覧');
    return {workRows,actionRows};
  }
  async function writeExisting(id,token,patches,remote,name,width){
    const data=patches.filter(p=>remote[p.id]).map(p=>({
      range:"'"+name+"'!"+String.fromCharCode(65+p.index)+(remote[p.id].index),
      values:[[p.value]]
    }));
    let completed=0;
    for(let start=0;start<data.length;start+=100){
      try{
        await request('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(id)+'/values:batchUpdate',
          token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data:data.slice(start,start+100)})});
        completed+=Math.min(100,data.length-start);
      }catch(error){
        throw Error(name+'の更新中に失敗しました。更新済みは少なくとも'+completed+'項目です。'+error.message);
      }
    }
    return completed;
  }
  async function appendNew(id,token,patches,remote,name,width){
    const grouped=new Map();
    patches.filter(p=>!remote[p.id]).forEach(p=>{
      if(!grouped.has(p.id)){const values=Array(width).fill('');values[0]=p.id;grouped.set(p.id,values);}
      grouped.get(p.id)[p.index]=p.value;
    });
    // Append is only used for genuinely missing IDs, never for existing rows.
    let completed=0;
    for(const values of grouped.values()){
      const url=root(id)+encodeURIComponent("'"+name+"'!A1:"+String.fromCharCode(64+width))
        +':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
      try{
        await request(url,token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:[values]})});
        completed++;
      }catch(error){
        throw Error(name+'の行追加中に失敗しました。追加済みは少なくとも'+completed+'行です。'+error.message);
      }
    }
    return completed;
  }
  function actionHistoryRow(item){
    const a=item.after||{};
    const row=[item.at,item.reason||'更新',a.id||item.id,a.goalId,a.theme,a.title,a.minimum,a.expected,
      a.start,a.due,a.horizon,a.priority,a.status,a.note,a.technical,a.adaptive,
      a.createdAt,a.updatedAt,a.completedAt,'ゴール達成くん（アプリ）',item.reason||'更新'];
    return row.map(x=>String(x??''));
  }
  async function writeActionHistory(sheetId,token,history){
    const rows=await read(sheetId,token,'アクション履歴','U5001');
    validateHeader(rows,ACTION_HISTORY_HEADERS,'アクション履歴');
    const known=new Set(rows.slice(1).map(r=>[r[0]||'',r[2]||'',r[20]||''].join('\u0001')));
    const additions=[],seen=new Set();
    for(const item of (history||[])){
      if(!item?.at||!item?.id||!item.after)continue;
      const row=actionHistoryRow(item),signature=[row[0],row[2],row[20]].join('\u0001');
      if(known.has(signature)||seen.has(signature))continue;
      seen.add(signature);additions.push(row);
    }
    const url=root(sheetId)+encodeURIComponent("'アクション履歴'!A1:U")
      +':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    for(let n=0;n<additions.length;n+=50){
      await request(url,token,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({values:additions.slice(n,n+50)})});
    }
    return additions.length;
  }
  async function commit({sheetId,token,data,baseline,expectedRows,includeActionHistory=false}){
    if(!/^[A-Za-z0-9_-]{20,}$/.test(sheetId))throw Error('スプレッドシートIDが未設定です');
    if(!token)throw Error('Google認証が必要です');
    const live=await load(sheetId,token);
    if(expectedRows&&(JSON.stringify(live.workRows)!==JSON.stringify(expectedRows.workRows)
      ||JSON.stringify(live.actionRows)!==JSON.stringify(expectedRows.actionRows))){
      throw Error('差分確認後にGoogle Sheetsの内容が変わりました。書き込まず、もう一度差分を確認してください');
    }
    const remoteWork=mapRows(live.workRows,24),remoteActions=mapRows(live.actionRows,18);
    const localActions=Object.fromEntries((data.progress?.actions||[]).filter(x=>x.id).map(x=>[x.id,x]));
    const w=differences(data.entries,baseline?.work||{},remoteWork,'work');
    const a=differences(localActions,baseline?.actions||{},remoteActions,'action');
    const conflicts=[...new Set([...w.conflicts,...a.conflicts])];
    if(conflicts.length)throw Error('他の端末／ChatGPTと変更が重複しています。自動上書きせず中止しました：'+conflicts.slice(0,5).join('、')+(conflicts.length>5?' ほか':''));
    // Changes from the app's action log are appended, never replaced.
    // Do this even after an interrupted previous attempt in which the main action row was written.
    if(!w.output.length&&!a.output.length){
      const h=includeActionHistory?await writeActionHistory(sheetId,token,data.progress?.actionHistory):0;
      return {count:h,...live};
    }
    // One user-triggered attempt. A failed partial attempt is safe to retry: cells already
    // equal the requested value are skipped, and new IDs are found on the next read.
    let changed=0,stage='ワーク記録の更新';
    try{
      changed+=await writeExisting(sheetId,token,w.output,remoteWork,'ワーク記録',24);
      changed+=await appendNew(sheetId,token,w.output,remoteWork,'ワーク記録',24);
      stage='アクション一覧の更新';
      changed+=await writeExisting(sheetId,token,a.output,remoteActions,'アクション一覧',18);
      changed+=await appendNew(sheetId,token,a.output,remoteActions,'アクション一覧',18);
      if(includeActionHistory){stage='アクション履歴の追加';changed+=await writeActionHistory(sheetId,token,data.progress?.actionHistory);}
      stage='保存結果の再確認';
      const after=await load(sheetId,token);
      const rowsW=mapRows(after.workRows,24),rowsA=mapRows(after.actionRows,18);
      for(const p of w.output)if(cell(rowsW[p.id]?.values[p.index],BOOL.has(p.index))!==p.value)throw Error('ワーク記録の書き込み確認に失敗しました');
      for(const p of a.output)if(String(rowsA[p.id]?.values[p.index]??'')!==p.value)throw Error('アクション一覧の書き込み確認に失敗しました');
      return {count:changed,...after};
    }catch(error){
      throw Error(stage+'で停止しました。確認できた処理は少なくとも'+changed+'項目です。Sheetsを再確認してから差分確認をやり直してください。'+error.message);
    }
  }
  return {commit,load,baselineFromRows,differences,countPending,preview,reviewCounts,importInitial,applyRemoteField,destructiveChanges,confirmDestructiveChanges,canAutoSync,
    readOnlyScope:READ_ONLY_SCOPE,writeScope:WRITE_SCOPE,workFields:WF,actionFields:AF,workHeaders:WORK_HEADERS,actionHeaders:ACTION_HEADERS};
})();