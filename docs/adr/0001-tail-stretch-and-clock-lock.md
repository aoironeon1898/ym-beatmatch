# ADR-0001: 尻尾の伸縮＋B冒頭PCM方式と、タップ相関による時刻固定

- Status: Accepted（Phase 0 の実測で裏づけ済み）
- Date: 2026-11-25
- Deciders: リポジトリ所有者 / Claude（設計・計測）
- 基準 upstream: pear-devs/pear-desktop `dbddad1e`

## Context
- YouTube Music の曲間を、DJ のように BPM と拍を合わせてつなぎたい。
- YTM の `<video>` は 1 本しかなく、キーロックで伸縮できるのは Chromium 内蔵の WSOLA だけ。
- 実装を始める前に、成立するかどうかを左右する前提を Phase 0（spike/phase0 ブランチ）で実測した。

## Decision
1. **伸縮するのは前の曲 A の尻尾だけ**にする（signalsmith-stretch、AudioWorklet）。次の曲 B は無加工・等速で流す。
2. **B の冒頭も自前の PCM で鳴らす**（AudioBufferSourceNode）。重なり中の拍は、作った時点でそろう。YTM の B は無音のまま裏で動かし、seek と playbackRate で追いつかせてから同じ音源どうしで切り替える。
3. **時刻の固定はタップ＋正規化相互相関**で行う。粗い時刻（`ctx.currentTime − video.currentTime`）は探索中心を決めるのにだけ使う。
4. **`src/renderer.ts` にコアパッチ**を当てて mainGain と mixBus を入れる。`video.volume` は使わない。
5. signalsmith-stretch 1.3.2 には **pnpm patch**（`patches/signalsmith-stretch@1.3.2.patch`）を当てる。

## Phase 0 の実測結果

| 項目 | 結果 | 判定 |
|---|---|---|
| P4 signalsmith のスケジュール（OfflineAudioContext、クリック音） | **未修正の 1.3.2 では、`schedule()` を呼ぶたびにそれより前の未来区間が消える**。`output` と `outputTime` のどちらのキーでも同じで、区間が 1 つしか残らない（誤差は約 100ms）。schedule 内の shift 条件を `outputTime` から `currentTime` に変える 1 行のパッチで直り、rate 1 / 1.08 / 0.92 の区間すべてで誤差の平均 0.7ms・最大 1.9ms（オンセット検出のバイアス込み）。`latency()` = 0.12 秒。内部のレイテンシ補償は機能している | ✅（パッチを前提とする） |
| P1 audio-only の取得（Premium） | 10/10 成功。すべて itag 774（opus、約 280〜330kbps）。所要時間の中央値 0.88 秒、最大 2.7 秒（初回はセッションと PoToken の生成を含む）。サイズの中央値 4.9MB。PoToken の TTL は 43200 秒 | ✅ |
| P2 decodeAudioData | 10/10 成功。中央値 283ms、最大 724ms（5.7 分の曲）。48kHz・2ch | ✅ |
| P16 ページ内の Blob Worker / Worklet、signalsmith | Worker・Worklet・signalsmith すべて成功 | ✅ |
| P13 相関による固定 | 音源が一致した 8 曲で **160/160 回の固定に成功**。曲ごとの固定値の標準偏差は最大 0.005ms、範囲は最大 0.018ms。ピークの中央値は 0.999 | ✅（目標 <1ms を大きく下回る） |
| 粗い時刻 | 固定値との差は −1.67〜−2.06ms（中央値 −1.89ms）で一定のバイアス。ジッタの標準偏差は最大 1.43ms（予想の 10〜30ms よりはるかに小さい） | ✅ → 探索幅は ±0.15 秒から ±0.03 秒程度に縮められる |
| P5 `video.volume=0` のときのタップ | RMS 0.36 → **0**。音量を 0 にするとタップも無音になる | ✅（D2 のコアパッチが必須であることを確認） |
| P18 `playbackRate` | 1.02 は上書きされずに残る（ratechange は設定時と戻したときの 2 回だけ）。ただし効き始めが遅い。3 秒で理論値 −60ms のところ実測は −29.7ms で、戻したあとも −16ms ずれが続く（約 1〜1.5 秒の遅延と推定） | ⚠️ 開ループでの制御は不可。0.5 秒ごとに固定し直す閉ループ制御を使う |
| P18 seek（+0.25 秒 × 3 回） | `seeked` までの遅延は 0〜5ms、停止時間は 0 / 2.0 / 2.0ms | ✅ seek だけで数 ms まで合わせ込める |
| P19 loudnessDb | `player_config.audio_config.loudness_db` と `perceptual_loudness_db` が取れる（例：−5.49〜+2.32） | ✅ 値は取れる。YTM 側でどう適用されているかは未確認 |
| **P21（新規）音源の版違い** | 10 回中 1 回、YTM が同じ videoId で**別の長さの版**（152.8 秒、取得した版は 122.9 秒）を再生していた。同じ曲を別の経路で再生したときは一致した | ⚠️ 検出してフォールバックする |
| 背景ウィンドウ | `requestAnimationFrame` は背景では止まる（初回の計測で発覚）。タイマーなら動く | ⚠️ rAF には依存しない |

## Consequences
- 良い点
  - 中核の前提（取得・decode・ページ内の Worklet・サンプル精度の時刻固定・伸縮のスケジュール）は、すべて実測で成立が確認できた。
  - 同期精度は予想よりはるかに高い。BHandoff は「seek で数 ms まで寄せ、残りを rate で詰める」だけで足りる見込み。
- 悪い点・注意点
  - signalsmith はフォーク版（パッチ当て）になる。upstream で更新されたら、パッチを当て直す必要がある。
  - `playbackRate` は遅れて効くので、BHandoff の収束は seek が主役になる。rate は ±1ms 程度の微調整に限る。
  - 版違い（P21）があるので、遷移の前に次の 2 点を確かめる。どちらかに当てはまれば、その曲の遷移は `none` にする。
    - 取得した音源の長さと `video.duration` の差が 1 秒を超える。
    - 固定してもピークが探索範囲の端に出る。
- 設計書への反映
  - §3-D の探索幅：粗い時刻で決めた中心から ±0.03 秒を探す。それで見つからなければ ±0.15 秒、その次に ±2 秒（ステップ 2）の順で広げる。
  - §3-C3 の手順 3〜4：まず `|δ|` が 2ms を超えている間は seek を繰り返す（最大 3 回）。それでも残ったずれは rate で詰め、0.5 秒ごとに固定し直す。
  - §9 に P21 の検出とフォールバックを追加する。
  - 粗い時刻の採取は 50ms のタイマーで行う。

## Alternatives（却下）
- `video.volume` でフェードする：P5 で、音量を 0 にするとタップが無音になると確定したため。
- README どおりの `output` キーでスケジュールする：P4 で、前の区間が消えることが分かったため。
- 未修正の signalsmith を使い、区間を直前に 1 つずつ予約する：境界でずれが 0.75ms 程度出る見込みで、パッチより劣る。
