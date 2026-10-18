/* Goal Tassei Kun: explicit, conflict-checked Google Sheets writeback.
   Nothing writes to Sheets until the user clicks the dedicated save button.
   The existing ChatGPT-maintained tabs retain their headers and unrelated cells. */
window.GoalWriteback=(function(){
  'use strict';
  const WORK_HEADERS=['日付','ゴール達成にふさわしい理由','ゴール側の自分の当たり前','未来の自分が喜ぶ行動','最も価値のある行動','最低限の完了ライン','行動しなかった未来','最低限を達成','価値のある行動を実行','今日できたこと','以前の自分との差分','明日の一歩','振り返り完了','ゴール','未来の景色','在り方（BE）','ゴールの理由','更新日時','復習した学びID','復習した学びテーマ','講義の学び：今日の気づき','講義の学び：明日の実践','講義の学び：復習完了','夜の記録更新日時'];
  const ACTION_HEADERS=['アクションID','関連ゴールID','テーマ','アクション名','最低限の完了ライン','完了条件・成果指標','予定開始日','期限','期間区分','優先度','状態','進捗メモ','技術課題','適応課題','作成日（JST）','最終更新日（JST）','完了日（JST）','記録元'];
  const WF={1:'fit',2:'normal',3:'futureAction',4:'valuableAction',5:'minimumAction',6:'withoutAction',7:'minimumDone',8:'valuableDone',9:'achievement',10:'growth',11:'tomorrow',12:'reviewed',18:'lessonId',19:'lessonTitle',20:'lessonReflection',21:'lessonNextStep',22:'lessonReviewed'};
  const AF={0:'id',1:'goalId',2:'theme',3:'title',4:'minimum',5:'expected',6:'start',7:'due',8:'horizon',9:'priority',10:'status',11:'note',12:'technical',13:'adaptive',14:'createdAt',15:'updatedAt',16:'completedAt',17:'source'};
  const BOOL=new Set([7,8,12,22]);
  const workDate=/^\d{4}-\d{2}-\d{2}$/;
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
  function countPending(data,base){
    if(!base)return 0;
    const current=(v)=>Object.fromEntries(Object.entries(v||{}).map(([id,row])=>[id,{index:1,values:row}]));
    const work=differences(data.entries,base.work||{},current(base.work),'work').output.length;
    const actions=Object.fromEntries((data.progress?.actions||[]).filter(x=>x.id).map(x=>[x.id,x]));
    const changed=differences(actions,base.actions||{},current(base.actions),'action').output.length;
    return work+changed;
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
    for(let start=0;start<data.length;start+=100){
      await request('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(id)+'/values:batchUpdate',
        token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data:data.slice(start,start+100)})});
    }
    return data.length;
  }
  async function appendNew(id,token,patches,remote,name,width){
    const grouped=new Map();
    patches.filter(p=>!remote[p.id]).forEach(p=>{
      if(!grouped.has(p.id)){const values=Array(width).fill('');values[0]=p.id;grouped.set(p.id,values);}
      grouped.get(p.id)[p.index]=p.value;
    });
    // Append is only used for genuinely missing IDs, never for existing rows.
    for(const values of grouped.values()){
      const url=root(id)+encodeURIComponent("'"+name+"'!A1:"+String.fromCharCode(64+width))
        +':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
      await request(url,token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:[values]})});
    }
    return grouped.size;
  }
  async function commit({sheetId,token,data,baseline}){
    if(!/^[A-Za-z0-9_-]{20,}$/.test(sheetId))throw Error('スプレッドシートIDが未設定です');
    if(!token)throw Error('Google認証が必要です');
    const live=await load(sheetId,token);
    const remoteWork=mapRows(live.workRows,24),remoteActions=mapRows(live.actionRows,18);
    const localActions=Object.fromEntries((data.progress?.actions||[]).filter(x=>x.id).map(x=>[x.id,x]));
    const w=differences(data.entries,baseline?.work||{},remoteWork,'work');
    const a=differences(localActions,baseline?.actions||{},remoteActions,'action');
    const conflicts=[...new Set([...w.conflicts,...a.conflicts])];
    if(conflicts.length)throw Error('他の端末／ChatGPTと変更が重複しています。自動上書きせず中止しました：'+conflicts.slice(0,5).join('、')+(conflicts.length>5?' ほか':''));
    if(!w.output.length&&!a.output.length)return {count:0,...live};
    // One user-triggered attempt. A failed partial attempt is safe to retry: cells already
    // equal the requested value are skipped, and new IDs are found on the next read.
    let changed=0;
    changed+=await writeExisting(sheetId,token,w.output,remoteWork,'ワーク記録',24);
    changed+=await appendNew(sheetId,token,w.output,remoteWork,'ワーク記録',24);
    changed+=await writeExisting(sheetId,token,a.output,remoteActions,'アクション一覧',18);
    changed+=await appendNew(sheetId,token,a.output,remoteActions,'アクション一覧',18);
    const after=await load(sheetId,token);
    const rowsW=mapRows(after.workRows,24),rowsA=mapRows(after.actionRows,18);
    for(const p of w.output)if(cell(rowsW[p.id]?.values[p.index],BOOL.has(p.index))!==p.value)throw Error('ワーク記録の書き込み確認に失敗しました');
    for(const p of a.output)if(String(rowsA[p.id]?.values[p.index]??'')!==p.value)throw Error('アクション一覧の書き込み確認に失敗しました');
    return {count:changed,...after};
  }
  return {commit,load,baselineFromRows,differences,countPending,workFields:WF,actionFields:AF};
})();