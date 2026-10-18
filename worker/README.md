# Cloudflare Worker：Googleへの再接続を毎回求めない認証

「ゴール達成くん」を開くたびにGoogleログインが必要になる問題の対策です。**このPRをマージしただけでは動きません。** Cloudflare WorkerのデプロイとGoogle Cloud側の設定が必要です。

## どう変わる？

- 初回だけGoogleでログイン。以後、PC/iPhoneでアプリを開くとWorkerから新しいGoogleアクセストークンを自動取得して同期。
- Googleの長期用**リフレッシュトークンはWorker側のKVにAES-GCM暗号化して保存**。GitHub Pages側に置かない。
- 各端末のブラウザーにはランダムなアプリ用セッションIDだけを保存（90日間有効、Workerから失効可能）。短期のGoogleアクセストークンはページのメモリ内だけ。
- Worker未設定なら従来の手動Google接続も引き続き使える。
- アプリの記録・同期基準情報・JSONバックアップはそのまま。**本番のシートを初期化しない。**

> 注意：アプリ用セッションIDはGitHub PagesのlocalStorageに保存します。ブラウザーの拡張機能やXSSに対する完全な防御ではありません。Workerにはアクセス制限をかけ、アプリの公開コードへ秘密情報を絶対に入れないでください。より強いセッション保護が必要ならアプリ本体もWorkerと同じオリジンへ移し、HttpOnly Cookieを利用する設計に変更してください。

## 事前準備

1. PC・iPhoneそれぞれ「Google連携 → 端末のJSONバックアップ」でバックアップを保存。
2. Cloudflareアカウントと、既存のGoogle CloudのOAuth Webクライアントを用意。
3. Google Cloudで **Google Sheets API** と **Google Drive API** が有効であることを確認。

## 手順（PC / Wrangler）

Cloudflareのダッシュボードでも同じ設定が可能です。以下は再現性のあるCLI手順です。

1. worker ディレクトリで npm install（外部依存なし）と npx wrangler login。
2. npx wrangler kv namespace create AUTH_KV を実行。返された id を控える。
3. wrangler.toml.example を wrangler.toml にコピーし、REPLACE_WITH_KV_NAMESPACE_ID をそのIDに置き換える。APP_ORIGIN と APP_RETURN_URL は現在のGitHub Pages URLを指定済み。
4. Google Cloud コンソール → APIとサービス → 認証情報 → 既存の **ウェブアプリケーション** OAuthクライアントを開く。「承認済みのリダイレクトURI」に、デプロイ予定の **正確な** Worker URL + /auth/callback を追加する。例：https://goal-tassei-auth.＜自分のサブドメイン＞.workers.dev/auth/callback
5. npx wrangler secret put GOOGLE_CLIENT_ID でそのOAuthクライアントIDを登録。
6. npx wrangler secret put GOOGLE_CLIENT_SECRET でGoogle CloudのOAuthクライアントシークレットを登録。
7. npx wrangler secret put ALLOWED_EMAIL で**自分のGoogleアカウントのメールアドレス**を登録（別のGoogleアカウントからの接続を拒否）。
8. npx wrangler secret put AUTH_ENCRYPTION_KEY でランダムな32バイトのbase64値を登録。PowerShellでの生成例：

   ~~~powershell
   $bytes = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   [Convert]::ToBase64String($bytes)
   ~~~

   **この鍵とGoogleのシークレットはChatGPT、GitHub、README、スクリーンショットに貼らない。** 暗号鍵を失うと既存セッションの復号はできません（再ログインで復旧）。
9. npx wrangler deploy で公開。表示された https://...workers.dev を控える。
10. Worker URLの末尾に /health をつけてブラウザーで開き、JSONで ok:true を確認。

### ダッシュボードで行う場合

Cloudflare → Workers & Pages でWorkerを作成し、worker/index.js をデプロイ。**Bindings** でKV namespaceを AUTH_KV という名前で接続し、**Settings → Variables and Secrets** に上記の環境変数/シークレットを登録します。APP_ORIGIN は https://nao-office.github.io 、APP_RETURN_URL は https://nao-office.github.io/goal-tassei-kun/ です。最後にGoogle CloudへWorkerのリダイレクトURIを追加してください。

## アプリでの初回設定

1. GitHub Pagesの新しいアプリを開き、「Google連携」を選ぶ。
2. **Cloudflare WorkerのURL** 欄に、デプロイした https://...workers.dev を入力。
3. 「自動同期を有効にする」（または上部のGoogle接続ボタン）を押す。
4. Googleで一度ログインし、アプリに戻ったら「自動同期オン」を確認。
5. PCでテスト用の文章を追記して自動保存を待ち、iPhoneで同じWorker URLを設定・初回ログインして反映を確認。逆方向も試す。
6. 両端末でページを閉じて開き直し、**「Googleに再接続」が表示されず自動同期するか**確認。

**アプリはGoogle Sheetsへの書き戻し時に競合を検出します。** 初回は重要な記録を変更せず、専用のテスト文で確認してください。

## トラブルシューティング

- redirect_uri_mismatch：Google Cloudの承認済みリダイレクトURIがWorker URL + /auth/callback と完全一致しているか確認。
- Google認証の設定または権限を確認してください：Workerの環境変数、OAuthクライアントシークレット、許可メールアドレス、Google同意画面を確認。
- 認証サーバーに接続できません（503）：WorkerのKVバインディングと4つのシークレット、2つのURL設定を確認。
- ログイン結果を受け取れませんでした（409）：KVの反映遅延または一時チケットの期限切れ。もう一度初回ログイン。
- 数日後に再ログインが必要：Google OAuthの同意画面が **Testing** だと外部ユーザー向けのリフレッシュトークンが7日で失効することがあります。Google Cloudの公開ステータスやGoogleのポリシーを確認してください。権限取り消し、セッション期限切れ、ブラウザーデータ削除でも再ログインが必要です。
- 変更が競合して止まった：自動で上書きしません。まずJSONバックアップを保存し、Google Sheetsと端末の内容を確認。
- Workerを変更/再デプロイしても動かない：Workerの AUTH_ENCRYPTION_KEY を変えていないか確認。変えた場合は再ログインが必要。

## セキュリティ・運用

- ALLOWED_EMAIL 必須。自分以外のGoogleアカウントは拒否。
- OAuth **authorization code + PKCE + state**。認可コードはWorker側でGoogleと交換。
- 更新用トークンはKVに暗号化保存。ブラウザーは90日有効のランダムセッションIDをlocalStorageに保存。**ログインなしで永久に使えるわけではありません。**
- APIはGitHub PagesのオリジンにCORS制限し、トークン取得はセッション認証必須。
- Google Sheetsの権限はユーザーが同意したGoogleアカウントの全シートに及ぶため、Workerを公開利用する場合は追加のアクセス制限・監査が必要。
- Cloudflare Workers/KVの無料枠・課金条件はCloudflareの最新料金を確認してください。
- Workerをデプロイするまでは既存のブラウザーOAuthが使えるため、移行を段階的に進められます。

## テスト

node --test worker/auth.test.js または cd worker && npm test。認証開始、PKCE、初回認証、使い捨てチケット、暗号化セッション、Googleアクセストークン更新、ログアウト、他オリジン/他アカウントの拒否を検証します。**Google/Cloudflareの実アカウントを使ったPC/iPhoneのE2Eテストは別途必要です。**
