/* Local-only backup/reuse helpers. No network or storage writes. */
window.GoalArchiveTools=(()=>{
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const workKeys=['fit','normal','futureAction','valuableAction','minimumAction','withoutAction','achievement','growth','tomorrow'];
  const actionKeys=['goalId','theme','title','minimum','expected','start','due','horizon','priority','note','technical','adaptive'];
  function bundles(value){
    if(!Array.isArray(value)||value.length>100)throw Error('別記録バックアップの形式・件数が不正です');
    for(const b of value){
      if(!b||Object.keys(b).sort().join('|')!=='fetchedAt|rows|schemaVersion|sheetId|tabExists'||b.schemaVersion!==1
        ||typeof b.sheetId!=='string'||!b.sheetId||b.sheetId.length>300||!Number.isFinite(Date.parse(b.fetchedAt))
        ||typeof b.tabExists!=='boolean'||!Array.isArray(b.rows)||b.rows.length>10001
        ||b.rows.some(row=>!Array.isArray(row)||row.length>10||row.some(v=>!['string','number','boolean'].includes(typeof v)))
        ||(!b.tabExists&&b.rows.length))throw Error('別記録バックアップの形式・容量が不正です');
    }
    if(new Blob([JSON.stringify(value)]).size>20000000)throw Error('別記録バックアップが20MBを超えています');
    return clone(value);
  }
  function draft(version){
    const p=version.payload;
    if(!p||!p.values||!['work','action'].includes(p.kind))throw Error('コピーできる内容がありません');
    const keys=p.kind==='work'?workKeys:actionKeys,values={};
    for(const key of keys){values[key]=p.values[key]||'';if(typeof values[key]!=='string'||values[key].length>4000)throw Error('編集できる文字数を超えています。元の別記録は残っています');}
    return {kind:p.kind,originalId:p.id,versionId:version.versionId,values};
  }
  function apply(data,draft,date,id,now){
    const out=clone(data),keys=draft.kind==='work'?workKeys:actionKeys;
    if(!['work','action'].includes(draft.kind)||Object.keys(draft.values).some(k=>!keys.includes(k)))throw Error('コピー内容が不正です');
    for(const key of keys)if(typeof draft.values[key]!=='string'||draft.values[key].length>4000)throw Error('文字数は各項目4000文字以内にしてください');
    if(draft.kind==='work'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('日付が不正です');
      out.entries=out.entries||{};
      if(!out.entries[date]&&Object.keys(out.entries).length>=5000)throw Error('ワークの保存件数が上限です');
      const e=out.entries[date]||{};
      for(const key of keys){
        const add=draft.values[key];if(!add.trim())continue;
        // Append only. Preserve checkboxes, original text, lesson identity and metadata.
        const next=e[key]?e[key]+'\n'+add:add;
        if(next.length>4000)throw Error('追記後に4000文字を超える項目があります。編集欄の内容を減らしてください');
        e[key]=next;
      }
      out.entries[date]=e;
    }else{
      out.progress=out.progress||{};const p=out.progress;p.actions=p.actions||[];
      if(p.actions.length>=1000)throw Error('アクションの保存件数が上限です');
      if(!id||[...p.actions,...(p.sheetActions||[])].some(a=>a.id===id))throw Error('新規IDを作成できませんでした');
      if(!draft.values.title.trim())throw Error('アクション名を入力してください');
      p.actions.push({...draft.values,id,status:'未着手',createdAt:now,updatedAt:now,completedAt:'',source:'別記録からコピー'});
    }
    return out;
  }
  return {bundles,draft,apply,workKeys,actionKeys};
})();
