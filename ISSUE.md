# VirtualizedList: interior spacer mixes measured and estimated offsets, so `maintainVisibleContentPosition` oscillates endlessly after a large prepend

<!--
Draft for react/react-native (the repo formerly at facebook/react-native), bug report template.
Template fields are the "###" headings below. Attach the three videos from evidence/ when filing.
-->

### Description

After a large prepend to a `FlatList` with `maintainVisibleContentPosition`, the list and the mVCP anchor can fall into a cycle that never settles. Every ~67 ms `contentSize.height` and `contentOffset.y` jump together by ~426 pt, then jump back. It keeps going at rest, for as long as you leave it.

The visible rows don't move, because mVCP compensates exactly. What does move:

- every `onScroll` listener sees a stream of ±426 pt scroll events, with ~15 direction reversals per second. Anything driven by scroll position (a collapsing header, scroll-linked animations) flickers.
- the scroll indicator jitters whenever it's visible.
- the list re-renders and re-lays out ~15 times a second, indefinitely.

We hit this in the Bluesky app: 320-529 pt swings every 60-130 ms on device, both at rest and while scrolling up through freshly prepended rows.

It needs:

- no `getItemLayout`, and rows of varying height
- `maintainVisibleContentPosition`, and no `initialScrollIndex`, so the scroll-to-top cells are retained
- a prepend large enough to leave unrendered rows between the retained head cells and the render window

#### Root cause

1. **`_createRenderMask` keeps cells `[0, initialNumToRender)` rendered** ([VirtualizedList.js#L520-L526](https://github.com/react/react-native/blob/4d590e63162f948b41b3bc2fb48793b4319221f8/packages/virtualized-lists/Lists/VirtualizedList.js#L520-L526)). After a 50-row prepend the mask is: head `[0, 9]`, an **interior spacer** `[10, W-1]`, then the window `[W, …]`. The spacer sits directly above the viewport.

2. **A spacer is sized as `getCellMetricsApprox(last).offset + length - getCellMetricsApprox(first).offset`** ([#L1032-L1041](https://github.com/react/react-native/blob/4d590e63162f948b41b3bc2fb48793b4319221f8/packages/virtualized-lists/Lists/VirtualizedList.js#L1032-L1041)). Suppose a cell has no frame at its current index, and some later cell has been measured. Then `getCellMetricsApprox` returns `offset = _averageCellLength * index` ([ListMetricsAggregator.js#L199-L201](https://github.com/react/react-native/blob/4d590e63162f948b41b3bc2fb48793b4319221f8/packages/virtualized-lists/Lists/ListMetricsAggregator.js#L199-L201)). That ignores the measured cells above it. In the repro, the spacer's `first` (index 10) is estimated at `avg * 10 = 3531.5`, but the measured head cells end at 3105.

3. **The spacer's `last` end is estimated or measured, depending on the cell at the window's leading edge.** Call that cell `W-1`.
   - While `W-1` is mounted, the spacer is `[10, W-2]`. Both ends are estimated, so the size is a consistent `avg * count`: here `9535`, plus `W-1`'s 301 pt.
   - Once `W-1` unmounts, the spacer is `[10, W-1]`. Its `last` cell now has a frame, so the size is `measured end - estimated start`: here `12941 - 3531.5 = 9409.5`.
   - The content above the window therefore shrinks by 426.5 pt, exactly the error in the estimated start (`3531.5 - 3105`).

4. **mVCP shifts the offset by -426.3 pt.** From the new offset, `computeWindowedRenderLimits` puts `W-1` back in the window, so it mounts. The spacer flips back, the content grows by 426.3 pt, mVCP shifts +426.3 pt, and `W-1` drops out of the window again. That 2-cycle repeats indefinitely.

Instrumented, at rest. The interior spacer alternates between these two states every ~67 ms (abbreviated; full output in [`evidence/ios-spacer-diagnostics.log`](https://github.com/mozzius/virtualizedlist-spacer-ring-repro/blob/main/evidence/ios-spacer-diagnostics.log)):

```text
[spacer] [10,37] size=9409.5 first(approx)={off:3531.48,i:10,m:false} last(approx)={i:37,len:301,m:true,off:12640} avg=353.15 above={i:9,len:89,off:3016} below={i:38,len:433,off:12941} window=[38,80]
[spacer] [10,36] size=9535.0 first(approx)={off:3531.48,i:10,m:false} last(approx)={off:12713.33,i:36,m:false}    avg=353.15 above={i:9,len:89,off:3016} below={i:37,len:301,off:12640} window=[37,79]
```

The tail spacer is already protected from a related problem: it's clamped to `getHighestMeasuredCellIndex()` "because otherwise content will likely jump around as it renders in above the viewport" ([#L1019-L1030](https://github.com/react/react-native/blob/4d590e63162f948b41b3bc2fb48793b4319221f8/packages/virtualized-lists/Lists/VirtualizedList.js#L1019-L1030)). Interior spacers get no such protection, even though they sit above the viewport.

#### Proposed fix

When a spacer has rendered cells on **both** sides, and both have been laid out where they are now, size it from those two frames. Use the estimate otherwise:

```js
_measuredInteriorSpacerSize(region: {first: number, last: number, ...}): ?number {
  if (
    this.props.getItemLayout != null ||
    region.first === 0 ||
    region.last + 1 >= this.props.getItemCount(this.props.data)
  ) {
    return null; // exact metrics already, or a leading/tail spacer
  }
  const above = this._listMetrics.getCellMetrics(region.first - 1, this.props);
  const below = this._listMetrics.getCellMetrics(region.last + 1, this.props);
  if (above == null || below == null || !above.isMounted || !below.isMounted) {
    return null;
  }
  const size = below.offset - (above.offset + above.length);
  return size > 0 ? size : null;
}

// in render():
const spacerSize =
  this._measuredInteriorSpacerSize(section) ??
  lastMetrics.offset + lastMetrics.length - firstMetrics.offset;
```

This gap contains no estimate. It's also self-consistent: it is the size that produced those two layouts. So when `W-1` unmounts, the spacer grows by exactly the space `W-1` took up. The content above the window doesn't change, and mVCP has nothing to correct. The first render after the change still uses the estimate, because the new neighbour hasn't been laid out yet. That costs at most one correction, not a cycle.

The trade-off: unmeasured content above the viewport keeps its first estimated size rather than following the running mean. It's corrected when the user scrolls into it, which is the same trade the tail clamp makes.

The repro applies exactly this as a `patch-package` patch. Its only extra is a `measureInteriorSpacers` prop, which exists so stock and fixed can be compared in one app. With the patch, after "Run":

- **iOS:** 2-4 corrections in total, then nothing in 5/5 runs. Stock rang until reset in 6/6 runs, ~14 ring steps/s.
- **Android:** 2 corrections. Stock rang the same way, as a 3-cycle of -472 / -472 / +945 pt.

An alternative is to make `getCellMetricsApprox` estimate an unmeasured cell from the nearest measured cell *before* it, as it already does for cells past the highest measured index. That would also fix this case, but it needs a scan by index, since frames are keyed by item key.

#### Upstream status

The spacer sizing and `getCellMetricsApprox` are unchanged on `main` (4d590e6). I also ran `main`'s `packages/virtualized-lists/Lists` sources on top of 0.87.1, and it rings the same way: ±426.3 pt, ~15 reversals/s. This is separate from #53542 / #57955 (`pendingScrollUpdateCount`), which only matters around the prepend itself.

Related, but not duplicates (these are native mVCP issues): #58186, #58578, #56866, #41212. Also related: #39187 (closed), where variable-height rows jump when scrolling up.

#### Expected

When a cell outside the viewport mounts or unmounts, the content above the anchor keeps its size. After a prepend, `contentOffset.y` and `contentSize.height` settle and stay still at rest.

#### Actual

`contentOffset.y` and `contentSize.height` oscillate together, by the head block's estimate error (~426 pt here), every ~67 ms, indefinitely. `onScroll` keeps firing at rest.

### Steps to reproduce

1. `git clone https://github.com/mozzius/virtualizedlist-spacer-ring-repro && cd virtualizedlist-spacer-ring-repro/ReproducerApp`
2. `yarn install`. The `postinstall` step applies the patch, which only adds an opt-in prop used by the **Fix** switch. With the switch off, VirtualizedList runs unmodified code.
3. `cd ios && bundle install && bundle exec pod install && cd ..`
4. `yarn start`, then `yarn ios` (or `yarn android`).
5. Tap **Run**. It scrolls down to y=3000, prepends 50 rows, then scrolls up 450 pt once the prepend has landed.
6. Don't touch anything. Watch the readout at the top: `reversals in last 1s` stays at ~15 and the `ring` counter keeps climbing. Logs are in the JS console, prefixed `[ring]`.
7. Turn on **Fix** (this resets the list) and tap **Run** again. You get 2-4 corrections, then everything is still.

### React Native Version

0.87.1. Same code in 0.86.3 and on `main` (4d590e6).

### Affected Platforms

Runtime - iOS, Runtime - Android

### Output of `npx @react-native-community/cli info`

```text
System:
  OS: macOS 27.0.1
  CPU: (14) arm64 Apple M4 Pro
  Memory: 1.65 GB / 48.00 GB
  Shell:
    version: 5.3.20
    path: /opt/homebrew/bin/bash
Binaries:
  Node:
    version: 24.19.0
    path: ~/.nvm/versions/node/v24.19.0/bin/node
  Yarn:
    version: 1.22.22
    path: ~/.nvm/versions/node/v24.19.0/bin/yarn
  npm:
    version: 11.17.0
    path: ~/.nvm/versions/node/v24.19.0/bin/npm
  Watchman:
    version: 2026.09.21.00
    path: /opt/homebrew/bin/watchman
Managers:
  CocoaPods:
    version: 1.17.0
    path: ~/.rbenv/shims/pod
SDKs:
  iOS SDK:
    Platforms:
      - DriverKit 27.0
      - iOS 27.0
      - macOS 27.0
      - tvOS 27.0
      - visionOS 27.0
      - watchOS 27.0
  Android SDK:
    API Levels:
      - "29"
      - "33"
      - "34"
      - "35"
      - "36"
    Build Tools:
      - 30.0.3
      - 34.0.0
      - 35.0.0
      - 35.0.1
      - 36.0.0
      - 37.0.0
    System Images:
      - android-28 | Google ARM64-V8a Play ARM 64 v8a
      - android-29 | Google Play ARM 64 v8a
      - android-30 | Google APIs ARM 64 v8a
      - android-34 | Google Play ARM 64 v8a
      - android-35 | Google Play ARM 64 v8a
      - android-35 | Google Play Tablet ARM 64 v8a
      - android-36 | Google Play ARM 64 v8a
    Android NDK: Not Found
IDEs:
  Android Studio: 2026.1 AI-261.26222.65.2614.16379836
  Xcode:
    version: 27.0/27A266a
    path: /usr/bin/xcodebuild
Languages:
  Java:
    version: 17.0.20.1
    path: /usr/bin/javac
  Ruby:
    version: 2.7.6
    path: ~/.rbenv/shims/ruby
npmPackages:
  "@react-native-community/cli":
    installed: 20.2.0
    wanted: 20.2.0
  react:
    installed: 19.2.3
    wanted: 19.2.3
  react-native:
    installed: 0.87.1
    wanted: 0.87.1
  react-native-macos: Not Found
npmGlobalPackages:
  "*react-native*": Not Found
Android:
  hermesEnabled: true
  newArchEnabled: true
iOS:
  hermesEnabled: true
  newArchEnabled: true
```

Tested on: iOS Simulator (iPhone 17 Pro, iOS 26.5) and Android Emulator (Pixel 9 Pro, API 35), both on the New Architecture.

### Stacktrace or Logs

The repro's `onScroll` log, stock, at rest after "Run". A `correction` is an event whose offset moved by the same amount as `contentSize`. A `RING` step is a correction that undid the previous one.

```text
[ring] +2005ms prepending 50 rows (-50..-1) at y=3000.0 h=8330.0
[ring] +2053ms y=20252.0 (dy=+17252.0) h=28216.0 (dh=+19886.0)
...
[ring] +3555ms scrolling up 450pt
...
[ring] +3917ms y=20191.0 (dy=+426.3) h=28605.0 (dh=+426.3) correction #7 RING #4 (69ms after -426.3)
[ring] +3982ms y=19764.7 (dy=-426.3) h=28178.7 (dh=-426.3) correction #8 RING #5 (65ms after +426.3)
[ring] +4049ms y=20191.0 (dy=+426.3) h=28605.0 (dh=+426.3) correction #9 RING #6 (67ms after -426.3)
[ring] +4116ms y=19764.7 (dy=-426.3) h=28178.7 (dh=-426.3) correction #10 RING #7 (67ms after +426.3)
... (unchanged for 40 s, until the list was reset)
[ring] +39904ms y=20191.0 (dy=+426.3) h=28605.0 (dh=+426.3) correction #545 RING #542 (68ms after -426.3)
[ring] +39971ms y=19764.7 (dy=-426.3) h=28178.7 (dh=-426.3) correction #546 RING #543 (67ms after +426.3)
```

With the fix, the same steps produce four corrections, and nothing after +3860 ms:

```text
[ring] +2126ms y=20310.3 (dy=+58.3) h=28274.3 (dh=+58.3) correction #1
[ring] +2187ms y=20624.7 (dy=+314.3) h=28588.7 (dh=+314.3) correction #2
[ring] +3787ms y=19831.3 (dy=-426.3) h=28162.3 (dh=-426.3) correction #3
[ring] +3856ms y=20195.0 (dy=+442.7) h=28605.0 (dh=+442.7) correction #4 RING #1 (69ms after -426.3)
[ring] +3860ms y=20191.0 (dy=-4.0) h=28605.0 (dh=+0.0)
```

The full logs are in the repro's [`evidence/`](https://github.com/mozzius/virtualizedlist-spacer-ring-repro/tree/main/evidence) directory, along with Android logs and a run that scrolls up through the prepended rows.

### MANDATORY Reproducer

https://github.com/mozzius/virtualizedlist-spacer-ring-repro

### Screenshots and Videos

<!-- Drag these into the issue when filing; GitHub hosts the uploads. -->

- `evidence/ios-stock.mp4`: stock, one tap on Run, then hands off. The rows stay still, while the readout's offset and size flip ~15 times a second and its counters climb.
- `evidence/ios-fixed.mp4`: the same steps with **Fix** on. It settles immediately.
- `evidence/ios-stock-drag.mp4`: stock, holding a slow drag while it rings. The scroll indicator jitters under the finger.
