# claude-usage-checker

AI エージェント（Claude Code など）が、Claude の **5時間制限** と **週間制限** があと何 % 残っているかを知るためのツールです。

```console
$ claude-usage --oneline
5h: 77% left (resets in 2h19m) | 7d: 59% left (resets in 3d17h)
```

- 5時間枠・週間（7日）枠の **残り % / 使用 % / リセットまでの時間** を取得
- エージェント向けの入口を一通り用意: JSON 出力、しきい値判定の終了コード、MCP サーバー、Claude Code の hooks、Skill
- Python 3.9 以上の標準ライブラリだけで動作（依存パッケージなし）
- OAuth トークンなどの認証情報を自分で読んだり保存したりしない

## しくみ

使用量は Claude Code 自身から受け取ります。経路は 2 つあります。

| 経路 | 中身 | 位置づけ | 速さ |
| --- | --- | --- | --- |
| **statusline** | Claude Code が statusline コマンドに渡す `rate_limits`（v2.1.80 以降） | ドキュメント化された公式機能 | 即時（キャッシュを読むだけ） |
| **Claude Code への問い合わせ** | `claude -p` の stream-json インターフェースに `get_usage` 制御リクエストを送る（`/usage` と同じデータ） | Agent SDK で「実験的（変更の可能性あり）」とされている API | 1〜3 秒 |

`claude-usage` は既定（`--source auto`）で次のように動きます。

1. キャッシュ（statusline が記録した値、または前回の問い合わせ結果）が新しければ（既定 120 秒以内）それを返す
2. 古ければ Claude Code に問い合わせて最新の値を取る
3. 問い合わせに失敗したら、古いキャッシュを `"stale": true` と警告付きで返す

問い合わせについて:

- プロンプトは送らないのでモデルは呼ばれず、**使用量を消費しません**。
- ログインとトークンの更新は Claude Code 自身が行います。問い合わせ用の Claude Code は hooks と MCP サーバーを無効にして起動します。
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` は無視して、`/login` したサブスクリプションのログインを使います（`-p` モードでは API キーが優先されてしまい、プランの制限を取得できないため）。

> 非公式のエンドポイント `api.anthropic.com/api/oauth/usage` を OAuth トークンで直接呼ぶ方法もありますが、採用していません。ツールが認証情報を扱うことになるうえ、リフレッシュトークンのローテーションで Claude Code のログインを壊しかねず、User-Agent によっては厳しいレート制限もかかるためです。

## 必要なもの

- Claude Code（Pro / Max / Team / Enterprise のサブスクリプションで `/login` 済み）
- Python 3.9 以上

## インストール

```bash
uv tool install git+https://github.com/60fullerene/claude-usage-checker
# または
pipx install git+https://github.com/60fullerene/claude-usage-checker
```

`claude-usage` コマンドが使えるようになります（`python -m claude_usage_checker` でも同じです）。

## セットアップ

### 1. statusline に登録する（推奨）

`~/.claude/settings.json` に追加します。Claude Code が API の応答ごとに最新の使用量を渡してくれるので、エージェントが確認するときは待ち時間なしで新しい値が返ります。

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-usage statusline"
  }
}
```

ステータスラインには `5h 77% left (resets in 2h19m) | 7d 59% left (resets in 3d17h)` のように表示されます（残りに応じて緑・黄・赤）。

自分の statusline がすでにある場合は `--wrap` で包むと、表示はそのままで記録だけを行います。`--append` を付けると使用量を 2 行目に追加します。

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-usage statusline --wrap '~/.claude/statusline.sh' --append"
  }
}
```

statusline を設定しなくても動きます。その場合は Claude Code への問い合わせになるため、キャッシュが切れるたびに 1〜3 秒かかります。

### 2. エージェントに使わせる

目的に合わせて、どれか（または複数）を設定します。

**A. Skill（いつ・どう確認するかを Claude Code に教える）**

```bash
git clone https://github.com/60fullerene/claude-usage-checker
mkdir -p ~/.claude/skills
cp -r claude-usage-checker/skills/claude-usage ~/.claude/skills/
```

[`skills/claude-usage/SKILL.md`](skills/claude-usage/SKILL.md) に、確認するタイミングと、残りが少ないときの振る舞い（10% を切ったら作業を保存・コミットしてまとめる、など）を書いてあります。好みに合わせて編集してください。

**B. MCP サーバー（`get_claude_usage` ツールとして提供）**

```bash
claude mcp add --scope user claude-usage -- claude-usage mcp
```

ほかの MCP クライアントでは次のように登録します。

```json
{
  "mcpServers": {
    "claude-usage": { "command": "claude-usage", "args": ["mcp"] }
  }
}
```

**C. hooks（エージェントに自動で知らせる）**

次の例では、セッション開始時に残りを伝え、ツールの実行後は残りが 15% を切ったときだけ警告します（同じセッションでは、さらに 5 ポイント減るごとに再警告）。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "claude-usage hook" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "claude-usage hook --warn-below 15" }] }
    ]
  }
}
```

エージェントには次のようなメッセージが届きます。

```text
Claude usage is running low: 5-hour limit has 12% left (resets in 38m). Current status: 5h: 12% left (resets in 38m) | 7d: 55% left (resets in 2d4h). Prioritize finishing and saving the current work (commit, write notes) before starting anything large.
```

`UserPromptSubmit` に `claude-usage hook` を登録すれば、毎ターン残りを伝えることもできます。

**D. CLAUDE.md / AGENTS.md に書く**

シェルを使えるエージェントなら、指示を書くだけでも使えます。

```markdown
- 大きな作業を始める前と長い作業の途中で、`claude-usage --oneline` で Claude の使用量の残りを確認する。
- 5時間枠の残りが 10% を切ったら新しい大きな作業は始めず、作業を保存・コミットして状況をまとめる。
```

## 使い方

```bash
claude-usage                         # 人間向けの表示
claude-usage --oneline               # 1 行の要約
claude-usage --json                  # エージェント・スクリプト向けの JSON
claude-usage --min-5h 10 --min-7d 5  # しきい値チェック（終了コードで判定）
```

```console
$ claude-usage
Claude usage limits
  5-hour        [########..]    77% left  (23% used), resets 18:35 (in 2h19m)
  7-day         [######....]    59% left  (41% used), resets Thu 09:16 (in 3d17h)
  7-day Sonnet  [#########.]    94% left  (6% used), resets Thu 09:16 (in 3d17h)
  source: Claude Code query, 0s old
```

| オプション | 説明 |
| --- | --- |
| `--source auto` | 既定。新しいキャッシュがあればそれを、なければ Claude Code に問い合わせる |
| `--source cache` | キャッシュだけを使う（即時。古ければ `"stale": true`） |
| `--source claude` | 毎回 Claude Code に問い合わせる |
| `--max-age SECONDS` | auto で受け入れるキャッシュの古さ（既定 120） |
| `--timeout SECONDS` | Claude Code の応答を待つ時間（既定 30） |
| `--min-5h PCT` / `--min-7d PCT` | 残りが PCT% 未満なら終了コード 1 |

終了コード: `0` 正常（しきい値も満たす）、`1` しきい値を下回った、`2` データなし・エラー

### JSON の形式

```json
{
  "ok": true,
  "summary": "5h: 77% left (resets in 2h19m) | 7d: 59% left (resets in 3d17h)",
  "five_hour": {
    "used_percent": 23.0,
    "remaining_percent": 77.0,
    "resets_at": "2026-09-27T18:35:04Z",
    "resets_in_seconds": 8369,
    "observed_at": "2026-09-27T16:15:35Z",
    "age_seconds": 0,
    "source": "claude"
  },
  "seven_day": {
    "used_percent": 41.0,
    "remaining_percent": 59.0,
    "resets_at": "2026-10-01T09:16:04Z",
    "resets_in_seconds": 320429,
    "observed_at": "2026-09-27T16:15:35Z",
    "age_seconds": 0,
    "source": "claude"
  },
  "stale": false,
  "warnings": [],
  "other_windows": {
    "seven_day_sonnet": { "used_percent": 6.0, "remaining_percent": 94.0, "...": "..." }
  },
  "subscription_type": "max",
  "generated_at": "2026-09-27T16:15:35Z"
}
```

| フィールド | 説明 |
| --- | --- |
| `ok` | データを取得できたか。`false` のときは `error.code` / `error.message` / `error.hint` に理由 |
| `summary` | 1 行の要約 |
| `five_hour` / `seven_day` | 5時間枠 / 週間枠。取得できなければ `null` |
| `*.remaining_percent` / `*.used_percent` | 残り % / 使用 %（0〜100） |
| `*.resets_at` / `*.resets_in_seconds` | リセット時刻（UTC）/ リセットまでの秒数 |
| `*.observed_at` / `*.age_seconds` / `*.source` | その値がいつ、どこ（`statusline` / `claude`）で得られたか |
| `*.estimated` | 値を得たあとで枠がリセットされたため、使用 0% と推定しているときに `true` |
| `stale` | 値が `--max-age` より古い（更新できなかった）ときに `true` |
| `warnings` | 更新の失敗などの注意 |
| `other_windows` | そのほかの枠（`seven_day_sonnet`、`seven_day_opus`、ゲートウェイ利用時の `spend_limit` など） |
| `model_windows` | モデル別の週間枠（Claude Code が返した場合） |
| `extra_usage` / `subscription_type` | 追加使用量の設定 / プランの種類（問い合わせで得た場合） |

エラーのときは次のようになります。

```json
{
  "ok": false,
  "summary": "Claude usage unavailable: Claude Code has no Claude subscription login that can report plan usage limits.",
  "error": { "code": "rate_limits_unavailable", "message": "...", "hint": "..." },
  "five_hour": null,
  "seven_day": null,
  "generated_at": "2026-09-27T16:15:35Z"
}
```

主な `error.code`: `claude_not_found`（Claude Code が見つからない）、`rate_limits_unavailable`（サブスクリプションでログインしていない）、`claude_unsupported`（Claude Code が古い）、`timeout`、`no_data`、`unsupported_environment`（Claude Code on the web の中で実行した）

## 環境変数

| 変数 | 説明 |
| --- | --- |
| `CLAUDE_USAGE_CACHE_DIR` | キャッシュの場所（既定は `~/.cache/claude-usage-checker`、Windows は `%LOCALAPPDATA%\claude-usage-checker`） |
| `CLAUDE_USAGE_CLAUDE_BIN` | `claude` 実行ファイルのパス（PATH にない場合） |
| `CLAUDE_CONFIG_DIR` | Claude Code と同じく参照します。既定以外の設定ディレクトリ（別アカウント）ではキャッシュを分けます |
| `NO_COLOR` | statusline の色を付けない |

## 注意点・制限

- **値の鮮度**: statusline の値は「そのセッションが最後に API の応答を受け取った時点」のものです。claude.ai（Web・アプリ）や別の端末での使用は、次の問い合わせか API 応答まで反映されません。どれだけ古いかは `age_seconds` で分かります。
- **`get_usage` は実験的な API** です。Claude Code の更新で使えなくなる可能性があります。その場合も statusline 経由の取得は動きます。
- **サブスクリプション専用**: API キー、Bedrock / Vertex、`claude setup-token` のトークンだけの環境（CI など）では、プランの制限を取得できません。
- **Claude Code on the web**（クラウドのセッション）の中からの問い合わせには対応していません。
- Windows では動作未確認です。
- キャッシュに保存するのはパーセンテージと時刻だけで、認証情報は保存しません。

## 開発

```bash
python -m unittest   # Claude Code の代わりに tests/fake_claude.py を使ってテストします
```
