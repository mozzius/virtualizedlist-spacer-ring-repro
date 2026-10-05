# VirtualizedList spacer ring under `maintainVisibleContentPosition`

After a large prepend to a `FlatList` with `maintainVisibleContentPosition`
(mVCP), the list and the mVCP anchor can fall into a cycle that never settles.
Every ~67 ms `contentSize.height` and `contentOffset.y` jump together by
roughly 400 pt, then jump back. The rows on screen don't move, because mVCP
compensates exactly. But `onScroll` fires ~15 times a second with ±400 pt
"movements", the scroll indicator jitters, and the list keeps re-rendering at
rest for as long as you leave it.

| iOS | Android |
| --- | --- |
| [`evidence/ios-demo.mp4`](evidence/ios-demo.mp4) | [`evidence/android-demo.mp4`](evidence/android-demo.mp4) |

Each demo is about 40 s: the stock list first, then the same steps with the
fix on (see [Demo videos](#demo-videos)).

The cause is in `@react-native/virtualized-lists`. After the prepend, the
interior spacer between the retained scroll-to-top cells and the render window
is sized from a measured frame at one end and `_averageCellLength * index` at
the other. Its size changes whenever a cell mounts or unmounts at the window's
leading edge, and mVCP has to chase it. [`ISSUE.md`](ISSUE.md) has the full
analysis and a proposed fix.

- **Upstream issue:** [react/react-native#58870](https://github.com/react/react-native/issues/58870)
- **Found in:** the Bluesky app
  ([bluesky-social/social-app#11872](https://github.com/bluesky-social/social-app/pull/11872)
  carries the fix as a patch)

## Environment

| | |
| --- | --- |
| react-native | 0.87.1 (also 0.86.3; the code is unchanged on `main` at 4d590e6) |
| react | 19.2.3 |
| Architecture | New (Fabric), Hermes |
| Reproduced on | iOS Simulator, iPhone 17 Pro, iOS 26.5 |
| Also reproduced on | Android Emulator, Pixel 9 Pro, API 35 |
| Dependencies | Only the template's, plus `patch-package` (see below) |

## Running it

```bash
cd ReproducerApp
yarn install            # postinstall applies patches/ with patch-package
(cd ios && bundle install && bundle exec pod install)
yarn start
yarn ios                # or: yarn android
```

1. Tap **Run**. The app scrolls 3000 pt down and prepends 50 rows at the top.
   Once the prepend has landed it nudges the list up 50 pt every 500 ms, like
   a slow scroll back into the new rows, and stops as soon as the list keeps
   moving by itself (or after 12 nudges). Where that happens depends on the
   screen size, so it is found rather than hardcoded. On Android the list
   usually starts ringing straight after the prepend, before any nudge.
2. Don't touch anything, and watch the readout at the top.

| | Stock | Fix on |
| --- | --- | --- |
| `reversals in last 1s` | ~15, indefinitely | 0 |
| `ring` counter | climbs ~14/s until you reset | 0-1 |
| `corrections` after Run | hundreds, still climbing | 2-4, then none |
| Readout colour | red: it's ringing right now | black |
| Visible rows | still | still |

Drag the list slowly while it's ringing to see the scroll indicator jitter
under your finger. You can also scroll up through the prepended rows by hand:
stock rings in bursts every time the window's leading edge passes a row, and
when you let go in the wrong place it keeps ringing at rest.

### The readout and logs

`onScroll` (`scrollEventThrottle={16}`) logs every event to the JS console
(open React Native DevTools with `j` in Metro) with the prefix `[ring]`:

```text
[ring] +8723ms moving by itself, stopped scrolling
[ring] +8726ms y=19642.3 (dy=+397.0) h=27183.3 (dh=+397.0) correction #11 RING #8 (92ms after -397.0)
[ring] +8785ms y=19245.3 (dy=-397.0) h=26786.3 (dh=-397.0) correction #12 RING #9 (59ms after +397.0)
```

- **correction:** an event whose offset moved by the same amount as the
  content height (`|dh| >= 20` and `|dy - dh| <= 2`). That is mVCP holding the
  anchor, not the user scrolling.
- **ring:** a correction that undid the previous one (opposite sign) within
  300 ms.
- **reversals in last 1s:** how many times `dy` changed sign in the last
  second.

The rows have deterministic heights from 60 to 600 pt, from a hash of the row
id, so every run lays out identically. Each row shows its id and height.

## Toggling the fix

The **Fix** switch passes `measureInteriorSpacers={true}` to the `FlatList`.
Toggling it also resets the list. That prop doesn't exist upstream. It comes
from [`patches/@react-native+virtualized-lists+0.87.1.patch`](ReproducerApp/patches/@react-native+virtualized-lists+0.87.1.patch),
which `patch-package` applies on `yarn install`.

- **Switch off:** `VirtualizedList` runs the stock code path, unchanged. The new
  method returns `null` before reading anything, and the spacer uses the
  upstream expression.
- **Switch on:** a spacer that has laid-out cells on both sides is sized from
  those two frames (`below.offset - (above.offset + above.length)`), not from
  the average. The prop exists only so that stock and fixed can be compared in
  the same app. The fix proposed in `ISSUE.md` is unconditional.

`App.tsx` is the whole repro. FlatList's TypeScript types don't know the prop,
hence the one `@ts-expect-error`.

## Demo videos

Recorded with this app, in real time (nothing trimmed but the lead-in). Each
one runs the same steps twice in one take: stock first, then with **Fix** on.

**[`evidence/ios-demo.mp4`](evidence/ios-demo.mp4)**: iPhone 17 Pro simulator, iOS 26.5, 40 s.

| Time | What happens |
| --- | --- |
| 0:00 | Stock. Tap **Run**. |
| 0:03-0:06 | The prepend lands, and Run nudges the list up. |
| 0:06-0:13 | It starts ringing at rest. The readout turns red, the offset and size flip ~15 times a second, the ring counter climbs, and the rows don't move. |
| 0:13-0:17 | A slow drag by hand. The scroll indicator jitters under the finger, and the ringing carries on. |
| 0:17-0:20 | Let go: still ringing. |
| 0:20-0:21 | **Fix** on (the list resets), then **Run** again. |
| 0:23-0:31 | The prepend lands and Run nudges up all 12 times. Four corrections, then it's still and the readout stays black. |
| 0:33-0:37 | The same slow drag. The indicator moves smoothly, with no corrections. |

**[`evidence/android-demo.mp4`](evidence/android-demo.mp4)**: Pixel 9 Pro emulator, API 35, 39 s.

| Time | What happens |
| --- | --- |
| 0:00 | Stock. Tap **Run**. |
| 0:02-0:12 | It starts ringing straight after the prepend, with no nudge needed. The scroll bar on the right edge stays visible and jitters, and the counters climb. |
| 0:12-0:16 | A slow drag by hand. It keeps ringing. |
| 0:16-0:19 | Let go: still ringing. |
| 0:19-0:21 | **Fix** on, then **Run** again. |
| 0:23-0:30 | The prepend lands and Run nudges up. Four corrections, then still. |
| 0:33-0:36 | The same slow drag. No corrections. |

The videos carry Argent's watermark (the tool used to record them).

## Logs

| File | What |
| --- | --- |
| [`evidence/ios-stock.log`](evidence/ios-stock.log), [`ios-fixed.log`](evidence/ios-fixed.log) | The JS console for the same steps as the demo, stock and fixed (a separate run) |
| [`evidence/ios-scroll-up.log`](evidence/ios-scroll-up.log) | Scrolling up through the prepended rows: 423 corrections and 285 ring steps stock, against 6 and 0 fixed |
| [`evidence/ios-spacer-diagnostics.log`](evidence/ios-spacer-diagnostics.log) | Temporary instrumentation of the spacer sizing, showing the two states the stock list alternates between |
| [`evidence/android.log`](evidence/android.log) | Stock and fixed on the Android emulator |

The last three were captured with an earlier version of `App.tsx`, which had a
smaller readout and so a taller list. That changes where the list rings, but
not how.

With the current Run, stock rang at rest until reset in 4 of 4 iOS runs and
4 of 5 Android runs. The Android run that didn't ring was the first one after a
cold launch. With the fix, the list settled after 2-4 corrections every time:
4 of 4 on iOS and 1 of 1 on Android. Earlier versions of the app agree: stock
6 of 6 and fixed 5 of 5 on iOS.
