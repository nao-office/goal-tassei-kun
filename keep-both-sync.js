/* Conflict copies belong in a separate, append-only tab, never duplicate daily rows.
   Archive format v1 (A:J): content ID, schema, kind, original ID, source,
   1-based chunk number, chunk count, SHA-256, JSON chunk, saved UTC time.
   The hashed JSON is exactly {schemaVersion:1,kind,id,values}, in that order.
   values contains only GoalWriteback's synchronized keys, in column order,
   with normalized string cells. null records an absent Sheets row.
   SHA-256 covers the complete JSON, not individual chunks or source/time metadata.
   A complete reread and hash check is required before any active record changes.
   Sheets has no compare-and-swap: another device can still write between checks.
   In particular, independent pages can both append the same previously absent
   date. Both outgoing snapshots are archived first; duplicate active IDs then
   fail closed. This module never deletes or arbitrarily merges those rows. */
window.GoalKeepBoth=(function(){
  'use strict';
  const W=window.GoalWriteback;
  if(!W)throw Error('GoalWriteback must be loaded before GoalKeepBoth');
  const schemaVersion=1,tabName='同期の別記録';
  const headers=['版ID','形式バージョン','記録種別','元のID／日付','記録元','分割番号','分割総数','SHA-256','記録内容（JSON分割）','保存日時（UTC）'];
  const limits=Object.freeze({chunkChars:30000,snapshotChars:2000000,versionChunks:100,rows:10000,totalChars:12000000,
    workRecords:5000,localActions:1000,legacyActions:1400,fieldChars:4000,actionIdChars:180});
  const boolColumns=new Set([7,8,12,22]);
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fields=kind=>kind==='work'?W.workFields:W.actionFields;
  const width=kind=>kind==='work'?24:18;
  const bool=(kind,index)=>kind==='work'&&boolColumns.has(Number(index));
  const cell=(value,boolean)=>boolean?(['TRUE','true','1','yes','はい','済','達成'].includes(String(value??'').trim())?'TRUE':'FALSE'):String(value??'');
  const meaningful=(value,boolean)=>boolean?value==='TRUE':value!=='';
  const baseURL=id=>'https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(id);
  const rangeURL=(id,range)=>baseURL(id)+'/values/'+encodeURIComponent("'"+tabName+"'!"+range);
  const locks=new Map();
  function validDate(id){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(id))return false;
    const date=new Date(id+'T00:00:00Z');
    return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===id;
  }

  function validateRows(rows,kind){
    const expected=kind==='work'?W.workHeaders:W.actionHeaders;
    if(!Array.isArray(rows)||!rows.length||expected.some((value,index)=>String(rows[0]?.[index]??'').trim()!==value)){
      throw Error((kind==='work'?'ワーク記録':'アクション一覧')+'の列見出しが想定と違います。同期を中止しました');
    }
    const result=new Map();
    rows.slice(1).forEach(raw=>{
      const row=Array.from({length:width(kind)},(_,index)=>String(raw?.[index]??'')),id=row[0];
      if(!id)return;
      if(kind==='work'&&!validDate(id))throw Error('ワーク記録の日付が不正です（'+id+'）。元の記録を変更せず同期を中止しました');
      if(result.has(id))throw Error('シートに同じID／日付の行が複数あります：'+id);
      result.set(id,row);
    });
    return result;
  }
  function actionMap(data){
    const result=new Map();
    for(const name of ['sheetActions','actions']){
      const seen=new Set();
      for(const item of data?.progress?.[name]||[]){
        if(!item?.id)continue;
        const id=String(item.id);
        if(seen.has(id))throw Error('端末に同じアクションIDが複数あります：'+id);
        seen.add(id);result.set(id,item);
      }
    }
    return result;
  }
  function recordMap(data,kind){
    if(kind!=='work')return actionMap(data);
    const entries=Object.entries(data?.entries||{}).filter(([id,item])=>/^\d{4}-\d{2}-\d{2}$/.test(id)&&item&&typeof item==='object');
    for(const [id] of entries)if(!validDate(id))throw Error('端末のワーク記録の日付が不正です（'+id+'）。同期を中止しました');
    return new Map(entries);
  }
  function payload(kind,id,item,isRow){
    if(!item)return {schemaVersion,kind,id,values:null};
    const values={};
    for(const [index,key] of Object.entries(fields(kind))){
      values[key]=key==='id'?id:cell(isRow?item[index]:item[key],bool(kind,index));
    }
    return {schemaVersion,kind,id,values};
  }
  function assign(item,kind,index,value){
    item[fields(kind)[index]]=bool(kind,index)?value==='TRUE':value;
  }
  function ensureData(data){
    if(!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))data.entries={};
    if(!data.progress||typeof data.progress!=='object')data.progress={};
    if(!Array.isArray(data.progress.actions))data.progress.actions=[];
    if(!Array.isArray(data.progress.sheetActions))data.progress.sheetActions=[];
    return data;
  }
  function validateForStorage(data){
    if(Object.keys(data.entries||{}).length>limits.workRecords)throw Error('端末のワーク記録が5,000件を超えるため同期を中止しました。記録は削除しません');
    if((data.progress?.actions||[]).length>limits.localActions||(data.progress?.sheetActions||[]).length>limits.legacyActions){
      throw Error('端末のアクション保存件数の上限を超えるため同期を中止しました。記録は削除しません');
    }
    for(const kind of ['work','action']){
      for(const [id,item] of recordMap(data,kind)){
        for(const [index,key] of Object.entries(fields(kind))){
          if(bool(kind,index))continue;
          const max=kind==='action'&&(key==='id'||key==='goalId')?limits.actionIdChars:limits.fieldChars;
          if(String(item[key]??'').length>max)throw Error((kind==='work'?'ワーク記録':'アクション')+'の項目が端末の文字数上限を超えています（'+id+'／'+key+'）。内容を切り詰めず同期を中止しました');
          if(kind==='action'&&key==='id'&&typeof item[key]!=='string')throw Error('アクションIDの形式が不正です。同期を中止しました');
        }
      }
    }
  }
  function plan(data,baseline,rows){
    const merged=ensureData(clone(data)),archives=[];
    const summary={conflictRecords:0,clearingRecords:0,deletedRowsKept:0,archivedRecords:0,remoteFieldsImported:0,localFieldsToWrite:0};
    for(const kind of ['work','action']){
      const local=recordMap(data,kind),remote=validateRows(kind==='work'?rows.workRows:rows.actionRows,kind);
      const target=recordMap(merged,kind),known=kind==='work'?baseline?.work:baseline?.actions;
      for(const id of new Set([...local.keys(),...remote.keys()])){
        if(kind==='work'&&!/^\d{4}-\d{2}-\d{2}$/.test(id))continue;
        const item=local.get(id),server=remote.get(id),old=own(known,id)?known[id]:null;
        let output=target.get(id);
        if(!output){
          output=kind==='work'?{}:{id};
          if(kind==='work')merged.entries[id]=output;
          else merged.progress.actions.push(output);
        }
        let conflict=false,clearing=false,different=false,localMeaningful=false;
        const deleted=Boolean(item&&old&&!server);
        for(const [index,key] of Object.entries(fields(kind))){
          if(key==='id')continue;
          const boolean=bool(kind,index),lv=item?cell(item[key],boolean):null;
          const rv=server?cell(server[index],boolean):null,bv=old?cell(old[index],boolean):null;
          if(item&&meaningful(lv,boolean))localMeaningful=true;
          if(item&&server&&lv!==rv)different=true;
          let selected;
          if(!item)selected=rv;
          else if(!server)selected=lv;
          else if(lv===rv)selected=lv;
          else if(old){
            const localChanged=lv!==bv,remoteChanged=rv!==bv;
            if(localChanged&&remoteChanged){conflict=true;selected=rv;}
            else selected=localChanged?lv:rv;
          }else{
            const localSet=boolean?own(item,key):meaningful(lv,false);
            const remoteSet=boolean?String(server[index]??'').trim()!=='':meaningful(rv,false);
            if(localSet&&remoteSet){conflict=true;selected=rv;}
            else selected=localSet?lv:rv;
          }
          if(item&&server){
            if(lv!==rv&&old&&meaningful(bv,boolean)&&(!meaningful(lv,boolean)||!meaningful(rv,boolean)))clearing=true;
            if(!meaningful(selected,boolean)&&(meaningful(lv,boolean)||meaningful(rv,boolean)))clearing=true;
          }
          if(item&&selected!==lv)summary.remoteFieldsImported++;
          else if(!item&&meaningful(selected,boolean))summary.remoteFieldsImported++;
          if(server?selected!==rv:meaningful(selected,boolean))summary.localFieldsToWrite++;
          assign(output,kind,index,selected??'');
        }
        // Preserve all outgoing versions, even without a conflict yet: another
        // cooperating device may be preparing its write at the same time.
        if(conflict||clearing||deleted||(localMeaningful&&(different||!server))){
          archives.push({source:'device',payload:payload(kind,id,item,false)},{source:'sheets',payload:payload(kind,id,server,true)});
          summary.archivedRecords++;
          if(conflict)summary.conflictRecords++;
          if(clearing)summary.clearingRecords++;
          if(deleted)summary.deletedRowsKept++;
        }
      }
    }
    validateForStorage(merged);
    // The persisted shape retains separate legacy/current arrays. GoalWriteback
    // gets a transient combined list because it only writes progress.actions.
    const candidate=clone(merged);
    candidate.progress.actions=[...actionMap(candidate).values()];
    return {data:merged,candidate,archives,summary};
  }

  // Do not mutate current or the in-flight snapshot. An edit made during network
  // work wins locally, remains pending, and can be sent by the next normal sync.
  // Device-only fields (including nested lessonNotes) are never rewritten here.
  function reconcile(current,snapshot,afterRows){
    const result=ensureData(clone(current));
    for(const kind of ['work','action']){
      const before=recordMap(snapshot,kind),now=recordMap(current,kind),target=recordMap(result,kind);
      const remote=validateRows(kind==='work'?afterRows.workRows:afterRows.actionRows,kind);
      for(const [id,row] of remote){
        if(kind==='work'&&!/^\d{4}-\d{2}-\d{2}$/.test(id))continue;
        const prior=before.get(id),present=now.get(id);
        if(prior&&!present)continue; // A record was removed while this sync ran.
        let item=target.get(id);
        if(!item){
          item=kind==='work'?{}:{id};
          if(kind==='work')result.entries[id]=item;
          else result.progress.actions.push(item);
        }
        for(const [index,key] of Object.entries(fields(kind))){
          if(key==='id')continue;
          if(own(present,key)!==own(prior,key)||present?.[key]!==prior?.[key])continue;
          assign(item,kind,index,cell(row[index],bool(kind,index)));
        }
      }
    }
    validateForStorage(result);
    return result;
  }

  async function request(url,token,options={}){
    const response=await fetch(url,{...options,headers:{Authorization:'Bearer '+token,...(options.headers||{})}});
    if(!response.ok){
      let detail='';try{detail=(await response.json()).error?.message||'';}catch(error){}
      throw Error('Google Sheets API '+response.status+(detail?'：'+detail:''));
    }
    return response.json();
  }
  const jsonOptions=(method,value)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  function validateCredentials(sheetId,token){
    if(!/^[A-Za-z0-9_-]{20,}$/.test(sheetId))throw Error('スプレッドシートIDが未設定です');
    if(!token)throw Error('Google認証が必要です');
  }
  async function sheetsMetadata(sheetId,token){
    const result=await request(baseURL(sheetId)+'?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',token);
    if(!Array.isArray(result.sheets))throw Error('Google Sheetsのシート構成を確認できませんでした');
    return result.sheets;
  }
  async function checkMainBounds(sheetId,token){
    const sheets=await sheetsMetadata(sheetId,token);
    // GoalWriteback reads bounded ranges. Never infer that an ID is missing if
    // the grid could contain additional rows beyond those ranges.
    for(const [title,maxRows,minColumns] of [['ワーク記録',5001,24],['アクション一覧',1200,18]]){
      const matches=sheets.filter(sheet=>sheet.properties?.title===title);
      const grid=matches[0]?.properties?.gridProperties;
      if(matches.length!==1||!Number.isInteger(grid?.rowCount)||grid.rowCount<1||!Number.isInteger(grid.columnCount)||grid.columnCount<minColumns){
        throw Error(title+'の読み取り範囲を確認できません。元の記録を変更せず同期を中止しました');
      }
      if(grid.rowCount>maxRows)throw Error(title+'のシート行数が安全な読み取り上限（'+maxRows+'行）を超えています。未取得の行を上書き・重複追加しないため同期を中止しました');
    }
  }
  async function load(sheetId,token){
    validateCredentials(sheetId,token);
    await checkMainBounds(sheetId,token);
    return W.load(sheetId,token);
  }
  async function metadata(sheetId,token){
    const matches=(await sheetsMetadata(sheetId,token)).filter(sheet=>sheet.properties?.title===tabName);
    if(matches.length>1)throw Error('別記録シートが重複しています');
    const found=matches[0]?.properties||null;
    if(found?.gridProperties?.rowCount>limits.rows+1)throw Error('別記録シートが安全に確認できる行数を超えています');
    return found;
  }
  async function rawArchive(sheetId,token){
    const result=await request(rangeURL(sheetId,'A1:J'+(limits.rows+2))+'?valueRenderOption=UNFORMATTED_VALUE',token);
    if(result.values!==undefined&&!Array.isArray(result.values))throw Error('別記録シートの取得結果が不正です');
    return result.values||[];
  }
  async function sha256(value){
    if(!globalThis.crypto?.subtle)throw Error('別記録の安全確認に必要なSHA-256を利用できません');
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  function validatePayload(value){
    if(!value||value.schemaVersion!==schemaVersion||!['work','action'].includes(value.kind)||typeof value.id!=='string'||!value.id||(value.kind==='work'&&!validDate(value.id))){
      throw Error('別記録のJSON形式が不正です');
    }
    if(Object.keys(value).join('|')!=='schemaVersion|kind|id|values')throw Error('別記録に未対応の項目があります');
    if(value.values!==null){
      if(typeof value.values!=='object'||Array.isArray(value.values))throw Error('別記録の項目形式が不正です');
      const keys=Object.values(fields(value.kind));
      if(Object.keys(value.values).join('|')!==keys.join('|')||keys.some(key=>typeof value.values[key]!=='string'))throw Error('別記録の同期項目が不正です');
      if(value.kind==='action'&&value.values.id!==value.id)throw Error('別記録のアクションIDが一致しません');
    }
  }
  async function inspectArchive(rows){
    if(rows.length>limits.rows+1)throw Error('別記録の保存件数が上限を超えています');
    if(!rows.length)return {versions:[],partialVersions:[],groups:new Map(),physicalRows:0,totalChars:0,empty:true};
    if(headers.some((value,index)=>rows[0]?.[index]!==value))throw Error('同期の別記録の列見出しが想定と違います。元の記録は変更しません');
    const groups=new Map();let totalChars=0;
    for(const raw of rows.slice(1)){
      if(raw.every(value=>value===null||value===undefined||value===''))continue;
      const row=Array.from({length:headers.length},(_,index)=>String(raw[index]??''));
      const [versionId,schema,kind,id,source,part,total,hash,chunk,savedAt]=row;
      if(!/^sha256:[a-f0-9]{64}$/.test(versionId)||versionId!=='sha256:'+hash||schema!==String(schemaVersion)
        ||!['work','action'].includes(kind)||!id||!['device','sheets'].includes(source)
        ||!/^\d+$/.test(part)||!/^\d+$/.test(total)||Number(part)<1||Number(part)>Number(total)
        ||Number(total)>limits.versionChunks||!chunk||chunk.length>limits.chunkChars||!Number.isFinite(Date.parse(savedAt))){
        throw Error('別記録に不正な分割データがあります。元の記録は変更しません');
      }
      totalChars+=chunk.length;
      if(totalChars>limits.totalChars)throw Error('別記録の総容量が安全な上限を超えています');
      let group=groups.get(versionId);
      if(!group){
        group={versionId,hash,kind,id,total:Number(total),chunks:new Map(),sources:new Set(),savedAt};groups.set(versionId,group);
      }
      if(group.kind!==kind||group.id!==id||group.total!==Number(total)||group.hash!==hash)throw Error('同じ版IDの別記録が一致しません');
      if(group.chunks.has(Number(part))&&group.chunks.get(Number(part))!==chunk)throw Error('同じ版IDの別記録の内容が一致しません');
      group.chunks.set(Number(part),chunk);group.sources.add(source);
      if(savedAt<group.savedAt)group.savedAt=savedAt;
    }
    const versions=[],partialVersions=[];
    for(const group of groups.values()){
      const summary={versionId:group.versionId,kind:group.kind,id:group.id,sources:[...group.sources],savedAt:group.savedAt};
      if(group.chunks.size!==group.total){partialVersions.push({...summary,receivedChunks:group.chunks.size,totalChunks:group.total});continue;}
      const serialized=Array.from({length:group.total},(_,index)=>group.chunks.get(index+1)).join('');
      if(serialized.length>limits.snapshotChars)throw Error('別記録の1件の容量が上限を超えています');
      if(await sha256(serialized)!==group.hash)throw Error('別記録のSHA-256確認に失敗しました。元の記録は変更しません');
      let content;try{content=JSON.parse(serialized);}catch(error){throw Error('別記録のJSONを読み取れません');}
      validatePayload(content);
      if(content.kind!==group.kind||content.id!==group.id||JSON.stringify(content)!==serialized)throw Error('別記録のJSONと版IDの情報が一致しません');
      versions.push({...summary,payload:content,...content});
    }
    return {versions,partialVersions,groups,physicalRows:rows.length-1,totalChars,empty:false};
  }
  async function ensureArchive(sheetId,token){
    let found=await metadata(sheetId,token);
    if(!found){
      let failure;
      try{
        await request(baseURL(sheetId)+':batchUpdate',token,jsonOptions('POST',{requests:[{addSheet:{properties:{title:tabName,gridProperties:{rowCount:1000,columnCount:headers.length}}}}]}));
      }catch(error){failure=error;}
      // Covers a successful creation with a lost response, and simultaneous creation.
      found=await metadata(sheetId,token);
      if(!found)throw Error('別記録シートを作成できませんでした'+(failure?'：'+failure.message:''));
    }
    let rows=await rawArchive(sheetId,token);
    if(!rows.length){
      let failure;
      try{await request(rangeURL(sheetId,'A1:J1')+'?valueInputOption=RAW',token,jsonOptions('PUT',{values:[headers]}));}
      catch(error){failure=error;}
      rows=await rawArchive(sheetId,token);
      if(!rows.length)throw Error('別記録の見出し保存を確認できませんでした'+(failure?'：'+failure.message:''));
    }
    return inspectArchive(rows);
  }
  function chunksOf(serialized){
    if(serialized.length>limits.snapshotChars)throw Error('別記録の1件の容量が上限を超えています。元の記録は変更しません');
    const chunks=[];
    for(let start=0;start<serialized.length;){
      let end=Math.min(start+limits.chunkChars,serialized.length);
      if(end<serialized.length&&/[\uD800-\uDBFF]/.test(serialized[end-1]))end--;
      chunks.push(serialized.slice(start,end));start=end;
    }
    if(chunks.length>limits.versionChunks)throw Error('別記録の分割数が上限を超えています');
    return chunks;
  }
  async function prepareVersions(archives){
    const result=new Map();
    for(const entry of archives){
      validatePayload(entry.payload);
      const serialized=JSON.stringify(entry.payload),chunks=chunksOf(serialized),hash=await sha256(serialized),versionId='sha256:'+hash;
      if(!result.has(versionId))result.set(versionId,{...entry,serialized,chunks,hash,versionId});
    }
    return [...result.values()];
  }
  async function saveVersions(sheetId,token,versions){
    if(!versions.length)return {archiveCount:0,archiveVerifiedCount:0};
    let state=await ensureArchive(sheetId,token);
    const existed=new Set(state.versions.map(version=>version.versionId)),pending=[],savedAt=new Date().toISOString();
    for(const version of versions){
      const known=state.groups.get(version.versionId);
      if(known&&(known.kind!==version.payload.kind||known.id!==version.payload.id||known.total!==version.chunks.length))throw Error('既存の別記録と保存内容が一致しません');
      version.chunks.forEach((chunk,index)=>{
        if(known?.chunks.has(index+1)){
          if(known.chunks.get(index+1)!==chunk)throw Error('既存の別記録と保存内容が一致しません');
          return;
        }
        pending.push([version.versionId,String(schemaVersion),version.payload.kind,version.payload.id,version.source,String(index+1),String(version.chunks.length),version.hash,chunk,savedAt]);
      });
    }
    if(state.physicalRows+pending.length>limits.rows||state.totalChars+pending.reduce((sum,row)=>sum+row[8].length,0)>limits.totalChars){
      throw Error('別記録の保存容量が上限に達しました。元の記録は変更しません');
    }
    for(let offset=0;offset<pending.length;){
      const batch=[];let characters=0;
      while(offset<pending.length&&batch.length<50&&characters+pending[offset][8].length<=500000){
        const row=pending[offset++];batch.push(row);characters+=row[8].length;
      }
      let failure;
      try{
        await request(rangeURL(sheetId,'A1:J')+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',token,jsonOptions('POST',{values:batch}));
      }catch(error){failure=error;}
      // Never blindly repeat an append after a timeout. Reread and accept only
      // bytes actually present; the next attempt can fill any missing chunks.
      try{state=await inspectArchive(await rawArchive(sheetId,token));}
      catch(error){throw Error('別記録の保存結果を確認できません。再試行時に再確認します：'+error.message);}
      for(const row of batch){
        if(state.groups.get(row[0])?.chunks.get(Number(row[5]))!==row[8]){
          throw Error('別記録の保存が未完了です。元の記録は変更しません'+(failure?'：'+failure.message:''));
        }
      }
    }
    // Even a retry with no append must prove every required version is complete.
    const complete=new Set(state.versions.map(version=>version.versionId));
    if(versions.some(version=>!complete.has(version.versionId)))throw Error('別記録の全分割とSHA-256を確認できません。元の記録は変更しません');
    return {archiveCount:versions.filter(version=>!existed.has(version.versionId)).length,archiveVerifiedCount:versions.length};
  }
  async function loadArchive(sheetId,token){
    validateCredentials(sheetId,token);
    if(!await metadata(sheetId,token))return {versions:[],partialVersions:[],tabExists:false};
    const {versions,partialVersions}=await inspectArchive(await rawArchive(sheetId,token));
    return {versions,partialVersions,tabExists:true};
  }
  const sameRows=(left,right)=>JSON.stringify(left.workRows)===JSON.stringify(right.workRows)&&JSON.stringify(left.actionRows)===JSON.stringify(right.actionRows);
  function writeIntent(data,live){
    const baseline=W.baselineFromRows(live.workRows,live.actionRows),patches=[];let count=0;
    for(const kind of ['work','action']){
      const remote=validateRows(kind==='work'?live.workRows:live.actionRows,kind);
      const asRows=Object.fromEntries([...remote].map(([id,values])=>[id,{values}]));
      const changed=W.differences(Object.fromEntries(recordMap(data,kind)),kind==='work'?baseline.work:baseline.actions,asRows,kind);
      const added=new Set();
      for(const patch of changed.output){
        patches.push({...patch,kind});
        if(remote.has(patch.id))count++;else added.add(patch.id);
      }
      count+=added.size;
    }
    return {patches,count};
  }
  function intentSaved(intent,rows){
    const maps={work:validateRows(rows.workRows,'work'),action:validateRows(rows.actionRows,'action')};
    return intent.patches.every(patch=>{
      const row=maps[patch.kind].get(patch.id);
      return row&&cell(row[patch.index],bool(patch.kind,patch.index))===patch.value;
    });
  }
  function validateAppendCapacity(intent,live){
    for(const [kind,maxRows] of [['work',5001],['action',1200]]){
      const rows=kind==='work'?live.workRows:live.actionRows,existing=validateRows(rows,kind);
      const additions=new Set(intent.patches.filter(patch=>patch.kind===kind&&!existing.has(patch.id)).map(patch=>patch.id));
      if(rows.length+additions.size>maxRows)throw Error((kind==='work'?'ワーク記録':'アクション一覧')+'の追加行が安全な読み取り上限を超えます。未取得の行を作らないため同期を中止しました');
    }
  }
  async function performAttempt({sheetId,token,data,baseline,expectedRows},tracking){
    validateCredentials(sheetId,token);
    const live=await load(sheetId,token);
    const prepared=plan(data,baseline,live),intent=writeIntent(prepared.candidate,live);
    validateAppendCapacity(intent,live);
    const versions=await prepareVersions(prepared.archives),archiveResult=await saveVersions(sheetId,token,versions);
    // Automatic sync has no user-selected preview to invalidate. expectedRows
    // is advisory; always plan from the freshly loaded, complete remote state.
    prepared.summary.refreshedRows=Boolean(expectedRows&&!sameRows(live,expectedRows));
    tracking.count+=archiveResult.archiveCount;
    versions.forEach(version=>tracking.ids.add(version.versionId));
    // Use the current Sheets baseline because our three-way merge already chose
    // safe field values. GoalWriteback performs its own final live-row recheck.
    let result;
    try{
      await checkMainBounds(sheetId,token);
      result=await W.commit({sheetId,token,data:prepared.candidate,baseline:W.baselineFromRows(live.workRows,live.actionRows),expectedRows:live});
    }catch(error){
      // An append/update may have succeeded despite a lost response. Do not send
      // it again: accept only a fresh read proving every planned cell is present.
      const after=await load(sheetId,token);
      if(!intentSaved(intent,after)||!intent.patches.length){
        if(/差分確認後にGoogle Sheetsの内容が変わりました|書き込み確認に失敗しました/.test(error.message))error.code='REMOTE_CHANGED';
        throw error;
      }
      result={...after,count:intent.count};
    }
    try{
      await checkMainBounds(sheetId,token);
      // A third-party edit can arrive in the final reread. Preserve those originals
      // too before returning data that reconcile may import over the local copy.
      const previouslyVerified=new Set(versions.map(version=>version.versionId));
      const finalVersions=await prepareVersions(plan(prepared.data,W.baselineFromRows(live.workRows,live.actionRows),result).archives);
      const additional=finalVersions.filter(version=>!previouslyVerified.has(version.versionId));
      if(additional.length){
        const extra=await saveVersions(sheetId,token,additional);
        tracking.count+=extra.archiveCount;
        additional.forEach(version=>tracking.ids.add(version.versionId));
      }
    }catch(error){
      if(result.count>0)error.message='Sheetsの更新は反映されましたが、端末への取り込み前の最終確認で停止しました。端末の記録はまだ置き換えていません。'+error.message;
      throw error;
    }
    return {...result,archiveCount:tracking.count,archiveVerifiedCount:tracking.ids.size,summary:prepared.summary};
  }
  async function performCommit(options){
    const tracking={count:0,ids:new Set()};
    for(let attempt=0;attempt<2;attempt++){
      try{return await performAttempt(options,tracking);}
      catch(error){
        if(error.code==='REMOTE_CHANGED'&&attempt===0)continue;
        error.archiveCount=tracking.count;
        error.archiveVerifiedCount=tracking.ids.size;
        if(error.code==='REMOTE_CHANGED')error.message='Google Sheetsの更新が続いています。記録は保持したまま、少し待って自動連係を再試行します';
        throw error;
      }
    }
  }
  function commit(options){
    // Snapshot at invocation, not after an earlier same-page operation finishes.
    const frozen={...options,data:clone(options.data),baseline:options.baseline?clone(options.baseline):null,expectedRows:options.expectedRows?clone(options.expectedRows):undefined};
    const previous=locks.get(options.sheetId)||Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>performCommit(frozen));
    locks.set(options.sheetId,task);
    const clear=()=>{if(locks.get(options.sheetId)===task)locks.delete(options.sheetId);};
    task.then(clear,clear);
    return task;
  }
  return {schemaVersion,tabName,headers,limits,plan,load,commit,reconcile,loadArchive};
})();
