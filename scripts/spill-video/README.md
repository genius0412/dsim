# Spill video: measure real HIVE tips, compare with DSIM (level 1)

Measures where a tipped HIVE's elements come to rest in real match video, then compares that with
where DSIM's 2D tip puts them. It can also suggest values for the three spill constants in
`src/games/biobuzz/hive.ts` (`BB_SPILL_SPEED`, `BB_SPILL_FAN`, `BB_SPILL_KICK`, all `APPROX`).

Level 1 means a person clicks and the scripts do the arithmetic. Nothing here detects balls on
its own. It measures where balls stop, not how they fly.

## The four steps

```powershell
# 1. Rank an event's matches by tips (FTCScout, no key needed). Writes data/<EVENT>/plan.json.
node scripts/spill-video/plan.mjs USWASAM1

# 2. Cut one clip per top match. Read ONE number off the stream first: the video time where the
#    first played match's AUTO starts. Every other match follows from FTCScout's start times.
node scripts/spill-video/clips.mjs USWASAM1 --match1 0:41:10 --url "https://www.youtube.com/watch?v=7VF5ax17flg"
#    or, from a VOD you already downloaded:
node scripts/spill-video/clips.mjs USWASAM1 --match1 0:41:10 --video D:\vods\salk1.mp4
#    --dry prints the plan without downloading. --fix 9=2:10:05 corrects one match after a stream cut.

# 3. Open scripts/spill-video/annotate.html in a browser (double-click it), then load a clip and
#    data/USWASAM1/plan.json. Calibrate, mark the tips, click the balls, Save. That writes a
#    .spill.json; put it in data/USWASAM1/.

# 4. Compare (and optionally fit):
npx tsx scripts/spill-video/compare.ts scripts/spill-video/data/USWASAM1/*.spill.json
npx tsx scripts/spill-video/compare.ts scripts/spill-video/data/USWASAM1/*.spill.json --fit
```

On Windows PowerShell 5.1 the glob above is not expanded. List the files instead, or use
`(Get-ChildItem scripts\spill-video\data\USWASAM1\*.spill.json).FullName`.

`clips.mjs --url` needs yt-dlp (`winget install yt-dlp`, or `pip install yt-dlp`) and ffmpeg on
PATH. Run it on your own computer. YouTube refuses downloads from cloud machines ("sign in to
confirm you're not a bot"). Clips stay in `data/<EVENT>/clips/`, which is gitignored. Commit
the `.spill.json` files, never the video.

## Annotating, step by step

1. **Calibrate** (once per clip, and again if the camera moves or zooms). Click a tile-seam
   crossing on the map, then the same crossing in the video. Use 6 to 10 points spread over the
   whole floor, not just near the hives. The green grid should then sit on the seams. RMS under
   about 3 px is good. If one point's error is much bigger than the others, delete it.
2. **Tips.** Find the moment a tray starts to swing and press "+ Red hive tip here" or
   "+ Blue hive tip here". The FTCScout count for the match shows beside the heading, so you know
   how many to look for. To find them faster, use "Draw hive boxes" (drag around each tray) and
   "Scan for motion". The strip under the video then peaks wherever a tray moved. Click it to jump
   there.
3. **Balls.** "Go to rest frame" (tip + 4 s by default; step forward until every spilled ball has
   stopped). Click each **spilled** ball **where it touches the floor**, at the centre of its
   shadow, not at the middle of the ball. Hold **P** to flip to the frame before the tip, which
   shows which balls are new. Keys 1, 2 and 0 set the kind (pollen, nectar, unsure). Click a marked
   ball again to remove it.
   - Visibility **partial**: some of the spill is hidden (behind a hive post, a robot or a person).
     Click what you can see. Compare treats the count as a minimum.
   - Visibility **hidden**: you can't see the spill. Keep the row so the tip count still matches
     FTCScout. It is not measured.
   - **A robot moved the spill before it settled**: tick it. That tip is skipped.

The page saves to your browser as you go (per clip file name) and restores when you reopen the
same clip. "Save annotations" writes the file compare reads.

## What the comparison does

- **Field.** DSIM's frame: inches, centre origin, red HIVE at −x. `compare.ts` checks the field
  numbers inside `annotate.html` against `src/games/biobuzz/config.ts` and refuses to run if they
  have drifted.
- **Simulated tips.** The `hive-tip` gallery scene's staging, stepped through `biobuzzStep` until
  every spilled element is still. So the swing, the release at level, `spillPoses`, the shared
  artifact solve and rolling friction are all shipped code. Each video tip is simulated with its
  own load (from the kinds you clicked; a partly hidden tip is raised to the smallest load that
  tips, per `BB_TIP_POLLEN`).
- **Measured.** Distance from the hive pivot, and angle off the outboard axis.
- **Noise.** The verdict compares the gap between video and sim with how far a same-sized sample
  of simulated tips strays from the sim by chance. Below 10 tips it prints the numbers but no
  verdict.
- **`--fit`.** A coordinate search over the three spill constants. It prints a suggestion and
  changes nothing.
- **`--selftest`.** Fakes a "video" from known constants and checks that the fit moves toward
  them. Run it after editing `compare.ts`.

## Limits (measured, not guessed)

- **Rest positions cannot pin top speed.** The pivot is about 70 in from the wall it spills
  toward, so every spill faster than about 50 in/s piles against that wall. In the self-test a
  true `BB_SPILL_SPEED` of [44, 76] was fitted as [53, 62]: the same rest distribution, different
  constants. The fan angle and the slow end are well determined. The top speed needs the flight
  (level 2: tracking frame to frame).
- **2D physics only.** A 3D-physics tip is a dynamic tray the balls really roll out of, with no
  spill constants to fit. Comparing it is the next step.
- **Floor only.** The calibration maps the floor plane, so a click is only right on a ball at
  rest on the tiles.
- **Accuracy on a synthetic clip** (1280×720, a camera 10 ft up behind the audience wall, real sim
  positions as truth, clicked from the picture alone): 0.2–0.5 in near the camera and 0.9–1.6 in
  on the far side, where one pixel covers more than an inch. One ball of 14 was hidden behind a
  hive post. A real stream adds motion blur, compression, people and camera moves. Expect worse,
  and check the grid overlay on every clip.

## Files

| file | what |
|---|---|
| `plan.mjs` | FTCScout → `data/<EVENT>/plan.json` (matches ranked by tips, FMS start offsets) |
| `clips.mjs` | plan + one stream time → one clip per match (yt-dlp or ffmpeg) |
| `annotate.html` | the clicking tool; opens from disk, uploads nothing |
| `compare.ts` | video vs the real 2D sim; `--fit`, `--selftest` |
| `data/<EVENT>/` | `plan.json`, `clips.json`, your `.spill.json` files; `clips/` is gitignored |
