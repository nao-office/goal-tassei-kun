/* A single writer per origin. No leases, timestamps, or read/check/write races. */
(function(root){
  'use strict';
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  // Three-way merge: untouched fields follow the latest tab; edited fields stay
  // here. Conflicting originals are retained in the durable rescue before write.
  function merge(base,local,remote,path=[],conflicts=[]){
    if(equal(local,base))return clone(remote);
    if(equal(remote,base)||equal(local,remote))return clone(local);
    // Two tabs can create today's empty work form independently. Its default
    // blank/unchecked fields are not edits and must not erase the other input.
    if(base===undefined&&path[0]==='entries'&&path.length>=3){
      if(local===''||local===false)return clone(remote);
      if(remote===''||remote===false)return clone(local);
    }
    if(object(local)&&object(remote)&&(object(base)||base===undefined)){
      const result={};
      for(const key of new Set([...Object.keys(base||{}),...Object.keys(local),...Object.keys(remote)])){
        const value=merge(base?.[key],local[key],remote[key],[...path,key],conflicts);
        if(value!==undefined)Object.defineProperty(result,key,{value,enumerable:true,writable:true,configurable:true});
      }
      return result;
    }
    if(Array.isArray(local)&&Array.isArray(remote)&&(Array.isArray(base)||base===undefined)){
      const arrays=[base||[],local,remote];
      // Histories are immutable events, not entities with a unique record ID.
      if(/History$|Checks$|Backups$/.test(path.at(-1)||'')){
        return [...new Map([...remote,...local].map(item=>[JSON.stringify(item),clone(item)])).values()];
      }
      if(arrays.every(items=>items.every(item=>object(item)&&typeof item.id==='string'&&item.id)&&new Set(items.map(item=>item.id)).size===items.length)){
        const [b,l,r]=arrays.map(items=>new Map(items.map(item=>[item.id,item]))),result=[];
        for(const id of new Set([...r.keys(),...l.keys(),...b.keys()])){
          const value=merge(b.get(id),l.get(id),r.get(id),[...path,id],conflicts);
          if(value!==undefined)result.push(value);
        }
        return result;
      }
    }
    conflicts.push({path:[...path],base:clone(base),local:clone(local),otherTab:clone(remote)});
    return clone(local);
  }
  function create({storage,locks,key,raw,data,blocked=false,onChange=()=>{},busy=()=>false,now=()=>new Date().toISOString(),id=()=>crypto.randomUUID()}){
    let baselineRaw=raw,baseline=clone(data),owned=false,waiting=false,yielding=false,suspended=blocked,releaseLock=null,closed=false;
    const requestKey=key+':edit-request',rescuePrefix=key+':tab-rescue:';
    const error=(code,message)=>Object.assign(Error(message),{code});
    const current=()=>storage.getItem(key);
    const stale=()=>{try{return current()!==baselineRaw;}catch(error){return true;}};
    const ready=()=>owned&&!yielding&&!suspended&&!stale();
    function release(){if(releaseLock){const done=releaseLock;releaseLock=null;owned=false;yielding=false;done();onChange();}}
    function write(value){
      if(!owned||suspended||stale())throw error('TAB_CHANGED','別のタブの更新を上書きしないため、保存を保留しました。入力はこの画面に残っています。');
      const next=JSON.stringify(value);storage.setItem(key,next);baselineRaw=next;baseline=clone(value);onChange();
    }
    function acquire(wait=false){
      if(owned)return Promise.resolve(true);
      if(!locks?.request)return Promise.reject(error('TAB_UNSUPPORTED','このブラウザーでは複数タブの安全な保存を利用できません。対応する最新ブラウザーで開いてください。'));
      if(waiting)return Promise.resolve(false);
      waiting=true;onChange();
      return new Promise((resolve,reject)=>{
        const abort=new AbortController(),timer=wait?setTimeout(()=>abort.abort(),15000):null;
        locks.request(key+':single-writer',wait?{signal:abort.signal}:{ifAvailable:true},async lock=>{
          clearTimeout(timer);waiting=false;
          if(!lock||closed){resolve(false);onChange();return;}
          owned=true;
          const held=new Promise(done=>{releaseLock=done;});
          resolve(true);onChange();await held;
        }).catch(reason=>{clearTimeout(timer);waiting=false;onChange();reject(reason);});
      });
    }
    async function request(){
      suspended=true;onChange();
      if(owned)return true;
      storage.setItem(requestKey,id());
      return acquire(true);
    }
    function changed(event){
      if(event.key===requestKey&&owned){
        yielding=true;onChange();
        const finish=()=>{if(!owned)return;if(busy())setTimeout(finish,100);else release();};finish();
      }else if(event.key===key||event.key===null)onChange();
    }
    function prepare(local,remote,remoteRaw,drafts,archiveDraft=null){
      if(!owned||current()!==remoteRaw)throw error('TAB_CHANGED','別のタブの更新が続いています。もう一度お試しください。');
      const conflicts=[],merged=merge(baseline,local,remote,[],conflicts);
      // Back up the exact stored bytes as well as normalized data, including
      // unsaved form controls. No previous rescue is overwritten or pruned.
      if(!equal(local,baseline)||drafts.length||archiveDraft||conflicts.length){
        const rescue={format:'goal-tab-rescue-v1',recoveryOnly:true,createdAt:now(),base:clone(baseline),thisTab:clone(local),otherTab:clone(remote),otherTabRaw:remoteRaw,drafts:clone(drafts),archiveDraft:clone(archiveDraft),conflicts};
        storage.setItem(rescuePrefix+id(),JSON.stringify(rescue));
      }
      return {merged,conflicts,remoteRaw};
    }
    function commit(prepared){
      if(!owned||current()!==prepared.remoteRaw)throw error('TAB_CHANGED','別のタブの更新が続いています。入力は残しています。');
      const next=JSON.stringify(prepared.merged);storage.setItem(key,next);baselineRaw=next;baseline=clone(prepared.merged);suspended=false;onChange();
    }
    function rescues(){const result=[];for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(rescuePrefix))result.push(JSON.parse(storage.getItem(k)));}return result;}
    return {write,ready,acquire,request,changed,prepare,commit,rescues,release,
      state:()=>({owned,waiting,yielding,suspended,supported:!!locks?.request,stale:stale()}),
      close:()=>{closed=true;release();}};
  }
  root.GoalTabStorage={merge,create};
  if(typeof module!=='undefined')module.exports=root.GoalTabStorage;
})(typeof window!=='undefined'?window:globalThis);
