# F-01 E2E 手順書（E2E-01〜06）

作成日: 2026-11-24（Phase 4・Step 4-16）

この文書は、F-01（店舗の無効化・ユーザーの削除・所属やロールの変更が、ログイン中のセッションにもすぐ反映されること）を、実際のブラウザ・開発サーバー・テストDB で確かめる手順です。

**まだ一度も実行していません。** 実行するときは、**この文書の操作を1つずつ、個別の承認を得てから行います。** まとめて自動で実行するものではありません。失敗したら、その場で止まり、次の操作に進みません（「8. 失敗したとき」）。

関連する文書：`docs/TESTING.md`（5〜7章。統合テストの経路、テストDB の復旧、E2E 用の開発サーバーとテストデータ）、`docs/PLAN-test-db-isolation.md`（4章。F-01 の E2E の設計と記録）。

---

## 1. 役割の分担（方式 B・案2）

| 誰が | 何をするか |
|---|---|
| **ユーザー** | `.env.e2e` を作る。ブラウザのログインの画面で、**パスワードを入力して「ログイン」を押す**（シナリオごと） |
| Claude | 承認を得たコマンドの実行（確認・データの準備・DB の変更・開発サーバーの起動と停止）。ブラウザの操作（URL を開く、メールアドレスの入力、ボタンを押す、再読み込み）。画面の URL・見出し・メッセージ・Cookie の有無の記録 |

- **Claude は `.env.e2e` を読まず、パスワードの入力欄には何も入力しない。** パスワードの値は、表示・記録しない（`CLAUDE.md` の Testing and Test Database の節）。
- ログインのたびに、Claude はメールアドレスまで入力して止まり、ユーザーに「パスワードの入力とログイン」を頼む。ユーザーが「ログインした」と伝えたら、次へ進む。
- 画面の記録は、URL・見出し・メッセージの文言・セッションの Cookie（`authjs.session-token`）の**有無**だけにする（Cookie の値は記録しない）。

## 2. 使うもの

| もの | 値 |
|---|---|
| 開発サーバー | 待ち受けは `127.0.0.1:3100`（`npm run e2e:dev-server -- --start` だけで起動する）。**ブラウザでは `http://localhost:3100` で開く**（`proxy.ts` の転送先が `localhost` になるため。`127.0.0.1` で開くと、途中で転送先のホストと入れ替わり、Cookie が2つに分かれる。`docs/PLAN-test-db-isolation.md` の R16） |
| テストDB | `127.0.0.1:5434`・`katana_test`（状態 C から `seed` で準備する） |
| データの準備・変更 | `npm run testdb:e2e -- --op <操作> --apply`（固定の操作だけ） |
| ブラウザ | Claude が操作するブラウザ（組み込みブラウザ、または Chrome）。**シナリオごとに新しいプライベートウィンドウ（新しいブラウザのコンテキスト）を使う**（K7：localhost のポートが違っても Cookie が混ざるため） |

**E2E 用のアカウント**（`seed` で作る。パスワードは全員 `.env.e2e` の `KATANA_E2E_USER_PASSWORD`）：

| メールアドレス | 店舗 | ロール | 使うシナリオ |
|---|---|---|---|
| `e2e-01@example.invalid` | A | STORE | E2E-01・02 |
| `e2e-03@example.invalid` | C | STORE | E2E-03（削除される。取り込み履歴なし） |
| `e2e-04@example.invalid` | C | STORE | E2E-04（店舗B へ移される） |
| `e2e-05@example.invalid` | C | ADMIN | E2E-05（STORE へ変えられる） |
| `e2e-06-ja@example.invalid` | D | STORE | E2E-06（日本語） |
| `e2e-06-en@example.invalid` | D | STORE | E2E-06（英語） |

**`seed` で入るデータ**：店舗 A（商品 `E2E-A-001`・取り込み `e2e-shop-a.csv`（PENDING。確定のボタンが出る））、店舗 B（商品 `E2E-B-001`・`E2E-B-002`、取り込み `e2e-shop-b.csv`（COMPLETED））、店舗 C（商品 `E2E-C-001`）、店舗 D（商品なし）。

## 3. 始める前の条件（それぞれ承認が必要）

1. **Git：** ブランチ・HEAD が想定どおりで、未commit の変更がないこと。
2. **固定ゲート：** 9つとも無効であること（このあと、E2E に必要な2つだけを有効にする）。
3. **テストDB：** `npm run testdb:status`・`npm run testdb:identity`・`npm run testdb:verify` で、コンテナが稼働中・healthy、**状態 C**、postmaster の識別情報を記録する（過去の結果で代えない）。
4. **開発用DB：** 稼働していないこと（案A。`katana-db` が0件、5432・5433番の待ち受けが0件）。E2E のあいだも起動しない。
5. **3100番：** 待ち受けがないこと（ほかの開発サーバーが動いていない）。
6. **`.env.e2e`：** ユーザーが作る（`umask 077` などで本人だけが読めるようにする。キーは `KATANA_E2E_USER_PASSWORD` だけ。16文字以上、`A-Z`・`a-z`・`0-9`・`_`・`-` だけ、テストDB のパスワードと違う値）。Claude は中身を読まない。
7. **予行：** `npm run testdb:e2e -- --op seed`（`.env.test`・`.env.e2e` の検証。DB に接続しない）と `npm run e2e:dev-server`（開発サーバーの環境変数の検証。起動しない）が、どちらも成功すること。

## 4. ゲートの有効化（承認が必要）

- 1つの commit で、**`E2E_DEV_SERVER_DISABLED`（`scripts/e2e-dev-server.mts`）と `E2E_FIXTURE_DISABLED`（`scripts/testdb-e2e.mts`）の2つだけ**を、固定のリテラル `{ mode: "enabled" }` にする。対応する静的テスト（`lib/testing/e2eDevServer.test.ts`・`lib/testing/testDbE2eFixtures.test.ts`）も同じ commit で更新し、名前を指定したテスト・型検査・ESLint で確かめる。
- ほかの7つのゲート（migration・checksum・catalog・schemaDiff・ro-role の2つ・統合テスト）は、無効のまま。
- E2E が終わったら、成功・失敗にかかわらず、2つとも無効に戻す（「7. 後片付け」）。

## 5. 準備（それぞれ承認が必要）

1. **データの準備：** `npm run testdb:e2e -- --op seed --apply` を1回。期待：終了コード0、「rows changed: 20」、事後の検査に通る。
2. **開発サーバーの起動：** `npm run e2e:dev-server -- --start`。Claude がバックグラウンドで起動し、`http://localhost:3100/ja/login` が表示されるまで待つ。期待：ログインの画面が出る。開発サーバーの出力に、接続の失敗・`TARGET_INVALID`・`DATABASE_URL_MISMATCH` などのガードのエラーが出ない。

## 6. シナリオ

各シナリオの「DB の変更」は、`npm run testdb:e2e -- --op <操作> --apply` の1回で、それぞれ承認が必要です。期待：終了コード0、「rows changed: 1」。**同じ操作を2回行わない**（2回目は0件で止まる）。

ログインの手順（各シナリオ共通）：新しいプライベートウィンドウで `http://localhost:3100/<ja|en>/login` を開く → Claude がメールアドレスを入力する → **ユーザーがパスワードを入力して「ログイン」（en は「Sign In」）を押す** → `/<ja|en>/dashboard` に移ることを確かめる。

### E2E-01：ログイン中に店舗を無効にする

1. `e2e-01@example.invalid` で `/ja/login` からログインする。期待：`/ja/dashboard` が表示される。
2. 同じウィンドウで、タブを2つ開いておく：`/ja/dashboard/products`（`E2E-A-001` の行に「販売済みにする」が出る）と、`/ja/dashboard/import/00000000-0000-4000-8e2e-000000001a01`（「この内容で取り込む」が出る）。
3. **DB の変更：** `e2e01-deactivate-shop-a`。
4. `/ja/dashboard` のタブを再読み込みする。期待：`/ja/access-suspended` に移り、「アクセスが停止されています」が出る。
5. 商品のタブで「販売済みにする」→ ダイアログの「販売済みにする」を押す。期待：「認証が必要です。」のメッセージ（通知）が出る。
6. 取り込みのタブで「この内容で取り込む」を押す。期待：「認証が必要です。」のエラーが出る。
7. 5・6 で DB が変わっていないことは、E2E-02 で確かめる。

### E2E-02：同じセッションのまま店舗を有効に戻す

1. **DB の変更：** `e2e02-activate-shop-a`。
2. E2E-01 と同じウィンドウ（同じセッション）で `/ja/dashboard` を開く。期待：**再ログインせずに**ダッシュボードが表示される。
3. `/ja/dashboard/products` を開く。期待：`E2E-A-001` はまだ販売中（E2E-01 の5で変わっていない）。
4. `/ja/dashboard/import/00000000-0000-4000-8e2e-000000001a01` を開く。期待：「この内容で取り込む」がまだ出る（E2E-01 の6で確定されていない）。

### E2E-03：ログイン中にユーザーを削除する

1. 新しいプライベートウィンドウで、`e2e-03@example.invalid` で `/ja/login` からログインする。期待：`/ja/dashboard`。
2. **DB の変更：** `e2e03-delete-user`。
3. `/ja/dashboard` を再読み込みする。期待：`/ja/access-suspended`。
4. 「ログアウト」を押す。期待：`/ja/login` に移る。セッションの Cookie がなくなる。
5. `/ja/dashboard` を開く。期待：`/ja/login` へ移される（ログインしていない扱い）。

### E2E-04：ログイン中に所属の店舗を変える

1. 新しいプライベートウィンドウで、`e2e-04@example.invalid` で `/ja/login` からログインする。期待：ダッシュボードの自店の件数が店舗C のもの（商品1件、取り込み履歴なし）。
2. **DB の変更：** `e2e04-move-user-to-shop-b`。
3. `/ja/dashboard` を再読み込みする。期待：自店の件数が店舗B のもの（商品2件）、最近の取り込みに `e2e-shop-b.csv` が出る。
4. `/ja/dashboard/products` を開く。期待：`E2E-B-001`・`E2E-B-002` だけが出て、`E2E-C-001` は出ない。

### E2E-05：ログイン中にロールを変える

1. 新しいプライベートウィンドウで、`e2e-05@example.invalid`（ADMIN）で `/ja/login` からログインする。`/ja/dashboard`・`/ja/dashboard/products`・`/ja/dashboard/import` が表示されることを記録する。
2. **DB の変更：** `e2e05-demote-admin`。
3. 同じ3つのページを再読み込みする。期待：**表示が変わらない**（ページと Action はロールを参照していないので、確かめられるのは「動作が変わらないこと」だけ）。

### E2E-06：日本語と英語で、停止画面とログアウトを確かめる

1. 新しいプライベートウィンドウを2つ使う。1つ目で `e2e-06-ja@example.invalid` を `/ja/login` から、2つ目で `e2e-06-en@example.invalid` を `/en/login` からログインする。期待：それぞれ `/ja/dashboard`・`/en/dashboard`。ダッシュボードのヘッダーにユーザー名が出ない。
2. **DB の変更：** `e2e06-deactivate-shop-d`。
3. それぞれ再読み込みする。期待：`/ja/access-suspended`（「アクセスが停止されています」）と `/en/access-suspended`（「Access suspended」）。停止画面にユーザー名・店舗名・停止の理由が出ない。
4. それぞれ「ログアウト」／「Log out」を押す。期待：`/ja/login`・`/en/login` に着き、そこで止まる（転送が繰り返されない。URL が変わり続けない）。

## 7. 後片付け（それぞれ承認が必要）

1. **開発サーバーの停止：** Claude が起動したプロセスを止め、3100番の待ち受けが0件になったことを確かめる。
2. **ゲートの無効化：** `E2E_DEV_SERVER_DISABLED`・`E2E_FIXTURE_DISABLED` を無効に戻す commit（有効にした commit の前の内容に戻す）。9つとも無効であることを確かめる。
3. **テストDB の作り直し：** E2E のデータは SQL で消さない。`docs/TESTING.md` の6章の手順（down → up → 状態 A の確認 → migration のゲートの有効化 → `migrate --apply` を1回 → ゲートを戻す → `verify` で状態 C）で戻す。`katana_test_ro` は作り直さない（schemaDiff の前だけ）。
4. **開発用DB：** 稼働していないことを、Phase 4 の開始時と同じコマンドで確かめる（案A の終了時の記録）。
5. **記録：** 結果を `docs/PLAN-test-db-isolation.md` の4章に記録し、F-01 の判定を更新する（「9. 判定」）。

## 8. 失敗したとき

- **期待と違う結果が出たら、そこで止まる。** 自動の再実行・次のシナリオへの移行・DB の修復はしない。URL・画面の文言・エラーのコード・時刻を記録して、報告し、承認を待つ。
- `testdb:e2e` が止まった場合（`STATE_NOT_ALLOWED`・`UNEXPECTED_ROW_COUNT`・`WRITE_FAILED` など）、同じ操作を繰り返さない。変更は ROLLBACK されているので、まず `npm run testdb:verify` で状態を読む。
- 開発サーバーの出力にガードのエラーが出た場合は、開発サーバーを止め、ゲートを無効に戻してから、原因を調べる。
- どの失敗のあとも、「7. 後片付け」の1〜4を、承認を得て行う。

## 9. 判定

- E2E-01〜06 を、**成功・失敗・未実施**に分けて記録する。未実施のシナリオを成功と扱わない。
- 6つすべてが成功し、後片付け（ゲートの無効化、テストDB の状態 C、開発用DB が稼働していないこと）まで確かめられたら、F-01 を **CONDITIONAL PASS から PASS に更新できる**。1つでも失敗・未実施があれば、CONDITIONAL PASS のままにする。

## 10. 範囲外と既知の事項

- ダッシュボードのヘッダーのログアウト（`actions/auth/logout.ts`）は、言語の付かない `/login` へ移す。E2E-06 の対象（停止画面からのログアウト）ではないので、今回は確かめない（Step 4-13 で記録した気づき）。
- 認可の3件（自己登録で ADMIN ができる、承認されていない店舗が市場データを見られる、`proxy.ts` が JWT の role で判定する）は、F-01 の範囲外で、本番公開の前に別の工程で扱う。
