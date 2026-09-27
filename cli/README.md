# claude-usage（コマンドライン版）

ターミナルの **Claude Code** を使う人向けの、`claude-usage` コマンドです。5時間制限と週間制限の残り % を、エージェントが JSON で受け取れます。Claude Desktop を使う場合は、リポジトリ直下の [README](../README.md) の拡張機能を使ってください。

```console
$ claude-usage --oneline
5h: 77% left (resets in 2h19m) | 7d: 59% left (resets in 3d17h)
```

使用量は Claude Code 自身から受け取ります。ブラウザ拡張は不要です。

- **statusline 経由**: Claude Code が statusline コマンドに渡す `rate_limits`（ドキュメント化された機能、v2.1.80 以降）を記録します。キャッシュを読むだけなので即時に返ります。
- **Claude Code への問い合わせ**: `claude -p` の stream-json に `get_usage` 制御リクエストを送ります。`/usage` と同じデータで、プロンプトを送らないので使用量は消費しません（Agent SDK では「実験的」扱いの API です）。

このツール自体は認証情報を読みも保存もしません。`/login` 済みの Claude Code（Pro / Max / Team / Enterprise）が必要です。

## インストール

Python 3.9 以上が必要です。依存パッケージはありません。

```bash
uv tool install "git+https://github.com/60fullerene/claude-usage-checker#subdirectory=cli"
# または
pipx install "git+https://github.com/60fullerene/claude-usage-checker#subdirectory=cli"
```

## セットアップ

statusline に登録すると、問い合わせなしで即時に新しい値が返ります（推奨）。`~/.claude/settings.json` に追加します。

```json
{ "statusLine": { "type": "command", "command": "claude-usage statusline" } }
```

自分の statusline がある場合は `claude-usage statusline --wrap '~/.claude/statusline.sh' --append` のように包みます。

エージェントに使わせる方法:

- MCP: `claude mcp add --scope user claude-usage -- claude-usage mcp`（`get_claude_usage` ツール）
- hooks: セッション開始時に残りを伝え、残りが少ないときだけ警告します。
  ```json
  {
    "hooks": {
      "SessionStart": [{ "hooks": [{ "type": "command", "command": "claude-usage hook" }] }],
      "PostToolUse": [{ "hooks": [{ "type": "command", "command": "claude-usage hook --warn-below 15" }] }]
    }
  }
  ```
- Skill: [`skills/claude-usage`](../skills/claude-usage) を `~/.claude/skills/` にコピーします。

## 使い方

```bash
claude-usage                          # 人間向けの表示
claude-usage --oneline                # 1 行の要約
claude-usage --json                   # JSON
claude-usage --min-5h 10 --min-7d 5   # 終了コード: 0 正常 / 1 しきい値未満 / 2 データなし・エラー
```

| オプション | 説明 |
| --- | --- |
| `--source auto` | 既定。新しいキャッシュ（既定 120 秒以内）があればそれを、なければ Claude Code に問い合わせる |
| `--source cache` | キャッシュだけを使う |
| `--source claude` | 毎回 Claude Code に問い合わせる |
| `--max-age SECONDS` / `--timeout SECONDS` | キャッシュの許容時間 / 問い合わせの待ち時間 |

環境変数: `CLAUDE_USAGE_CACHE_DIR`（キャッシュの場所、既定 `~/.cache/claude-usage-checker`）、`CLAUDE_USAGE_CLAUDE_BIN`（`claude` のパス）。`CLAUDE_CONFIG_DIR` を使い分けている場合はキャッシュも分かれます。

## 注意点

- 問い合わせのときは `ANTHROPIC_API_KEY` などの環境変数を無視し、`/login` したサブスクリプションのログインを使います。`claude setup-token` のトークンだけの環境ではプランの制限を取得できません。
- statusline の値は、そのセッションが最後に API の応答を受け取った時点のものです。
- Claude Code on the web の中からの問い合わせには対応していません。Windows では動作未確認です。

## テスト

```bash
python -m unittest   # Claude Code の代わりに tests/fake_claude.py を使います
```
