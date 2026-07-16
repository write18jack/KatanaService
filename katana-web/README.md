# 刀市場分析プラットフォーム

## 概要

刀市場分析プラットフォームは、刀販売店向けの市場分析・在庫管理サービスです。

各店舗が登録した販売商品の情報をもとに、市場全体の価格動向や市場傾向を分析し、商品の価格決定を支援します。

また、各店舗は自社商品の登録・編集・Excel/CSVによる一括取込ができます。

---

# システム目的

本サービスは以下を目的としています。# システム概要図

![System Architecture](docs/images/system-architecture.png)

# ER図

![ER Diagram](docs/images/er-diagram.png)

# 画面遷移図

![Screen Flow](docs/images/screen-flow.png)

- 市場価格の参考指標を提供する
- 各店舗の商品管理を効率化する
- 販売履歴・価格履歴を蓄積する
- Excel/CSVによる一括更新を可能にする

---

# システム全体構成図

```text
┌──────────────────────────────┐
│         利用者（店舗）          │
└──────────────┬───────────────┘
               │
               ▼
      Next.js (App Router)
               │
      ┌────────┴────────┐
      │                 │
      ▼                 ▼
市場分析               自社管理
(Market)            (Products)
      │                 │
      └────────┬────────┘
               ▼
       Route Handlers(API)
               │
               ▼
         Service Layer
               │
               ▼
           Prisma ORM
               │
               ▼
          PostgreSQL
               │
      ┌────────┴─────────┐
      │                  │
      ▼                  ▼
   商品データ         マスタデータ
(products)     (makers, grades...)
```

# システム全体構成図

```text
             店舗ユーザー
                   │
      ┌────────────┴─────────────┐
      │                          │
      ▼                          ▼
 市場分析画面               自社管理画面
      │                          │
      └────────────┬─────────────┘
                   ▼
            Next.js(App Router)
                   │
        Route Handlers(API)
                   │
         ┌─────────┴──────────┐
         │                    │
         ▼                    ▼
    商品管理Service      Excel取込Service
         │                    │
         └─────────┬──────────┘
                   ▼
                Prisma
                   │
                   ▼
             PostgreSQL
                   │
      ┌────────────┼──────────────────────────┐
      ▼            ▼            ▼             ▼
   products   product_histories price_histories masters
```

## システム構成

|レイヤー|役割|
|---------|------|
|Frontend|Next.js(App Router)|
|API|Route Handlers|
|Business Logic|Service Layer|
|ORM|Prisma|
|Database|PostgreSQL|
|Storage|Excel/CSV Import|

# 主な機能

## 市場分析

- 市場商品一覧
- 平均価格分析
- 刀種別分析
- 時代別分析
- 作者別分析
- 価格推移分析

※ 市場分析では店舗情報は表示されません。

---

## 自社管理

- 商品一覧
- 商品登録
- 商品編集
- 商品詳細
- SOLD管理
- Excel/CSV取込
- 取込履歴

---

## マスタ管理

- 作者
- 格付
- 位列
- 時代
- 伝
- 刀種
- 鑑定者

---

# システム構成

```
Next.js
      │
      ▼
Route Handler(API)
      │
      ▼
Prisma ORM
      │
      ▼
PostgreSQL
```

---

# 技術スタック

|分類|技術|
|------|------|
|Frontend|Next.js 15|
|Language|TypeScript|
|UI|Tailwind CSS|
|Authentication|NextAuth|
|ORM|Prisma|
|Database|PostgreSQL|
|Validation|Zod|
|Runtime|Node.js|
|Container|Docker Compose|

---

# ディレクトリ構成

```
katana-service/

├── app/
├── components/
├── lib/
├── prisma/
├── public/
├── docs/
├── scripts/
└── docker/
```

---

# ドキュメント一覧

```
docs/

01_要件定義書.docx
02_業務フロー設計書.docx
03_画面設計書.docx
04_画面遷移図.drawio
05_DB設計書.docx
06_ER図.drawio
07_API設計書.docx
08_ExcelCSV取込仕様書.docx
09_認可・権限設計書.docx
10_マスタ管理設計書.docx
11_バリデーション設計書.docx
README.md
```
# 設計資料

設計書は `docs` フォルダに格納しています。

|No.|ドキュメント|内容|
|---:|-----------|------|
|01|[要件定義書](docs/01_要件定義書.docx)|システム全体要件|
|02|[業務フロー設計書](docs/02_業務フロー設計書.docx)|業務フロー|
|03|[画面設計書](docs/03_画面設計書.docx)|画面仕様|
|04|[画面遷移図](docs/04_画面遷移図.drawio)|画面遷移|
|05|[DB設計書](docs/05_DB設計書.docx)|テーブル設計|
|06|[ER図](docs/06_ER図.drawio)|ER図|
|07|[API設計書](docs/07_API設計書.docx)|API仕様|
|08|[ExcelCSV取込仕様書](docs/08_ExcelCSV取込仕様書.docx)|Excel取込|
|09|[認可・権限設計書](docs/09_認可・権限設計書.docx)|認証・認可|
|10|[マスタ管理設計書](docs/10_マスタ管理設計書.docx)|マスタ設計|
|11|[バリデーション設計書](docs/11_バリデーション設計書.docx)|入力チェック|

---

# 開発環境

## 必要環境

- Node.js
- Docker
- Docker Compose
- PostgreSQL

---

# セットアップ

```bash
git clone <repository>

cd katana-service

npm install
```

---

## Docker起動

```bash
docker compose up -d
```

---

## Prisma

```bash
npx prisma generate

npx prisma migrate dev
```

---

## 開発サーバ起動

```bash
npm run dev
```

---

# Excel/CSV取込フロー

```
Excel作成

↓

アップロード

↓

取込内容確認

↓

差分判定

↓

登録・更新

↓

履歴保存

↓

市場分析へ反映
```

---

# 権限

|機能|STORE|ADMIN|
|------|:---:|:---:|
|市場分析|〇|〇|
|自社商品管理|〇|〇|
|Excel取込|〇|〇|
|マスタ管理|×|〇|
|ユーザー管理|×|〇|

---

# データベース概要

主要テーブル

- shops
- users
- products
- product_histories
- price_histories
- import_jobs
- import_rows

マスタ

- makers
- grades
- ranks
- periods
- traditions
- categories
- appraisers

---

# 開発ルール

## コーディング

- TypeScript Strict Mode
- ESLint
- Prettier

---

## DB

- Prisma Migrationを使用する
- 手動SQL更新は禁止

---

## Git運用

main

↓

develop

↓

feature/xxxx

↓

Pull Request

↓

Review

↓

Merge

---

# 将来拡張

- AI価格予測
- オークションデータ連携
- 海外市場分析
- REST API公開
- CSVエクスポート
- ダッシュボード分析
- メール通知
- 在庫アラート

---

# ライセンス

Private Project

---

# 更新履歴

|Version|Date|Description|
|--------|------|-----------|
|1.0.0|2026-07|初版作成|
