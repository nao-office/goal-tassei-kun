window.GoalCloudAuth=(function(){
  'use strict';
  function clearSession(storage,{sessionKey,autoSyncKey,autoEnableAfterReviewKey}){
    storage.setItem(autoSyncKey,'0');
    storage.removeItem(autoEnableAfterReviewKey);
    storage.removeItem(sessionKey);
  }
  function saveSession(storage,{sessionKey,autoSyncKey,autoEnableAfterReviewKey},session){
    storage.setItem(autoSyncKey,'0');
    storage.removeItem(autoEnableAfterReviewKey);
    storage.setItem(sessionKey,session);
  }
  async function requestAccessToken(fetchImpl,workerUrl,session){
    const response=await fetchImpl(workerUrl+'/auth/token',{
      headers:{Authorization:'Bearer '+session},cache:'no-store'
    });
    if(!response.ok){
      const error=new Error(errorMessage(response.status));
      error.status=response.status;
      throw error;
    }
    const body=await response.json();
    if(!body.access_token)throw new Error('Googleの認証情報を取得できませんでした。端末の記録は変更していません。');
    return body.access_token;
  }
  function errorMessage(status){
    if(status===401)return 'Googleとの接続期限が切れたか、認証が無効です。「Googleに再ログイン」を押してください。端末とSheetsの記録は変更していません。';
    if(status===403)return 'Googleへの接続が許可されませんでした。ログイン中のGoogleアカウントとWorkerの設定を確認してください。';
    return `Googleとの接続を確認できません（HTTP ${Number(status)||'不明'}）。ネット接続とWorkerの設定を確認してください。`;
  }
  return {clearSession,saveSession,requestAccessToken,errorMessage};
})();
